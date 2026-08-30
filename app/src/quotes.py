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
from typing import (Dict, Iterable, List, Mapping, Optional, Sequence, Set,
                    Tuple)

from logfmt_logger import getLogger

import carrying
import instants
import retention
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


def record_attributes(store, symbol: str, moment: datetime,
                      attributes: Mapping) -> None:
    """Write what the instrument **is**, with no price claimed beside it (#773).

    :func:`record_quote` is the other writer of these columns and it cannot
    serve here: it appends a ``price_point``, and the pass that needs this one is
    the lateral pass, whose whole contract is *an ``UPDATE``, never an
    ``INSERT``* (issue #704). A row inserted to carry a currency would be a
    market observation nobody made, on a table with no key to refuse it
    (ADR-0007).

    The subject is the symbol the live scrape **never meets** — a line sold
    before this install existed, which ``_held_symbols`` filters out by design
    (#699) — and whose history the backfill reconstructs all the same since
    ADR-0009. ``symbol_quote.currency`` is the only memory
    :func:`quote_currency` reads and the only one the perf job may consult
    (#707), so a currency learnt anywhere else would be learnt for the length of
    one process and forgotten.

    ``attributes`` **replaces**, for :func:`record_quote`'s reason: a fetch that
    came back without a currency is a fetch that no longer knows one, and the
    row must not claim an observation it did not make. ``fetched_at`` moves with
    them, which is exactly what that column says — *when the attributes above
    were last refreshed* — and it is why this is not a targeted
    ``UPDATE ... SET currency``.
    """
    refreshed = ('fetched_at',) + QUOTE_ATTRIBUTES
    assignments = ', '.join(f'{name} = excluded.{name}' for name in refreshed)
    store.execute(
        f'INSERT INTO symbol_quote (symbol, {", ".join(refreshed)}) '
        f'VALUES (?{", ?" * len(refreshed)}) '
        f'ON CONFLICT (symbol) DO UPDATE SET {assignments}',
        [symbol, truncate(moment),
         *(finite(attributes.get(name)) for name in QUOTE_ATTRIBUTES)])


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
# The retention ladder — a DELETE, and never anything else (issue #705)
# --------------------------------------------------------------------------- #

def collapse_to_ladder(store, now: datetime) -> int:
    """Age the whole series onto the ladder, in place. Returns rows removed.

    ADR-0010's write half: under a year a point is kept **as it was written**,
    from one year to two only the last point of each hour survives, and beyond
    two years only the last point of each day. :mod:`retention` holds the rungs
    and the two walls; this is the statement that applies them.

    Seven things about it are decisions rather than details.

    **It is a ``DELETE`` and nothing else.** The ladder is a ceiling, never a
    floor: it designates rows and removes them, so a gap filled at nine months
    of age arrives hourly and *stays* hourly — nothing here interpolates it up
    to the live cadence, and no later pass will either. That is also the whole
    of why it is safe to run every cycle on a series it does not own the
    writing of.

    **The survivor of a bucket is its last point — its last *usable* one where
    the bucket is mixed**, and that qualifier is the whole of the rule. The
    criterion behind it is *a survivor chosen otherwise would make the value
    jump as the wall goes by*, and this store's three daily-ish readers do not
    all mean the same thing by *the price then*: :func:`price_series` and
    :meth:`store_reads.PortfolioReader.daily_closes` rank the day's
    **converted** rows (an unconverted one is not money and they filter it out
    before ranking), while :meth:`store_reads.PortfolioReader.chart_series`
    ranks by instant alone. One survivor cannot satisfy both in a bucket that
    holds a converted point *and* a later unconverted one, so the disagreement
    is settled — and settled towards the money.

    Keeping the last point flat would **delete the only usable value in the
    bucket**: measured on a store, a day carrying ``10:00 converted`` and
    ``17:00 NULL`` disappears entirely from
    :meth:`store_reads.PortfolioReader.daily_closes`, which the perf job reads,
    so the job carries the previous day's price onto it, and — since
    ``oldest_priced`` is derived from those same pairs — a symbol's earliest
    converted day moving forward widens its block in
    :func:`performance.account_horizon`, moves the account's bound and has the
    prune drop days. That is the #708/#765 crater
    class, from a ``DELETE`` that cannot be undone: at best #704's lateral pass
    later refills the survivor at the *historical daily* rate, which is a
    different number from the spot rate that was stored.

    Ranked converted-first, ``price_series`` and ``daily_closes`` are preserved
    **to the value**: the day's last converted point is the last converted point
    of its own bucket, so it is exactly the row that survives. What changes is
    ``chart_series``, which renders that bucket as a price where it rendered a
    gap — a true observation appearing, not a figure moving, which is the
    direction the criterion is indifferent to. It does not retract #763's rule
    either: *that* rule is about not letting one resolved rate stand for a whole
    hour of unresolved ones **that are still stored**, and after the collapse
    there is nothing left to stand for. The two rank differently because they
    answer two questions — *what is stored right now* against *which single
    observation is worth keeping*.

    A bucket with **no** converted point at all keeps its last point, native
    price and all: that is still a row #704's lateral pass repairs in place, and
    throwing it away would be the ladder deciding a conversion will never land.

    **Idempotent by construction.** On an already-collapsed bucket exactly one
    row stands, so it is that bucket's last one and ``rn > 1`` designates
    nothing. There is no watermark to keep, and running the pass twice in a row
    leaves an identical table — which is what lets it be a step of a job that
    fires every sixty seconds.

    **One statement over the whole table, not one per symbol.** ``price_point``
    carries no index of any kind (ADR-0007), so ``WHERE symbol = ?`` is a full
    scan: N symbols would be N scans of the same rows. Partitioning by
    ``(symbol, bucket)`` pays for one. And it is the reading that covers the
    rows spec #695 § 10 most insists on keeping — those of a symbol **no event
    names any more**, which the backfill's own loop never visits, because it
    walks the holding windows the ledger produces.

    **The ``latest`` row may name a point this removes, and that is not a
    dangling reference.** ``symbol_quote``'s ``last_*`` columns are a **copy of
    an observation**, not a key into the series — nothing joins them to
    ``price_point`` — so what they go on saying is *the newest observation ever
    made*, which stays true. It can only happen where the newest point of a
    symbol is itself past a wall (a line quoted nowhere for over a year) **and**
    unconverted while an earlier point of its bucket is not; in that state
    ``last_price_converted`` was already ``NULL`` beside a series that had a
    converted price for the same hour, so the collapse leaves the inconsistency
    exactly as it found it rather than creating one. Protecting the row instead
    would leave one bucket per symbol permanently uncollapsed, to defend a
    figure no reader recomputes from the series.

    **And it is cheap enough to ride a sixty-second job**, which is what
    *idempotent by construction* and *one statement* are worth together — the
    two are only a design if the pass they license is free. Measured on a synthetic store of the shape
    a twenty-year install has — 19 symbols, 1,32 M points, a raw year at 120 s,
    an hourly band and eighteen daily years: **43 ms** for a steady cycle, which
    designates the 114 points that crossed a wall that day. A six-month
    catch-up — 820 800 dense points that aged past the first wall while nothing
    was running — is **790 020 rows removed in 66 ms**, in the one statement.

    **``rowid`` is what addresses a row**, since the table has no key to do it
    with. It is read and used inside one statement, which is the only scope over
    which DuckDB promises it means anything — and the count comes back off that
    same statement rather than from a second scan, which the surrounding
    transaction is what makes safe: it holds the store's lock from ``BEGIN`` to
    ``COMMIT``, so no other thread can put a second pending result on the
    connection between the ``execute`` and its ``fetchone``.
    """
    hourly_wall, daily_wall = retention.walls(now)
    # The two bands, each as its own ``(bucket, bound, parameters)``. The daily
    # bucket is ``CAST(ts AS DATE)`` and not ``time_bucket(INTERVAL '1 day',
    # ts)``: the two name the same UTC day, and the first is the spelling
    # :func:`price_series` and the perf job's own read already mean by *the price
    # of that day*, so the survivor left behind is by construction the point
    # those reads were already taking. The bounds match :func:`retention.walls`'
    # own edges — ``<=`` on the hourly side of the second wall, ``<`` on the
    # daily one — so the bands are disjoint and no point is designated twice.
    bands = (
        ("time_bucket(INTERVAL '1 hour', ts)", 'ts <= ? AND ts >= ?',
         [hourly_wall, daily_wall]),
        ('CAST(ts AS DATE)', 'ts < ?', [daily_wall]),
    )

    #: The survivor, in one ``ORDER BY``: a **converted** point before an
    #: unconverted one, then the latest instant, then the last row to have
    #: landed on it — two points can truncate to the same second, and
    #: ``_advance_latest`` keeps the last of them for the same reason.
    survivor = ('(price_converted IS NOT NULL) DESC, ts DESC, rowid DESC')

    removed = 0
    with store.transaction():
        for bucket, bound, parameters in bands:
            result = store.execute(
                'DELETE FROM price_point WHERE rowid IN ('
                '  SELECT rowid FROM ('
                '    SELECT rowid, ROW_NUMBER() OVER ('
                f'             PARTITION BY symbol, {bucket}'
                f'              ORDER BY {survivor}) AS rn'
                '      FROM price_point'
                f'     WHERE {bound}'
                '  ) WHERE rn > 1)',
                parameters)
            removed += int(result.fetchone()[0])

    if removed:
        logger.debug(f"Aged {removed} price point(s) onto the retention ladder")
    return removed


# --------------------------------------------------------------------------- #
# The lateral pass — an UPDATE, and never an INSERT (issue #704)
# --------------------------------------------------------------------------- #

def unconverted_span(store, symbol: str) -> Optional[Tuple[date, date, int]]:
    """``(oldest day, newest day, how many)`` of the points missing a conversion.

    What the lateral pass works on: the **same rows** as the series, short of a
    column. A quote that landed with ``price_converted NULL`` — no reporting
    currency yet, or a rate that could not be had (issue #702) — is what makes
    writing the point rather than losing it viable at all, and this is the read
    that finds them again.

    ``price_native IS NOT NULL`` is part of the predicate rather than an
    optimisation: a point with no native price has nothing to convert, and
    counting it would give the pass a day it can never repair and therefore a
    reason to come back for ever.

    ``None`` when there is nothing to repair, which is the steady state of an
    install whose currency was answered before its first scrape.
    """
    rows = store.query(
        'SELECT min(CAST(ts AS DATE)), max(CAST(ts AS DATE)), count(*) '
        '  FROM price_point '
        ' WHERE symbol = ? AND price_native IS NOT NULL '
        '   AND price_converted IS NULL', [symbol])
    if not rows or rows[0][2] in (None, 0):
        return None
    oldest, newest, count = rows[0]
    return oldest, newest, int(count)


def unconverted_days(store, symbol: str, first: date,
                     last: date) -> List[date]:
    """The calendar days of ``[first, last]`` carrying a point to repair.

    The chunk :func:`unconverted_span` sizes, resolved to the days that actually
    need a rate. Asking for the days rather than walking the interval is what
    keeps the repair proportional to the gap instead of to the window: a chunk of
    a year holds 365 days and a handful of them may be all that is missing, and
    every day named here becomes a bound parameter in the ``UPDATE`` below.

    The bounds are **cast**, because ``ts`` is a ``TIMESTAMPTZ`` and the two
    kinds of time never mix (spec #695 § 3): compared against a bare ``DATE``,
    DuckDB widens the day to midnight and silently drops the last day of every
    window.
    """
    return [row[0] for row in store.query(
        'SELECT DISTINCT CAST(ts AS DATE) AS day FROM price_point '
        ' WHERE symbol = ? AND price_native IS NOT NULL '
        '   AND price_converted IS NULL '
        '   AND CAST(ts AS DATE) BETWEEN ? AND ? '
        ' ORDER BY day', [symbol, first, last])]


def repair_conversions(store, symbol: str,
                       factors: Mapping[date, float]) -> int:
    """Give a day's points the conversion they were written without. Returns rows.

    **An ``UPDATE``, never an ``INSERT``** (spec #695 § 5): the pass works on
    rows that exist and are short of a column, so inserting anything here would
    duplicate the very series it is repairing — on a table that carries no key to
    refuse it (ADR-0007).

    ``factors`` maps a calendar day to the number a **price** is multiplied by,
    subunit folded in — :meth:`fx.Rates.rate`'s answer for that day, and the
    caller's to compute, exactly as the live writer hands its conversion in
    rather than having it worked out here. The figure is written as
    ``price_native * factor`` so ``price_converted == price_native × fx_rate``
    goes on holding on the stored row: it is a journal, not three numbers that
    do not reconcile.

    A day the caller has no factor for is simply **not passed**, and its points
    stay ``NULL`` for a later cycle. That is the honest state, and it is why the
    pass has no notion of a day it has "done".

    **The ``latest`` maintenance rule applies with no extra clause** (spec #695
    § 7). The newest point this call repairs is handed to :func:`_advance_latest`
    exactly as the live writer and the forward pass hand theirs; its ``WHERE``
    decides by itself, updating the row when the repaired point *is* the most
    recent one and refusing when it is not. The invariant stays *the most recent
    point, whatever its completeness* — a rule about the point, not about which
    of its columns are filled.

    One transaction, like every other writer here: a reader landing between the
    ``UPDATE`` and the ``latest`` row would see a series and a summary that
    disagree about the same observation.
    """
    days = sorted(day for day, factor in factors.items() if factor is not None)
    if not days:
        return 0

    placeholders = ', '.join('?' * len(days))
    predicate = (
        ' WHERE symbol = ? AND price_native IS NOT NULL '
        '   AND price_converted IS NULL '
        f'  AND CAST(ts AS DATE) IN ({placeholders})')

    with store.transaction():
        # Counted **before** the write, over the very rows about to be touched:
        # the count is what the cycle reports as written, and a DuckDB
        # ``executemany`` has no row count to hand back.
        rows = store.query(
            'SELECT count(*), max(ts) FROM price_point' + predicate,
            [symbol, *days])
        repaired, newest = (int(rows[0][0]), rows[0][1]) if rows else (0, None)
        if not repaired:
            return 0

        store.executemany(
            'UPDATE price_point '
            '   SET price_converted = price_native * ?, fx_rate = ? '
            ' WHERE symbol = ? AND price_native IS NOT NULL '
            '   AND price_converted IS NULL AND CAST(ts AS DATE) = ?',
            [(factors[day], factors[day], symbol, day) for day in days])

        # ``ORDER BY rowid DESC`` and not ``ORDER BY ts``: ``ts`` is pinned
        # to one value by the WHERE clause, so ordering by it discriminates
        # nothing and DuckDB is free to answer with either row. ``price_point``
        # carries no key (ADR-0007), so two points *can* land on one second —
        # which is exactly the tie ``record_history`` and ``collapse_to_ladder``
        # both take the trouble to break, and by the same rule: the last one
        # posted wins. Left as it was, ``symbol_quote.last_*`` could copy a
        # different point than the one the series serves.
        latest = store.query(
            'SELECT price_native, price_converted, fx_rate FROM price_point '
            ' WHERE symbol = ? AND ts = ? AND price_converted IS NOT NULL '
            ' ORDER BY rowid DESC LIMIT 1', [symbol, newest])
        if latest:
            _advance_latest(store, symbol, instants.utc(newest), *latest[0])

    logger.debug(f"Repaired {repaired} conversion(s) for {symbol}")
    return repaired


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
        symbol: instants.utc(value)
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

    **And a quote is a number *and* a unit** (issue #773), which is the join on
    ``symbol_quote.currency``. A symbol whose unit was never recorded carries
    ``price_native`` values nothing downstream may spend: every money figure the
    app draws is in the reporting currency, and a number with no unit cannot be
    converted into one — not by a rate that lands later, not by any cycle of any
    pass, because there is no pair to name. Left in this mapping such a symbol
    reads as *waiting for a rate*, which is a **transitory** absence, and #706
    answers a transitory absence with ``None``; the day then counts **zero** in
    :func:`performance._holdings_value` beside a cash ledger that has already
    paid for the shares, which is the crater ADR-0004 exists to fill. Out of it,
    the position joins the **carrying** convention (ADR-0004) rather than a
    fourth kind of absence (ADR-0021), and the cost is defined in the right unit
    already: event amounts are the debit *in the reporting currency* (ADR-0002),
    so the PMP needs no conversion.

    What makes the reading **permanent** rather than premature is the predicate's
    *second* term, which stays the caller's: :func:`terminal_symbols`. A symbol
    still being reconstructed is never handed to :func:`carrying.carrying_price`
    at all, and one whose backward pass has concluded has been met by the lateral
    pass — which since #773 **asks** for the unit and writes it here
    (:func:`record_attributes`) — so a ``currency`` still ``NULL`` under a
    terminal backfill is Yahoo having been asked and having named none. The
    empty string is excluded beside ``NULL`` so this reading and
    :func:`quote_currency`'s stay one reading.

    One scalar per symbol is enough because the consumers forward-fill: a day is
    *quoted* from the first observation on, exactly as ``price_at`` carries the
    last close forward (:func:`carrying.was_quoted`). One ``GROUP BY`` for the
    whole portfolio, so the perf recompute and the history route each pay one
    read rather than one per symbol.
    """
    return {
        symbol: value
        for symbol, value in store.query(
            'SELECT p.symbol, min(CAST(p.ts AS DATE)) '
            '  FROM price_point p '
            '  JOIN symbol_quote q ON q.symbol = p.symbol '
            " WHERE p.price_native IS NOT NULL AND q.currency IS NOT NULL "
            "   AND q.currency <> '' "
            ' GROUP BY p.symbol')
        if value is not None
    }


def quote_currency(store, symbol: str) -> Optional[str]:
    """The currency the exchange quotes a symbol in, or ``None``.

    Read from ``symbol_quote`` rather than from the scheduler's
    ``_share_info_cache`` for the reason :func:`terminal_symbols` gives about the
    backfill watermark: the cache is empty for the whole first cycle after every
    boot, and it never holds a symbol this process has not scraped — a position
    sold before the install existed, which the live scrape by design never polls.

    ``None`` is still an **ordinary** state and still never arms
    ``unconvertible`` — there is no pair yet, so nothing has failed to resolve —
    but it stopped being a **durable** one at #773. This docstring used to say
    the lateral pass had to *name it rather than act on it*, and it was written
    for a symbol *Yahoo says nothing about*; the population it actually
    described was a line sold before the install existed, which the live scrape
    never polls (#699) and whose history the backfill reconstructs all the same
    (ADR-0009) — a symbol Yahoo answers years of prices for, in a unit the app
    had no path left to learn. So the pass now **asks**, once per symbol, and
    :func:`record_attributes` writes the answer here. What survives under this
    ``None`` is the case the sentence was aimed at: the request came back naming
    no currency, which is durable, nameable, and still not a failure.
    """
    rows = store.query(
        'SELECT currency FROM symbol_quote WHERE symbol = ?', [symbol])
    return rows[0][0] if rows and rows[0][0] else None


def quote_exchanges(store, symbols: Iterable[str]) -> Dict[str, Optional[str]]:
    """``{symbol: venue | None}`` for the symbols asked — **one query** (#851).

    The venue's own reading of :func:`quote_currency`, and it is here for the
    same reason and by the same argument: the place a symbol trades on lives in
    ``symbol_quote`` and is read from there rather than from the scheduler's
    ``_share_info_cache``, which *is empty for the whole first cycle after every
    boot*. Its one consumer is the executor pool's sizing
    (:func:`scheduling.compute_pool_size`), and that sizing happens in
    :func:`main.start_runtime` — before the socket is bound. It used to be a
    *pre-scheduler exchange capture*, one yfinance fetch per held symbol behind a
    30-second deadline, and what those seconds bought was an integer between 4
    and 10 that the app then re-derived from the same fetches, non-blocking, a
    few seconds later. The store already knew.

    **One query for the whole portfolio**, never one per symbol: the caller asks
    about every held symbol at once and there is nothing to stagger. An empty
    set is answered without touching the store at all — a portfolio holding
    nothing has no venue to look up, and no ``IN ()`` to write.

    A symbol the store has no quotation row for — declared, never scraped, or
    scraped and never answered — maps to ``None``, and so does one whose
    ``exchange`` is ``NULL`` or empty: the two are the same absence to the only
    reader there is, which groups every unknown venue as a **solo market**
    rather than into one giant cohort. The empty string counts as absent here
    exactly as it does in :func:`quote_currency`, so the two stay one
    reading. There is no
    sentinel left to filter out (#845): a payload naming no venue writes
    ``NULL``, and the word the app used to fabricate is gone from the column.
    """
    wanted = sorted(set(symbols))
    if not wanted:
        return {}
    stored = dict(store.query(
        'SELECT symbol, exchange FROM symbol_quote '
        ' WHERE symbol IN (%s)' % ', '.join('?' * len(wanted)), wanted))
    return {symbol: (stored.get(symbol) or None) for symbol in wanted}


def oldest_ts(store, symbol: str) -> Optional[datetime]:
    """The oldest stored instant of a symbol's series, or ``None``.

    The backward pass's anchor. Per **symbol**: the series it measures has no
    account dimension any more, so an anchor scoped per account would ask N
    times the same question and fetch the same window N times a cycle.
    """
    rows = store.query(
        'SELECT min(ts) FROM price_point WHERE symbol = ?', [symbol])
    return instants.utc(rows[0][0]) if rows and rows[0][0] is not None else None


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
    return instants.utc(rows[0][0]) if rows and rows[0][0] is not None else None


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

    **No production reader since #844**: the performance module takes its daily
    closes from :meth:`store_reads.PortfolioReader.daily_closes`, which reads
    every symbol in one scan of ``price_point`` where this one asks per symbol.
    What is kept here is the reference implementation the perf price-source test
    measures that scan against, day for day and price for price.

    The survivor of a day is its **last** point, which is the rule every other
    daily read in the product follows (and the one the retention ladder will
    inherit in #705): a survivor chosen otherwise would make the value jump when
    a day is collapsed.

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
    row['fetched_at'] = instants.utc(row['fetched_at'])
    row['last_price_ts'] = instants.utc(row['last_price_ts'])
    return row


def forget_symbol(store, symbol: str) -> int:
    """Drop every market row of one symbol — its series and its quote row.

    The **only** way the market's two tables lose a symbol, and it exists for
    exactly one caller: the orphan purge (:func:`ledger.purge_orphan_symbols`,
    #695 § 10). A symbol whose events have all been forgotten keeps its series
    on purpose — forgetting an import is reversible, a reconstructed series is
    not, so the app never throws one away by itself — and what the spec owes in
    exchange is a way to *see and purge them on demand*.

    It writes ``price_point`` and ``symbol_quote``, which is why it is here:
    those two tables have one writer (ADR-0006), and a ``DELETE`` is a write.
    The caller owns the ``symbol`` row itself and the transaction the whole
    gesture runs in.

    Returns the number of ``price_point`` rows removed — the figure the purge
    reports, and the one that has to be said beside *this returns rows, not
    bytes*.
    """
    (points,) = store.query(
        'SELECT count(*) FROM price_point WHERE symbol = ?', [symbol])[0]
    store.execute('DELETE FROM price_point WHERE symbol = ?', [symbol])
    store.execute('DELETE FROM symbol_quote WHERE symbol = ?', [symbol])
    return int(points)


__all__ = [
    'QUOTE_ATTRIBUTES', 'truncate',
    'record_quote', 'record_attributes', 'record_history',
    'collapse_to_ladder',
    'unconverted_span', 'unconverted_days', 'repair_conversions',
    'record_window_tried', 'oldest_window_tried', 'terminal_symbols',
    'first_quoted_days',
    'quote_currency',
    'oldest_ts', 'newest_ts', 'last_price', 'price_series', 'read_quote',
    'forget_symbol',
]
