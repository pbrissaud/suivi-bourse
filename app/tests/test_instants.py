"""The tree's one repair and its one serialization (issue #843).

Two kinds of time reach the wire since #700 — an observed price carries a
``TIMESTAMPTZ``, a perf point carries a ``DATE`` — and the eight copies this
module replaced had already drifted on both halves: on whether an *aware*
instant in another zone was converted or let through, and on whether a
serialized instant was stamped at all. What is asserted here is the pair of
rules that closed the drift, because they are the two the callers rely on and
neither is observable on a machine in UTC once it is wrong.
"""
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import instants


PARIS = timezone(timedelta(hours=2))


def test_a_naive_instant_is_stamped_utc_rather_than_read_as_local():
    """Naive means UTC here: the store's session is pinned there.

    The alternative is the defect the copies were written against — a naive ISO
    string read by ``new Date()`` as *local* time, moving every instant on the
    page by the browser's own offset, and invisible on a machine in UTC.
    """
    stamped = instants.utc(datetime(2026, 8, 5, 15, 0))

    assert stamped == datetime(2026, 8, 5, 15, 0, tzinfo=timezone.utc)
    assert instants.iso(datetime(2026, 8, 5, 15, 0)) \
        == '2026-08-05T15:00:00+00:00'


def test_an_aware_instant_in_another_zone_comes_back_in_utc():
    """The strict variant, and it is the one three modules did **not** have.

    ``runtime_view``, ``ledger`` and ``quotes`` let an aware instant through
    untouched, so the same payload could carry two offsets and a reader
    comparing two of its instants by eye compared two different things.
    Converting is a superset of passing through — idempotent on what is already
    UTC, which is everything the store answers — and it buys the property the
    front reads: an instant is always spelled ``+00:00``.
    """
    elsewhere = datetime(2026, 8, 5, 17, 0, tzinfo=PARIS)

    assert instants.utc(elsewhere) == datetime(2026, 8, 5, 15, 0,
                                               tzinfo=timezone.utc)
    assert instants.iso(elsewhere) == '2026-08-05T15:00:00+00:00'


def test_a_calendar_day_crosses_iso_without_being_stamped_into_an_instant():
    """The distinction the unification had to preserve, not flatten (#700).

    A perf point is a ``DATE``. Stamping it at midnight would hand the browser
    an instant, which a negative offset renders as **the day before** — the
    whole of the defect, in one field nobody would think to look at.
    """
    assert instants.iso(date(2026, 8, 5)) == '2026-08-05'
    # And the order of the two tests is load-bearing: `datetime` is a subclass
    # of `date`, so an instant recognised as a day would lose its time of day.
    assert instants.iso(datetime(2026, 8, 5, 15, 0, tzinfo=timezone.utc)) \
        == '2026-08-05T15:00:00+00:00'


def test_utc_repairs_and_never_decides_what_a_non_instant_becomes():
    """It is called on store rows one column at a time, where a value is
    whatever the column is: a repair that only repairs is easier to place than
    one that also has an opinion about a string."""
    assert instants.utc(None) is None
    assert instants.utc('2026-08-05') == '2026-08-05'
    assert instants.utc(4.2) == 4.2
    assert instants.utc(date(2026, 8, 5)) == date(2026, 8, 5)


def test_iso_answers_none_for_everything_that_is_not_a_date_or_an_instant():
    """A field with nothing in it is ``null`` on the wire, never a string."""
    assert instants.iso(None) is None
    assert instants.iso('2026-08-05') is None
    assert instants.iso(4.2) is None


def test_the_module_carries_no_project_import():
    """What makes it importable from a **pure** view module.

    ``portfolio_view`` claims :mod:`performance`'s discipline — no store, no
    Flask, no clock — so the repair could not live beside ``store.finite``
    without pulling ``duckdb`` into it. The tree's precedent is explicit:
    ``carrying`` re-spells a constant by hand rather than import it. Holding
    the standard library as the only dependency is that precedent, paid once.
    """
    source = Path(instants.__file__).read_text()
    imports = [line for line in source.splitlines()
               if line.startswith('import ') or line.startswith('from ')]

    assert imports == ['from datetime import date, datetime, timezone',
                       'from typing import Optional, Union']
