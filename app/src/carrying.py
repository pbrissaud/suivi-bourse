"""The carrying price: what a position is worth on a day nothing priced it.

Issue #706, ADR-0004, spec #695 § 9. Pure, in the exact taste of
:mod:`scheduling` / :mod:`performance` / :mod:`portfolio_view`: no store, no
yfinance, no clock — ``now`` arrives as an argument.

A position held on a day where no price was ever observed — **and never will
be** — is valued at its own unit cost. Not at the last execution price, and not
at zero. Zero is what the app used to do, and it is what dug a crater in the
consolidated curve on the day of a purchase: the cash ledger had already paid
for the shares while the holding was worth nothing, so the total dropped by the
purchase and climbed back the next morning. Without the cash ledger the two
curves ignored the position together and simply stepped up a day late — which is
why no version before the consolidated dashboard ever drew the hole.

Three things about it are decisions rather than details:

* **The rule is keyed on the absence of a price, never on a calendar.** A market
  calendar would explain the hole without filling it, and the app polls listings
  whose exchange it does not always know — the surviving occurrence is an
  Amsterdam execution mis-valued because the app asks Yahoo for the *NASDAQ*
  quote of the same company.

* **The price carried is the weighted average cost — the PMP — and not the
  execution price.** That is what makes the purchase day exactly cash-neutral
  and the latent gain identically zero for as long as the fallback holds, which
  in turn is what makes the convention statable on screen in one sentence. The
  division is the same rule as :func:`events.schemas.unit_cost` (ADR-0003, CGI
  art. 150-0 D), and it is that function that is called: the ``events`` package
  stopped loading its machinery at module level (:pep:`562` in
  ``events/__init__.py``), so the vocabulary now imports nothing but the standard
  library and this module stays pure while spelling the rule once.

* **The predicate has two terms, not one.** *No price was observed* **and** *the
  symbol's backfill is terminal*. The first term lives in :func:`carrying_price`;
  the second is the caller's, and it is the caller's because only the caller
  knows which symbol a figure belongs to. Without it the reconstruction replays a
  portfolio flat-at-cost for four years that takes off abruptly and then corrects
  itself, with the owner having done nothing — *"not yet"* rendered as *"never"*,
  for as long as the rebuild lasts. :func:`is_terminal` is the second term's one
  spelling, and :func:`quotes.terminal_symbols` is what puts the store's answer
  to it.

* **"No price was observed" is about the quote, not about its conversion.**
  Every money figure the app draws reads ``price_converted``, so the naive
  spelling of the first term — *the converted price is absent* — also catches the
  position whose **quote is known and whose rate is not**: a base currency not
  answered yet, or a pair that does not resolve. Those are *waiting*, and
  ``CONTEXT.md`` § Absence names them as a different kind of absence from *carried
  at cost*, never rendered alike (`website/docs/read-your-figures.mdx`: "price
  known, conversion rate missing → waiting for a rate"). Carrying them would
  answer a valuation where the app owes a *pending*, and it would do it durably —
  until #704's lateral pass repairs the stock. So :func:`carrying_price` takes
  **both**: the converted price it may return, and ``quoted``, which says a quote
  was observed at all. A quote with no rate yields ``None``, which is the same
  absence the pre-#706 app showed and the honest one.

* **And a quote is a number *and* a unit** (issue #773). ``quoted`` is not
  *"a ``price_native`` is stored"*: a symbol whose quote currency was never
  recorded carries numbers no rate can ever turn into money, there being no pair
  to name — so it is **not quoted** for the purpose of a valuation, and it joins
  the carrying convention rather than staying permanently in the *waiting* one,
  where every day it was held counted **zero** beside a cash ledger that had
  paid. The two spellings of the term say so, :func:`is_quoted` on a row and
  :func:`quotes.first_quoted_days` on a series; what makes the absence permanent
  rather than premature is the predicate's second term, unchanged. The cost it is
  then carried at is already in the right unit: event amounts are the debit *in
  the reporting currency* (ADR-0002).

The case where carrying **diverges** from a valuation, stated once so nobody has
to rediscover it: a position mixing a purchase and a zero-cost grant *inside* the
window with no price is carried at its cost, therefore at half of what its shares
are worth. Ten bought at 100 and ten granted by dilution is a quantity of 20 for
a basis of 1 000, so a PMP of 50 against a market that would say 100. It takes
both events within the few days before the symbol's first quote, and the answer
is still the honest one: the app knows what the position cost and does not know
what it is worth.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Dict, Optional, Tuple

from events.schemas import EventType, unit_cost


def carrying_price(observed: Optional[float],
                   quoted: bool,
                   quantity: Optional[float],
                   cost_basis: Optional[float]) -> Optional[float]:
    """The price the position is carried at: the market's, failing that its own.

    **One implementation, and that is the acceptance criterion.** The valuation
    (:func:`performance._holdings_value`, the daily curve) and the shares page
    read the same function, because two of them would make two users of the same
    software see two curves for the same portfolio with nothing on screen able to
    say so.

    ``observed`` is the price in the **reporting** currency — the only unit any
    figure downstream is allowed to be in — and ``quoted`` says whether a quote
    was observed **at all**, in any currency: ``price_native`` on a P1 row, a
    native close at or before the day on a series (:func:`was_quoted`). The two
    are not the same question and this is where they stop being conflated
    (issue #706): a security whose quote is known and whose rate is not is
    *waiting*, not priceless, and carrying it at cost would publish a valuation
    where the app owes a pending — durably, since an unresolvable pair keeps its
    ``price_converted`` ``NULL`` until #704's lateral pass. ``quoted`` is required
    rather than defaulted for the same reason: a default is a value some caller
    would inherit without deciding, and either default is a bug.

    ``None`` when there is neither a price nor a quantity: a position nobody
    holds has no carrying price — it has a realized gain, exactly as it has no
    unit cost. A quantity with no basis (a dilution grant) is carried at ``0.0``,
    which is a **figure** and not an absence: it cost nothing, so it is worth
    nothing until the market says otherwise.

    The second term of the predicate — *and the symbol's backfill is terminal* —
    is **not** here. Callers apply it, and they apply it by not calling this
    function at all while history is still being fetched; see :func:`is_terminal`
    and the module docstring.
    """
    if observed is not None:
        return observed
    if quoted:
        # A quote exists and its conversion does not: *waiting for a rate*, which
        # is the absence the page already knows how to say. Not a carrying price.
        return None
    return unit_cost(quantity or 0.0, cost_basis or 0.0)


def was_quoted(first_quoted: Optional[date], day: date) -> bool:
    """Had **any** quote of this symbol been observed by ``day``?

    The series form of :func:`carrying_price`'s ``quoted`` term, and it is a
    forward fill for the same reason the price beside it is one: a valuation asks
    *what was the last thing known on that day*, not *did that day trade*. So one
    scalar per symbol answers it — the first calendar day carrying a
    ``price_native`` (:func:`quotes.first_quoted_days`) — and everything from that
    day on counts as quoted, whether or not its conversion landed.

    ``None`` means the symbol has never been quoted at all, which is ``False``
    on every day: that is the ticket's own subject. Since #773 it also covers
    the symbol quoted **in no nameable unit** — :func:`quotes.first_quoted_days`
    folds that into the mapping rather than into a second argument, because on a
    series the unit is a fact about the symbol while the day is the variable.
    See :func:`is_quoted` for the same rule stated on a row.
    """
    return first_quoted is not None and day >= first_quoted


def is_quoted(price_native: Optional[float], currency: Optional[str]) -> bool:
    """The same term on a **P1 row**: a quote is a number *and* a unit (#773).

    :func:`was_quoted`'s spelling for the reads that hold one observation rather
    than a series — the shares table and its per-account breakdown. It is the
    same rule and it is spelled twice for the reason the module docstring gives
    about ``quoted``: each caller supplies the term from what it has, and a row
    carries the symbol's currency in a column while a series carries it in the
    mapping it was built from.

    Two would be one too many if they could disagree, and this is exactly where
    they must not: the valuation and the shares page read one
    :func:`carrying_price`, so a row carried at cost in the curve and left at an
    em dash in the table would be two users of one software seeing two figures
    for one position. ``price_native`` alone was that disagreement — it says a
    number was observed and nothing about the unit it is in, so a symbol Yahoo
    named no currency for read as *waiting for a rate* here while #773 makes it
    *carried at cost* over there.
    """
    return price_native is not None and bool(currency)


#: What starts a holding window (issue #703). A ``GRANT`` is an acquisition: the
#: share is held from the day it lands, priced or not (``events.schemas.
#: declared_value`` decides the second question and not this one). Reading only
#: ``BUY`` left a portfolio held entirely by grant with no backfill target at
#: all, which is the state the retired ``no_buy`` terminal was reporting.
ACQUISITION_EVENT_TYPES = (EventType.BUY, EventType.GRANT)


def holding_windows(events, held) -> Dict[str, Tuple[date, Optional[date]]]:
    """``{symbol: (first acquisition, last exit or None)}`` out of a raw ledger.

    Pure, and here rather than in ``main`` since #850, beside the
    :func:`holding_bounds` that turns its answer into the two instants a
    backward pass works between: the two halves of one window had a module
    boundary between them, and the module that held the first was the one this
    file's callers must not import.

    It has **two** callers since #706 and they hold two different things.
    :meth:`main.ConfigSnapshot.backfill_windows` reads the published snapshot;
    the perf recompute reads the store directly (its only inputs are the store
    and the clock, #707) and derives ``held`` from its own replay. Both have to
    reach the same window, since one drives the backfill and the other asks
    whether that backfill is finished — and a second spelling of *"when did this
    position start"* would put them a day apart, which is one chunk of
    disagreement about whether a symbol is terminal.
    """
    first: Dict[str, date] = {}
    exits: Dict[str, date] = {}
    for event in events:
        if not event.symbol:
            continue
        if event.event_type in ACQUISITION_EVENT_TYPES:
            known = first.get(event.symbol)
            if known is None or event.date < known:
                first[event.symbol] = event.date
        elif event.event_type == EventType.SELL:
            known = exits.get(event.symbol)
            if known is None or event.date > known:
                exits[event.symbol] = event.date

    return {
        symbol: (acquired, None if symbol in held else exits.get(symbol))
        for symbol, acquired in first.items()
    }


def holding_bounds(acquired: date, exited: Optional[date],
                   now: datetime) -> Tuple[datetime, datetime]:
    """A holding window as the two instants the backward pass works between.

    ``(target, ceiling)`` out of :meth:`main.ConfigSnapshot.backfill_windows`'
    ``(first acquisition, last exit or None)``. A ``None`` end means *still
    held*, so the ceiling is ``now``; a closed position's ceiling is the day
    **after** its last sale, since yfinance reads the end of a range as exclusive
    and the price of the day one sells is part of the history one held.

    One definition, read by the backfill and by the terminality question alike
    (issue #706): the two ask about the same window, and a second spelling of it
    would eventually put them a day apart — which is exactly one chunk of
    disagreement about whether a symbol is finished.

    The installation fact reads it too (issue #709), and there the stake is the
    ``_backfill_complete`` watermark: it is keyed by the **target**, so a second
    spelling of "the first acquisition as an instant" would make
    :meth:`ingestion.IngestionWorkload.reconstruction_state` compare against a target
    the backward pass never stored, and announce a reconstruction that never
    finishes on a portfolio that finished it minutes ago.
    """
    target = datetime.combine(acquired, datetime.min.time(), tzinfo=timezone.utc)
    ceiling = (
        now if exited is None
        else datetime.combine(exited + timedelta(days=1),
                              datetime.min.time(), tzinfo=timezone.utc))
    return target, ceiling


def backward_anchor(ceiling: datetime, oldest_stored: Optional[datetime],
                    oldest_tried: Optional[date]) -> datetime:
    """Where the backward pass resumes from — the **minimum** of the three.

    The pure half of :meth:`backfill.BackfillWorkload.backward_anchor`, extracted
    by #706 so the anchor has one definition and the terminality read below can
    ask the same question in one batched query instead of re-deriving it.

    A minimum, so the anchor can only ever move backwards: the holding window's
    ``ceiling`` (where a symbol with nothing stored and nothing tried starts),
    the oldest stored point, and the oldest window **tried** — the last being the
    only one that moves on a symbol Yahoo answers nothing about (ADR-0009).

    ``oldest_tried`` is a ``DATE`` because a window boundary is a calendar day;
    it becomes midnight UTC here, which is the one place the two kinds of time
    meet on this path.
    """
    candidates = [ceiling]
    if oldest_stored is not None:
        candidates.append(oldest_stored)
    if oldest_tried is not None:
        candidates.append(datetime.combine(
            oldest_tried, datetime.min.time(), tzinfo=timezone.utc))
    return min(candidates)


def is_terminal(anchor: datetime, target: datetime) -> bool:
    """Has the backward pass nothing left to fetch for this symbol?

    The second term of the carrying predicate, and the **same comparison**
    :meth:`backfill.BackfillWorkload.backward` makes to set its
    completion watermark — at day granularity, so tiny windows are not chased.

    Derived from the store rather than read off the scheduler's in-memory
    ``_backfill_complete``, and that is what makes it usable at all: the dict is
    empty for the first cycle after every restart, so a convention hanging off it
    would switch itself off on each boot and back on a minute later, with the
    figures moving underneath a reader who did nothing.
    """
    return anchor.date() <= target.date()


__all__ = ['carrying_price', 'was_quoted', 'is_quoted', 'holding_bounds',
           'backward_anchor', 'is_terminal']
