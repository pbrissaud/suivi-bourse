"""The market's own two tables: ``symbol_quote`` and ``price_point`` (issue #700).

Spec #695 § 3 / § 5 / § 7, ADR-0001, ADR-0007. The rule that generates the
schema is *declaration and derived state never share a row*, and this module is
one of its four writers — **the only** writer of these two tables. The
configuration path owns the events, the replay owns the position, the perf job
owns the series; what the *market* says is laid down here.

Three things about it are decisions rather than details.

**The price series has no account dimension.** A market price belongs to no
account, so any query joining prices *per account* was a bug — and the code
already said so without being listened to: ``get_price_series`` and
``raw_series`` queried by symbol alone while the writer wrote one point per
holding. The ``COALESCE(account, 'default')`` shim dies with the column it
rescued, and the row count falls by 25 % before any retention decision.

**Close only: no OHLC, no volume.** ``price_open`` / ``price_high`` /
``price_low`` were not dead columns, they were columns that **lied** — the live
writer set all three to the close on every point, so a candlestick drawn from
them showed a flat doji for every intraday bar the app ever wrote. A column that
is wrong is worse than one that is missing.

**One maintenance rule, written once, covering three cases.** ``symbol_quote``
is already one row per symbol, written by this module, refreshed at the same
instant — so it carries the ``last_*`` columns rather than a second table:

    any writer inserting a ``price_point`` whose ``ts >= last_price_ts``
    updates the ``last_*`` columns in the same transaction.

The live point, the forward pass and (from #704) the lateral pass all fall under
it. The invariant is **"the most recent point, whatever its completeness"** and
not "the most recent complete point" — the second spelling reintroduces the
per-field last-non-null pass the store exists to avoid.

**One watermark is stored, and only one** (issue #703). Backfill progress is
derived state and stays in process memory (spec #695 § 4) — with the single named
exception of ``oldest_window_tried``, the backward pass's anchor. The argument for
deriving a watermark is *it recomputes itself from the rows*, and that argument
falls exactly where a delisted symbol stands: it stores no row, so the anchor
computed from the series never moves and the same window is re-fetched every 60
seconds, for ever, in silence. The anchor is therefore the oldest window
**attempted**, and it is written here because ``symbol_quote`` is this module's
row and a second writer on it is the one thing the schema rule forbids.

The **fundamentals live here in current value only** (``dividend_yield`` /
``pe_ratio`` / ``market_cap``): yfinance supplies them on the live quote alone,
so their v4 "history" was a comb of ``NULL`` down the price series and nothing
ever read them as one.

And the **name of a share is not here**. It lives on ``position``, written by the
replay, because it comes from the owner's file and not from Yahoo — two accounts
may legitimately call the same line differently, and renaming a share no longer
cuts its history in two (spec #695 § 3).
"""
from datetime import date, datetime, timezone
from typing import Dict, Mapping, Optional, Sequence, Set, Tuple

from logfmt_logger import getLogger

import carrying
from store import finite

logger = getLogger("quotes")

#: What ``symbol_quote`` carries about the instrument, as opposed to about the
#: last observed price. One list, so the upsert below and whatever reads the row
#: cannot drift apart.
QUOTE_ATTRIBUTES = (
    'currency', 'exchange', 'quote_type',
    'dividend_yield', 'pe_ratio', 'market_cap',
)


def truncate(moment: datetime) -> datetime:
    """One instant, in UTC and truncated to the second.

    Kept from v4's ``WritePrecision.S`` and for the same reason it was chosen
    there: it is what makes re-writing a cycle idempotent. A range writer that
    deletes what it is about to insert lands on exactly the timestamps it
    replaces, instead of leaving a shadow copy a microsecond away that no
    ``DELETE`` bounded by the batch could ever find.
    """
    stamped = moment if moment.tzinfo is not None else moment.replace(
        tzinfo=timezone.utc)
    return stamped.astimezone(timezone.utc).replace(microsecond=0)


# --------------------------------------------------------------------------- #
# The maintenance rule — one sentence, one function
# --------------------------------------------------------------------------- #

def _advance_latest(store, symbol: str, ts: datetime,
                    price_native: Optional[float],
                    price_converted: Optional[float] = None,
                    fx_rate: Optional[float] = None) -> None:
    """Apply the ``latest`` maintenance rule for one inserted point.

    *Any writer inserting a ``price_point`` whose ``ts >= last_price_ts``
    updates the ``last_*`` columns in the same transaction.* The predicate is in
    the ``WHERE``, so a backward chunk — which is entirely older — updates
    nothing, and a forward chunk or a live point updates unconditionally.

    **The three price columns move together**, converted and rate included
    (issue #702). They are one observation, and carrying the newest native price
    beside a converted one from an earlier point would be exactly the per-field
    last-non-null row the store exists to avoid — with the added twist that the
    two would be a price and a *different* price wearing another unit.

    ``price_native`` may be ``NULL``, and so may the other two — that is the
    ordinary state while the reporting currency is unanswered or a rate could
    not be had. The invariant is *the most recent point*, not *the most recent
    point that has a price*; weakening it to the second means reading the row
    field by field again.

    Assumes the ``symbol_quote`` row exists — :func:`_ensure_row` is what the
    writers call first. The row is never created here so the function stays a
    statement of the rule and nothing else.
    """
    store.execute(
        'UPDATE symbol_quote '
        '   SET last_price_native = ?, last_price_converted = ?, '
        '       last_fx_rate = ?, last_price_ts = ? '
        ' WHERE symbol = ? '
        '   AND (last_price_ts IS NULL OR ? >= last_price_ts)',
        [price_native, price_converted, fx_rate, ts, symbol, ts])


def _ensure_row(store, symbol: str) -> None:
    """Make sure the symbol has a ``symbol_quote`` row, attributes or not.

    A backfill can reach a symbol the live scrape has never fetched (a position
    sold before this install existed), and the ``latest`` rule needs a row to
    update. The attributes stay ``NULL`` until a quote supplies them.

    Deliberately does **not** create the ``symbol`` row the foreign key points
    at: that table belongs to the configuration path, and a market writer
    inventing a declaration is exactly the two-writers-one-row the schema rule
    forbids. Every symbol these writers see came from the event ledger, so the
    row is there.
    """
    store.execute(
        'INSERT INTO symbol_quote (symbol) VALUES (?) '
        'ON CONFLICT (symbol) DO NOTHING', [symbol])


# --------------------------------------------------------------------------- #
# The live writer — appends, never rewrites its own timestamp
# --------------------------------------------------------------------------- #

def record_quote(store, symbol: str, moment: datetime,
                 price_native: Optional[float],
                 attributes: Optional[Mapping] = None,
                 price_converted: Optional[float] = None,
                 fx_rate: Optional[float] = None) -> None:
    """One live observation: a ``price_point`` appended, ``symbol_quote`` refreshed.

    The scrape's whole write, and it is **one call per symbol** rather than one
    per holding — there is nothing left on a market observation that belongs to
    an account.

    A plain ``INSERT``: the live writer adds and never rewrites its own
    timestamp, which is what lets ``price_point`` carry no key at all
    (ADR-0007). Two live points cannot collide, the poll cadence having a floor
    of ten seconds while the stamp is truncated to the second.

    ``attributes`` **replaces** what the row holds rather than merging into it —
    a fetch that came back without a currency is a fetch that no longer knows
    one, and keeping the old value would make the row claim an observation it
    did not make. Passing nothing therefore blanks them, which is what a caller
    holding only a price wants and never what the scrape does.

    ``price_converted`` / ``fx_rate`` are the conversion the *caller* performed
    (issue #702, ADR-0002), never one this module works out: the rate is a
    journal entry — the number that produced this figure — and a writer that
    looked one up here would be free to store a rate the price was not actually
    multiplied by. Both ``None`` is the ordinary state while the reporting
    currency is unanswered, or when the pair could not be resolved; the point
    still lands, with its native price, and #704's lateral pass repairs the
    column afterwards.

    Both statements plus the ``latest`` rule run in one transaction, and
    :meth:`store.Store.transaction` holds the connection for its duration — so
    no reader ever sees a point whose ``latest`` row has not caught up with it.
    """
    ts = truncate(moment)
    values = dict(attributes or {})
    native = finite(price_native)
    converted = finite(price_converted)
    rate = finite(fx_rate)

    refreshed = ('fetched_at',) + QUOTE_ATTRIBUTES
    assignments = ', '.join(f'{name} = excluded.{name}' for name in refreshed)
    with store.transaction():
        store.execute(
            f'INSERT INTO symbol_quote (symbol, {", ".join(refreshed)}) '
            f'VALUES (?{", ?" * len(refreshed)}) '
            f'ON CONFLICT (symbol) DO UPDATE SET {assignments}',
            [symbol, ts,
             *(finite(values.get(name)) for name in QUOTE_ATTRIBUTES)])
        store.execute(
            'INSERT INTO price_point '
            '  (symbol, ts, price_native, price_converted, fx_rate) '
            'VALUES (?, ?, ?, ?, ?)',
            [symbol, ts, native, converted, rate])
        _advance_latest(store, symbol, ts, native, converted, rate)


# --------------------------------------------------------------------------- #
# The range writer — deletes what it is about to insert
# --------------------------------------------------------------------------- #

def record_history(store, symbol: str, points: Sequence[Mapping]) -> int:
    """Write one fetched chunk of history. Returns how many points landed.

    ``points`` are ``{'timestamp': datetime, 'price': float}`` rows as the
    backfill fetched them, optionally carrying ``'converted'`` and ``'rate'``
    (issue #702) — the conversion the caller performed at the rate of the
    point's **own day**, which is why the rebuild fetches the pair's history
    beside the price history rather than converting a five-year-old close at
    today's rate. A point with neither lands with a ``NULL`` converted price.

    **Deletes its own span, then inserts.** That is where ``price_point``'s
    uniqueness lives now that the table carries no key (ADR-0007, spec #695 § 5),
    and the span is taken from the **batch** rather than from the window that was
    asked for. The difference is not stylistic: a ``DELETE`` bounded by the
    requested window removes points the fetch did not bring back, so a chunk that
    came back short after a Yahoo hiccup would silently erase the history it
    failed to re-supply. Bounded by the batch, the call can only remove rows
    inside the span it is re-supplying — which is what makes re-running the same
    cycle idempotent.

    What it can still replace, inside that span, is a *finer* point with a
    coarser one: a 120-second live point falling in an hour this chunk brings
    back as a single bar. The geometry of the two passes is what keeps that
    rare — the backward one works strictly before the oldest stored point, and
    the forward one only starts once the newest is a day old, which only a
    stopped live writer allows — and where it does happen the survivor is
    Yahoo's own bar for that hour rather than a point about the same hour.

    The delete and the insert are **one transaction**, and the store holds the
    connection for its whole length: a reader landing between them would see the
    span missing — a chart losing a year of history for the length of the write,
    and the perf job computing a daily total from the hole and persisting it.

    The ``latest`` rule is applied once, with the batch's newest instant: a
    backward chunk is entirely older and updates nothing, a forward chunk moves
    the row. And because the deleted span is the batch's own, a ``last_price_ts``
    inside it is always ≤ that newest instant — the rule cannot leave the
    ``latest`` row pointing at a row this call removed.
    """
    rows = []
    for point in points:
        price = point.get('price')
        if price is None:
            continue
        price = finite(float(price))
        if price is None:
            continue
        rows.append((symbol, truncate(point['timestamp']), price,
                     finite(point.get('converted')), finite(point.get('rate'))))
    if not rows:
        return 0

    oldest = min(row[1] for row in rows)
    newest = max(row[1] for row in rows)

    with store.transaction():
        _ensure_row(store, symbol)
        store.execute(
            'DELETE FROM price_point '
            ' WHERE symbol = ? AND ts >= ? AND ts <= ?',
            [symbol, oldest, newest])
        store.executemany(
            'INSERT INTO price_point '
            '  (symbol, ts, price_native, price_converted, fx_rate) '
            'VALUES (?, ?, ?, ?, ?)',
            rows)
        # The **last** row landing on the newest second, not the first: two
        # points can truncate to the same instant, and the survivor rule this
        # store follows everywhere else — the day's last point — is the one that
        # keeps the ``latest`` line agreeing with what a read of the series says.
        latest = [row for row in rows if row[1] == newest][-1]
        _advance_latest(store, symbol, newest, latest[2], latest[3], latest[4])

    logger.debug(f"Wrote {len(rows)} historical price(s) for {symbol}")
    return len(rows)


# --------------------------------------------------------------------------- #
# The backward pass's persisted anchor (issue #703)
# --------------------------------------------------------------------------- #

def record_window_tried(store, symbol: str, oldest: date) -> None:
    """Remember that the backward pass has attempted a window starting at ``oldest``.

    Written **only when a fetch completed** — empty or not. A fetch that failed
    has attempted nothing the app is entitled to skip: persisting it would let a
    Yahoo hiccup erase a year of a symbol's history for good, on a pass that has
    no second chance to notice.

    Moves the anchor **backwards only**, the same shape as
    :func:`_advance_latest` and for a symmetrical reason. The predicate is in the
    ``WHERE`` rather than in a read-then-write, so a ledger that grows a *later*
    first acquisition — an import forgotten, a file corrected — cannot walk the
    anchor forward and set the pass fetching ground it has already covered.
    """
    with store.transaction():
        _ensure_row(store, symbol)
        store.execute(
            'UPDATE symbol_quote '
            '   SET oldest_window_tried = ? '
            ' WHERE symbol = ? '
            '   AND (oldest_window_tried IS NULL OR ? < oldest_window_tried)',
            [oldest, symbol, oldest])


def oldest_window_tried(store, symbol: str) -> Optional[date]:
    """The oldest window the backward pass has attempted, or ``None``.

    A ``DATE``: a window boundary is a calendar day, not an observed instant
    (spec #695 § 3), and the two kinds of time are never mixed.
    """
    rows = store.query(
        'SELECT oldest_window_tried FROM symbol_quote WHERE symbol = ?',
        [symbol])
    return rows[0][0] if rows and rows[0][0] is not None else None


# --------------------------------------------------------------------------- #
# The reads the scheduler needs — anchors, and the sonde's one value
# --------------------------------------------------------------------------- #

def terminal_symbols(store, windows: Mapping[str, Tuple[date, Optional[date]]],
                     now: datetime) -> Set[str]:
    """Which symbols the backward pass has **finished** with — issue #706.

    The second term of the carrying predicate (ADR-0004), and it is read from the
    store rather than from the scheduler's ``_backfill_complete`` for the reason
    :func:`carrying.is_terminal` states: that dict is empty for the first cycle
    after every restart, so a convention hanging off it would flicker off and on
    at each boot with the figures moving under a reader who did nothing. The
    three inputs it is derived from — the ceiling, the oldest stored point and
    the oldest window tried — are all persisted, so the answer survives the
    process that produced it.

    ``windows`` is :meth:`main.ConfigSnapshot.backfill_windows`' output, and a
    symbol absent from it is absent from the answer: nothing was ever acquired,
    so there is no history to be finished with.

    **Two queries for the whole portfolio**, never two per symbol. Both consumers
    ask this about every symbol at once — the perf recompute over its whole
    replay, the shares page over its whole table — and the per-symbol reads
    :meth:`main.SuiviBourseMetrics._backward_anchor` makes are affordable only
    because the backfill visits one symbol at a time with a rate-limit sleep
    between them. The anchor itself is not re-derived here: it comes from
    :func:`carrying.backward_anchor`, the same function that per-symbol path
    calls.
    """
    if not windows:
        return set()

    oldest_stored = {
        symbol: _utc(value)
        for symbol, value in store.query(
            'SELECT symbol, min(ts) FROM price_point GROUP BY symbol')
        if value is not None
    }
    oldest_tried = {
        symbol: value
        for symbol, value in store.query(
            'SELECT symbol, oldest_window_tried FROM symbol_quote '
            ' WHERE oldest_window_tried IS NOT NULL')
    }

    finished = set()
    for symbol, (acquired, exited) in windows.items():
        target, ceiling = carrying.holding_bounds(acquired, exited, now)
        anchor = carrying.backward_anchor(
            ceiling, oldest_stored.get(symbol), oldest_tried.get(symbol))
        if carrying.is_terminal(anchor, target):
            finished.add(symbol)
    return finished


def first_quoted_days(store) -> Dict[str, date]:
    """``{symbol: first calendar day carrying a quote}`` — one query, whole store.

    The **first** term of the carrying predicate for every read that works off the
    price *series* rather than off a P1 row (issue #706). ``price_native``, never
    ``price_converted``: the question is whether a quote was ever observed, and a
    quote whose conversion has not landed is still a quote — a base currency not
    answered yet, or a pair that does not resolve, is *waiting for a rate* and not
    a security nobody prices. Reading the converted column here would carry those
    positions at cost, which is the one thing ``CONTEXT.md`` § Absence says the
    two states must never do: be rendered alike.

    One scalar per symbol is enough because the consumers forward-fill: a day is
    *quoted* from the first observation on, exactly as ``price_at`` carries the
    last close forward (:func:`carrying.was_quoted`). One ``GROUP BY`` for the
    whole portfolio, so the perf recompute and the history route each pay one
    read rather than one per symbol.
    """
    return {
        symbol: value
        for symbol, value in store.query(
            'SELECT symbol, min(CAST(ts AS DATE)) FROM price_point '
            ' WHERE price_native IS NOT NULL GROUP BY symbol')
        if value is not None
    }


def oldest_ts(store, symbol: str) -> Optional[datetime]:
    """The oldest stored instant of a symbol's series, or ``None``.

    The backward pass's anchor. Per **symbol**: the series it measures has no
    account dimension any more, so an anchor scoped per account would ask N
    times the same question and fetch the same window N times a cycle.
    """
    rows = store.query(
        'SELECT min(ts) FROM price_point WHERE symbol = ?', [symbol])
    return _utc(rows[0][0]) if rows and rows[0][0] is not None else None


def newest_ts(store, symbol: str) -> Optional[datetime]:
    """The newest **price-bearing** instant of a symbol's series, or ``None``.

    The forward pass's anchor. Price-bearing rather than merely newest, because
    the pass exists to fill *price* gaps: a newer point with a ``NULL`` price
    (which #702's currency work makes an ordinary state) would otherwise make it
    believe coverage reaches ``now`` and skip an older missing range.
    """
    rows = store.query(
        'SELECT max(ts) FROM price_point '
        ' WHERE symbol = ? AND price_native IS NOT NULL', [symbol])
    return _utc(rows[0][0]) if rows and rows[0][0] is not None else None


def last_price(store, symbol: str) -> Optional[float]:
    """The newest stored **native** price of a symbol, or ``None``.

    What #628's freshness sonde compares against, and it is read off the
    ``latest`` row rather than by scanning the series — the row exists for
    exactly this.

    Native, and never a converted value (spec #695 § 7). The sonde asks whether
    the *writer* has gone silently stale; a converted price moves whenever the
    exchange rate does, so watching it would let a currency tick pass for a
    price that is still being refreshed.
    """
    rows = store.query(
        'SELECT last_price_native FROM symbol_quote WHERE symbol = ?', [symbol])
    return rows[0][0] if rows and rows[0][0] is not None else None


def price_series(store, symbol: str) -> Dict[date, float]:
    """``{day: close}`` — one entry per calendar day that has a **converted** price.

    The shared price source the performance module is fed through. The survivor
    of a day is its **last** point, which is the rule every other daily read in
    the product follows (and the one the retention ladder will inherit in #705):
    a survivor chosen otherwise would make the value jump when a day is
    collapsed.

    **Converted, and it has to be** (issue #702). Everything downstream of this
    is money in the reporting currency — ``holdings_value``, ``total_value``,
    the gain — while ``cost_basis`` comes from events already recorded in it. A
    native price here would add dollars to euros under a label that makes the
    sum look homogeneous, which is the defect ADR-0002 exists against. A day
    whose conversion has not landed yet is simply **absent**, and the perf job's
    horizon is what bounds the consequence rather than a zero appearing in a
    series.
    """
    table = store.arrow(
        'SELECT day, price FROM ('
        '  SELECT CAST(ts AS DATE) AS day, price_converted AS price,'
        '         ROW_NUMBER() OVER ('
        '             PARTITION BY CAST(ts AS DATE) ORDER BY ts DESC) AS rn'
        '    FROM price_point'
        '   WHERE symbol = ? AND price_converted IS NOT NULL'
        ') WHERE rn = 1 ORDER BY day', [symbol])
    days = table.column('day').to_pylist()
    prices = table.column('price').to_pylist()
    return {day: float(price) for day, price in zip(days, prices)}


def read_quote(store, symbol: str) -> Optional[Dict]:
    """One ``symbol_quote`` row as a dict, or ``None`` when there is none."""
    columns = ('symbol',) + QUOTE_ATTRIBUTES + (
        'fetched_at', 'last_price_native', 'last_price_converted',
        'last_fx_rate', 'last_price_ts')
    rows = store.query(
        f'SELECT {", ".join(columns)} FROM symbol_quote WHERE symbol = ?',
        [symbol])
    if not rows:
        return None
    row = dict(zip(columns, rows[0]))
    row['fetched_at'] = _utc(row['fetched_at'])
    row['last_price_ts'] = _utc(row['last_price_ts'])
    return row


def _utc(value):
    """Stamp what DuckDB hands back as UTC-aware. One rule, applied on exit.

    ``TIMESTAMPTZ`` round-trips aware on a session pinned to UTC (see
    :func:`store.prepare`), but the guard is cheap and the alternative is a
    naive instant travelling into arithmetic that subtracts an aware one — a
    ``TypeError`` raised from the one code path that only runs while a backward
    pass is *in progress*.
    """
    if not isinstance(value, datetime):
        return value
    return value if value.tzinfo is not None else value.replace(
        tzinfo=timezone.utc)


__all__ = [
    'QUOTE_ATTRIBUTES', 'truncate',
    'record_quote', 'record_history',
    'record_window_tried', 'oldest_window_tried', 'terminal_symbols',
    'first_quoted_days',
    'oldest_ts', 'newest_ts', 'last_price', 'price_series', 'read_quote',
]
