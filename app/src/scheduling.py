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
from typing import Optional, Tuple

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

# Approximate local open used only when the exact next-open is unavailable.
# ``marketState`` remains the authority on wake, so an early guess is fine.
_APPROX_OPEN_HOUR = 8


def is_closed(state) -> bool:
    """True only for a recognized closed-family state (fail-open coercion)."""
    return state in CLOSED_STATES


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

    ``failure_count`` is threaded through unchanged here; consecutive-failure
    backoff is deferred to the dead-ticker-guard slice.

    Returns ``(should_write, next_delay, new_failure_count, mark_dirty)``.
    """
    closed = is_closed(state)

    should_write = (not closed) and price_present
    mark_dirty = should_write  # a REGULAR write makes the perf series stale

    if not closed:
        next_delay: float = base_interval
    elif next_open is None:
        next_delay = SHORT_RETRY
    else:
        delta = (next_open - now).total_seconds()
        # No lead-in margin: target exactly next_open. A non-positive delta
        # means we woke on/after the expected open but the state is still
        # closed (holiday / half-day) — short-retry and re-read next time.
        next_delay = min(delta, MAX_SLEEP) if delta > 0 else SHORT_RETRY

    return should_write, next_delay, failure_count, mark_dirty


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
