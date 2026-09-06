"""A stored point's resolution is a function of its **age** (issue #705, ADR-0010)."""

from datetime import datetime, timedelta
from typing import Optional, Tuple

RAW = 'raw'
HOUR = 'hour'
DAY = 'day'

RUNGS = (RAW, HOUR, DAY)

HOUR_WALL_DAYS = 365
DAY_WALL_DAYS = 730


def rung_at(age: timedelta) -> str:
    """The rung a point of that age sits on."""
    if age < timedelta(days=HOUR_WALL_DAYS):
        return RAW
    if age <= timedelta(days=DAY_WALL_DAYS):
        return HOUR
    return DAY


def walls(now: datetime) -> Tuple[datetime, datetime]:
    """``(hourly wall, daily wall)`` as two instants, oldest last."""
    return (now - timedelta(days=HOUR_WALL_DAYS),
            now - timedelta(days=DAY_WALL_DAYS))


def coarsest(*rungs: str) -> str:
    """The coarsest of the rungs given. Raises on a name that is not one."""
    for rung in rungs:
        if rung not in RUNGS:
            raise ValueError(
                f"Unknown rung {rung!r}: expected one of {', '.join(RUNGS)}")
    return max(rungs, key=RUNGS.index)


def rung_over(span_days: Optional[float]) -> str:
    """The coarsest rung a window of ``span_days`` reaches back into."""
    if span_days is None:
        return DAY
    return rung_at(timedelta(days=span_days))


def rung_of_bucket(interval: Optional[str]) -> str:
    """The rung a downsampling bucket announces. ``None`` is *as written*."""
    if interval is None:
        return RAW
    if interval == '1 hour':
        return HOUR
    if interval == '1 day':
        return DAY
    raise ValueError(
        f"No rung announces a {interval!r} bucket: the resolution served has "
        f"three names ({', '.join(RUNGS)})")


__all__ = [
    'RAW', 'HOUR', 'DAY', 'RUNGS',
    'HOUR_WALL_DAYS', 'DAY_WALL_DAYS',
    'rung_at', 'walls', 'coarsest', 'rung_over', 'rung_of_bucket',
]
