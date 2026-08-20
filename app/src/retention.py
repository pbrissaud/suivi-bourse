"""A stored point's resolution is a function of its **age** (issue #705, ADR-0010).

Pure, in the taste of :mod:`scheduling`, :mod:`carrying` and :mod:`fx`: three
rungs, the two walls between them, and the arithmetic that reads a window
against them — with ``now`` injected, so the whole of it is testable without a
clock and without a database. What *writes* is
:func:`quotes.collapse_to_ladder`, and what calls that is the backfill.

The ladder is one function of age applied on both sides of the present. The
reconstruction already asks Yahoo for hourly bars under 729 days and daily ones
beyond — an API ceiling, not an arbitration — and the collapse extends the same
shape to the present as it ages, so a fresh install and a mature one
**converge** instead of being declared similar.

Three properties are written here because they are the three a contributor will
break.

**The ladder is a ceiling, never a floor.** It says *no finer than X at age Y*
and it fabricates nothing: a gap filled at nine months of age arrives hourly and
stays hourly. That is why this module answers a rung and a pair of bounds, and
never a cadence to write at — nothing downstream of it inserts a row.

**Fine resolution is only ever obtained by having been there.** Yahoo sells
nothing below the hour past 60 days, which makes sampling *at write time* the
only irreversible decision the subject offers — and therefore the only one that
was refused. The app writes what it sees and ages it afterwards.

**And there is not a single setting.** Neither the walls nor the rungs enter
:mod:`settings_registry` (ADR-0014's list is the whole of what a dial is): an
install whose retention differs is an install whose pages do not mean the same
thing, and the resolution the API announces would then describe a policy no
reader of that page can see.
"""

from datetime import datetime, timedelta
from typing import Optional, Tuple

#: The three rungs, **finest first**. They are also the three names
#: ``GET /api/prices/<symbol>`` announces as its ``resolution``, which is not a
#: coincidence to be kept up by hand: :func:`store_reads.chart_window` composes
#: that field out of :func:`rung_of_bucket` and :func:`rung_over`.
RAW = 'raw'
HOUR = 'hour'
DAY = 'day'

RUNGS = (RAW, HOUR, DAY)

#: The two walls, in days of age. A point is kept **as it was written** under a
#: year, **hourly** from one year to two, and **daily** beyond — so the second
#: wall is inclusive on the hourly side: at exactly two years a point is still
#: on the hourly rung, and it is the day *after* that it goes daily.
HOUR_WALL_DAYS = 365
DAY_WALL_DAYS = 730


def rung_at(age: timedelta) -> str:
    """The rung a point of that age sits on.

    Total over every age, negative ones included: a point stamped in the future
    is on the finest rung, which is the only answer that keeps the ladder a
    ceiling — the alternative would have the collapse designate a row nothing
    has aged yet.
    """
    if age < timedelta(days=HOUR_WALL_DAYS):
        return RAW
    if age <= timedelta(days=DAY_WALL_DAYS):
        return HOUR
    return DAY


def walls(now: datetime) -> Tuple[datetime, datetime]:
    """``(hourly wall, daily wall)`` as two instants, oldest last.

    **An age bound, and never a counter.** The collapse's whole left-hand side
    is open: everything older than a wall is that wall's business, however long
    ago it was written. An install switched back on after six months of
    downtime therefore catches its six months up in one statement, where a
    counter — *one day per cycle* — would have taken a hundred and eighty
    cycles to reach the same rows and would have had to remember where it had
    got to. *One day of wall per cycle* is what that costs in steady state, not
    what the operation is bounded by.

    The two bounds cut the series into three bands that are disjoint and
    complete: ``ts > hourly`` is the raw year, ``daily <= ts <= hourly`` is the
    hourly band, and ``ts < daily`` is the daily one. They agree with
    :func:`rung_at` at both edges by construction — that is what makes the pure
    reading of a point and the ``WHERE`` clause that collapses it one rule
    rather than two.
    """
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
    """The coarsest rung a window of ``span_days`` reaches back into.

    ``None`` is *the whole series*, which reaches the daily rung on any install
    old enough to have one and is answered ``day`` on one that is not. That is
    honest rather than approximate: the field it feeds says what was **served**,
    and daily is what a window with no left edge is served as. Sizing it from
    the oldest stored point would put a query behind a field whose only job is
    to describe the answer that came back.
    """
    if span_days is None:
        return DAY
    return rung_at(timedelta(days=span_days))


def rung_of_bucket(interval: Optional[str]) -> str:
    """The rung a downsampling bucket announces. ``None`` is *as written*.

    Total on the three widths the chart's ladder picks from, and a refusal
    everywhere else — deliberately. A resolution has **three** names, so a
    bucket between two rungs (``6 hours``, say, which
    :func:`store_reads.bucket_for_window` may still pick for the older
    per-share route) has no honest name to be announced under, and answering
    the nearer of the two would be a rounding nobody could see.
    """
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
