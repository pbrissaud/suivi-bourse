"""The two kinds of time, on the way out. One definition, for the whole tree (issue #843)."""
from datetime import date, datetime, timezone
from typing import Optional, Union


def utc(value):
    """Normalize an instant to UTC. One rule, applied at every exit."""
    if not isinstance(value, datetime):
        return value
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def iso(value: Optional[Union[datetime, date]]) -> Optional[str]:
    """ISO-8601, the wire format #655 fixed for every date and instant."""
    if isinstance(value, datetime):
        return utc(value).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return None


__all__ = ['utc', 'iso']
