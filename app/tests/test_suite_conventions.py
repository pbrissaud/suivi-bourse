"""What `app/` holds as a whole — the subject here is the tree itself, never a
module of it."""

import re
from pathlib import Path

_APP = Path(__file__).resolve().parents[1]
_THIS = Path(__file__).resolve()

#: A clock read answering in the machine's own zone — or in no stated zone at
#: all: `.today()`, `.utcnow()` and `.localtime()` are three spellings of one
#: fault, and `.now()` with no argument is the fourth. A `.fromtimestamp(` that
#: names no zone is the fifth, and it is the one the tree can regress into by
#: *deletion* rather than by writing something new: `scheduling.py` states its
#: zone in a keyword argument, and dropping that argument is #781 again under
#: another name. What the product writes — `.now(timezone.utc)`, `.now(UTC)`,
#: `.fromtimestamp(ts, tz=timezone.utc)` — is left alone. The rule the five
#: share is that **the zone is stated**, never that a particular call is.
_LOCAL_CLOCK = re.compile(
    r'\.(?:today|utcnow|localtime)\s*\('
    r'|\.now\s*\(\s*\)'
    r'|\.fromtimestamp\s*\((?![^)]*(?:tz|UTC|utc))')


def test_the_tree_reads_one_clock_and_it_is_the_products():
    """#781, checked on the source: one clock, and it is UTC.

    The product reads UTC at both ends — the perf job stamps its days with it,
    and the route bounds its window with it — so a test seeding with the
    machine's own zone seeds a row the route dates *tomorrow*: between local
    midnight and UTC midnight the row falls out of the window and the series
    comes back empty. The repository's CI runs in UTC and can therefore never
    see this class by behaviour, before or after a repair, which is what makes
    a sentence in prose a rule held by **nothing**. The assertion is what holds
    it.

    `app/src/` is policed beside `app/tests/`: the rule names the product as
    the reference clock, so exempting it from the guard that states it would be
    odd — and a test that *reads* the product does not change it.

    This file is the one exception, excluded by identity rather than by name:
    it has to name the refused spellings, in its pattern and in its prose, and
    naming a fault is not committing it. Should a local read ever become
    legitimate, the repository's precedent is to exclude it **by its name** in
    the pattern — `test_no_other_module_writes_the_replays_two_tables` excludes
    `positions.py` in so many words — and never to invent an opt-out marker.

    The cost that exclusion pays for is written down rather than left to be
    rediscovered: the pattern reads the file's **text**, so a comment or a
    docstring anywhere else that *names* a refused spelling is an offender too,
    and a removed local read cannot be documented by its own name. Reading the
    tokens instead — `tokenize`, skipping `STRING` and `COMMENT` — would judge
    code and never prose, and it is the exit to take should the cost ever bite;
    it is not taken today because the repository's one precedent for an
    assertion on the source is a compiled pattern over the file's text, and one
    guard of that shape reads at a glance where two shapes do not.
    """
    offenders = []
    for root in (_APP / 'src', _APP / 'tests'):
        scanned = [path for path in sorted(root.rglob('*.py'))
                   if path.resolve() != _THIS]
        # The coverage half, and it is asserted **per root** rather than in
        # total: a root that stopped resolving reads no file, the assertion
        # below goes green for ever, and the guard reports clean on a tree it
        # never opened — the one failure a check on the source has (#778). In
        # total, the other root's sixty files would hide it.
        assert len(scanned) > 20, root
        offenders += [path.relative_to(_APP).as_posix() for path in scanned
                      if _LOCAL_CLOCK.search(path.read_text())]

    assert offenders == []
