"""InfluxDB read primitives for the web UI (issue #659, design #655).

A **sibling** of ``influxdb_writer.py``, not a growth of it, and the reason is
the error contract. The writer's five reads are scheduler anchors: each ends in
``except Exception: logger.error(...); return None``, which is right for a
backfill that must survive a flaky query and wrong for a UI, where it makes "the
database is dead" and "you own nothing yet" render identically. Here **query
errors propagate** and absence is a distinct, typed state.

The module is the *for-keeps* half of the prototype. What is expensive in it is
not the transport — a route that calls a primitive and ``jsonify``s is five
lines — it is the traps of the `data-contract inventory
<https://github.com/pbrissaud/suivi-bourse/issues/650>`_ that each query has to
keep honouring. They are named at their call sites below.

Two boundaries the design leans on:

* **One injection point.** :class:`PortfolioReader` takes a ``query(sql) -> table``
  executor, not a client. The connected ``InfluxDBClient3`` is created in
  ``post_fork`` (issue #651); the reader receives its ``query`` bound method. A
  fake that records the SQL then tests every primitive, including that they all
  route through :mod:`influx_sql`.
* **pandas stays inside.** Primitives convert to plain ``list[dict]`` before
  returning, and that conversion is where NaN becomes ``None`` — pandas hands
  back NaN for any absent field, NaN is a float that passes ``is not None``, and
  JSON has no NaN at all. Letting it out would push pandas' semantics into the
  pure view module and its tests, killing exactly what makes ``scheduling.py``
  and ``performance.py`` pleasant to test.
"""
import os
import re
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from logfmt_logger import getLogger

from influx_sql import escape_literal, is_valid_number, utc_z

LOG_LEVEL = (os.getenv('LOG_LEVEL') or '').strip() or 'INFO'
logger = getLogger("influx_reads", level=LOG_LEVEL)

MEASUREMENT = "portfolio_metrics"

#: Fields carried by every live point, read as one coherent observation.
#:
#: ``write_metrics`` writes all of these on the same point, and its callers only
#: invoke it once the quote fetch succeeded — so a live point always carries a
#: price *and* the position fields *and* whatever fundamentals yfinance supplied.
#: That is what lets P1 be a single window function rather than one
#: last-non-null pass per field.
_POINT_FIELDS = (
    'share_price',
    'purchased_quantity',
    'purchased_price',
    'purchased_fee',
    'owned_quantity',
    'received_dividend',
    'dividend_yield',
    'pe_ratio',
    'market_cap',
)

#: Tags carried alongside. ``share_name`` is here as a *display* attribute:
#: trap 9 — every Grafana panel keys on it, so renaming a share splits its
#: history in two even though the symbol, and the series, are continuous. The
#: read layer keys on ``share_symbol`` and lets the newest point supply the name.
_POINT_TAGS = (
    'share_symbol',
    'share_name',
    'share_currency',
    'share_exchange',
    'quote_type',
)

#: An InfluxDB 3 measurement exists only once a point has been written to it, and
#: a tag column only once a point carried that tag. Querying either before the
#: first write is not a failure, it is a **fresh install** — the "empty
#: collection" state, which must be ``[]`` and never a 503. Matched on the
#: message because the client raises a generic exception for both.
_ABSENT_SCHEMA = re.compile(
    r"(table|schema) .*not found|no field named|does not exist", re.IGNORECASE)


class PortfolioReader:
    """The read primitives the Shares slice needs, and nothing else.

    Args:
        query: the executor, ``query(sql) -> arrow table``. In production this
            is ``InfluxDBWriter._client.query`` bound with ``language="sql"``;
            :func:`from_writer` builds that binding.
    """

    def __init__(self, query: Callable[[str], Any]):
        self._query = query

    @classmethod
    def from_writer(cls, writer) -> 'PortfolioReader':
        """Build a reader over an already-connected :class:`InfluxDBWriter`.

        The client is a connection pool created on the far side of the fork, so
        the reader borrows it rather than opening a second one — one process,
        one pool (issue #651).
        """
        def _execute(sql: str):
            if writer._client is None:
                writer.connect()
            return writer._client.query(query=sql, language="sql")

        return cls(_execute)

    # ------------------------------------------------------------------ #
    # Execution boundary — pandas in, list[dict] out
    # ------------------------------------------------------------------ #

    def _rows(self, sql: str) -> List[Dict[str, Any]]:
        """Run ``sql`` and return plain rows, NaN normalised to ``None``.

        The only place pandas is touched. Errors propagate — with the single
        exception of a measurement or column that does not exist yet, which is
        a fresh install rather than a fault (see :data:`_ABSENT_SCHEMA`).
        """
        try:
            table = self._query(sql)
        except Exception as exc:
            if _ABSENT_SCHEMA.search(str(exc)):
                logger.debug(f"No data written yet, returning empty: {exc}")
                return []
            raise

        if table is None or len(table) == 0:
            return []

        df = table.to_pandas()
        rows: List[Dict[str, Any]] = []
        for record in df.to_dict('records'):
            rows.append({key: _normalise(value) for key, value in record.items()})
        return rows

    # ------------------------------------------------------------------ #
    # P1 — the newest point per (share_symbol, account)
    # ------------------------------------------------------------------ #

    def latest_per_account(
        self, share_symbol: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Newest observation per ``(share_symbol, account)``.

        The workhorse: eight of Grafana's per-share stats are this shape, and
        #652 déc. 8 generalised it to *all symbols in one call* so the shares
        table and the dashboard's allocation + movers block share one query and
        one cache entry. ``share_symbol=None`` is that generalised form; passing
        one narrows it to a single share for the detail sheet.

        Aggregation deliberately stays **out** of the SQL. Grafana's panels
        ``SUM`` the per-account rows away inside the query, which is why no
        dashboard can show the breakdown; returning the rows is what lets
        :mod:`portfolio_view` compute the weighted mean *and* keep the
        per-account detail the sheet displays.

        Traps honoured here:

        * **1** — partitioned on ``COALESCE(account, 'default')``, so points
          written before the account tag existed count as ``default`` instead
          of forming a phantom ``NULL`` bucket.
        * **6** — no time window. #652 déc. 1 made "current" absolute: a stat
          reads the newest known point, full stop, and the window drives charts
          only. A market closed for a long weekend no longer blanks the page.
        * **7** — no per-field lookback either, and none is needed: the
          fundamentals ride the same point as the price. A field yfinance never
          supplies for a ticker (an ETF has no P/E) is absent from *every* row,
          and ``None`` is then the honest answer rather than a gap to paper over.

        Returns:
            One dict per ``(symbol, account)`` with the tags, ``time`` and the
            nine fields. Empty when nothing has been written yet.
        """
        where = ["share_price IS NOT NULL"]
        if share_symbol is not None:
            where.append(f"share_symbol = '{escape_literal(share_symbol)}'")

        columns = ", ".join(
            [t for t in _POINT_TAGS if t != 'share_symbol'] + list(_POINT_FIELDS))

        sql = f"""
        SELECT share_symbol, account, time, {columns}
        FROM (
            SELECT share_symbol, COALESCE(account, 'default') AS account, time,
                   {columns},
                   ROW_NUMBER() OVER (
                       PARTITION BY share_symbol, COALESCE(account, 'default')
                       ORDER BY time DESC) AS rn
            FROM "{MEASUREMENT}"
            WHERE {' AND '.join(where)}
        ) WHERE rn = 1
        ORDER BY share_symbol, account
        """
        return self._rows(sql)

    # ------------------------------------------------------------------ #
    # P3 — the price series behind the chart
    # ------------------------------------------------------------------ #

    def raw_series(
        self,
        share_symbol: str,
        start: Optional[datetime] = None,
        stop: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """Every stored price of a symbol in ``[start, stop]``, oldest first.

        🔒 Queried by ``share_symbol`` **only**, never by account — the same
        rule ``get_price_series`` carries: a market price belongs to no account,
        and pre-v4.1 points have ``account = NULL``, so any account filter
        silently truncates the history.

        A share held in two accounts is written twice per cycle, at two
        near-identical timestamps with the same price, so the rows are collapsed
        to one price per instant. Gaps are **returned as gaps** — non-trading
        days are by design (#606) and the chart, not the API, decides whether to
        bridge them (``connectNulls`` is a per-series prop, and #650's trap 5
        notes the two dashboards disagree about it on purpose).
        """
        where = [
            f"share_symbol = '{escape_literal(share_symbol)}'",
            "share_price IS NOT NULL",
        ]
        where += _window_clauses(start, stop)

        sql = f"""
        SELECT DISTINCT time, share_price
        FROM "{MEASUREMENT}"
        WHERE {' AND '.join(where)}
        ORDER BY time
        """
        return self._rows(sql)

    def bucketed_series(
        self,
        share_symbol: str,
        interval: str,
        start: Optional[datetime] = None,
        stop: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """The same price series, downsampled to the last price of each bucket.

        Not in the ticket's scope list, and it is here because the arithmetic of
        the raw one forces it rather than because a page asked: a ``REGULAR``
        cadence of 120 s over a 6.5-hour session is ~200 points a day, so a
        five-year window is a quarter of a million points on the wire and in the
        chart. ``raw_series`` stays the honest primitive for a short window; this
        is what a long one uses.

        ``interval`` is a SQL interval literal (``'1 day'``, ``'1 hour'``) and is
        **not** interpolated from user input — see :func:`bucket_for_window`,
        which is the only caller and picks from a fixed set.

        Takes the *last* price of each bucket, matching ``get_price_series``'s
        daily-close rule, so the two agree wherever they overlap. An empty
        bucket produces no row: the gap survives downsampling (#606).
        """
        if interval not in _ALLOWED_INTERVALS:
            raise ValueError(f"Unsupported bucket interval: {interval!r}")

        where = [
            f"share_symbol = '{escape_literal(share_symbol)}'",
            "share_price IS NOT NULL",
        ]
        where += _window_clauses(start, stop)

        sql = f"""
        SELECT time, share_price FROM (
            SELECT DATE_BIN(INTERVAL '{interval}', time) AS time,
                   share_price,
                   ROW_NUMBER() OVER (
                       PARTITION BY DATE_BIN(INTERVAL '{interval}', time)
                       ORDER BY time DESC) AS rn
            FROM "{MEASUREMENT}"
            WHERE {' AND '.join(where)}
        ) WHERE rn = 1
        ORDER BY time
        """
        return self._rows(sql)


#: The bucket widths :func:`bucket_for_window` may choose. Closed set on purpose:
#: the value reaches SQL as a literal, so it must never come from a request.
_ALLOWED_INTERVALS = ('5 minutes', '30 minutes', '1 hour', '6 hours', '1 day')


def bucket_for_window(span_days: float) -> Optional[str]:
    """Pick a bucket width for a window, or ``None`` to serve it raw.

    Pure, so the choice is testable without a database. The thresholds aim at
    roughly one to three thousand points on the wire — enough that a line chart
    is faithful, few enough that it stays interactive.
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


def _window_clauses(start: Optional[datetime], stop: Optional[datetime]) -> List[str]:
    """Render the optional ``[start, stop]`` bounds as SQL predicates."""
    clauses = []
    if start is not None:
        clauses.append(f"time >= '{utc_z(start)}'")
    if stop is not None:
        clauses.append(f"time <= '{utc_z(stop)}'")
    return clauses


def _normalise(value: Any) -> Any:
    """Make one pandas cell safe to hand out: NaN becomes ``None``, times UTC.

    ``is_valid_number`` is shared with the writer for a reason — it is the same
    NaN-is-not-absence problem seen from the other side. The writer skips the
    field; the reader reports it as ``None``, which #655's three-state table
    calls *absent by design*.
    """
    if value is None:
        return None
    if hasattr(value, 'to_pydatetime'):
        value = value.to_pydatetime()
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, float) and not is_valid_number(value):
        return None
    # numpy scalars answer .item(); plain Python values do not.
    if hasattr(value, 'item') and not isinstance(value, (str, bytes)):
        try:
            value = value.item()
        except (ValueError, AttributeError):
            return value
        return value if is_valid_number(value) or not isinstance(value, float) else None
    return value


__all__ = ['PortfolioReader', 'bucket_for_window', 'MEASUREMENT']
