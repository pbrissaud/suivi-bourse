"""The exchange rate — one pure module with a TTL cache (issue #702, ADR-0002).

There are **two levels of currency and not three**: the *reporting* currency,
which is global and has no default, and the *quote* currency of a security,
which its exchange decides. ``Account.currency`` was the third and it is deleted
rather than converted — in a three-level model, "a EUR account holding a USD
security" is a sentence with a meaning, therefore a bug needing a guard, a test
and a degraded screen; here it has no referent at all.

This module is what turns the second into the first, and four things about it
are decisions rather than details.

**It is a module in the taste of `scheduling.py` / `performance.py`**: no store,
no yfinance, no clock of its own. The fetch is *injected*, which is what lets the
whole of it be tested against a fake without a network — the same seam
``performance.price_at`` uses. What it does own, and what a pure function could
not, is the **cache**, so it is a small class rather than a bare function.

**The TTL is what makes two positions comparable.** A market-open wave scrapes N
symbols over as many seconds; without a shared rate they would be converted at N
slightly different ones and the same portfolio would not add up to its own total.
One fetch per pair per :data:`DEFAULT_TTL` is what removes that, and it is also
the whole of the pacing story: no pseudo-symbol ``EURUSD=X`` in the scheduler (a
currency pair has no ``marketState`` that projects onto the equity model), no
``fx_rates`` table, no extra job.

**``GBp`` is normalised to ``GBP ÷ 100`` before any pair is named.** London
listings quote in pence; ``GBpEUR=X`` does not exist, and getting it wrong is
wrong by a factor of a hundred while looking entirely plausible. The
normalisation is folded into the **rate**, not applied to the price, so that
``price_converted == price_native × fx_rate`` holds on the stored row — which is
what makes the row a journal one can read back (*"2 345 € — 10 × 234,50 $ at
1,0844 on 5 August"*) rather than three numbers that do not reconcile.

**A rate that cannot be had is ``None``, never an exception and never ``1.0``.**
The write path turns it into a ``price_converted`` of ``NULL`` beside a
``price_native`` that landed: the quote is never lost over a currency, and the
lateral pass (#704) is what repairs the column afterwards.
"""
import bisect
from datetime import date, datetime, timezone
from typing import Callable, Dict, List, Optional, Tuple

from logfmt_logger import getLogger

logger = getLogger("fx")

#: Quote currencies that are a **subunit** of a real ISO-4217 code, with how
#: many of them make one of it. Matched **case-sensitively**, and that is the
#: point rather than an oversight: ``GBp`` and ``GBP`` differ by one letter's
#: case and by a factor of a hundred, so an ``upper()`` anywhere on this path
#: turns pence into pounds silently. yfinance spells London pence exactly
#: ``GBp``.
SUBUNITS: Dict[str, Tuple[str, float]] = {
    'GBp': ('GBP', 100.0),
}

#: How long a live rate is reused. Long enough that a whole market-open wave
#: shares one fetch — which is the property that makes the positions in it
#: comparable — and short enough that the number beside a price is not visibly
#: from another hour. It is **not a dial**: the registry is closed at six keys
#: (spec #695 § 13), and an install whose rates were staler than another's would
#: be an install whose pages do not mean the same thing.
DEFAULT_TTL = 300.0

#: How far back :meth:`Rates.rate` looks for a daily rate when it has to fetch
#: one for a past day. A window rather than a day because a rate is a *market*
#: series: a Sunday, a holiday and a Christmas week have no close of their own,
#: and the honest answer for them is the last one before.
_DAILY_LOOKBACK_DAYS = 10


def normalise(currency: Optional[str]) -> Tuple[Optional[str], float]:
    """``('GBp')`` → ``('GBP', 100.0)``; anything else → itself and ``1.0``.

    The pair-naming rule, on its own so that every caller goes through it: the
    first return value is the code a pair may be built from, the second is how
    many of the *quoted* unit make one of it.

    ``None`` and the empty string pass through as ``None``: a quote with no
    currency is not convertible, and inventing one here would produce a rate for
    a pair nobody observed.
    """
    if not currency:
        return None, 1.0
    text = str(currency).strip()
    if not text:
        return None, 1.0
    if text in SUBUNITS:
        main, per_unit = SUBUNITS[text]
        return main, per_unit
    return text.upper(), 1.0


def pair_symbol(from_ccy: str, to_ccy: str) -> str:
    """Yahoo Finance's name for a currency pair: ``USDEUR=X``.

    Both codes are expected to be **normalised** already — that is the whole of
    :func:`normalise`'s reason for existing, and the one place a ``GBp`` would
    otherwise leak into a ticker that does not exist.
    """
    return f'{from_ccy}{to_ccy}=X'


class Rates:
    """The rate source: an injected fetch behind a TTL cache.

    Two fetches, because the two questions are not the same shape:

    * ``fetch_live(pair) -> Optional[float]`` — what the pair is worth now. The
      live scrape's question, asked once per pair per :data:`ttl`.
    * ``fetch_series(pair, start, end) -> Mapping[date, float]`` — the pair's
      daily closes over a window. The **rebuild**'s question: it fetches the
      pair's history beside the price history it is already fetching, so a
      backfilled point is converted at the rate of *its own day* rather than at
      today's.

    ``clock`` is injected for the same reason it is everywhere else in this
    codebase: a TTL tested against ``time.monotonic`` is a TTL tested with
    ``sleep``.
    """

    def __init__(self,
                 fetch_live: Callable[[str], Optional[float]],
                 fetch_series: Optional[Callable[[str, date, date], Dict[date, float]]] = None,
                 ttl: float = DEFAULT_TTL,
                 clock: Optional[Callable[[], float]] = None):
        self._fetch_live = fetch_live
        self._fetch_series = fetch_series
        self._ttl = ttl
        self._clock = clock or _monotonic
        #: pair -> (rate, taken_at). The live half.
        self._live: Dict[str, Tuple[Optional[float], float]] = {}
        #: pair -> {day: rate}, sorted lazily. The historical half, and it has
        #: **no TTL**: a closed day's rate is final, so re-expiring it would
        #: re-fetch a number that cannot have changed.
        self._daily: Dict[str, Dict[date, float]] = {}
        #: pair -> the windows already asked for, so a day that is genuinely
        #: absent from a fetched window (a weekend) is forward-filled instead of
        #: re-fetched on every point of that weekend.
        self._windows: Dict[str, List[Tuple[date, date]]] = {}

    # ------------------------------------------------------------------ #
    # The one entry point
    # ------------------------------------------------------------------ #

    def rate(self, from_ccy: Optional[str], to_ccy: Optional[str],
             at: Optional[date] = None) -> Optional[float]:
        """What one unit of ``from_ccy`` is worth in ``to_ccy``, or ``None``.

        ``at`` is a **calendar day** and ``None`` means *now*: the live rate for
        the live writer, the day's rate for a point the rebuild is placing in the
        past.

        The factor answered is the one a **price** is multiplied by, subunit
        included — so ``rate('GBp', 'EUR')`` is a hundredth of
        ``rate('GBP', 'EUR')``. That is what keeps ``price_converted ==
        price_native × fx_rate`` true of the stored row, and it is why the stored
        rate is described as *the rate the conversion used* rather than as a
        quotation someone could look up.

        ``None`` on every unanswerable case, and they are deliberately not told
        apart here: no reporting currency yet, a quote with no currency, a pair
        the fetch could not resolve. What the caller does with all three is
        identical — write the point with no converted price — and the difference
        between *transient* and *terminal* is the rebuild's to name, on the
        record it publishes (spec #695 § 7), not this module's.
        """
        source, per_unit = normalise(from_ccy)
        target, _ = normalise(to_ccy)
        if source is None or target is None:
            return None
        if source == target:
            # No pair, no fetch, no failure mode. A portfolio reported in the
            # currency its securities are quoted in is the common case and must
            # not depend on Yahoo answering anything.
            return 1.0 / per_unit

        pair = pair_symbol(source, target)
        base = self._live_rate(pair) if at is None else self._daily_rate(pair, at)
        return None if base is None else base / per_unit

    def series(self, from_ccy: Optional[str], to_ccy: Optional[str],
               start: date, end: date) -> Dict[date, float]:
        """Fetch (once) and cache the pair's daily rates over ``[start, end]``.

        The rebuild's prefetch: one call beside the chunk of prices it is about
        to convert, after which every :meth:`rate` on a day of that chunk is a
        cache hit. Returns what is known of the window — the mapping is a
        *market* series, so weekends and holidays are simply absent from it and
        :meth:`rate` forward-fills them.

        The mapping it answers with is in the **normalised** pair's unit, not the
        quoted one: it is a prefetch, and the subunit is applied by
        :meth:`rate`, once, where the price is.
        """
        source, _ = normalise(from_ccy)
        target, _ = normalise(to_ccy)
        if source is None or target is None or source == target:
            return {}
        pair = pair_symbol(source, target)
        self._ensure_window(pair, start, end)
        return dict(self._daily.get(pair, {}))

    # ------------------------------------------------------------------ #
    # The two halves of the cache
    # ------------------------------------------------------------------ #

    def _live_rate(self, pair: str) -> Optional[float]:
        """The pair's live rate, refetched at most once per ``ttl``.

        A **failed** fetch is cached too, and for the same span. Without that, a
        wave of forty symbols quoted in an unresolvable currency would ask Yahoo
        forty times for a ticker that does not exist, every cycle, forever — the
        exact herd the TTL exists to prevent, in the one case where the answer is
        certain not to change.
        """
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
        """The pair's rate on ``day``, forward-filled inside a fetched window.

        Forward-filling is the correct reading rather than a convenience: a rate
        is a market series and a Sunday has no close of its own, so the rate that
        applied on that Sunday *is* Friday's. Bounded by what has actually been
        fetched, so a day before anything known triggers a fetch instead of
        silently borrowing a rate from the wrong side of a gap.
        """
        if not self._covers(pair, day):
            self._ensure_window(
                pair, _shift(day, -_DAILY_LOOKBACK_DAYS), _shift(day, 1))

        known = self._daily.get(pair)
        if not known:
            return None
        days = sorted(known)
        index = bisect.bisect_right(days, day)
        return known[days[index - 1]] if index else None

    def _ensure_window(self, pair: str, start: date, end: date) -> None:
        """Fetch a window unless it has already been asked for."""
        if self._fetch_series is None:
            return
        if any(known[0] <= start and end <= known[1]
               for known in self._windows.get(pair, ())):
            return
        try:
            fetched = self._fetch_series(pair, start, end) or {}
        except Exception as exc:
            logger.warning(
                f"Could not fetch the {pair} history over [{start}, {end}]: {exc}")
            return
        self._daily.setdefault(pair, {}).update(
            {_as_date(day): float(value) for day, value in fetched.items()})
        self._windows.setdefault(pair, []).append((start, end))

    def _covers(self, pair: str, day: date) -> bool:
        return any(start <= day <= end
                   for start, end in self._windows.get(pair, ()))


def convert(price: Optional[float], from_ccy: Optional[str],
            to_ccy: Optional[str], rates: Optional[Rates],
            at: Optional[date] = None) -> Tuple[Optional[float], Optional[float]]:
    """``(price_converted, fx_rate)`` for one observed price.

    The whole of what a writer needs, so that no write path has to remember the
    order of the two questions. Both halves are ``None`` together — a converted
    price with no rate beside it would be a figure nobody could explain three
    years later, which is precisely what storing the rate is for.
    """
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
    """A ``date`` out of whatever the injected fetch handed back."""
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).date()
    return value


__all__ = [
    'SUBUNITS', 'DEFAULT_TTL', 'normalise', 'pair_symbol', 'Rates', 'convert',
]
