"""The store's read primitives for the web UI (issue #700, heir of #659)."""
from datetime import date, datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence

from application import instants
from application import retention
from application import store

POSITION_COLUMNS = (
    'account', 'symbol', 'name',
    'quantity', 'cost_basis', 'realized_gain', 'received_dividend',
)
QUOTE_COLUMNS = (
    'currency', 'exchange', 'quote_type',
    'dividend_yield', 'pe_ratio', 'market_cap',
)
PRICE_COLUMNS = ('price', 'price_native', 'fx_rate', 'price_time')

CLOSING_COLUMNS = ('closed_at',)

P1_COLUMNS = POSITION_COLUMNS + QUOTE_COLUMNS + PRICE_COLUMNS + CLOSING_COLUMNS

PERF_COLUMNS = (
    'day', 'cash_balance', 'holdings_value', 'total_value', 'net_contributed',
    'xirr', 'gain_absolu', 'twr_index',
)


class PortfolioReader:
    """The read primitives the pages need, and nothing else."""

    def __init__(self, store):
        self._store = store

    def positions(self, symbol: Optional[str] = None) -> List[Dict[str, Any]]:
        """One row per ``(account, symbol)``: the position, joined to its quote."""
        where = 'WHERE p.symbol = ?' if symbol is not None else ''
        parameters = [symbol] if symbol is not None else None
        selected = [f'p.{name}' for name in POSITION_COLUMNS]
        selected += [f'q.{name}' for name in QUOTE_COLUMNS]
        selected += ['q.last_price_converted', 'q.last_price_native',
                     'q.last_fx_rate', 'q.last_price_ts']
        selected += ['CASE WHEN p.quantity = 0 THEN s.closed_at END']
        rows = self._store.query(
            f'SELECT {", ".join(selected)} '
            '  FROM position p '
            '  LEFT JOIN symbol_quote q ON q.symbol = p.symbol '
            '  LEFT JOIN (SELECT account, symbol, max(date) AS closed_at '
            "              FROM event WHERE event_type = 'SELL' "
            '             GROUP BY account, symbol) s '
            '    ON s.account = p.account AND s.symbol = p.symbol '
            f' {where} '
            ' ORDER BY p.symbol, p.account', parameters)
        return [_stamp(dict(zip(P1_COLUMNS, row))) for row in rows]

    def chart_series(self, symbol: str, interval: Optional[str] = None,
                     start: Optional[datetime] = None,
                     stop: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """One symbol's series for ``GET /api/prices/<symbol>`` (issue #763)."""
        clauses, parameters = _window('ts', start, stop)
        if interval is None:
            return self._series(
                'SELECT ts, price_converted FROM price_point '
                f' WHERE symbol = ?{clauses}'
                ' ORDER BY ts',
                [symbol] + parameters, ('ts', 'price'))

        if interval not in ALLOWED_INTERVALS:
            raise ValueError(f"Unsupported bucket interval: {interval!r}")
        return self._series(
            "SELECT bucket, price_converted FROM ("
            f"  SELECT time_bucket(INTERVAL '{interval}', ts) AS bucket,"
            "         price_converted,"
            "         ROW_NUMBER() OVER ("
            f"             PARTITION BY time_bucket(INTERVAL '{interval}', ts)"
            "             ORDER BY ts DESC) AS rn"
            "    FROM price_point"
            f"   WHERE symbol = ?{clauses}"
            ") WHERE rn = 1 ORDER BY bucket",
            [symbol] + parameters, ('ts', 'price'))

    def prices_at(self, moment: datetime) -> List[Dict[str, Any]]:
        """Each symbol's last price at or **before** ``moment``, with its instant."""
        return self._series(
            'SELECT symbol, price_converted, ts FROM ('
            '  SELECT symbol, price_converted, ts,'
            '         ROW_NUMBER() OVER ('
            '             PARTITION BY symbol ORDER BY ts DESC) AS rn'
            '    FROM price_point'
            '   WHERE price_converted IS NOT NULL AND ts <= ?'
            ') WHERE rn = 1 ORDER BY symbol',
            [moment], ('symbol', 'price', 't'))

    def daily_closes(self, start: Optional[datetime] = None,
                     stop: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """``{day, symbol, price}`` — every symbol's closing price, per day."""
        clauses, parameters = _window('ts', start, stop)
        return self._series(
            'SELECT day, symbol, price FROM ('
            '  SELECT CAST(ts AS DATE) AS day, symbol, price_converted AS price,'
            '         ROW_NUMBER() OVER ('
            '             PARTITION BY CAST(ts AS DATE), symbol'
            '             ORDER BY ts DESC) AS rn'
            '    FROM price_point'
            f'   WHERE price_converted IS NOT NULL{clauses}'
            ') WHERE rn = 1 ORDER BY day, symbol',
            parameters, ('day', 'symbol', 'price'))

    def latest_totals(self) -> Optional[Dict[str, Any]]:
        """The newest ``portfolio_totals`` point, or ``None`` when there is none."""
        rows = self._store.query(
            f'SELECT {", ".join(PERF_COLUMNS)} FROM portfolio_totals '
            ' ORDER BY day DESC LIMIT 1')
        return _stamp(dict(zip(PERF_COLUMNS, rows[0]))) if rows else None

    def totals_on_or_before(self, day: date) -> Optional[Dict[str, Any]]:
        """The newest ``portfolio_totals`` point at or **before** ``day``."""
        rows = self._store.query(
            f'SELECT {", ".join(PERF_COLUMNS)} FROM portfolio_totals '
            ' WHERE day <= CAST(? AS DATE) ORDER BY day DESC LIMIT 1', [day])
        return _stamp(dict(zip(PERF_COLUMNS, rows[0]))) if rows else None

    def twr_origin(self) -> Optional[date]:
        """The day the time-weighted index counts from — ``MIN(day)``."""
        rows = self._store.query(
            'SELECT min(day) FROM portfolio_totals WHERE twr_index IS NOT NULL')
        return rows[0][0] if rows else None

    def transfer_fees(self, through: date) -> float:
        """ADR-0018's fourth term, **signed as it enters the sum**."""
        rows = self._store.query(
            'SELECT sum(fee) FROM event '
            " WHERE event_type IN ('DEPOSIT', 'WITHDRAWAL') "
            '   AND date <= CAST(? AS DATE)', [through])
        total = store.finite(rows[0][0]) if rows else None
        return -total if total else 0.0

    def transfer_fees_by_account(self,
                                 through: Mapping[str, date]
                                 ) -> Dict[str, float]:
        """The same fourth term, **per account** (issue #722)."""
        if not through:
            return {}

        rows = self._store.query(
            'SELECT account, date, sum(fee) FROM event '
            " WHERE event_type IN ('DEPOSIT', 'WITHDRAWAL') "
            '   AND date <= CAST(? AS DATE) '
            ' GROUP BY account, date', [max(through.values())])

        gathered = {account: 0.0 for account in through}
        for account, day, fee in rows:
            bound = through.get(account)
            amount = store.finite(fee)
            if bound is None or day is None or day > bound or not amount:
                continue
            gathered[account] += amount
        return {account: (-total if total else 0.0)
                for account, total in gathered.items()}

    def totals_series(self, start: Optional[datetime] = None,
                      stop: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """The global perf series over ``[start, stop]``, oldest day first."""
        clauses, parameters = _window('day', start, stop, as_date=True)
        return self._series(
            f'SELECT {", ".join(PERF_COLUMNS)} FROM portfolio_totals '
            f' WHERE TRUE{clauses} ORDER BY day', parameters, PERF_COLUMNS)

    def latest_account_metrics(self) -> List[Dict[str, Any]]:
        """The newest point of **every** account, in one query."""
        columns = ('account',) + PERF_COLUMNS
        rows = self._store.query(
            f'SELECT {", ".join(columns)} FROM ('
            f'  SELECT {", ".join(columns)}, ROW_NUMBER() OVER ('
            '             PARTITION BY account ORDER BY day DESC) AS rn'
            '    FROM account_metrics'
            ') WHERE rn = 1 ORDER BY account')
        return [_stamp(dict(zip(columns, row))) for row in rows]

    def account_series(self, account: str,
                       start: Optional[datetime] = None,
                       stop: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """One account's perf series over ``[start, stop]``, oldest day first."""
        clauses, parameters = _window('day', start, stop, as_date=True)
        return self._series(
            f'SELECT {", ".join(PERF_COLUMNS)} FROM account_metrics '
            f' WHERE account = ?{clauses} ORDER BY day',
            [account] + parameters, PERF_COLUMNS)

    def _series(self, sql: str, parameters: Optional[Sequence[Any]],
                names: Sequence[str]) -> List[Dict[str, Any]]:
        """Run a wide read and turn its columns into rows, through Arrow."""
        table = self._store.arrow(sql, parameters)
        columns = [_stamped(table.column(index).to_pylist())
                   for index in range(table.num_columns)]
        return [dict(zip(names, values)) for values in zip(*columns)]


ALLOWED_INTERVALS = ('5 minutes', '30 minutes', '1 hour', '6 hours', '1 day')


CHART_WINDOWS = ('1M', '1Y', '2Y', 'MAX')

_CHART_LADDER = {
    '1M': (31, None),
    '1Y': (365, '1 hour'),
    '2Y': (730, '1 hour'),
    'MAX': (None, '1 day'),
}


def chart_window(window: Optional[str]) -> tuple:
    """Resolve a window name into ``(span_days, bucket, resolution)``."""
    if window not in _CHART_LADDER:
        raise ValueError(
            f"Unknown window {window!r}: expected one of "
            f"{', '.join(CHART_WINDOWS)}")
    span_days, bucket = _CHART_LADDER[window]
    return (span_days, bucket,
            retention.coarsest(retention.rung_of_bucket(bucket),
                               retention.rung_over(span_days)))


def _window(column: str, start: Optional[datetime],
            stop: Optional[datetime], as_date: bool = False) -> tuple:
    """Render the optional ``[start, stop]`` bounds as predicates + parameters."""
    bound = 'CAST(? AS DATE)' if as_date else '?'
    clauses = ''
    parameters: List[Any] = []
    if start is not None:
        clauses += f' AND {column} >= {bound}'
        parameters.append(start)
    if stop is not None:
        clauses += f' AND {column} <= {bound}'
        parameters.append(stop)
    return clauses, parameters


def _stamp(row: Dict[str, Any]) -> Dict[str, Any]:
    """Make one row safe to hand out. For a handful of rows."""
    return {key: store.finite(instants.utc(value))
            for key, value in row.items()}


def _stamped(values: List[Any]) -> List[Any]:
    """One Arrow column, with the guards decided **once** for the column."""
    sample = next((value for value in values if value is not None), None)
    if isinstance(sample, datetime):
        if sample.tzinfo is not None:
            return values
        return [instants.utc(value) for value in values]
    if isinstance(sample, float):
        return [store.finite(value) for value in values]
    return values


__all__ = [
    'PortfolioReader', 'ALLOWED_INTERVALS',
    'chart_window', 'CHART_WINDOWS',
    'P1_COLUMNS', 'PERF_COLUMNS',
]
