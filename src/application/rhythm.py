"""The **investment rhythm** — how much is bought in a month, and how often.

Issue #751, ADR-0041, `CONTEXT.md` under *The ledger*.

The record settles what this measures and what it refuses to measure, and three
of its sentences are the whole of this module:

**The signal is the ``BUY`` events and only those.** A buy is worth
``quantity × unit_price + fee`` — fees absorbed, the same convention the cost
basis already applies, and the amount that actually left the owner's pocket. A
``GRANT`` is not a purchase and a ``DIVIDEND`` is not one either; a reinvested
dividend is counted through the ``BUY`` it produces, like any other buy. And
**a ``SELL`` is not subtracted**: selling one holding to buy another counts as
rhythm here, because nothing on a ``BUY`` says where its money came from. That
cost is named rather than repaired — subtracting the month's sells turns a heavy
rebalancing into a *negative* rhythm, which is not a slower rhythm but a
meaningless one. The limitation travels in the MCP tool's description, where a
model reads it before quoting the figure.

**The amount is a median over the months that carry a purchase, and it is
published with its coverage or not at all.** Six months of 500 € inside a
twelve-month window is not *250 € a month* — the mean over the window, and, half
of its months being empty, the median over the window too; four such months
would have made that same median *0 €*. It is **500 €, six months out of
twelve**, and that pair is the smallest honest statement available. A median
rather than a mean because one exceptional month, a bonus or a release of
savings, would otherwise set the figure a twenty-year projection is built on.

**There is no label and no verdict.** Not *monthly*, not *regular*, not
*irregular*: the word *regular* is a threshold nobody asked for (ADR-0036), and
the judgement is the reader's. This publishes the numbers, and the chat and the
MCP agent draw the conclusion.

Two shapes of absence, and they are not the same absence:

* **no month carries a purchase** — the amount and the dispersion are ``None``
  and the coverage is ``0`` out of the months observed. The precedent is the
  performance writer, which writes ``NULL`` rather than ``0`` so that *"no
  ledger"* and *"a ledger at zero"* are not the same row;
* **nothing has been observed at all** — an empty ledger, or one whose every
  event is dated in the future: ``months_observed`` is ``0`` too, and the
  coverage is zero out of zero rather than zero out of twelve.

**Pure**, in the sense the root `CLAUDE.md` gives the word: no store, no
yfinance, ``now`` injected. It takes the ledger's events and an instant and it
returns figures; `test_suite_conventions.py` holds that on the source.
"""
from dataclasses import dataclass
from datetime import date, datetime
from statistics import median, pstdev
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from application.events.schemas import DEFAULT_ACCOUNT, Event, EventType

#: How many calendar months the measure looks back over, the month of ``now``
#: included. **Hard-coded, and not a setting** (ADR-0041, ADR-0036): *"a setting
#: nobody has ever turned is a setting that should not have been written."* It
#: becomes a dial the day a second value is actually wanted.
WINDOW_MONTHS = 12


@dataclass(frozen=True)
class Figures:
    """One rhythm — the portfolio's, or one account's. The same four members.

    ``monthly_amount`` and ``months_covered`` are **inseparable** and that is
    why they are two members of one object rather than two figures a caller
    assembles: a reader handed ``500 €`` alone will say ``6 000 € a year`` with
    complete confidence when half of that never went in.

    ``months_observed`` is the denominator, and it is bounded by the age of the
    ledger rather than fixed at :data:`WINDOW_MONTHS`. It is counted from the
    **first event of any kind**, never from the first buy: nine months without a
    purchase is a fact *about* the rhythm, and starting the count at the first
    buy would erase exactly the thing a reader wants to see.

    ``dispersion`` is a coefficient of variation over the covered months' own
    amounts — the answer to *is the rhythm held at a steady amount*. ``None``
    when there is no month to disperse over, and ``None`` too when those months
    average zero, a ratio to zero being no figure rather than a large one.
    """

    monthly_amount: Optional[float]
    months_covered: int
    months_observed: int
    dispersion: Optional[float]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'monthly_amount': self.monthly_amount,
            'months_covered': self.months_covered,
            'months_observed': self.months_observed,
            'dispersion': self.dispersion,
        }


@dataclass(frozen=True)
class Rhythm:
    """The portfolio's figures, and the same figures broken down by account.

    **Never by symbol** (ADR-0041): an ETF bought in January and bitcoin in
    February are one monthly habit expressed twice, and per symbol they are two
    irregular ones. Per symbol stays *addable* — ADR-0040 makes the tool surface
    a contract in which a new field is safe and a removed one is not.
    """

    portfolio: Figures
    #: One entry per account the ledger names, ``default`` included, sorted by
    #: id. Sorted rather than *by amount*: a breakdown that reshuffles between
    #: two reads is a breakdown nobody can follow.
    accounts: Tuple[Tuple[str, Figures], ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        return {
            **self.portfolio.to_dict(),
            'accounts': [{'account': account, **figures.to_dict()}
                         for account, figures in self.accounts],
        }


def value(event: Event) -> float:
    """What a buy took out of the owner's pocket — ``quantity × price + fee``.

    Fees are **included**, which is the convention the cost basis already
    applies (*"acquisition fees are absorbed into it"*) and the amount that
    actually left. A missing member reads as zero here rather than raising: the
    validator refuses a ``BUY`` without a positive quantity and a positive unit
    price, so an event reaching this function without one never came through the
    ledger's writer, and a measure is not the place to re-raise what the write
    path already refused.

    **Nothing is clamped.** The same validator forbids a negative fee and a
    negative price, so a negative value here would be a row the product cannot
    hold; a ``max(0, …)`` would hide it rather than let it be seen.
    """
    shares = (event.quantity or 0.0) * (event.unit_price or 0.0)
    return shares + (event.fee or 0.0)


def measure(events: Sequence[Event], now: datetime) -> Rhythm:
    """The rhythm of a ledger at an instant — the whole of this module's surface.

    ``events`` is the ledger as the snapshot holds it: the rows the aggregator
    actually ran on, so the rhythm and every other figure describe one ledger.
    Undated rows are ignored, there being no month to put them in.

    The breakdown covers **every account the events name**, not only those that
    bought: an account touched in the window and buying in none of it reports a
    coverage of zero, which is a statement about the rhythm and not an absence
    of one. Each account's ``months_observed`` is counted from **its own** first
    event, which is this module's one rule applied at the finer grain — an
    account opened three months into a five-year ledger is not answering for the
    fifty-seven months before it existed.
    """
    return Rhythm(
        portfolio=_figures(events, now),
        accounts=tuple(
            (account, _figures(owned, now))
            for account, owned in sorted(_by_account(events).items())),
    )


# --------------------------------------------------------------------------- #
# The window, and the arithmetic over it
# --------------------------------------------------------------------------- #

def _figures(events: Iterable[Event], now: datetime) -> Figures:
    """The four members, over one collection of events.

    **A row dated after ``now`` has not been lived**, and it is dropped before
    anything is counted. Only the month of ``now`` can hold one — a later month
    falls outside the window on its own — and that is the month a reader looks
    at first: a buy pencilled in for the 15th would otherwise be published on
    the 2nd as money already spent, and would carry its month into the coverage
    besides. The cut is here rather than in :func:`measure` so that the
    portfolio and every account are cut at the same instant.
    """
    today = now.date()
    events = [event for event in events
              if event.date is None or event.date <= today]
    observed = _observed_months(events, now)
    if not observed:
        return Figures(monthly_amount=None, months_covered=0,
                       months_observed=0, dispersion=None)

    amounts = _monthly_amounts(events, observed)
    return Figures(
        # ``None`` and never ``0.0``: no month carried a purchase, which is not
        # a month that carried a purchase of nothing.
        monthly_amount=median(amounts) if amounts else None,
        months_covered=len(amounts),
        months_observed=len(observed),
        dispersion=_dispersion(amounts),
    )


def _monthly_amounts(events: Iterable[Event],
                     observed: Sequence[int]) -> List[float]:
    """What each **covered** month is worth, oldest first.

    A month is covered when it carries a buy, whatever that buy is worth: the
    key is written on sight and the value accumulated onto it, so a month whose
    purchases happen to total zero is a covered month at zero rather than a
    month that disappears. Months with no buy are **not** here as zeros — that
    would halve the median and describe nothing.
    """
    window = set(observed)
    months: Dict[int, float] = {}
    for event in events:
        if event.event_type is not EventType.BUY or event.date is None:
            continue
        key = _index(event.date)
        if key not in window:
            continue
        months[key] = months.get(key, 0.0) + value(event)
    return [months[key] for key in observed if key in months]


def _dispersion(amounts: Sequence[float]) -> Optional[float]:
    """The coefficient of variation of the covered months' amounts.

    The **population** deviation and not the sample's: what is measured is the
    spread of the months that were actually lived, not an estimate of some wider
    population of months the owner might have had. It also gives the one figure
    a sample deviation cannot: a single covered month disperses by ``0``, where
    the sample form is undefined and would have had to be published as an
    absence beside a coverage of one.

    ``None`` on no month at all, and ``None`` on months averaging zero: a ratio
    to zero is not a large dispersion, it is no figure.
    """
    if not amounts:
        return None
    mean = sum(amounts) / len(amounts)
    if mean <= 0:
        return None
    return pstdev(amounts) / mean


def _observed_months(events: Iterable[Event], now: datetime) -> Tuple[int, ...]:
    """The months the measure answers for, oldest first — at most twelve.

    Bounded by the age of the ledger, counted from the **first event of any
    kind** (ADR-0041). A ledger four months old answers for four months; a
    five-year-old one whose last buy was nine months ago answers for twelve, and
    those nine months count as uncovered.

    Empty on an empty ledger — and empty too when every dated event is still in
    the future, which is a ledger nothing has been observed of rather than one
    observed to have bought nothing.
    """
    days = [event.date for event in events if event.date is not None]
    if not days:
        return ()
    anchor = _index(now.date())
    span = anchor - _index(min(days)) + 1
    if span <= 0:
        return ()
    return tuple(anchor - offset
                 for offset in reversed(range(min(span, WINDOW_MONTHS))))


def _by_account(events: Iterable[Event]) -> Mapping[str, List[Event]]:
    """The events, split by the account each one names.

    ``event.account or DEFAULT_ACCOUNT`` is the aggregator's own resolution
    (:meth:`events.aggregator.EventAggregator._event_account`), re-applied here
    rather than assumed: the ledger's writer resolves a blank on the way in, so
    a stored row always carries one, and a row that has not been written yet is
    the one shape this module could still be handed.
    """
    owned: Dict[str, List[Event]] = {}
    for event in events:
        owned.setdefault(event.account or DEFAULT_ACCOUNT, []).append(event)
    return owned


def _index(day: date) -> int:
    """A calendar month as one comparable integer — ``year × 12 + month``.

    Months are subtracted and stepped through here, and doing that on a
    ``(year, month)`` pair means writing the carry by hand in three places. The
    integer has no meaning outside this module and never leaves it.
    """
    return day.year * 12 + (day.month - 1)


__all__ = ['WINDOW_MONTHS', 'Figures', 'Rhythm', 'measure', 'value']
