"""Market-aware per-symbol scheduling — pure cadence & context decisions."""

from datetime import datetime, timedelta, timezone
from math import ceil, isclose
from typing import Dict, List, NamedTuple, Optional, Tuple

from application import market_info

try:  # zoneinfo is stdlib on 3.9+; no new dependency (design #602/#603).
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - defensive, py<3.9 unsupported anyway
    ZoneInfo = None
    ZoneInfoNotFoundError = Exception

CLOSED_STATES = frozenset({'CLOSED', 'POST', 'POSTPOST', 'PRE', 'PREPRE'})

BEFORE_SESSION_STATES = frozenset({'PRE', 'PREPRE'})
AFTER_SESSION_STATES = frozenset({'POST', 'POSTPOST'})

SHORT_RETRY = 60           # s: re-probe when the next open is unknown
MAX_SLEEP = 24 * 60 * 60   # s: hard cap on a single deep-sleep to next open

OPENING_LAG = 15 * 60      # s: the ambiguous reading only — see above

PERF_TICK = 120            # s

BACKFILL_JOB_ID = 'backfill'
PERF_JOB_ID = 'perf'

FAILURE_GRACE = 3          # K: first K failures still re-arm at base_interval
_BACKOFF_FACTOR = 2        # geometric growth per failure beyond the grace window
_MAX_BACKOFF_EXP = 32

_APPROX_OPEN_HOUR = 8

JITTER_SECONDS = 30

POOL_CAP = 50              # hard bound on the *auto* formula only (not the dial)
FETCH_EST_SECONDS = 5      # rough wall-clock of one _fetch_ticker_data cycle
RESERVED = 3               # backfill + perf (+ headroom), the non-scrape jobs


def is_closed(state) -> bool:
    """True only for a recognized closed-family state (fail-open coercion)."""
    return state in CLOSED_STATES


def is_before_session(state) -> bool:
    """True for a state that names the side **before** a session (issue #769)."""
    return state in BEFORE_SESSION_STATES


def is_after_session(state) -> bool:
    """True for a state that names the side **after** a session (issue #769)."""
    return state in AFTER_SESSION_STATES


def backoff_delay(base_interval: int, failure_count: int) -> float:
    """Re-arm delay for ``failure_count`` consecutive failures (design #608)."""
    excess = failure_count - FAILURE_GRACE
    if excess <= 0:
        return base_interval
    exponent = min(excess, _MAX_BACKOFF_EXP)
    return min(base_interval * (_BACKOFF_FACTOR ** exponent), MAX_SLEEP)


def decide(state, price_present: bool, next_open: Optional[datetime],
           now: datetime, failure_count: int,
           base_interval: int) -> Tuple[bool, float, int]:
    """Decide one scrape cycle's write gate and next re-arm delay."""
    closed = is_closed(state)

    should_write = (not closed) and price_present

    if closed:
        new_failure_count = failure_count
        if next_open is None:
            next_delay: float = SHORT_RETRY
        else:
            delta = (next_open - now).total_seconds()
            next_delay = min(delta, MAX_SLEEP) if delta > 0 else SHORT_RETRY
    elif should_write:
        new_failure_count = 0
        next_delay = base_interval
    else:
        new_failure_count = failure_count + 1
        next_delay = backoff_delay(base_interval, new_failure_count)

    return should_write, next_delay, new_failure_count


HOURLY_CEILING_DAYS = 729

HOURLY = '1h'
DAILY = '1d'


def history_interval(start: datetime, now: datetime) -> str:
    """The finest interval Yahoo still sells for a window starting at ``start``."""
    return HOURLY if (now - start).days <= HOURLY_CEILING_DAYS else DAILY


def clip_to_hourly_ceiling(start: datetime, end: datetime,
                           now: datetime) -> datetime:
    """``start``, bounded at the ceiling when ``[start, end]`` straddles it (#783)."""
    if history_interval(start, now) == HOURLY:
        return start
    ceiling = now - timedelta(days=HOURLY_CEILING_DAYS)
    if ceiling < end and (end - ceiling) >= timedelta(days=1):
        return ceiling
    return start


def forward_backfill_window(
    newest: Optional[datetime], now: datetime, chunk_days: int
) -> Optional[Tuple[datetime, datetime]]:
    """Size one forward gap-fill window ``[newest, end]``, or ``None`` (#627/#626)."""
    if newest is None:
        return None
    if newest.tzinfo is None:
        newest = newest.replace(tzinfo=timezone.utc)
    if (now - newest).days < 1:
        return None
    end = min(newest + timedelta(days=chunk_days), now)
    ceiling = now - timedelta(days=HOURLY_CEILING_DAYS)
    if history_interval(newest, now) == DAILY and ceiling < end:
        end = ceiling
    return newest, end


_STALENESS_REL_TOL = 1e-9


class SondeState(NamedTuple):
    """The price-freshness sonde's per-(symbol, account) memory (issue #628)."""
    stored_price: float
    frozen_since: datetime
    last_seen: datetime


def price_freshness_step(
    prev: Optional[SondeState], live_price: Optional[float],
    stored_price: Optional[float], now: datetime, horizon: float,
) -> Tuple[Optional[SondeState], bool]:
    """Advance the price-freshness liveness sonde one ``REGULAR`` cycle (#628/#626)."""
    if horizon <= 0 or stored_price is None:
        return None, False

    value_advanced = prev is None or not isclose(
        prev.stored_price, stored_price, rel_tol=_STALENESS_REL_TOL, abs_tol=0.0)
    polling_broke = prev is not None and (
        now - prev.last_seen).total_seconds() > horizon
    if value_advanced or polling_broke:
        return SondeState(stored_price, now, now), False

    frozen_since = prev.frozen_since
    moved = live_price is not None and not isclose(
        live_price, stored_price, rel_tol=_STALENESS_REL_TOL, abs_tol=0.0)
    stale = moved and (now - frozen_since).total_seconds() >= horizon
    return SondeState(stored_price, frozen_since, now), stale


class RearmSplit(NamedTuple):
    """How a new ``regular_interval`` divides the held symbols (issue #701)."""

    rearm: Tuple[str, ...]
    self_arming: Tuple[str, ...]
    asleep: Tuple[str, ...]


def rearm_split(symbols, closed: Dict[str, Optional[bool]],
                armed) -> RearmSplit:
    """Divide the held symbols the way a new cadence actually reaches them."""
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
    """Auto executor-pool size — **always**, since #701 (#619, design #611)."""
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
    """Extract ``(marketState, next_open)`` from ticker data."""
    info = info or {}
    state = market_info.market_state_of(info)

    current_open = _current_regular_open(history_meta)
    if current_open is None:
        return state, _approx_next_open(info, now)
    if current_open > now:
        return state, current_open

    if is_before_session(state):
        return state, None

    bounds = _opening_hour_bounds(current_open, info, now)
    if bounds is None:
        return state, None
    previous, following = bounds
    if is_after_session(state):
        return state, following
    if (now - previous).total_seconds() <= OPENING_LAG:
        return state, None
    return state, following


def _current_regular_open(history_meta: Optional[dict]) -> Optional[datetime]:
    """The **current** trading period's regular open, or None."""
    start = market_info.regular_period_start(history_meta)
    if start is None:
        return None
    try:
        return datetime.fromtimestamp(start, tz=timezone.utc)
    except (OSError, ValueError, OverflowError, TypeError):
        return None


def _exchange_tz(info: dict):
    """The venue's ``ZoneInfo``, or None — the one place that parses the name."""
    tz_name = market_info.exchange_timezone_name_of(info)
    if not tz_name or ZoneInfo is None:
        return None
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return None


def _opening_hour_bounds(current_open: datetime, info: dict,
                         now: datetime) -> Optional[Tuple[datetime, datetime]]:
    """``(previous, following)`` occurrences of the venue's opening hour (#769)."""
    tz = _exchange_tz(info)
    if tz is None:
        return None
    local_open = current_open.astimezone(tz)
    local_now = now.astimezone(tz)
    previous = local_now.replace(
        hour=local_open.hour, minute=local_open.minute,
        second=local_open.second, microsecond=0)
    if previous > local_now:
        previous -= timedelta(days=1)
    following = previous + timedelta(days=1)
    if following <= local_now:          # defensive: a DST day is never < 23 h
        following += timedelta(days=1)
    return previous.astimezone(timezone.utc), following.astimezone(timezone.utc)


def _approx_next_open(info: dict, now: datetime) -> Optional[datetime]:
    """~08:00 local on the next day in the exchange timezone, or None."""
    tz = _exchange_tz(info)
    if tz is None:
        return None

    local_now = now.astimezone(tz)
    candidate = local_now.replace(
        hour=_APPROX_OPEN_HOUR, minute=0, second=0, microsecond=0)
    if candidate <= local_now:
        candidate = candidate + timedelta(days=1)
    return candidate.astimezone(timezone.utc)
