"""The exchange rate — one pure module with a TTL cache (issue #702, ADR-0002)."""
import bisect
import re
from datetime import date, datetime
from typing import Callable, Dict, List, Optional, Tuple

from logfmt_logger import getLogger

from application import instants

logger = getLogger("fx")

SUBUNITS: Dict[str, Tuple[str, float]] = {
    'GBp': ('GBP', 100.0),
    'ILA': ('ILS', 100.0),
    'ZAc': ('ZAR', 100.0),
}

DEFAULT_TTL = 300.0

_DAILY_LOOKBACK_DAYS = 10

RESOLVED = 'resolved'
UNRESOLVED = 'unresolved'
FAILED = 'failed'


_CODE = re.compile(r'^[A-Za-z]{3}$')


def normalise(currency: Optional[str]) -> Tuple[Optional[str], float]:
    """``('GBp')`` → ``('GBP', 100.0)``; a code → itself and ``1.0``; else ``None``."""
    if not currency:
        return None, 1.0
    text = str(currency).strip()
    if not text:
        return None, 1.0
    if text in SUBUNITS:
        main, per_unit = SUBUNITS[text]
        return main, per_unit
    if not _CODE.match(text):
        return None, 1.0
    return text.upper(), 1.0


def pair_symbol(from_ccy: str, to_ccy: str) -> str:
    """Yahoo Finance's name for a currency pair: ``USDEUR=X``."""
    return f'{from_ccy}{to_ccy}=X'


class Rates:
    """The rate source: an injected fetch behind a TTL cache."""

    def __init__(self,
                 fetch_live: Callable[[str], Optional[float]],
                 fetch_series: Optional[Callable[[str, date, date], Dict[date, float]]] = None,
                 ttl: float = DEFAULT_TTL,
                 clock: Optional[Callable[[], float]] = None):
        self._fetch_live = fetch_live
        self._fetch_series = fetch_series
        self._ttl = ttl
        self._clock = clock or _monotonic
        self._live: Dict[str, Tuple[Optional[float], float]] = {}
        self._daily: Dict[str, Dict[date, float]] = {}
        self._windows: Dict[str, List[Tuple[date, date]]] = {}
        self._failed_at: Dict[str, float] = {}

    def rate(self, from_ccy: Optional[str], to_ccy: Optional[str],
             at: Optional[date] = None) -> Optional[float]:
        """What one unit of ``from_ccy`` is worth in ``to_ccy``, or ``None``."""
        source, per_unit = normalise(from_ccy)
        target, _ = normalise(to_ccy)
        if source is None or target is None:
            return None
        if source == target:
            return 1.0 / per_unit

        pair = pair_symbol(source, target)
        base = self._live_rate(pair) if at is None else self._daily_rate(pair, at)
        return None if base is None else base / per_unit

    def series(self, from_ccy: Optional[str], to_ccy: Optional[str],
               start: date, end: date) -> Dict[date, float]:
        """Fetch (once) and cache the pair's daily rates over ``[start, end]``."""
        return self.observe(from_ccy, to_ccy, start, end)[1]

    def observe(self, from_ccy: Optional[str], to_ccy: Optional[str],
                start: date, end: date) -> Tuple[str, Dict[date, float]]:
        """The same fetch as :meth:`series`, **and what it did** (issue #704)."""
        source, _ = normalise(from_ccy)
        target, _ = normalise(to_ccy)
        if source is None or target is None:
            return FAILED, {}
        if source == target:
            return RESOLVED, {}
        pair = pair_symbol(source, target)
        outcome = self._ensure_window(pair, start, end)
        return outcome, dict(self._daily.get(pair, {}))

    def answers_from_cache(self, from_ccy: Optional[str],
                           to_ccy: Optional[str],
                           start: date, end: date) -> bool:
        """Whether :meth:`observe` over that window would ask Yahoo nothing."""
        source, _ = normalise(from_ccy)
        target, _ = normalise(to_ccy)
        if source is None or target is None or source == target:
            return True
        pair = pair_symbol(source, target)
        return any(known[0] <= start and end <= known[1]
                   for known in self._windows.get(pair, ()))

    def _live_rate(self, pair: str) -> Optional[float]:
        """The pair's live rate, refetched at most once per ``ttl``."""
        cached = self._live.get(pair)
        now = self._clock()
        if cached is not None and now - cached[1] < self._ttl:
            return cached[0]

        try:
            fetched = self._fetch_live(pair)
        except Exception as exc:
            logger.warning(f"Could not fetch the {pair} rate: {exc}")
            fetched = None
        self._live[pair] = (fetched, now)
        return fetched

    def _daily_rate(self, pair: str, day: date) -> Optional[float]:
        """The pair's rate on ``day``, forward-filled inside a fetched window."""
        if not self._covers(pair, day):
            self._ensure_window(
                pair, _shift(day, -_DAILY_LOOKBACK_DAYS), _shift(day, 1))

        known = self._daily.get(pair)
        if not known:
            return None
        days = sorted(known)
        index = bisect.bisect_right(days, day)
        if not index:
            return None
        nearest = days[index - 1]
        if (day - nearest).days > _DAILY_LOOKBACK_DAYS:
            return None
        return known[nearest]

    def _ensure_window(self, pair: str, start: date, end: date) -> str:
        """Fetch a window unless it has already been asked for. Says what it did."""
        if any(known[0] <= start and end <= known[1]
               for known in self._windows.get(pair, ())):
            return RESOLVED if self._resolves(pair, end) else UNRESOLVED
        if self._fetch_series is None:
            return FAILED
        failed_at = self._failed_at.get(pair)
        if failed_at is not None and self._clock() - failed_at < self._ttl:
            return FAILED
        try:
            fetched = self._fetch_series(pair, start, end) or {}
        except Exception as exc:
            logger.warning(
                f"Could not fetch the {pair} history over [{start}, {end}]: {exc}")
            self._failed_at[pair] = self._clock()
            return FAILED
        self._failed_at.pop(pair, None)
        self._daily.setdefault(pair, {}).update(
            {_as_date(day): float(value) for day, value in fetched.items()})
        self._windows.setdefault(pair, []).append((start, end))
        return RESOLVED if self._resolves(pair, end) else UNRESOLVED

    def _resolves(self, pair: str, end: date) -> bool:
        """Whether the pair carries a rate a window ending on ``end`` can use."""
        return any(day <= end for day in self._daily.get(pair, ()))

    def _covers(self, pair: str, day: date) -> bool:
        return any(start <= day <= end
                   for start, end in self._windows.get(pair, ()))


def convert(price: Optional[float], from_ccy: Optional[str],
            to_ccy: Optional[str], rates: Optional[Rates],
            at: Optional[date] = None) -> Tuple[Optional[float], Optional[float]]:
    """``(price_converted, fx_rate)`` for one observed price."""
    if price is None or rates is None or not to_ccy:
        return None, None
    factor = rates.rate(from_ccy, to_ccy, at)
    if factor is None:
        return None, None
    return price * factor, factor


def _monotonic() -> float:
    import time
    return time.monotonic()


def _shift(day: date, days: int) -> date:
    from datetime import timedelta
    return day + timedelta(days=days)


def _as_date(value) -> date:
    """A ``date`` out of whatever the injected fetch handed back.

    Through :func:`instants.utc` and not ``astimezone``, which is the whole
    point: a naive instant means **UTC** here (#843), where ``astimezone``
    reads it as the machine's local time and shifts the day by its offset.
    """
    normalised = instants.utc(value)
    return (normalised.date() if isinstance(normalised, datetime)
            else normalised)


__all__ = [
    'SUBUNITS', 'DEFAULT_TTL', 'RESOLVED', 'UNRESOLVED', 'FAILED',
    'normalise', 'pair_symbol', 'Rates', 'convert',
]
