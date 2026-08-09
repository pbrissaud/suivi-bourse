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
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from logfmt_logger import getLogger

from influx_sql import escape_literal, is_valid_number, utc_z

LOG_LEVEL = (os.getenv('LOG_LEVEL') or '').strip() or 'INFO'
logger = getLogger("influx_reads", level=LOG_LEVEL)

MEASUREMENT = "portfolio_metrics"

#: The global perf series (issue #660). Untagged on purpose — trap 4: a
#: synthetic ``account`` tag would double every ``SUM()`` over
#: ``account_metrics``, so the *global* figures are read from here and are never
#: derived by summing the per-account series.
TOTALS_MEASUREMENT = "portfolio_totals"

#: The per-account perf series (issue #661). The same seven fields as
#: :data:`TOTALS_MEASUREMENT`, tagged ``account`` / ``account_type`` /
#: ``account_currency``, one point per calendar day at midnight.
ACCOUNT_MEASUREMENT = "account_metrics"

#: What a ``portfolio_totals`` row carries. Documentation and a whitelist — not
#: a SELECT list; :meth:`latest_totals` explains why the query is ``SELECT *``.
TOTALS_FIELDS = (
    'cash_balance',
    'holdings_value',
    'total_value',
    'net_contributed',
    'xirr',
    'gain_absolu',
    'twr_index',
)

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

# ``_ABSENT_SCHEMA`` — the regular expression that read "this measurement was
# never written to" out of a query error and answered ``[]`` — is gone with
# #696. It existed because in InfluxDB 3 a measurement, and a column, come into
# being only on their first write, so absence and failure arrived down the same
# channel and had to be told apart by matching an error message. The store
# declares its twelve tables at creation and a column that was never written
# reads as ``NULL``, not as missing (ADR-0001), so the whole class of defensive
# "select only what exists" reading retires with it.


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

        The only place pandas is touched. Errors propagate, without exception
        since #696: the "measurement that does not exist yet" tolerance was the
        one place where a query *error* was read as an empty collection, and it
        left with :data:`_ABSENT_SCHEMA`. Absence is now a shape of the data —
        no rows, or a ``NULL`` column — never a raised exception.
        """
        table = self._query(sql)

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

    # ------------------------------------------------------------------ #
    # P6 — value_at: the last point at or before an instant (issue #660)
    # ------------------------------------------------------------------ #

    def value_at(
        self,
        measurement: str,
        field: str,
        t: datetime,
        filters: Optional[Dict[str, str]] = None,
    ) -> Optional[float]:
        """The value of ``field`` at ``t`` — meaning the **last point ≤ t**.

        The 6th primitive of #650's inventory, named by #652 déc. 2 and left
        unbuilt by the vertical slice. The "≤" is the whole of it: *the exact
        point never exists*. ``portfolio_totals`` is stamped at midnight, prices
        land every 120 s during a session and not at all outside one, and a
        weekend or a holiday is a legitimate hole (#606). A query for the point
        *at* an instant answers ``None`` almost always; a query for the last one
        before it answers what a human means by "its value then".

        Returns ``None`` when nothing was ever stored before ``t`` — which is
        absence, not zero: a portfolio that did not exist yet has no value, and
        rendering that as ``0`` would put a spectacular fake gain on screen.
        """
        rows = self._rows(self._last_before_sql(measurement, field, t, filters))
        return rows[0].get(field) if rows else None

    def values_at(
        self,
        measurement: str,
        field: str,
        t: datetime,
        partition_by: str,
        filters: Optional[Dict[str, str]] = None,
    ) -> List[Dict[str, Any]]:
        """:meth:`value_at` for every value of a tag, in **one** query.

        The movers block needs the previous session's close for the whole
        portfolio at once, and doing that as one ``value_at`` per symbol would
        be N round-trips to answer one screen — the same arithmetic that made
        #652 déc. 8 generalise P1. The rule is identical (last point ≤ ``t``);
        only the partitioning differs, which is why both shapes are built by
        :meth:`_last_before_sql` rather than by two SQL strings that would drift.
        """
        sql = self._last_before_sql(measurement, field, t, filters, partition_by)
        return self._rows(sql)

    def _last_before_sql(
        self,
        measurement: str,
        field: str,
        t: datetime,
        filters: Optional[Dict[str, str]],
        partition_by: Optional[str] = None,
    ) -> str:
        """Render the "last point ≤ t" rule, scalar or partitioned.

        ``measurement``, ``field`` and ``partition_by`` reach SQL as
        **identifiers**, and quote-doubling protects a string literal, not an
        identifier. So they are not escaped, they are *whitelisted*: a caller can
        only ask for a pair :data:`_VALUE_AT_TARGETS` names. Filter values, which
        do come from user-authored files, go through ``escape_literal``.
        """
        if (measurement, field) not in _VALUE_AT_TARGETS:
            raise ValueError(f"Unsupported value_at target: {measurement}.{field}")
        if partition_by is not None and partition_by not in _FILTERABLE_TAGS:
            raise ValueError(f"Unsupported partition: {partition_by!r}")

        where = [f"{field} IS NOT NULL", f"time <= '{utc_z(t)}'"]
        for tag, value in (filters or {}).items():
            where.append(_tag_clause(tag, value))
        predicate = ' AND '.join(where)

        if partition_by is None:
            return f"""
            SELECT {field}, time
            FROM "{measurement}"
            WHERE {predicate}
            ORDER BY time DESC
            LIMIT 1
            """

        return f"""
        SELECT {partition_by}, {field}, time FROM (
            SELECT {partition_by}, {field}, time,
                   ROW_NUMBER() OVER (
                       PARTITION BY {partition_by}
                       ORDER BY time DESC) AS rn
            FROM "{measurement}"
            WHERE {predicate}
        ) WHERE rn = 1
        ORDER BY {partition_by}
        """

    # ------------------------------------------------------------------ #
    # The global perf series behind the dashboard (issue #660)
    # ------------------------------------------------------------------ #

    def latest_totals(self) -> Optional[Dict[str, Any]]:
        """The newest ``portfolio_totals`` point, or ``None`` when there is none.

        ``SELECT *`` rather than a field list, and that is not laziness. Three of
        the seven fields are written **only when computable** — ``xirr`` and
        ``gain_absolu`` need an external flow, ``twr_index`` needs a non-zero
        valuation — and in InfluxDB 3 a field that was never written is a
        *column that does not exist*. Naming it in the SELECT would turn "this
        portfolio has no deposits" into a query error — and, since #696, into a
        ``503``: the entire head would vanish because one rate happened to be
        undefined. An absent field has to arrive as an absent key, and
        ``SELECT *`` is what delivers that.

        No time window, per #652 déc. 1 — "current" is absolute. It matters more
        here than on the shares page: the perf job is gated (#618) and a
        fully-closed market wave writes nothing at all, so any window narrow
        enough to be useful is also narrow enough to blank the dashboard.
        """
        rows = self._rows(
            f'SELECT * FROM "{TOTALS_MEASUREMENT}" ORDER BY time DESC LIMIT 1')
        return rows[0] if rows else None

    def totals_series(
        self,
        start: Optional[datetime] = None,
        stop: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """The global perf series over ``[start, stop]``, oldest first.

        Deliberately **not** bucketed, unlike :meth:`bucketed_series`: the series
        is written one point per calendar day at midnight, so five years is ~1800
        rows and there is nothing to downsample. The same fact is what makes a
        short preset degenerate on the dashboard's main chart — a "1 day" window
        holds one point — and why that chart offers months and years only.
        """
        where = _window_clauses(start, stop)
        predicate = f"WHERE {' AND '.join(where)}" if where else ""
        return self._rows(f"""
        SELECT * FROM "{TOTALS_MEASUREMENT}"
        {predicate}
        ORDER BY time
        """)

    # ------------------------------------------------------------------ #
    # The per-account perf series behind the accounts page (issue #661)
    # ------------------------------------------------------------------ #

    def latest_account_metrics(self) -> List[Dict[str, Any]]:
        """The newest ``account_metrics`` point of **every** account, in one query.

        P1's shape applied to a second measurement: one ``ROW_NUMBER()`` window
        answering the whole comparison table, rather than one ``value_at`` per
        declared account. Same arithmetic as #652 déc. 8 — N accounts is N round
        trips to fill one screen.

        ``SELECT *`` for :meth:`latest_totals`' reason, and it is the same fact
        seen per account: ``xirr`` and ``gain_absolu`` are written only once an
        external flow exists, ``twr_index`` only once the valuation is non-zero,
        and a field never written is a *column that does not exist*. Naming them
        would turn "this account has no deposits" into a query error, and so
        into a ``503`` — the whole table gone because one rate is undefined.

        **Trap 2** lives here rather than in the SQL: the series is daily and
        midnight-stamped, and *today's point is rewritten in place* through the
        day (#597 writes only the stale tail). "Latest" therefore means the
        latest **day**, and its value is expected to change under a client cache
        — which is why the front polls this rather than treating it as settled.

        Trap 1's ``COALESCE`` is deliberately **not** applied: unlike
        ``portfolio_metrics``, this measurement has carried its ``account`` tag
        since its first point (``write_account_metrics`` tags every point,
        defaulting the value itself), so there is no untagged generation to
        rescue and coalescing would only hide a genuinely malformed write.
        """
        rows = self._rows(f"""
        SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (
                       PARTITION BY account ORDER BY time DESC) AS rn
            FROM "{ACCOUNT_MEASUREMENT}"
        ) WHERE rn = 1
        ORDER BY account
        """)
        # The ranking column is an artefact of the window, not a field of the
        # series. `SELECT * EXCEPT` is not portable enough to lean on, so it is
        # dropped here — where the row is already being handled — rather than
        # leaking into the payload as a mystery integer.
        for row in rows:
            row.pop('rn', None)
        return rows

    def account_series(
        self,
        account: str,
        start: Optional[datetime] = None,
        stop: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """One account's perf series over ``[start, stop]``, oldest first.

        Two consumers, which is why it is one primitive: the TWR-by-account
        chart reads ``twr_index`` from N of these in parallel, and the account's
        detail sheet reads cash / holdings / contributed from the one it opened.
        A multi-series endpoint would have served the first and left the second
        to a second query — #655 weighed that and took the N calls, each cached
        on its own.

        Not bucketed, for :meth:`totals_series`' reason: one point per calendar
        day means five years is ~1800 rows, and there is nothing to downsample.

        The account filter goes through :func:`_tag_clause`, so the one rule
        about the ``account`` tag has one home even where — as here — the tag is
        never null.
        """
        where = [_tag_clause('account', account)]
        where += _window_clauses(start, stop)
        return self._rows(f"""
        SELECT * FROM "{ACCOUNT_MEASUREMENT}"
        WHERE {' AND '.join(where)}
        ORDER BY time
        """)

    def daily_position_series(
        self,
        start: Optional[datetime] = None,
        stop: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """One row per ``(day, share_symbol, account)``: the day's closing state.

        The source of the **degraded** main chart — valuation vs investment,
        #652 déc. 7's fallback for a portfolio with no declared accounts, which
        is what a default install is. It has to come from ``portfolio_metrics``
        because ``portfolio_totals`` does not exist without declared accounts.

        The trap is in the shape, not the fields: during a session a symbol is
        written every 120 s, so a plain ``SUM(owned_quantity * share_price)``
        grouped by day multiplies the portfolio by however many times it was
        polled — a valuation curve that tracks *market opening hours*. Hence the
        same ``ROW_NUMBER()`` as P1, one rank per ``(day, symbol, account)``,
        taking each series' last point of each day before anything is added up.

        Summing is deliberately left to :mod:`portfolio_view`: a symbol whose
        market was shut on a day the others traded simply has no row for it, and
        dropping it from that day's total would make the whole portfolio dip
        every time one exchange took a holiday. Forward-filling is the fix and it
        is pure logic, so it belongs where it can be tested with literal lists.
        """
        where = ["share_price IS NOT NULL"]
        where += _window_clauses(start, stop)

        return self._rows(f"""
        SELECT day, share_symbol, account, share_price, owned_quantity,
               purchased_quantity, purchased_price
        FROM (
            SELECT DATE_BIN(INTERVAL '1 day', time) AS day,
                   share_symbol, COALESCE(account, 'default') AS account,
                   share_price, owned_quantity,
                   purchased_quantity, purchased_price,
                   ROW_NUMBER() OVER (
                       PARTITION BY DATE_BIN(INTERVAL '1 day', time),
                                    share_symbol, COALESCE(account, 'default')
                       ORDER BY time DESC) AS rn
            FROM "{MEASUREMENT}"
            WHERE {' AND '.join(where)}
        ) WHERE rn = 1
        ORDER BY day, share_symbol, account
        """)


#: The ``(measurement, field)`` pairs :meth:`PortfolioReader.value_at` may be
#: asked for. A closed set because both halves land in SQL as identifiers, where
#: quote-doubling buys nothing — and because a primitive that can read *any*
#: field of *any* measurement is the generic query API #655 decision 6 rejected.
_VALUE_AT_TARGETS = frozenset({
    # The movers block: the previous session's close, per symbol.
    (MEASUREMENT, 'share_price'),
    # The head's relative delta ("+10 % since…"), #652 déc. 2.
    (TOTALS_MEASUREMENT, 'total_value'),
    (TOTALS_MEASUREMENT, 'net_contributed'),
    (TOTALS_MEASUREMENT, 'twr_index'),
})

#: Tags a filter or a partition may name — same identifier argument.
_FILTERABLE_TAGS = ('share_symbol', 'account')


def _tag_clause(tag: str, value: str) -> str:
    """One ``tag = value`` predicate, with trap 1 applied where it belongs.

    ``account`` is compared through ``COALESCE(account, 'default')`` because
    points written before v4.1 carry no account tag; every other tag is compared
    bare. Getting this wrong is invisible — the query succeeds and silently
    omits the pre-v4.1 half of the history.
    """
    if tag not in _FILTERABLE_TAGS:
        raise ValueError(f"Unsupported filter tag: {tag!r}")
    if tag == 'account':
        return f"COALESCE(account, 'default') = '{escape_literal(value)}'"
    return f"{tag} = '{escape_literal(value)}'"


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


__all__ = [
    'PortfolioReader', 'bucket_for_window',
    'MEASUREMENT', 'TOTALS_MEASUREMENT', 'ACCOUNT_MEASUREMENT', 'TOTALS_FIELDS',
]
