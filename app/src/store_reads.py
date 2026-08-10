"""The store's read primitives for the web UI (issue #700, heir of #659).

The module ``influx_reads.py`` became when its subject moved. What it was built
to protect is unchanged and is the reason it is still a module of its own rather
than a handful of queries in the blueprint: **the error contract**. The
scheduler's own reads end in ``except: return None``, which is right for a
backfill surviving a flaky query and wrong for a UI, where it makes *"the
database is unreachable"* and *"you own nothing yet"* the same screen. Here
query errors **propagate**, and :mod:`web.problem` turns them into ``503`` +
``application/problem+json``.

Four things changed with the store, and each of them removed a defence rather
than moving it:

* **P1 is a join, not a window.** ``position ⋈ symbol_quote`` — one row per
  ``(account, symbol)`` beside the newest observation of that symbol, measured
  at 0,43 ms against 25,4 ms for the ``ROW_NUMBER()`` scan of the whole price
  series it replaces. Still **no time window**: "current" is absolute (#652
  déc. 1), so a long market closure does not blank the page.
* **Absence is structural again.** In InfluxDB a measurement — and a column —
  came into being on its first write, so *"never written"* and *"the query
  failed"* arrived down the same channel and had to be told apart by matching an
  error message (``_ABSENT_SCHEMA``). The store declares its twelve tables at
  creation and an unwritten column reads as ``NULL`` (ADR-0001), so naming
  fields in a ``SELECT`` is safe and the three states of absence — ``200``+
  ``null``, ``200``+``[]``, ``503`` — are shapes of the data rather than
  exception handling. With it goes the window #696 left open: an install whose
  measurement did not exist yet answered ``503`` where it owed ``200`` + ``[]``.
* **A price has no account.** The ``COALESCE(account, 'default')`` shim and the
  whole of ``influx_sql.py`` die with the column they rescued.
* **A wide read crosses Arrow.** ``TIMESTAMPTZ`` costs 8× at the Python frontier
  in rows and nothing in Arrow (spec #695 § 1), so the series primitives fetch
  columns and turn them into lists in one vectorised call each — see
  :meth:`Store.arrow`. The narrow reads (one row, a handful of accounts) stay
  tuples, where the frontier is not the cost.
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

import store

#: What P1 hands back per ``(account, symbol)``. The position's own columns, the
#: instrument's attributes, and the newest observation — named as the store
#: names them, since there is no longer a second vocabulary to translate into.
POSITION_COLUMNS = (
    'account', 'symbol', 'name',
    'quantity', 'cost_basis', 'realized_gain', 'received_dividend',
)
QUOTE_COLUMNS = (
    'currency', 'exchange', 'quote_type',
    'dividend_yield', 'pe_ratio', 'market_cap',
)
#: The two ``latest`` columns, renamed on the way out: what the page means by
#: "the price" is the newest observed one, and the ``last_`` prefix is a fact
#: about the row it is stored on rather than about the figure.
PRICE_COLUMNS = ('price', 'price_time')

P1_COLUMNS = POSITION_COLUMNS + QUOTE_COLUMNS + PRICE_COLUMNS

#: The seven value columns of the two perf series, plus the day they describe.
PERF_COLUMNS = (
    'day', 'cash_balance', 'holdings_value', 'total_value', 'net_contributed',
    'xirr', 'gain_absolu', 'twr_index',
)


class PortfolioReader:
    """The read primitives the pages need, and nothing else.

    Takes the open :class:`store.Store` rather than an executor: there is one
    connection in this process (DuckDB refuses a second), it is opened in
    ``post_fork``, and a reader is built per request out of it — which costs
    nothing, since it holds a reference and no state.
    """

    def __init__(self, store):
        self._store = store

    # ------------------------------------------------------------------ #
    # P1 — the position beside the newest observation of its symbol
    # ------------------------------------------------------------------ #

    def positions(self, symbol: Optional[str] = None) -> List[Dict[str, Any]]:
        """One row per ``(account, symbol)``: the position, joined to its quote.

        The workhorse. ``symbol=None`` is the whole portfolio in one query — the
        shares table *and* the dashboard's allocation and movers share it and
        share one client cache (#652 déc. 8); passing a symbol narrows it to the
        detail sheet.

        A **LEFT** join, and that is the interesting half. A position whose
        symbol has never been fetched is a row with every market column
        ``NULL``: a fresh install between its first import and its first scrape,
        and a position held with no observable price — one of the three shapes
        the developer's own portfolio cannot produce (#695 Further Notes). An
        inner join would answer *"you own nothing"* to someone who has just
        declared everything they own.

        Aggregation deliberately stays **out** of the SQL. Grafana ``SUM``s the
        per-account rows away inside the query, which is exactly why no panel of
        the baseline can show the breakdown; returning the rows is what lets
        :mod:`portfolio_view` compute the totals *and* keep the detail.
        """
        where = 'WHERE p.symbol = ?' if symbol is not None else ''
        parameters = [symbol] if symbol is not None else None
        selected = [f'p.{name}' for name in POSITION_COLUMNS]
        selected += [f'q.{name}' for name in QUOTE_COLUMNS]
        selected += ['q.last_price_native', 'q.last_price_ts']
        rows = self._store.query(
            f'SELECT {", ".join(selected)} '
            '  FROM position p '
            '  LEFT JOIN symbol_quote q ON q.symbol = p.symbol '
            f' {where} '
            ' ORDER BY p.symbol, p.account', parameters)
        return [_stamp(dict(zip(P1_COLUMNS, row))) for row in rows]

    # ------------------------------------------------------------------ #
    # The price series behind the chart
    # ------------------------------------------------------------------ #

    def raw_series(self, symbol: str, start: Optional[datetime] = None,
                   stop: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """Every stored price of a symbol in ``[start, stop]``, oldest first.

        Queried by symbol alone, which is no longer a rule to remember: there is
        no account column to forget. Gaps are **returned as gaps** — a
        non-trading day is by design (#606) and whether to bridge it is the
        chart's call, not the API's.
        """
        clauses, parameters = _window('ts', start, stop)
        return self._series(
            'SELECT ts, price_native FROM price_point '
            f' WHERE symbol = ? AND price_native IS NOT NULL{clauses}'
            ' ORDER BY ts',
            [symbol] + parameters, ('t', 'price'))

    def bucketed_series(self, symbol: str, interval: str,
                        start: Optional[datetime] = None,
                        stop: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """The same series, downsampled to the last price of each bucket.

        It survives the move for **one** reason and it is a new one: the
        browser. Five years of a symbol is still tens of thousands of points
        after the retention ladder (#705), which is fifty times what a chart
        carries — so the threshold is a budget of pixels, no longer a cost of
        materialisation.

        ``interval`` reaches SQL as a literal and is therefore **whitelisted**,
        never escaped: :func:`bucket_for_window` is its only caller and picks
        from a closed set.

        Takes the **last** price of each bucket, the same survivor rule
        :func:`quotes.price_series` and the ladder use, so the three agree
        wherever they overlap. An empty bucket produces no row: the gap survives
        downsampling.
        """
        if interval not in ALLOWED_INTERVALS:
            raise ValueError(f"Unsupported bucket interval: {interval!r}")

        clauses, parameters = _window('ts', start, stop)
        return self._series(
            "SELECT bucket, price_native FROM ("
            f"  SELECT time_bucket(INTERVAL '{interval}', ts) AS bucket,"
            "         price_native,"
            "         ROW_NUMBER() OVER ("
            f"             PARTITION BY time_bucket(INTERVAL '{interval}', ts)"
            "             ORDER BY ts DESC) AS rn"
            "    FROM price_point"
            f"   WHERE symbol = ? AND price_native IS NOT NULL{clauses}"
            ") WHERE rn = 1 ORDER BY bucket",
            [symbol] + parameters, ('t', 'price'))

    def prices_at(self, moment: datetime) -> List[Dict[str, Any]]:
        """Each symbol's last price at or **before** ``moment``, with its instant.

        The movers block's baseline, and the "≤" is the whole of it: *the exact
        instant never exists*. Prices land every 120 s during a session and not
        at all outside one, and a weekend is a legitimate hole (#606) — a query
        for the price *at* an instant answers nothing almost always, while a
        query for the last one before it answers what a human means by "its
        price then".

        One query for the whole portfolio, for the arithmetic that made #652
        déc. 8 generalise P1: N symbols would otherwise be N round trips to fill
        one screen.

        A symbol with nothing stored that early is simply **absent** from the
        result — that is absence, not zero, and rendering it as zero would put a
        spectacular fake move on screen.

        The instant rides along because the page needs it: the cut is a *rule*
        and the newest instant found at or before it is the close the comparison
        actually rests on. Labelling the block with the cut announced a session
        that had not happened yet.
        """
        return self._series(
            'SELECT symbol, price_native, ts FROM ('
            '  SELECT symbol, price_native, ts,'
            '         ROW_NUMBER() OVER ('
            '             PARTITION BY symbol ORDER BY ts DESC) AS rn'
            '    FROM price_point'
            '   WHERE price_native IS NOT NULL AND ts <= ?'
            ') WHERE rn = 1 ORDER BY symbol',
            [moment], ('symbol', 'price', 't'))

    def daily_closes(self, start: Optional[datetime] = None,
                     stop: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """``{day, symbol, price}`` — every symbol's closing price, per day.

        The valuation curve's price half. The reduction to one row per
        ``(day, symbol)`` is SQL's job and not the caller's: during a session a
        symbol is written every 120 s, so summing raw points multiplies the
        portfolio by its own polling rate — a valuation curve that tracks market
        *opening hours*.

        What it deliberately does **not** carry is the position. Those fields
        rode the price point in v4 and that is precisely the sharing this ticket
        ends: a market observation says nothing about who held what. The holding
        of a given day comes from the replay, and the two are folded together in
        :func:`portfolio_view.valuation_series`.
        """
        clauses, parameters = _window('ts', start, stop)
        return self._series(
            'SELECT day, symbol, price FROM ('
            '  SELECT CAST(ts AS DATE) AS day, symbol, price_native AS price,'
            '         ROW_NUMBER() OVER ('
            '             PARTITION BY CAST(ts AS DATE), symbol'
            '             ORDER BY ts DESC) AS rn'
            '    FROM price_point'
            f'   WHERE price_native IS NOT NULL{clauses}'
            ') WHERE rn = 1 ORDER BY day, symbol',
            parameters, ('day', 'symbol', 'price'))

    # ------------------------------------------------------------------ #
    # The two perf series behind the dashboard and the accounts page
    # ------------------------------------------------------------------ #

    def latest_totals(self) -> Optional[Dict[str, Any]]:
        """The newest ``portfolio_totals`` point, or ``None`` when there is none.

        The fields are **named** rather than starred, which is the change
        ADR-0001 buys: three of the seven are written only when computable, and
        in InfluxDB a field never written was a column that did not exist — so
        naming it turned *"this portfolio has no deposits"* into a query error
        and, since #696, into a ``503`` that took the whole head with it. Here an
        unwritten column is ``NULL``.

        No time window, per #652 déc. 1: the series is written one point a day,
        so any window narrow enough to be useful is also narrow enough to blank
        the dashboard.
        """
        rows = self._store.query(
            f'SELECT {", ".join(PERF_COLUMNS)} FROM portfolio_totals '
            ' ORDER BY day DESC LIMIT 1')
        return _stamp(dict(zip(PERF_COLUMNS, rows[0]))) if rows else None

    def total_value_at(self, moment: datetime) -> Optional[float]:
        """The global total value on the last day at or **before** ``moment``.

        The head's relative delta (#652 déc. 2). Same "≤" rule as
        :meth:`prices_at` and for a sharper reason: the series carries one point
        a *day*, so a query for the value *at* an instant answers nothing
        whenever the instant is not midnight.

        ``None`` when nothing was written that early — absence, not zero. A
        portfolio that did not exist yet has no value, and rendering that as
        ``0`` would put a spectacular fake gain on screen.
        """
        rows = self._store.query(
            'SELECT total_value FROM portfolio_totals '
            ' WHERE total_value IS NOT NULL AND day <= CAST(? AS DATE) '
            ' ORDER BY day DESC LIMIT 1', [moment])
        return rows[0][0] if rows else None

    def totals_series(self, start: Optional[datetime] = None,
                      stop: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """The global perf series over ``[start, stop]``, oldest day first.

        Not bucketed, unlike the price series: one point per calendar day means
        five years is ~1 800 rows and there is nothing to downsample. The same
        fact is why a one-day preset is degenerate on this chart.
        """
        clauses, parameters = _window('day', start, stop, as_date=True)
        return self._series(
            f'SELECT {", ".join(PERF_COLUMNS)} FROM portfolio_totals '
            f' WHERE TRUE{clauses} ORDER BY day', parameters, PERF_COLUMNS)

    def latest_account_metrics(self) -> List[Dict[str, Any]]:
        """The newest point of **every** account, in one query.

        P1's argument applied to a second table: N accounts is N round trips to
        fill one screen otherwise.

        "Latest" means the latest **day**, and today's point is rewritten in
        place through the day as prices move — which is why the page polls this
        rather than treating it as settled.
        """
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
        """One account's perf series over ``[start, stop]``, oldest day first.

        Two consumers, which is why it is one primitive: the TWR chart reads
        ``twr_index`` from N of these in parallel, and an account's detail sheet
        reads cash / holdings / contributed from the one it opened.
        """
        clauses, parameters = _window('day', start, stop, as_date=True)
        return self._series(
            f'SELECT {", ".join(PERF_COLUMNS)} FROM account_metrics '
            f' WHERE account = ?{clauses} ORDER BY day',
            [account] + parameters, PERF_COLUMNS)

    # ------------------------------------------------------------------ #
    # The Arrow frontier
    # ------------------------------------------------------------------ #

    def _series(self, sql: str, parameters: Optional[Sequence[Any]],
                names: Sequence[str]) -> List[Dict[str, Any]]:
        """Run a wide read and turn its columns into rows, through Arrow.

        The one place the frontier is crossed. Each column is converted in a
        single vectorised call and the rows are zipped afterwards, which is what
        makes an instant cost nothing to materialise: the 8× penalty
        ``TIMESTAMPTZ`` carries is paid per *object*, and Arrow builds none.

        The UTC guard is applied **per column and not per cell**, which is the
        other half of that: walking every value through a Python function is the
        very cost the frontier was moved to avoid. The store's session is pinned
        to UTC (:func:`store.prepare`), so a naive instant is a fault rather than
        a shape — one sample answers for the column, and the slow path only runs
        where there is something to repair.
        """
        table = self._store.arrow(sql, parameters)
        columns = [_stamped(table.column(index).to_pylist())
                   for index in range(table.num_columns)]
        return [dict(zip(names, values)) for values in zip(*columns)]


#: The bucket widths :func:`bucket_for_window` may choose. A closed set on
#: purpose: the value reaches SQL as a literal, so it must never come from a
#: request.
ALLOWED_INTERVALS = ('5 minutes', '30 minutes', '1 hour', '6 hours', '1 day')


def bucket_for_window(span_days: float) -> Optional[str]:
    """Pick a bucket width for a window, or ``None`` to serve it raw.

    Pure, so the choice is testable without a database. The thresholds aim at
    one to three thousand points on the wire — enough that a line is faithful,
    few enough that it stays interactive.
    """
    if span_days <= 7:
        return None
    if span_days <= 31:
        return '30 minutes'
    if span_days <= 120:
        return '1 hour'
    if span_days <= 400:
        return '6 hours'
    return '1 day'


def _window(column: str, start: Optional[datetime],
            stop: Optional[datetime], as_date: bool = False) -> tuple:
    """Render the optional ``[start, stop]`` bounds as predicates + parameters.

    Bound values are **parameters**, never literals. v4 formatted them into the
    SQL because InfluxDB 3's client took a string; DuckDB binds, so the whole
    ``utc_z`` / ``escape_literal`` apparatus of ``influx_sql.py`` — and the
    bare-UTC-Z literal trap it existed for — goes with it.

    ``as_date`` is the store's two kinds of time meeting the API's one. A window
    always arrives as an **instant** — the route parses ISO-8601 and defaults
    ``from`` to ``now − 365 days``, which is never midnight — while the perf
    series is keyed by **day**. Compared raw, DuckDB widens the ``DATE`` to
    midnight and ``day >= 2025-08-10T14:23Z`` drops 2025-08-10 entirely: the
    curve silently starts one day after the window it prints in its own
    ``from``. The cast is where the two are reconciled, once, rather than at
    each call site.
    """
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
    """Make one row safe to hand out. For a handful of rows.

    Two guards, and the second is not about time: **JSON has no NaN**, so a
    fundamental yfinance never had reaches ``jsonify`` as a bare ``NaN`` token —
    which Python's own parser accepts and a browser's ``JSON.parse`` refuses, so
    the page gets a ``200`` whose body it cannot read. :func:`store.finite` is
    the one rule, applied here as the last line of defence over rows that were
    stored before the writers had it.
    """
    return {key: store.finite(_stamp_value(value))
            for key, value in row.items()}


def _stamped(values: List[Any]) -> List[Any]:
    """One Arrow column, with the guards decided **once** for the column.

    A column is one type, so *which* guard it needs is a property of the column
    and not of each of its cells. Deciding per cell would put a Python call on
    every value of a series read — the cost :meth:`Store.arrow` exists to
    remove — so a sample answers for the column and the slow path runs only
    where there is something to repair.
    """
    sample = next((value for value in values if value is not None), None)
    if isinstance(sample, datetime):
        if sample.tzinfo is not None:
            return values
        return [_stamp_value(value) for value in values]
    if isinstance(sample, float):
        return [store.finite(value) for value in values]
    return values


def _stamp_value(value: Any) -> Any:
    """Naive means UTC here. One rule, applied at the read layer's exit.

    The store is pinned to UTC (:func:`store.prepare`) so an aware value is what
    comes back, but a naive instant reaching the wire is read by ``new Date()``
    as *local* time and shifts every timestamp on the page by the browser's
    offset — a defect that is invisible on a machine in UTC and only in UTC.
    """
    if isinstance(value, datetime) and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


__all__ = [
    'PortfolioReader', 'bucket_for_window', 'ALLOWED_INTERVALS',
    'P1_COLUMNS', 'PERF_COLUMNS',
]
