"""The **investment rhythm** — how much is bought in a month, and how often."""
from dataclasses import dataclass
from datetime import date, datetime
from statistics import median, pstdev
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from application.events.schemas import DEFAULT_ACCOUNT, Event, EventType

WINDOW_MONTHS = 12


@dataclass(frozen=True)
class Figures:
    """One rhythm — the portfolio's, or one account's. The same four members."""

    monthly_amount: Optional[float]
    months_covered: int
    months_observed: int
    dispersion: Optional[float]
    # The observed months themselves, oldest first — ``amount`` is ``None`` on a
    # month with no purchase. The four figures above are reductions of this
    # series; it travels with them so a screen can *show* the coverage and the
    # spread rather than quote them.
    months: Tuple[Tuple[str, Optional[float]], ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        return {
            'monthly_amount': self.monthly_amount,
            'months_covered': self.months_covered,
            'months_observed': self.months_observed,
            'dispersion': self.dispersion,
            'months': [{'month': month, 'amount': amount}
                       for month, amount in self.months],
        }


@dataclass(frozen=True)
class Rhythm:
    """The portfolio's figures, and the same figures broken down by account."""

    portfolio: Figures
    accounts: Tuple[Tuple[str, Figures], ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        return {
            **self.portfolio.to_dict(),
            'accounts': [{'account': account, **figures.to_dict()}
                         for account, figures in self.accounts],
        }


def value(event: Event) -> float:
    """What a buy took out of the owner's pocket — ``quantity × price + fee``."""
    shares = (event.quantity or 0.0) * (event.unit_price or 0.0)
    return shares + (event.fee or 0.0)


def measure(events: Sequence[Event], now: datetime) -> Rhythm:
    """The rhythm of a ledger at an instant — the whole of this module's surface."""
    return Rhythm(
        portfolio=_figures(events, now),
        accounts=tuple(
            (account, _figures(owned, now))
            for account, owned in sorted(_by_account(events).items())),
    )


def _figures(events: Iterable[Event], now: datetime) -> Figures:
    """The four members, over one collection of events."""
    today = now.date()
    events = [event for event in events
              if event.date is None or event.date <= today]
    observed = _observed_months(events, now)
    if not observed:
        return Figures(monthly_amount=None, months_covered=0,
                       months_observed=0, dispersion=None)

    by_month = _monthly_amounts(events, observed)
    months = tuple((_label(key), by_month.get(key)) for key in observed)
    amounts = [amount for _, amount in months if amount is not None]
    return Figures(
        monthly_amount=median(amounts) if amounts else None,
        months_covered=len(amounts),
        months_observed=len(observed),
        dispersion=_dispersion(amounts),
        months=months,
    )


def _monthly_amounts(events: Iterable[Event],
                     observed: Sequence[int]) -> Dict[int, float]:
    """What each **covered** month is worth, by month index."""
    window = set(observed)
    months: Dict[int, float] = {}
    for event in events:
        if event.event_type is not EventType.BUY or event.date is None:
            continue
        key = _index(event.date)
        if key not in window:
            continue
        months[key] = months.get(key, 0.0) + value(event)
    return months


def _dispersion(amounts: Sequence[float]) -> Optional[float]:
    """The coefficient of variation of the covered months' amounts."""
    if not amounts:
        return None
    mean = sum(amounts) / len(amounts)
    if mean <= 0:
        return None
    return pstdev(amounts) / mean


def _observed_months(events: Iterable[Event], now: datetime) -> Tuple[int, ...]:
    """The months the measure answers for, oldest first — at most twelve."""
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
    """The events, split by the account each one names."""
    owned: Dict[str, List[Event]] = {}
    for event in events:
        owned.setdefault(event.account or DEFAULT_ACCOUNT, []).append(event)
    return owned


def _index(day: date) -> int:
    """A calendar month as one comparable integer — ``year × 12 + month``."""
    return day.year * 12 + (day.month - 1)


def _label(index: int) -> str:
    """The month back from its integer, as ``YYYY-MM``."""
    return f'{index // 12:04d}-{index % 12 + 1:02d}'


__all__ = ['WINDOW_MONTHS', 'Figures', 'Rhythm', 'measure', 'value']
