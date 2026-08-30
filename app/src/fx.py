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

**And that pass needs one thing :meth:`Rates.rate` deliberately refuses to
say** (issue #704): *why* there is no rate. Three answers, not two —
:func:`observe` names them — because a fetch that did not complete and a pair
yfinance has never heard of ask for opposite things: the first is retried for
ever behind #617's back-off, the second is a **reply** and arms the
``unconvertible`` terminal that tells the owner to act. Collapsing them into
``None`` is right for a writer (which writes the point either way) and wrong
for the pass whose whole subject is the difference.
"""
import bisect
import re
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
    # Tel-Aviv quotes in agorot and Johannesburg in cents, spelled by yfinance
    # exactly like this. Left out, ``normalise`` answers the subunit unchanged,
    # ``pair_symbol`` builds ``ILAEUR=X`` — a ticker that does not exist — and
    # the pass arms ``unconvertible`` on a line that converts perfectly well
    # through ``ILS``. Same factor of a hundred as London's, two places more.
    'ILA': ('ILS', 100.0),
    'ZAc': ('ZAR', 100.0),
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

#: What one window fetch **did**, for the caller that has to tell a failure from
#: a reply (issue #704). ``rate()`` folds all three into ``None`` on purpose;
#: :meth:`Rates.observe` is the one entry point that keeps them apart.
#:
#: * :data:`RESOLVED` — the pair is known and its rates are cached.
#: * :data:`UNRESOLVED` — the fetch **completed** and the pair has nothing:
#:   ``XYZEUR=X`` is not a ticker. A reply, never a failure, and the only one of
#:   the three that may arm a terminal.
#: * :data:`FAILED` — the fetch itself did not complete (a raise). Nothing was
#:   learnt about the pair, so nothing may be concluded about it.
RESOLVED = 'resolved'
UNRESOLVED = 'unresolved'
FAILED = 'failed'


#: What a currency code looks like: three letters, and nothing else. A **shape**
#: and never a list — ISO-4217 has 180 entries, gains one when a country
#: redenominates, and a table of them here would be a second thing to maintain
#: that fails closed on the day it falls behind. Read after :data:`SUBUNITS`, so
#: ``GBp`` is a code by the time it gets here.
_CODE = re.compile(r'^[A-Za-z]{3}$')


def normalise(currency: Optional[str]) -> Tuple[Optional[str], float]:
    """``('GBp')`` → ``('GBP', 100.0)``; a code → itself and ``1.0``; else ``None``.

    The pair-naming rule, on its own so that every caller goes through it: the
    first return value is the code a pair may be built from, the second is how
    many of the *quoted* unit make one of it.

    ``None`` and the empty string answer ``None``: a quote with no currency is
    not convertible, and inventing one here would produce a rate for a pair
    nobody observed.

    **And so does anything that is not shaped like a code** (issue #845). This
    is the guard :func:`pair_symbol`'s docstring already claims to be — *the one
    place a ``GBp`` would otherwise leak into a ticker that does not exist* —
    and it is written here rather than at each call site because there are three
    of those and the one that had no guard is the one that wrote the defect: the
    word the fetch used to write for a field Yahoo held no value for reached the
    currency column, came back out of it, and was named as one half of
    ``UNDEFINEDEUR=X``. One rule of *form* covers every edge at once, including
    the ones nobody has met yet, which is strictly more than a guard per site
    could do.

    What the shape does **not** do, said plainly so nobody reads more into it
    than it holds: it is not an ISO-4217 membership test. ``ZZZ`` and ``ABC``
    are three letters, so they cross this function and name ``ZZZEUR=X`` — a
    ticker Yahoo answers nothing for, which resolves as :data:`UNRESOLVED` and
    is handled like any other pair that does not exist. That residue is the
    price of not keeping a table of 180 codes here, and it is cheap: nothing
    upstream *invents* three letters, so the population it lets through is
    empty, while the population the shape stops — a word, a name, a number,
    anything longer or shorter — is the one the defect came from.
    """
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
    """Yahoo Finance's name for a currency pair: ``USDEUR=X``.

    Both codes are expected to be **normalised** already — that is the whole of
    :func:`normalise`'s reason for existing, and the one place a ``GBp`` would
    otherwise leak into a ticker that does not exist. Since #845 that
    expectation is enforceable rather than hoped for: ``normalise`` answers
    ``None`` for anything that is not shaped like a code, and every caller here
    stops on the ``None`` before there is a pair to name.
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

    **The caches carry no lock, deliberately.** Several scrape threads call
    :meth:`rate` at once, and the rule this codebase follows is that *a lock
    never covers a fetch* (issue #668) — one held here would serialise the whole
    market-open wave behind one yfinance round trip, which is the opposite of
    what the TTL is for. Dict assignment is atomic under the GIL, so the worst
    a race produces is two threads fetching the same pair in the same second and
    the second overwriting the first with an equal value. That is a duplicated
    request, bounded by the TTL, and never a wrong rate.
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
        #: pair -> when a window fetch last **failed**, so an outage costs one
        #: request rather than one per point. Only a *successful* fetch records
        #: a window above, so after a failed prefetch every point of the chunk
        #: fell through ``_covers`` and asked for an eleven-day window of its
        #: own: up to 365 extra requests to Yahoo, on the job that already emits
        #: more of them than the rest of the application, and while it is
        #: already failing. TTL'd rather than remembered for good — a failure is
        #: transitory by nature, and the same TTL the live half uses is the one
        #: rhythm this class has.
        self._failed_at: Dict[str, float] = {}

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
        return self.observe(from_ccy, to_ccy, start, end)[1]

    def observe(self, from_ccy: Optional[str], to_ccy: Optional[str],
                start: date, end: date) -> Tuple[str, Dict[date, float]]:
        """The same fetch as :meth:`series`, **and what it did** (issue #704).

        Answers ``(outcome, rates)`` where the outcome is one of
        :data:`RESOLVED` / :data:`UNRESOLVED` / :data:`FAILED`. The lateral pass
        is the caller: it repairs the points whose conversion is missing, and its
        two stopping conditions must never be confused — a failure retries for
        ever, a pair that does not resolve arms ``unconvertible`` and asks the
        owner to act.

        **The reporting currency's own code answers `RESOLVED` with no rates and
        no fetch**: there is no pair, :meth:`rate` returns ``1 / per_unit`` for
        every day, and a portfolio reported in the currency its securities are
        quoted in must not depend on Yahoo answering anything.

        **A code that is missing answers `FAILED`, never `UNRESOLVED`**, and the
        asymmetry is the trap the ticket writes down: a ``price_converted`` of
        ``NULL`` caused by an unanswered reporting currency is *transient* and
        lifted by a write of the owner's, so reading it as a pair that does not
        resolve would make answering the dial change nothing for the whole stock
        already scraped. The caller names those two states before it ever gets
        here; this is the second lock on the same door.
        """
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
        """Whether :meth:`observe` over that window would ask Yahoo nothing.

        The lateral pass reads it to decide whether it owes the backfill's
        politeness delay: sleeping between two requests is a courtesy, sleeping
        after an answer served off the cache is a wait nobody is owed — and a
        pair that never resolves answers off the cache **for ever**, so an
        unconditional sleep would burn ``backfill_delay`` on it every cycle for
        the life of the process.
        """
        source, _ = normalise(from_ccy)
        target, _ = normalise(to_ccy)
        if source is None or target is None or source == target:
            return True
        pair = pair_symbol(source, target)
        return any(known[0] <= start and end <= known[1]
                   for known in self._windows.get(pair, ()))

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

        And bounded **on the right as well**, at the same
        :data:`_DAILY_LOOKBACK_DAYS` the window is opened over. The fill used to
        walk the pair's whole history, every window confounded: when the window
        this day needs failed to fetch, the ``bisect`` happily answered with a
        rate from another year. That rate is then written down —
        ``main._convert_history`` puts it on the point and ``quotes.record_history``
        persists it — and nothing ever judges it again, since the lateral pass
        only looks at ``price_converted IS NULL``. A 2026 quote converted at a
        2020 rate is definitive and invisible. A missing conversion is
        repairable; a wrong one is not, so past the bound the answer is ``None``.
        """
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
        """Fetch a window unless it has already been asked for. Says what it did.

        The outcome is :meth:`observe`'s, and it is decided **here** because this
        is the only place that knows whether a fetch happened: an injected fetch
        that *raises* did not complete (:data:`FAILED`), one that answers nothing
        did (:data:`UNRESOLVED`) — that is the contract the two yfinance calls in
        :mod:`main` honour, and the whole of how #704 tells a Yahoo hiccup from a
        pair that does not exist.

        A window already covered answers off the cache and asks nothing, which is
        what lets a symbol carrying an unresolvable pair re-arm its terminal every
        cycle without emitting a single request. **The verdict is about the
        window, never about the pair** — see :meth:`_resolves`.
        """
        if any(known[0] <= start and end <= known[1]
               for known in self._windows.get(pair, ())):
            return RESOLVED if self._resolves(pair, end) else UNRESOLVED
        if self._fetch_series is None:
            # No historical fetch injected: nothing was asked, so nothing may be
            # concluded. ``FAILED`` is the only answer that arms no terminal.
            return FAILED
        failed_at = self._failed_at.get(pair)
        if failed_at is not None and self._clock() - failed_at < self._ttl:
            # This pair failed a moment ago and nothing about it has changed.
            # Asking again once per point of a chunk is how a Yahoo hiccup
            # turned into a flood; the answer is the same ``FAILED``, which arms
            # no terminal, so nothing downstream reads it as a reply.
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
        """Whether the pair carries a rate a window ending on ``end`` can use.

        A day of its own, or an earlier one :meth:`_daily_rate`'s forward-fill
        carries in — and never *the pair has some rate somewhere*, which is a
        statement about **another** window. Read globally the verdict is not
        stable in time: a window lying before everything the pair has ever
        quoted answers nothing, arms ``unconvertible`` and is remembered; a
        later prefetch then fills ``_daily`` for a window of its own, the same
        question comes back "covered, and the pair has rates", the terminal
        disappears and the pass publishes ``written=0`` for ever with nothing on
        screen saying why those points stay unconverted.
        """
        return any(day <= end for day in self._daily.get(pair, ()))

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
    'SUBUNITS', 'DEFAULT_TTL', 'RESOLVED', 'UNRESOLVED', 'FAILED',
    'normalise', 'pair_symbol', 'Rates', 'convert',
]
