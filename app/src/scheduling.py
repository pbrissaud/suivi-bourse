"""
Market-aware per-symbol scheduling — pure cadence & context decisions.

Mirror of ``performance.py``: no InfluxDB, no yfinance, ``now`` injected. The
two functions here drive the self-rescheduling per-symbol scrape jobs in
``main.py`` without touching the outside world, so they are exhaustively
testable against dicts and an injected clock (issue #616, design #602-#609).

  * ``decide`` — one scrape cycle's write gate + next re-arm delay.
  * ``extract_market_context`` — parse ``marketState`` + the next regular open
    from the ticker ``info`` and ``history()`` metadata.
"""

from datetime import datetime, timedelta, timezone
from math import ceil
from typing import Dict, List, Optional, Tuple

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
SHORT_RETRY = 60           # s: re-probe when woken but still not REGULAR
MAX_SLEEP = 24 * 60 * 60   # s: hard cap on a single deep-sleep to next open

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
RESERVED_EVENTS = 3        # backfill + perf (+ headroom) exist in events mode
RESERVED_MANUAL = 1        # backfill only in manual mode


def is_closed(state) -> bool:
    """True only for a recognized closed-family state (fail-open coercion)."""
    return state in CLOSED_STATES


def _backoff_delay(base_interval: int, failure_count: int) -> float:
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
           base_interval: int) -> Tuple[bool, float, int, bool]:
    """Decide one scrape cycle's write gate and next re-arm delay.

    Two-gate split (design #608): the **reschedule** gate keys on ``state``
    alone, the **write** gate on ``not-closed AND price_present`` — so a
    transient price failure keeps a job polling while only a recognized-closed
    state quiets it.

    Two-tier cadence (design #607): ``REGULAR`` re-arms in ``base_interval``;
    every closed-family state sleeps to the exact ``next_open`` (capped at
    ``MAX_SLEEP``, no lead-in margin), short-retrying at ``SHORT_RETRY`` when
    ``next_open`` is unknown or already past (self-resolves holidays/half-days
    forward once the job wakes and re-reads ``marketState``).

    Dead-ticker guard (design #608, issue #617): a **failure** is one
    non-closed cycle with no writable price. A closed cycle is *never* a
    failure (the market being shut is not a ticker fault) — the counter is
    passed through untouched. ``new_failure_count`` increments on each failure
    and resets to 0 on a successful write. While failing, the non-closed re-arm
    grows from ``base_interval`` (first ``FAILURE_GRACE`` failures) to
    ``base_interval × 2^(n − FAILURE_GRACE)`` capped at ``MAX_SLEEP``, so a dead
    ticker stops hammering yfinance instead of polling every ``base_interval``.

    Returns ``(should_write, next_delay, new_failure_count, mark_dirty)``.
    """
    closed = is_closed(state)

    should_write = (not closed) and price_present
    mark_dirty = should_write  # a REGULAR write makes the perf series stale

    if closed:
        # Market shut: sleep to the next open, counter frozen (not a failure).
        new_failure_count = failure_count
        if next_open is None:
            next_delay: float = SHORT_RETRY
        else:
            delta = (next_open - now).total_seconds()
            # No lead-in margin: target exactly next_open. A non-positive delta
            # means we woke on/after the expected open but the state is still
            # closed (holiday / half-day) — short-retry and re-read next time.
            next_delay = min(delta, MAX_SLEEP) if delta > 0 else SHORT_RETRY
    elif should_write:
        # Success: reset the failure counter and resume the base cadence.
        new_failure_count = 0
        next_delay = base_interval
    else:
        # Non-closed cycle with no writable price: a failure — back off.
        new_failure_count = failure_count + 1
        next_delay = _backoff_delay(base_interval, new_failure_count)

    return should_write, next_delay, new_failure_count, mark_dirty


def perf_should_run(events_changed: bool, backfill_pending: bool,
                    live_write: bool) -> bool:
    """Gate one run of the perf-recompute interval job (design #605, issue #618).

    Now that ``update_account_metrics`` is its own interval job (it can no longer
    piggyback on the per-symbol scrape without firing N recomputes per market-open
    wave), it must stay as quiet as prices do overnight. Run **only when something
    changed** since the last recompute; skip ⟺ events unchanged **and** no
    backfill watermark **and** no live ``REGULAR`` write since the last run:

      * ``events_changed`` — the events cache reloaded (a new list object): the
        whole series is rewritten.
      * ``backfill_pending`` — a backfill watermark (``_perf_dirty_from``) is set:
        earlier prices were filled, so the stale tail must be rewritten.
      * ``live_write`` — a ``REGULAR`` write landed since the last run (the
        boot-seeded live-write bool): today's close is fresh.

    All-quiet skips, so a fully-closed market wave writes no ``account_metrics`` /
    ``portfolio_totals`` point — the non-trading-day gap is by design (#606) and
    there is no closed-day Parquet drip (#597).
    """
    return events_changed or backfill_pending or live_write


def forward_backfill_window(
    newest: Optional[datetime], now: datetime, chunk_days: int
) -> Optional[Tuple[datetime, datetime]]:
    """Size one forward gap-fill window ``[newest, end]``, or ``None`` (#627/#626).

    Pure mirror of the backward pass's window sizing, injected ``now``, no
    InfluxDB/yfinance — so the "should we fetch, and how wide" decision is unit
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


def compute_pool_size(mode: str, shares: List[dict],
                      exchange_of: Dict[str, Optional[str]]) -> int:
    """Auto executor-pool size for ``SB_DYNAMIC_EXECUTOR_POOL`` (#619, #611).

    Under one self-rescheduling job per symbol (#616), every symbol on the same
    exchange gets the same next-open timestamp, so at market open a whole cohort
    fires together. Size the pool to the busiest wave: the **largest same-exchange
    cohort** drives the scrape workers. Each cohort of ``N`` is spread over the
    ``JITTER_SECONDS`` window, so ``ceil(N × FETCH_EST_SECONDS / JITTER_SECONDS)``
    workers keep up::

        min(reserved + ceil(largest_cohort × FETCH_EST / JITTER), POOL_CAP)

    ``reserved`` covers the non-scrape jobs — ``RESERVED_EVENTS`` (backfill + perf
    + headroom) in events mode, ``RESERVED_MANUAL`` (backfill only) otherwise.
    ``exchange_of`` maps each held symbol to its exchange; a symbol with no known
    exchange (``None``/missing/falsy) is its own **solo market** (cohort of 1),
    never grouped — so an all-unknown portfolio never inflates into one giant
    cohort. The result is clamped to ``[1, POOL_CAP]``: ``POOL_CAP`` bounds only
    this auto formula, never the fixed ``SB_EXECUTOR_POOL`` dial.
    """
    reserved = RESERVED_EVENTS if mode == 'events' else RESERVED_MANUAL

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
    return max(1, min(reserved + scrape_workers, POOL_CAP))


def extract_market_context(info: Optional[dict], history_meta: Optional[dict],
                           now: datetime) -> Tuple[Optional[str], Optional[datetime]]:
    """Extract ``(marketState, next_open)`` from ticker data.

    Prefers the exact next regular open from ``history()`` metadata
    ``currentTradingPeriod.regular.start`` (design #603 amendment). Falls back
    to ``exchangeTimezoneName`` + stdlib ``zoneinfo`` at ~08:00 local on the
    next day (DST handled by ``zoneinfo``; an approximate open is fine — the
    freshly-read ``marketState`` is the authority on wake). ``now`` is injected
    and must be timezone-aware. Returns ``(state, next_open|None)``.
    """
    info = info or {}
    state = info.get('marketState')

    next_open = _exact_next_open(history_meta)
    if next_open is None:
        next_open = _approx_next_open(info, now)
    return state, next_open


def _exact_next_open(history_meta: Optional[dict]) -> Optional[datetime]:
    """The exact regular-session open from ``history()`` metadata, or None.

    Reads ``currentTradingPeriod.regular.start`` (a Unix timestamp) defensively
    — any missing/garbage layer yields None so the caller falls back.
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

    Used only when the exact next-open is unavailable. Returns a UTC datetime.
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
