"""The two kinds of time, on the way out. One definition, for the whole tree
(issue #843).

The root `CLAUDE.md` states *there is one clock, and it is the product's, and
every read of it is UTC-qualified*, and `test_suite_conventions.py` holds that
on the source. But the guard covers the **reads** — `datetime.now(...)` — and
says nothing about the **repair** of what comes back naive from the store. That
repair had been rewritten in eight modules, in three variants that had already
drifted: some let a non-UTC *aware* instant through untouched, some converted
it, and the two modules feeding most of the page's fields did not repair at all.
This module is where it is written once.

Two functions, because there are two kinds of time and they must not be
confused:

* :func:`utc` — the repair. Naive means UTC here: the app writes UTC
  everywhere, the store's session is pinned to it (:func:`store.prepare`), so a
  value that comes back without a zone is a UTC value that lost its label. An
  *aware* value is **normalized**, not merely accepted, so that everything this
  tree serializes carries `+00:00` rather than some arbitrary offset and two
  instants read side by side in one payload are comparable by eye.
* :func:`iso` — the serialization. An **instant** goes through :func:`utc`
  first; a **calendar day** is written as it is. Both shapes reach the wire
  since #700 — an observed price carries a `TIMESTAMPTZ`, a perf point carries
  a `DATE` — and stamping the day into an instant is the way to lose a day at
  the browser's offset.

Two observations produced these rules, and neither is cosmetic:

* **The `TypeError`.** A naive instant travelling into arithmetic that
  subtracts an aware one raises `can't subtract offset-naive and offset-aware
  datetimes`. In the backfill's progress bar that exception is rendered by the
  blueprint's catch-all as **503 Portfolio storage unavailable** — from the one
  route that touches no storage, and precisely while a backward pass is *in
  progress*, which is the only time the bar is worth drawing. A completed pass
  short-circuits before the arithmetic, so the defect was invisible on a stack
  whose history is already filled.
* **The silent shift.** A naive ISO string is read by `new Date()` as *local*
  time, quietly moving every instant on the page by the browser's offset — a
  defect that is invisible on a machine in UTC, and the repository's CI runs in
  UTC, so behaviour can never see it. Only a rule on the source holds it, which
  is what `test_suite_conventions.py` now does.

**This module imports the standard library and nothing else**, and that is what
makes it importable from anywhere. `portfolio_view` is a pure view module — no
store, no Flask, no clock, the discipline `performance` states — so the home of
the repair could not be `store.py` beside `store.finite` without pulling
`duckdb` into it. The precedent is explicit in the tree: `carrying` re-spells a
constant by hand rather than import it, and says why in a comment. Keeping this
module free of every project import is the version of that which costs nothing.
"""
from datetime import date, datetime, timezone
from typing import Optional, Union


def utc(value):
    """Normalize an instant to UTC. One rule, applied at every exit.

    A naive `datetime` is **stamped**: it came from the store, whose session is
    pinned to UTC, so it is a UTC instant that lost its label. An *aware* one is
    **converted** — the strict variant, chosen over letting it pass because it
    is a superset (idempotent on what is already UTC) and it is what gives the
    property downstream cares about: an instant serialized by :func:`iso` always
    reads `+00:00`.

    Anything that is not a `datetime`, `None` included, is returned unchanged.
    The signature is deliberately permissive: this is called on values that come
    back from the store one row at a time, where a column is whatever it is, and
    a repair that only knows how to repair is easier to place than one that also
    decides what a non-instant becomes.
    """
    if not isinstance(value, datetime):
        return value
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def iso(value: Optional[Union[datetime, date]]) -> Optional[str]:
    """ISO-8601, the wire format #655 fixed for every date and instant.

    An **instant** passes through :func:`utc` first, so it always carries its
    offset. A **calendar day** is serialized as it stands — never stamped at
    midnight, which is how a browser in a negative offset reads the day before.
    The order of the two tests is what makes that true: `datetime` is a subclass
    of `date`, so the instant has to be recognized first.

    Everything else, `None` included, is `None`.
    """
    if isinstance(value, datetime):
        return utc(value).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return None


__all__ = ['utc', 'iso']
