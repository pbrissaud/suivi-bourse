"""The same money, put in one fund instead: the replay behind #760.

Answers *how much would be left*, in euros, not *what return* — the ledger's
own contributions and withdrawals, on the same days, buying and selling shares
of a single reference. Money-weighted by construction, which is why it cannot
be read off a base-100 index: two portfolios with the same index end on
different amounts when the money arrived on different days.

**The order of the day is the whole correctness of this module, and nothing in
the signature shows it.** Each day, in this order:

1. **A day with no price and no rate ends it.** Not a closed market — a day
   whose close could not be converted into the base currency (``quotes.
   unconverted_span``). Nothing is replayed that day and the period ends the
   evening before, because a holding valued at yesterday's rate is a number
   nobody asked for.
2. **The split, before the price.** #988 stores every close in the share the
   market printed it in, so the close of a split day already stands in the new
   share and the units have to be there to meet it. Applied the other way round
   the holding jumps by the ratio for one day and settles back, which shows up
   as a spike nobody can source.
3. **The price, or yesterday's.** A missing close on a day that *is* convertible
   is a closed market, and a closed market changes nothing.
4. **The flow.** A contribution buys at that price and adds to the cost basis. A
   withdrawal sells at that price and takes its share of the basis with it —
   average cost, so what is left is what was paid for it.
5. **A withdrawal the reference could not have funded ends it, that day.** The
   ledger's own withdrawal is a fact; the reference simply does not have it. The
   alternative is negative units, which is the PME / Long-Nickels defect, and a
   negative holding compounds into a figure that looks like an answer.

Pure: no store, no market, no clock. The window, the prices, the splits, the
flows and the opening position are handed in, and the caller is the one that
knows where they come from.

**Recomputed on every read, and measured once so nobody has to wonder.** On the
longest window the closed list offers — 6 302 calendar days, 4 503 of them
quoted, seventeen splits and 207 flows, which is heavier than a real portfolio
— one replay takes **1,4 ms** (median of 20, 2026-09-20, Python 3.14 on an
M-series laptop). The route runs one per account: 6,7 ms at five accounts,
13,6 ms at ten.

That is the whole argument against persisting the series. #760 reserved the
right to switch to a stored curve "past a threshold"; the threshold is two
code paths and a staleness question for a Python loop that costs less than the
JSON encoding of its own output, and the branch would be one nobody ever
exercises. The measurement is here rather than in a pull request body because
this is where the next person to wonder will look.
"""

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Collection, List, Mapping, NamedTuple, Optional, Tuple

ONE_DAY = timedelta(days=1)

#: A withdrawal the reference could not have funded (branch 5).
EXHAUSTED = 'exhausted'

#: A day whose close has no rate to be converted at (branch 1).
AWAITING_RATE = 'awaiting_rate'

#: The reference has no convertible close anywhere in the window. Not an early
#: end — a comparison that never started, and the caller shows no figure at all.
NEVER_QUOTED = 'never_quoted'


class Snapshot(NamedTuple):
    """One covered day, and everything an aggregate needs to read **on it**.

    The value alone was not enough: an aggregate ends at the *earliest* of its
    accounts' ends, so a replay that ran longer has to be read back at that day
    and not at its own last one. Carrying the three terms together is what
    keeps the tax side, the return's denominator and the curve on one date.
    """

    day: date
    #: Units at the day's price.
    value: float
    #: The opening position plus every flow since, withdrawals netted off.
    contributed: float
    #: What was paid for the units still held — the assiette, on this day.
    cost_basis: float

    @property
    def latent_gain(self) -> float:
        """What the tax would be projected on, **on this day**."""
        return self.value - self.cost_basis


@dataclass(frozen=True)
class Replay:
    """What the reference would be worth, and over what period it really ran."""

    #: Shares of the reference held at the end. ``0.0`` when it never started.
    units: float
    #: What was paid for the units still held — average cost, the tax assiette.
    cost_basis: float
    #: ``units`` at the last price the replay actually reached.
    value: float
    #: The day the money went in. **Not** the window's first day: the first day
    #: of it the reference was convertibly quoted on.
    first_day: Optional[date]
    #: The last day covered. Earlier than the window's when ``ended`` is set.
    last_day: Optional[date]
    #: Why it stopped early, or ``None`` for a period that ran to the end.
    ended: Optional[str] = None
    #: The opening position plus every flow since, withdrawals netted off —
    #: the denominator both sides share, because both ran the same flows from
    #: the same seed. A return read off anything else compares two fractions
    #: with different bottoms and calls the difference a gap.
    contributed: float = 0.0
    #: One :class:`Snapshot` per calendar day covered, oldest first — the curve
    #: drawn against the portfolio's own, and the three terms an aggregate
    #: reads back at a day that is not this replay's last. One entry per
    #: calendar day and not per quoted day, because the two curves are read as
    #: the area between them and a reference that skips weekends would draw
    #: that area wrong.
    series: List[Snapshot] = field(default_factory=list)

    @property
    def latent_gain(self) -> float:
        """What the tax would be projected on: value minus what was paid."""
        return self.value - self.cost_basis


def replay(window: Tuple[date, date],
           prices: Mapping[date, float],
           splits: Mapping[date, float],
           flows: Mapping[date, float],
           seed: float,
           unconverted: Collection[date] = ()) -> Replay:
    """Buy ``seed`` worth of the reference, then follow ``flows`` day by day.

    ``window`` is ``(first, last)``, inclusive. ``seed`` is the position **at
    the close of** ``first`` — the real portfolio's value that evening — so the
    flows of ``first`` are already inside it and are never read. Every flow
    after it is: positive buys, negative sells.

    ``prices`` are converted closes, one per quoted day; ``splits`` are ratios
    by day, the whole history (:func:`quotes.read_splits`); ``unconverted`` are
    the days carrying a close that has no rate yet.

    The seed lands on the first convertibly quoted day at or after ``first``,
    and anything that flowed in between goes in with it rather than being lost.
    """
    first, last = window
    unconverted = set(unconverted)

    day = first
    while day <= last and day not in prices:
        if day in unconverted:
            return Replay(0.0, 0.0, 0.0, None, None, AWAITING_RATE)
        day += ONE_DAY
    if day > last:
        return Replay(0.0, 0.0, 0.0, None, None, NEVER_QUOTED)

    seeded = day
    opening = seed + sum(
        flows.get(d, 0.0)
        for d in _span(first + ONE_DAY, seeded))
    price = prices[seeded]
    if opening <= 0 or price <= 0:
        return Replay(0.0, 0.0, 0.0, seeded, seeded, EXHAUSTED)

    units = opening / price
    basis = opening
    contributed = opening
    ended = None
    series = [Snapshot(seeded, opening, opening, opening)]

    day = seeded + ONE_DAY
    while day <= last:
        quoted = prices.get(day)
        if quoted is None and day in unconverted:
            ended = AWAITING_RATE
            break

        ratio = splits.get(day)
        if ratio:
            units *= ratio
        if quoted is not None:
            # **A close of zero or less is not a price.** The seed already
            # refuses one, and this is the same number divided by two lines
            # down: `flow / price` raises on a zero and a negative quote buys
            # negative units, which compounds into a figure that still looks
            # like an answer. The store can hold one — `finite()` keeps `0.0`,
            # and a converted close is a product of two numbers this module
            # never sees. Nothing is replayed past it.
            if quoted <= 0:
                ended = AWAITING_RATE
                break
            price = quoted

        flow = flows.get(day, 0.0)
        if flow > 0:
            units += flow / price
            basis += flow
            contributed += flow
        elif flow < 0:
            if -flow > units * price:
                ended = EXHAUSTED
                series.append(Snapshot(day, units * price, contributed, basis))
                break
            before = units
            units -= -flow / price
            basis *= units / before
            contributed += flow

        series.append(Snapshot(day, units * price, contributed, basis))
        day += ONE_DAY

    # A day with no rate is not replayed at all, so the period ends the evening
    # before it. An exhausting withdrawal happens *on* its day, and the day
    # counts: the split and the price of it were already applied above.
    if ended == AWAITING_RATE:
        last_day = day - ONE_DAY
    elif ended == EXHAUSTED:
        last_day = day
    else:
        last_day = last

    return Replay(units, basis, units * price, seeded, last_day, ended,
                  contributed, series)


def _span(first: date, last: date):
    """Every calendar day of ``[first, last]``, empty when ``last`` is earlier."""
    day = first
    while day <= last:
        yield day
        day += ONE_DAY


__all__ = ['Replay', 'Snapshot', 'replay',
           'EXHAUSTED', 'AWAITING_RATE', 'NEVER_QUOTED']
