"""The carrying price: what a position is worth on a day nothing priced it."""
from datetime import date, datetime, timedelta, timezone
from typing import Dict, Optional, Tuple

from application.events.schemas import EventType, unit_cost


def carrying_price(observed: Optional[float],
                   quoted: bool,
                   quantity: Optional[float],
                   cost_basis: Optional[float]) -> Optional[float]:
    """The price the position is carried at: the market's, failing that its own."""
    if observed is not None:
        return observed
    if quoted:
        return None
    return unit_cost(quantity or 0.0, cost_basis or 0.0)


def was_quoted(first_quoted: Optional[date], day: date) -> bool:
    """Had **any** quote of this symbol been observed by ``day``?"""
    return first_quoted is not None and day >= first_quoted


def is_quoted(price_native: Optional[float], currency: Optional[str]) -> bool:
    """The same term on a **P1 row**: a quote is a number *and* a unit (#773)."""
    return price_native is not None and bool(currency)


ACQUISITION_EVENT_TYPES = (EventType.BUY, EventType.GRANT)


def holding_windows(events, held) -> Dict[str, Tuple[date, Optional[date]]]:
    """``{symbol: (first acquisition, last exit or None)}`` out of a raw ledger."""
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
    """A holding window as the two instants the backward pass works between."""
    target = datetime.combine(acquired, datetime.min.time(), tzinfo=timezone.utc)
    ceiling = (
        now if exited is None
        else datetime.combine(exited + timedelta(days=1),
                              datetime.min.time(), tzinfo=timezone.utc))
    return target, ceiling


def backward_anchor(ceiling: datetime, oldest_stored: Optional[datetime],
                    oldest_tried: Optional[date]) -> datetime:
    """Where the backward pass resumes from — the **minimum** of the three."""
    candidates = [ceiling]
    if oldest_stored is not None:
        candidates.append(oldest_stored)
    if oldest_tried is not None:
        candidates.append(datetime.combine(
            oldest_tried, datetime.min.time(), tzinfo=timezone.utc))
    return min(candidates)


def is_terminal(anchor: datetime, target: datetime) -> bool:
    """Has the backward pass nothing left to fetch for this symbol?"""
    return anchor.date() <= target.date()


__all__ = ['carrying_price', 'was_quoted', 'is_quoted', 'holding_bounds',
           'backward_anchor', 'is_terminal']
