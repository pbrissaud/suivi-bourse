"""One event as a JSON object: the body ``POST /api/events`` takes, and the
agent's proposals (#1119) are made of. Pure: no store, no clock."""
import re
from datetime import date
from typing import Any, Dict, Optional

from application.events.schemas import Event, EventType

ISO_DAY = re.compile(r'\d{4}-\d{2}-\d{2}')

TEXT_FIELDS = ('symbol', 'name', 'notes', 'account')
NUMBER_FIELDS = ('quantity', 'unit_price', 'fee', 'amount')


class InvalidBody(Exception):
    """A member of the body is not a value an event can carry."""

    def __init__(self, message: str, field: str):
        super().__init__(message)
        self.field = field


def event_from_body(body: Optional[dict]) -> Event:
    """One JSON object as an :class:`events.schemas.Event`, or a named refusal."""
    if not isinstance(body, dict):
        raise InvalidBody("a JSON object is required", 'date')

    raw_type = body.get('event_type')
    try:
        event_type = EventType(str(raw_type).upper())
    except (ValueError, AttributeError):
        allowed = ", ".join(kind.value for kind in EventType)
        raise InvalidBody(
            f"event_type {raw_type!r} is not one of {allowed}", 'event_type')

    fields = {name: _text_member(body, name) for name in TEXT_FIELDS}
    fields.update({name: _number_member(body, name) for name in NUMBER_FIELDS})

    return Event(date=_day_member(body), event_type=event_type, **fields)


def body_of(event: Event) -> Dict[str, Any]:
    """The body that :func:`event_from_body` reads back as ``event``."""
    body: Dict[str, Any] = {'date': event.date.isoformat(),
                            'event_type': event.event_type.value}
    for name in TEXT_FIELDS + NUMBER_FIELDS:
        if getattr(event, name) is not None:
            body[name] = getattr(event, name)
    return body


def _day_member(body: dict) -> date:
    raw = body.get('date')
    if not isinstance(raw, str) or not ISO_DAY.fullmatch(raw.strip()):
        raise InvalidBody(
            f"date {raw!r} is not a calendar day (YYYY-MM-DD)", 'date')
    try:
        return date.fromisoformat(raw.strip())
    except ValueError:
        raise InvalidBody(f"date {raw!r} is not a day that exists", 'date')


def _text_member(body: dict, name: str) -> Optional[str]:
    """A string member, blank read as absent — the empty cell of a CSV."""
    raw = body.get(name)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise InvalidBody(f"{name} must be text", name)
    return raw.strip() or None


def _number_member(body: dict, name: str) -> Optional[float]:
    """A numeric member, or ``None``."""
    raw = body.get(name)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise InvalidBody(f"{name} must be a number", name)
    try:
        return float(raw)
    except OverflowError:
        raise InvalidBody(f"{name} is too large to be a number", name)
