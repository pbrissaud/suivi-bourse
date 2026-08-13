"""
Market-aware per-symbol scheduling — pure cadence & context decisions.

Mirror of ``performance.py``: no store, no yfinance, ``now`` injected. The
two functions here drive the self-rescheduling per-symbol scrape jobs in
``main.py`` without touching the outside world, so they are exhaustively
testable against dicts and an injected clock (issue #616, design #602-#609).

  * ``decide`` — one scrape cycle's write gate + next re-arm delay.
  * ``extract_market_context`` — parse ``marketState`` + the next regular open
    from the ticker ``info`` and ``history()`` metadata. A ``next_open`` it
    returns is **strictly future, or it is None** (issue #769).
"""

from datetime import datetime, timedelta, timezone
from math import ceil, isclose
from typing import Dict, List, NamedTuple, Optional, Tuple

try:  # zoneinfo is stdlib on 3.9+; no new dependency (design #602/#603).
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - defensive, py<3.9 unsupported anyway
    ZoneInfo = None
    ZoneInfoNotFoundError = Exception

# The closed-family ``marketState`` values (design #608). Only these quiet a
# job; anything else — unknown, missing, or garbage — is coerced to ``REGULAR``
# (fail-open) so an unparseable state never sleeps a symbol indefinitely.
CLOSED_STATES = frozenset({'CLOSED', 'POST', 'POSTPOST', 'PRE', 'PREPRE'})

# Hardcoded safety constants (design #607) — not operator dials.
# ``SHORT_RETRY`` is what a closed cycle does when the next open is **unknown**,
# and only that (issue #769). It stopped being that for a while: an ordinary
# evening handed ``decide`` this morning's open, the non-positive-delta branch
# fired, and 60 s became the cadence of a fifteen-hour closure — one Yahoo
# request a minute per symbol, none of which may write.
SHORT_RETRY = 60           # s: re-probe when the next open is unknown
MAX_SLEEP = 24 * 60 * 60   # s: hard cap on a single deep-sleep to next open

# How long past the **current** period's regular open a still-closed state is
# read as *the open has not registered yet* rather than as *the session is over*
# (issue #769). It is the one thing the captured metadata cannot tell us: after
# the close and one minute after the open, ``currentTradingPeriod.regular.start``
# is the same past timestamp, and only the distance to ``now`` separates the two.
#
# The morning is not a corner case, it is **the** daily path. ``decide`` arms the
# job *at* ``next_open`` with no lead-in margin and #619 adds ``uniform(0, 30)``,
# so every single wake lands 0 to 30 s **after** the open — and if ``marketState``
# has not flipped yet (Yahoo's own lag, an opening auction, a half-day), a rule
# that only asked *is it past?* would hand the whole day to ``_approx_next_open``,
# whose ~08:00 local is itself already past by then, i.e. **tomorrow**. Measured
# on the capture with ``marketState='PRE'``: 82 800 s of sleep, at 0, 15, 60 and
# 300 s past the open alike — the symbol writes no price for the entire session,
# in silence, and nothing catches it up (``_reconcile_jobs`` only revives a symbol
# with **no** job, and #628's sonde only runs on a ``REGULAR`` write).
#
# So the window is bounded on both sides and the two costs are not symmetric: too
# tight and a session is lost, too wide and a day that never opens after all is
# probed once a minute for the width of the window. Fifteen minutes is fifteen
# probes per symbol in the worst case — against the ~900 a night #769 measured —
# and it is far below the shortest closure a market has, so an evening never
# enters it. It is not *the session*: bounding by a nominal 8 h session would pay
# a half-day (closed at 14:05, probed until 17:00) in exactly the coin this
# ticket exists to stop spending.
OPENING_LAG = 15 * 60      # s: past the open and still closed reads as *not yet*

# How often the perf job recomputes, in full and unconditionally (issue #707,
# ADR-0011). A constant and not a dial (issue #701): the two tables are a
# **cache** — a pure function of the ledger, the price points and the declared
# accounts, all three in the store — and a full recompute costs 0,4 % of this
# tick at five years. There is nothing left for an operator to trade off, so
# ``SB_PERF_INTERVAL`` was deleted rather than moved into the store.
#
# ``perf_should_run`` used to stand here as the real cadence, and it is gone
# **without a replacement** — not as a query, not reduced to one signal. One does
# not protect a cache from a faulty recompute; one rebuilds it.
PERF_TICK = 120            # s

# Dead-ticker guard (design #608, issue #617) — hardcoded, not operator dials.
# A symbol whose non-closed fetches keep producing no writable price backs off
# progressively instead of hammering yfinance every base_interval forever.
FAILURE_GRACE = 3          # K: first K failures still re-arm at base_interval
_BACKOFF_FACTOR = 2        # geometric growth per failure beyond the grace window
# Cap the exponent so a ticker dead for years never builds an astronomical int
# from FACTOR**n; MAX_SLEEP bounds the resulting delay anyway.
_MAX_BACKOFF_EXP = 32

# Approximate local open used only when the exact next-open is unavailable.
# ``marketState`` remains the authority on wake, so an early guess is fine.
_APPROX_OPEN_HOUR = 8

# Anti-herd jitter (issue #619, design #611) — the heir of the removed
# inter-share ``time.sleep(1)``. Hardcoded, not an operator dial (like
# ``SHORT_RETRY`` / ``MAX_SLEEP``). Every per-symbol job arming (main.py) offsets
# its ``run_date`` by a fresh ``uniform(0, JITTER_SECONDS)`` so a same-exchange
# cohort sharing one next-open spreads over ``[open, open + JITTER_SECONDS]`` and
# the ``REGULAR``-poll lockstep is re-randomized each cycle. A ``date`` trigger
# can't carry APScheduler's own ``jitter``, so main applies it to ``run_date``.
JITTER_SECONDS = 30

# Executor pool auto-sizing (issue #619, design #611) — see ``compute_pool_size``.
POOL_CAP = 50              # hard bound on the *auto* formula only (not the dial)
FETCH_EST_SECONDS = 5      # rough wall-clock of one _fetch_ticker_data cycle
RESERVED = 3               # backfill + perf (+ headroom), the non-scrape jobs


def is_closed(state) -> bool:
    """True only for a recognized closed-family state (fail-open coercion)."""
    return state in CLOSED_STATES


def backoff_delay(base_interval: int, failure_count: int) -> float:
    """Re-arm delay for ``failure_count`` consecutive failures (design #608).

    ``base_interval`` for the first ``FAILURE_GRACE`` failures, then geometric
    ``base_interval × FACTOR^(n − FAILURE_GRACE)`` growth, capped at
    ``MAX_SLEEP``. ``failure_count == 0`` (a fresh reset / success) yields
    ``base_interval``.
    """
    excess = failure_count - FAILURE_GRACE
    if excess <= 0:
        return base_interval
    exponent = min(excess, _MAX_BACKOFF_EXP)
    return min(base_interval * (_BACKOFF_FACTOR ** exponent), MAX_SLEEP)


def decide(state, price_present: bool, next_open: Optional[datetime],
           now: datetime, failure_count: int,
           base_interval: int) -> Tuple[bool, float, int]:
    """Decide one scrape cycle's write gate and next re-arm delay.

    Two-gate split (design #608): the **reschedule** gate keys on ``state``
    alone, the **write** gate on ``not-closed AND price_present`` — so a
    transient price failure keeps a job polling while only a recognized-closed
    state quiets it.

    Two-tier cadence (design #607): ``REGULAR`` re-arms in ``base_interval``;
    every closed-family state sleeps to ``next_open`` (capped at ``MAX_SLEEP``,
    no lead-in margin), short-retrying at ``SHORT_RETRY`` when ``next_open`` is
    **unknown** — which is the whole of what ``SHORT_RETRY`` is for (issue #769).
    *Unknown* is a real daily state and it arrives as ``None``: woken at an open
    that has not registered yet, ``extract_market_context`` says so rather than
    guessing a date (``OPENING_LAG``).

    A non-future ``next_open`` is read as unknown too, and that is now a guard
    rather than a case: ``extract_market_context`` holds the invariant that a
    date it returns is strictly future, so the only way in is a caller that does
    not. It used to be described here as a *holiday / half-day* — a rarity —
    while it in fact happened every single evening, ``currentTradingPeriod``
    naming the **current** period and not the next one.

    Dead-ticker guard (design #608, issue #617): a **failure** is one
    non-closed cycle with no writable price. A closed cycle is *never* a
    failure (the market being shut is not a ticker fault) — the counter is
    passed through untouched. ``new_failure_count`` increments on each failure
    and resets to 0 on a successful write. While failing, the non-closed re-arm
    grows from ``base_interval`` (first ``FAILURE_GRACE`` failures) to
    ``base_interval × 2^(n − FAILURE_GRACE)`` capped at ``MAX_SLEEP``, so a dead
    ticker stops hammering yfinance instead of polling every ``base_interval``.

    Returns ``(should_write, next_delay, new_failure_count)``. A fourth element
    said *"this write makes the perf series stale"*; it was ``should_write``
    spelt twice, and it left with the flag it fed (issue #707) — the perf
    recompute is unconditional, so a scrape has nothing left to tell it.
    """
    closed = is_closed(state)

    should_write = (not closed) and price_present

    if closed:
        # Market shut: sleep to the next open, counter frozen (not a failure).
        new_failure_count = failure_count
        if next_open is None:
            next_delay: float = SHORT_RETRY
        else:
            delta = (next_open - now).total_seconds()
            # No lead-in margin: target exactly next_open. A non-positive delta
            # is a next open we do not actually know — the same answer as None
            # and for the same reason. Its producer here holds #769's invariant,
            # so this is the guard for one that does not, never the evening.
            next_delay = min(delta, MAX_SLEEP) if delta > 0 else SHORT_RETRY
    elif should_write:
        # Success: reset the failure counter and resume the base cadence.
        new_failure_count = 0
        next_delay = base_interval
    else:
        # Non-closed cycle with no writable price: a failure — back off.
        new_failure_count = failure_count + 1
        next_delay = backoff_delay(base_interval, new_failure_count)

    return should_write, next_delay, new_failure_count


# ``perf_should_run`` stood here and is **deleted without a replacement** (issue
# #707, ADR-0011). It existed because recomputing was expensive on InfluxDB and
# a closed-market wave dripped never-compacted Parquet files; both subjects left
# with the database. What it gated is now unconditional, and the three signals it
# read — a reloaded events cache, a backfill watermark, a live ``REGULAR`` write
# — no longer exist anywhere: they were the last coupling between the backfill
# and the perf, and re-deriving any of them "as a query" would rebuild it.


def forward_backfill_window(
    newest: Optional[datetime], now: datetime, chunk_days: int
) -> Optional[Tuple[datetime, datetime]]:
    """Size one forward gap-fill window ``[newest, end]``, or ``None`` (#627/#626).

    Pure mirror of the backward pass's window sizing, injected ``now``, no
    the store/yfinance — so the "should we fetch, and how wide" decision is unit
    testable in isolation. The forward pass recovers a trading session the app
    missed while down by asking ``history(newest → now)``; classifying the window
    (real session vs weekend/holiday) is delegated to yfinance, never decided
    here.

    Returns ``None`` (no fetch this cycle) when:

      * ``newest is None`` — the series has no stored point yet; the *backward*
        pass owns seeding an empty series, the forward pass has no anchor.
      * ``(now - newest).days < 1`` — reuse of the backward pass's ``< 1 day``
        guard. This is what makes the forward pass **no-op during live trading**:
        the live ``REGULAR`` writer keeps ``newest`` ≈ ``now``, the sub-day window
        is skipped, and the forward pass never races or duplicates the seam. A
        clock skew (``now < newest``) yields a negative delta → also skipped.

    Otherwise returns ``(newest, end)`` where ``end = min(newest + chunk_days,
    now)`` — chunked identically to the backward pass so a long gap is filled one
    ``chunk_days`` window per cycle, advancing forward as ``newest`` catches up.
    """
    if newest is None:
        return None
    if newest.tzinfo is None:
        newest = newest.replace(tzinfo=timezone.utc)
    if (now - newest).days < 1:
        return None
    end = min(newest + timedelta(days=chunk_days), now)
    return newest, end


# Price-freshness sonde default horizon (issue #628, design #626). The operator
# dial is ``staleness_horizon``, in the **store** — it has had no environment
# form since #701, and ``SB_STALENESS_HORIZON`` is named at boot and obeyed by
# nothing (#740). The default is a few ``REGULAR`` poll cycles wide so an
# ordinary tick never trips the sonde.
STALENESS_HORIZON = 900  # s

# Relative tolerance for "the stored price is unchanged". A live quote differing
# by more than this fraction has *moved*; anything within it is treated as the
# same price (a genuinely flat quote is not a stuck writer).
_STALENESS_REL_TOL = 1e-9


class SondeState(NamedTuple):
    """The price-freshness sonde's per-(symbol, account) memory (issue #628).

    Carried across ``REGULAR`` cycles by the caller so staleness is measured over
    *consecutive polling*, not the raw wall-clock age of the stored point:

      * ``stored_price`` — the newest stored price observed last cycle, to detect
        whether the writer advanced it since.
      * ``frozen_since`` — when the stored price was first seen frozen (the anchor
        the horizon is measured from).
      * ``last_seen`` — when the sonde last ran for this series, to detect a break
        in consecutive polling (a market-closed gap) and re-baseline across it.
    """
    stored_price: float
    frozen_since: datetime
    last_seen: datetime


def price_freshness_step(
    prev: Optional[SondeState], live_price: Optional[float],
    stored_price: Optional[float], now: datetime, horizon: float,
) -> Tuple[Optional[SondeState], bool]:
    """Advance the price-freshness liveness sonde one ``REGULAR`` cycle (#628/#626).

    Pure and stateful-by-value — no store / yfinance, ``now`` injected,
    ``prev`` fed back in from last cycle — so the "is the writer silently stale"
    call is unit-testable in isolation. This is the repurposed price-diff,
    shipped as **observability**, not as a backfill trigger: the time-window
    forward pass (#627) can't see a writer that fetches fine but persists a frozen
    value because it believes coverage reaches ``now``.

    **Why memory instead of the stored point's raw age.** A healthy writer
    advances the newest stored price *every* ``REGULAR`` cycle, so "the newest
    stored value stopped advancing across *consecutive* cycles" is the true
    stuck-writer signal. Measuring the horizon over consecutive observations —
    not the wall-clock age of the stored point — is what stops the **first tick
    after an overnight/weekend close** from firing a false positive: the market
    being shut writes nothing (#606), so that morning point is legitimately hours
    old, yet the writer is fine. Age alone can't tell the two apart; consecutive
    observation can. Two guards make it robust:

      * **value advanced** (or first observation) → the writer is persisting:
        re-baseline ``frozen_since = now``, no signal. In the healthy case the
        last-of-session write advanced the value beyond the sonde's last
        observation, so the morning cycle sees a change and re-baselines.
      * **polling gap wider than the horizon** (``now − last_seen > horizon``) →
        the market was closed in between, so accrued frozen time can't be trusted:
        re-baseline, no signal. A genuinely stuck writer polls every
        ``base_interval`` (≪ horizon) and never trips this.

    Otherwise, with the stored value unchanged across consecutive polling, the
    signal fires (``stale=True``) iff the live quote has **moved** away from it
    (``not isclose``) *and* it has stayed frozen for at least ``horizon`` seconds.
    A flat live quote is a genuinely flat market, not a stuck writer — no signal
    (the accepted false-negative called out in #626).

    Returns ``(new_state, stale)``; a ``None`` new-state means "forget this
    series" (sonde disabled or empty series). Diagnostic only: the caller must
    never let this change scrape cadence, write gating, or the #617 backoff.
    """
    if horizon <= 0 or stored_price is None:
        return None, False

    value_advanced = prev is None or not isclose(
        prev.stored_price, stored_price, rel_tol=_STALENESS_REL_TOL, abs_tol=0.0)
    polling_broke = prev is not None and (
        now - prev.last_seen).total_seconds() > horizon
    if value_advanced or polling_broke:
        # Writer advanced the value, or consecutive polling broke (market closed)
        # — re-baseline the frozen anchor to now, emit nothing.
        return SondeState(stored_price, now, now), False

    frozen_since = prev.frozen_since
    moved = live_price is not None and not isclose(
        live_price, stored_price, rel_tol=_STALENESS_REL_TOL, abs_tol=0.0)
    stale = moved and (now - frozen_since).total_seconds() >= horizon
    return SondeState(stored_price, frozen_since, now), stale


class RearmSplit(NamedTuple):
    """How a new ``regular_interval`` divides the held symbols (issue #701).

    ``rearm`` and ``self_arming`` together are what the API reports as reached;
    they are two tuples rather than one because only the first has a job to
    touch, and touching the second would race the pass that is about to arm it.
    """

    #: Polling, with an idle job in the store: re-arm these.
    rearm: Tuple[str, ...]
    #: Polling, and arming themselves anyway — mid-pass, or armed and not yet
    #: fired. They read the new value on their own, from the same attribute.
    self_arming: Tuple[str, ...]
    #: Asleep until their market opens. Off-topic, and left alone.
    asleep: Tuple[str, ...]


def rearm_split(symbols, closed: Dict[str, Optional[bool]],
                armed) -> RearmSplit:
    """Divide the held symbols the way a new cadence actually reaches them.

    The acceptance criterion of #701: saving a cadence re-arms **only the
    symbols whose market is open right now**. A sleeping symbol is not mis-set,
    it is off-topic — it re-reads the dial when it wakes, because ``decide`` is
    handed ``base_interval`` on every pass.

    **The question is put to the last-pass record, not to the clock.** The
    obvious instrument is the armed ``next_run_time`` — a polling symbol is
    minutes out, a sleeping one is hours out — and it is the wrong one, three
    times over: it misreads a symbol asleep until an open that falls *inside* a
    long outgoing interval, it cannot tell a #617 back-off (armed at
    ``interval × 2^n``) from a market close, and it inverts the moment the dial
    it is compared against is itself the thing being changed. ``closed`` is what
    :func:`decide` *acted on* for that symbol on its last pass — the same field
    the runtime pills read — so it answers the question that was asked.

    ``closed`` maps a symbol to that flag, and ``None`` (or an absent key) means
    the symbol has never completed a pass. That is ``self_arming``, not
    ``rearm``: at boot every held symbol is armed to fire *immediately*, and
    re-arming one there would push the bootstrap a whole cadence into the
    future.

    ``armed`` is the set of symbols with an idle job in the store. A symbol
    **absent** from it is mid-pass: a ``date`` job leaves the jobstore *while it
    runs* — APScheduler removes it rather than nulling its run time — and
    re-arms itself at the end of ``_scrape_symbol`` from the same attribute the
    write path has just assigned. It is reached, and it is not touched.

    The row set is ``symbols`` — the held positions — and not the jobstore, so
    the two figures the API publishes **add up to the portfolio**. Reading it
    off the jobstore would silently drop whichever symbol happened to be
    mid-scrape, and the count exists precisely so a reader can tell that the
    symbols it does not name are asleep rather than misconfigured.

    Every tuple is sorted, so a count is stable and a log line reads the same
    twice.
    """
    armed = set(armed)
    rearm, self_arming, asleep = [], [], []
    for symbol in sorted(symbols):
        if closed.get(symbol):
            asleep.append(symbol)
        elif symbol in armed and closed.get(symbol) is not None:
            rearm.append(symbol)
        else:
            self_arming.append(symbol)
    return RearmSplit(tuple(rearm), tuple(self_arming), tuple(asleep))


def compute_pool_size(shares: List[dict],
                      exchange_of: Dict[str, Optional[str]]) -> int:
    """Auto executor-pool size — **always**, since #701 (#619, design #611).

    Under one self-rescheduling job per symbol (#616), every symbol on the same
    exchange gets the same next-open timestamp, so at market open a whole cohort
    fires together. Size the pool to the busiest wave: the **largest same-exchange
    cohort** drives the scrape workers. Each cohort of ``N`` is spread over the
    ``JITTER_SECONDS`` window, so ``ceil(N × FETCH_EST_SECONDS / JITTER_SECONDS)``
    workers keep up::

        min(RESERVED + ceil(largest_cohort × FETCH_EST / JITTER), POOL_CAP)

    ``RESERVED`` covers the non-scrape jobs (backfill + perf + headroom) — one
    value since #711, there being one loading path and therefore one job set.
    ``exchange_of`` maps each held symbol to its exchange; a symbol with no known
    exchange (``None``/missing/falsy) is its own **solo market** (cohort of 1),
    never grouped — so an all-unknown portfolio never inflates into one giant
    cohort. The result is clamped to ``[1, POOL_CAP]``.

    This is no longer one of two paths. The fixed dial it used to compete with
    was deleted in #701 rather than moved into the store: a ``ThreadPoolExecutor``
    does not shrink hot, so it was the one setting that would still have demanded
    a restart — and a fixed pool is a silent trap besides, a cohort of thirty
    symbols on a pool of ten serialising its own scrapes with nothing to say so.
    """
    symbols = {s['symbol'] for s in shares if s.get('symbol')}
    cohorts: Dict[str, int] = {}
    solo = 0
    for symbol in symbols:
        exchange = exchange_of.get(symbol)
        if exchange:
            cohorts[exchange] = cohorts.get(exchange, 0) + 1
        else:
            solo += 1  # unknown exchange: a solo market, its own cohort of 1

    cohort_sizes = list(cohorts.values())
    if solo:
        cohort_sizes.append(1)
    largest = max(cohort_sizes, default=0)

    scrape_workers = ceil(largest * FETCH_EST_SECONDS / JITTER_SECONDS)
    return max(1, min(RESERVED + scrape_workers, POOL_CAP))


def extract_market_context(info: Optional[dict], history_meta: Optional[dict],
                           now: datetime) -> Tuple[Optional[str], Optional[datetime]]:
    """Extract ``(marketState, next_open)`` from ticker data.

    **The invariant, and it is the point of this function** (issue #769): a
    ``next_open`` returned here is **strictly in the future, or it is None**.
    Nothing downstream has to ask whether the date it was handed has already
    happened, and ``SHORT_RETRY`` goes back to meaning *we do not know when this
    market opens*.

    Prefers ``history()`` metadata's ``currentTradingPeriod.regular.start``
    (design #603 amendment) — but only while it is still ahead of ``now``, see
    below. Falls back to ``exchangeTimezoneName`` + stdlib ``zoneinfo`` at
    ~08:00 local on the next day (DST handled by ``zoneinfo``; an approximate
    open is fine — the freshly-read ``marketState`` is the authority on wake).
    ``now`` is injected and must be timezone-aware. Returns
    ``(state, next_open|None)``.

    **A past open has two meanings, and they are read apart** (issue #769): just
    past is *the open has not registered yet* and answers ``None``; long past is
    *this session is over* and answers the approximation. ``OPENING_LAG`` is the
    line, and the argument for it is written where the constant is.
    """
    info = info or {}
    state = info.get('marketState')

    # ``currentTradingPeriod`` describes the **current** period and never the
    # next one, so after the close ``regular.start`` is the open of that same
    # morning — measured on ``BNP.PA`` at 2026-08-12 20:47 UTC, Paris shut since
    # 15:30 (``tests/fixtures/trading_period/``). Passed on as-is it gave
    # ``decide`` a non-positive delta, i.e. ``SHORT_RETRY``, i.e. one Yahoo
    # request a minute per symbol for the whole evening — of the order of 4 000
    # a night on eleven European lines, not one of which may write, the write
    # gate being shut on a closed market by construction.
    #
    # So a non-future value never leaves this function, and what replaces it
    # depends on **how far** past it is, because that field says two different
    # things at two distances and only ``now`` tells them apart:
    #
    #   * **long past — the evening.** The session is over and this metadata
    #     names no other; ``_approx_next_open``, the one producer that
    #     guarantees a strictly future date in its own body, takes over. It was
    #     never reached here before: the exact field parsed perfectly, it simply
    #     meant something else, and *the better fallback was masked by a field
    #     that reads well*.
    #   * **just past — the morning, every morning.** The job was armed *at*
    #     this very open (no lead-in margin, plus #619's jitter), so it wakes
    #     inside this window by construction; a state still closed here means
    #     the open has not registered yet, not that the day is done. The honest
    #     answer is that we do **not know** when this market opens — ``None``,
    #     which is ``SHORT_RETRY``, which is one minute and a re-read. Handing
    #     the approximation over instead would answer *tomorrow ~08:00* (08:00
    #     local is already past at a 09:00 open) and cost the whole session, in
    #     silence: no other mechanism re-arms a symbol that still has a job.
    #
    # The two exits not taken, with their reasons, at the place where the choice
    # is made:
    #   * **derive the real next open** from ``post.end`` or the venue's
    #     calendar. More exact, and it rests on fields Yahoo documents nowhere
    #     and does not guarantee — the captured reading carries no ``end`` at
    #     all, so the day one of them is missing the app is back on this line
    #     with no invariant to state at all.
    #   * **assume ``SHORT_RETRY``** for every past open and document it. 60 s
    #     across the fifteen hours of a closure is not a *short* retry; the
    #     constant carries that name because it answers an open that is
    #     unknown, not one that is far — which is exactly why the morning gets
    #     it and the evening does not.
    # The cost accepted is that the evening loses the exactness the morning
    # keeps: ~08:00 local instead of the venue's real open. Design #603 already
    # assumes that, ``marketState`` being re-read on wake and being the
    # authority — an early guess costs one extra fetch, a late one costs a
    # session.
    current_open = _current_regular_open(history_meta)
    if current_open is None:
        return state, _approx_next_open(info, now)
    if current_open > now:
        return state, current_open
    if (now - current_open).total_seconds() <= OPENING_LAG:
        return state, None
    return state, _approx_next_open(info, now)


def _current_regular_open(history_meta: Optional[dict]) -> Optional[datetime]:
    """The **current** trading period's regular open, or None.

    Reads ``currentTradingPeriod.regular.start`` (a Unix timestamp) defensively
    — any missing/garbage layer yields None so the caller falls back. The name
    says what the field holds and not what a scheduler would like it to hold:
    before the open it *is* the next open, after the close it is this morning's
    (issue #769). Deciding what to do with a past one belongs to the caller,
    which is where the invariant is stated.
    """
    if not isinstance(history_meta, dict):
        return None
    ctp = history_meta.get('currentTradingPeriod')
    if not isinstance(ctp, dict):
        return None
    regular = ctp.get('regular')
    if not isinstance(regular, dict):
        return None
    start = regular.get('start')
    if start is None:
        return None
    try:
        return datetime.fromtimestamp(start, tz=timezone.utc)
    except (OSError, ValueError, OverflowError, TypeError):
        return None


def _approx_next_open(info: dict, now: datetime) -> Optional[datetime]:
    """~08:00 local on the next day in the exchange timezone, or None.

    Used when the current period's regular open is unavailable, or **past by
    more than ``OPENING_LAG``** (issue #769) — i.e. when this metadata's session
    is over rather than merely slow to register. Returns a UTC datetime, and it
    is the only producer that carries the strictly-future guarantee in its own
    body.
    """
    tz_name = info.get('exchangeTimezoneName')
    if not tz_name or ZoneInfo is None:
        return None
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return None

    local_now = now.astimezone(tz)
    candidate = local_now.replace(
        hour=_APPROX_OPEN_HOUR, minute=0, second=0, microsecond=0)
    # Always land strictly in the future; marketState resolves weekends/holidays
    # forward one wake at a time.
    if candidate <= local_now:
        candidate = candidate + timedelta(days=1)
    return candidate.astimezone(timezone.utc)
