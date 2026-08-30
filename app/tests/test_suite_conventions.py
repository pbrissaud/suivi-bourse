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


#: The repair of a naive instant and the serialization of an instant, each
#: written under a private name. `app/src/` held eight of them (#843), in three
#: variants that had already drifted, and the ninth is the one this pattern
#: exists to refuse. It names the **definition** and never the expression
#: `replace(tzinfo=timezone.utc)`: three repairs are made **on the way in** and
#: are legitimate exactly where they stand — `scheduling` repairs an argument it
#: is handed (and is a *pure* module, so it could not import anything that is
#: not), `main` repairs a pandas `Timestamp` at the market's edge, and
#: `web.api._parse_instant` repairs an ISO string arriving from the front. A
#: banner on the expression would bite all three; a banner on the definition
#: bites the copies, which are the subject.
_PRIVATE_TIME_HELPER = re.compile(r'^def _(?:utc|iso|stamp_value)\s*\(',
                                  re.MULTILINE)

#: Where the two of them live, and the only file exempted — by its name, which
#: is the repository's precedent for an exclusion.
_INSTANTS = 'src/instants.py'


def test_the_repair_of_an_instant_is_written_once_in_the_tree():
    """#843, checked on the source: one `utc`, one `iso`, and no ninth copy.

    The root `CLAUDE.md` states that every read of the clock is UTC-qualified
    and the test above holds it — but a **read** is not the only way a naive
    instant enters. What comes back from the store is the other way, and the
    repair of it was rewritten in eight modules that had already drifted apart:
    some converted an aware instant to UTC, some let it through, and the two
    modules feeding most of the page's fields did not repair at all.

    Nothing behavioural can hold this. A naive ISO string is read by
    `new Date()` as *local* time, so the defect is a shift by the browser's
    offset — and it is invisible on a machine in UTC, which is what the CI runs
    on. A rule on the source is the only shape this guard has, the same
    conclusion the deleted `_stamp_value` docstring had already written down.

    The exemption is `src/instants.py` and it is asserted to be **used** rather
    than merely allowed: a rule that goes green when the module it points at
    disappears is the failure a check on the source has (#778).
    """
    offenders = []
    scanned = sorted((_APP / 'src').rglob('*.py'))
    assert len(scanned) > 20
    for path in scanned:
        relative = path.relative_to(_APP).as_posix()
        if relative == _INSTANTS:
            continue
        if _PRIVATE_TIME_HELPER.search(path.read_text()):
            offenders.append(relative)

    assert offenders == []

    # The other half: the home exists, it is where the tree imports from, and
    # it answers under the two public names the copies were folded into.
    home = (_APP / _INSTANTS).read_text()
    assert 'def utc(' in home and 'def iso(' in home
    importers = [path.relative_to(_APP).as_posix() for path in scanned
                 if 'import instants' in path.read_text()]
    assert len(importers) >= 8, importers


#: The modules the root `CLAUDE.md` lists under *the rules that are expensive to
#: break*: **no store, no yfinance, `now` injected**. What that costs is
#: measurable at the import, which is the one form of it a test can hold.
_PURE = ('scheduling', 'performance', 'carrying', 'retention', 'fx',
         'boot_env', 'mounts')

#: The edges a pure module must not reach — the store, the market, and the two
#: file readers. There was a fifth, and it is how the violation was found:
#: `events/__init__.py` imported the drop-folder watcher at module level, so
#: `from events.schemas import Timeline` — which is how `performance` gets the
#: domain's vocabulary — pulled it in, and `import performance` failed with
#: `ModuleNotFoundError: watchdog` outside the full venv. The watcher and its
#: dependency left the project with the folder (ADR-0032), so guarding against
#: a package that is not installed anywhere would be guarding against nothing.
_HEAVY = ('duckdb', 'yfinance', 'pandas', 'openpyxl')


def test_the_pure_modules_are_pure_at_the_import():
    """The rule stated in `CLAUDE.md`, checked rather than promised.

    `carrying.py` re-spells a constant rather than importing it, and says why in
    a comment: *importing it pulls pandas and openpyxl into a pure view module*.
    A rule a contributor works around by hand in one module and breaks in the
    one next door is a rule nothing holds — and the neighbour was `performance`,
    which reached all four edges through a package `__init__`.

    Run in a **subprocess**: `sys.modules` is process-wide and the suite has
    already imported everything by the time this file runs, so asking the
    current interpreter would answer about pytest rather than about the module.
    """
    import subprocess
    import sys

    program = (
        'import sys; sys.path.insert(0, %r)\n'
        'import importlib\n'
        'for name in %r: importlib.import_module(name)\n'
        'print(",".join(sorted(m for m in sys.modules '
        '                      if m.split(".")[0] in %r)))\n'
    ) % (str(_APP / 'src'), _PURE, _HEAVY)

    result = subprocess.run([sys.executable, '-c', program],
                            capture_output=True, text=True)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == '', result.stdout
