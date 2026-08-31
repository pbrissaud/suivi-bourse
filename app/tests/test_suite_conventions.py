"""What `app/` holds as a whole — the subject here is the tree itself, never a
module of it."""

import ast
import io
import re
import tokenize
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


#: The **repair** of a naive instant, written under a private name. `app/src/`
#: held it in six modules (#843), in variants that had already drifted, and the
#: seventh is what this pattern exists to refuse. It names the **definition**
#: and never the expression `replace(tzinfo=timezone.utc)`: three repairs are
#: made **on the way in** and are legitimate exactly where they stand —
#: `scheduling` repairs an argument it is handed (and is a *pure* module, so it
#: could not import anything that is not), `main` repairs a pandas `Timestamp`
#: at the market's edge, and `web.api._parse_instant` repairs an ISO string
#: arriving from the front. A banner on the expression would bite all three; a
#: banner on the definition bites the copies, which are the subject.
#:
#: `_iso` is named here too, and it is not redundant with the rule below: a
#: private helper that merely *delegates* — `def _iso(v): return instants.iso(v)`
#: — is a second name for one definition, which is how a tree drifts back
#: towards eight of them without ever spelling `isoformat` again.
_PRIVATE_TIME_HELPER = re.compile(r'^def _(?:utc|iso|stamp_value)\s*\(',
                                  re.MULTILINE)

#: Where the two of them live, and the only file exempted — by its name, which
#: is the repository's precedent for an exclusion.
_INSTANTS = 'src/instants.py'


def _hands_back_an_iso_string(node) -> bool:
    """Whether a returned expression *is* somebody's `.isoformat()`.

    The **serialization** half of the rule, and it is stated by shape rather
    than by name: a function whose own answer is a value's `.isoformat()` is a
    definition of the ISO serialization whatever it is called, and `_day` —
    which the first pass at #843 left standing because the pattern enumerated
    `_utc|_iso|_stamp_value` instead of saying the rule — is the proof that a
    list of names is not the rule.

    The test is on the **top** of the returned expression, through the two
    wrappers a `None` guard uses (`x.isoformat() if x else None`, and the
    `and`/`or` spelling of the same). A payload builder that spells one field's
    `.isoformat()` inside a dict it returns is untouched: it hands back a
    payload, not a serialization, and folding those is another subject.
    """
    if isinstance(node, ast.IfExp):
        return (_hands_back_an_iso_string(node.body)
                or _hands_back_an_iso_string(node.orelse))
    if isinstance(node, ast.BoolOp):
        return any(_hands_back_an_iso_string(value) for value in node.values)
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'isoformat')


def _private_iso_serializers(source: str):
    """The private functions of one module that serialize ISO themselves."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.name.startswith('_'):
            continue
        for statement in ast.walk(node):
            if (isinstance(statement, ast.Return)
                    and statement.value is not None
                    and _hands_back_an_iso_string(statement.value)):
                found.append(node.name)
                break
    return found


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

    The guard has two halves because the fault has two shapes. The **name** half
    refuses `_utc`, `_iso` and `_stamp_value`, which is how the copies were
    spelled and how a delegating alias would re-spell them. The **shape** half
    refuses a private function that hands back a value's own `.isoformat()`
    *whatever it is called*: enumerating names is not the rule, and the first
    pass at #843 proved it — `runtime_view._day` was a second definition of the
    serialization, identical to the `date` branch of `instants.iso`, and it went
    through a pattern that listed three names.

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
        source = path.read_text()
        if _PRIVATE_TIME_HELPER.search(source):
            offenders.append(relative)
        offenders += [f'{relative}::{name}'
                      for name in _private_iso_serializers(source)]

    assert offenders == []

    # The other half: the home exists, it is where the tree imports from, and
    # it answers under the two public names the copies were folded into.
    home = (_APP / _INSTANTS).read_text()
    assert 'def utc(' in home and 'def iso(' in home
    importers = [path.relative_to(_APP).as_posix() for path in scanned
                 if 'import instants' in path.read_text()]
    assert len(importers) >= 8, importers


def test_the_serialization_guard_reads_the_shape_and_not_the_name():
    """#843, second pass: the guard above bites a copy called anything.

    The first pass wrote the rule as the list `_utc|_iso|_stamp_value`, and a
    list of names is not a rule: `runtime_view._day` was a second definition of
    the ISO serialization, identical to the `date` branch of `instants.iso`,
    and it walked straight through. Asserting that on the tree alone would go
    green again the day somebody writes the ninth copy under a tenth name and
    nobody notices — so the shape is exercised here on snippets, where a refusal
    and an acquittal can both be shown.

    What must be refused is *a private function whose own answer is a value's
    `.isoformat()`*, under any name and through a `None` guard of either
    spelling. What must be acquitted is everything the ticket left standing: a
    payload builder that spells one field inline, a public route doing the same,
    and the three repairs made **on the way in**, which the expression-level
    banner would have bitten.
    """
    refused = [
        "def _day(value):\n    return value.isoformat()\n",
        "def _horizon(value):\n"
        "    return value.isoformat() if value is not None else None\n",
        "def _moment(value):\n    return value and value.isoformat()\n",
    ]
    for source in refused:
        assert _private_iso_serializers(source) != [], source

    acquitted = [
        # A payload builder spelling one field inline: it hands back a payload.
        "def _event_to_dict(event):\n"
        "    return {'date': event.date.isoformat()}\n",
        # A public route doing the same — the rule is about private copies.
        "def get_history(start):\n    return {'from': start.isoformat()}\n",
        # The three repairs on the way in, which stay where they stand.
        "def _parse_instant(text):\n"
        "    parsed = datetime.fromisoformat(text)\n"
        "    return parsed if parsed.tzinfo else"
        " parsed.replace(tzinfo=timezone.utc)\n",
        "def _newest(newest):\n"
        "    return newest.replace(tzinfo=timezone.utc)\n",
    ]
    for source in acquitted:
        assert _private_iso_serializers(source) == [], source


#: The modules the root `CLAUDE.md` lists under *the rules that are expensive to
#: break*: **no store, no yfinance, `now` injected**. What that costs is
#: measurable at the import, which is the one form of it a test can hold.
_PURE = ('scheduling', 'performance', 'carrying', 'retention', 'fx',
         'boot_env', 'mounts', 'market_info')

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


#: The market edge, and the two halves #846 split it into. `market.py` is the
#: impure one — `yf.Ticker`, the retries, the three error policies — and
#: `market_info.py` the pure translation, which is why the second is in `_PURE`
#: above and the first can never be.
_MARKET = 'src/market.py'

#: Binding the library, which is the door the suite fakes: this is the
#: repository's own grep for the library's import, written as a rule instead —
#: and spelled so this file is not itself an answer to that grep.
_BINDS_YFINANCE = re.compile(r'^\s*import\s+yfinance\b', re.MULTILINE)

#: Reaching into it for a name — its exception classes, in practice. Held over
#: `src/` alone, because an exception class is the library's vocabulary rather
#: than its edge: a test that has to raise one is not opening a second door.
#: No test does today — `market` re-exports `YFRateLimitError`, so the suite
#: reaches it through the edge like everything else — and the day one needs the
#: library's own name for something the edge does not carry, it may take it.
_READS_FROM_YFINANCE = re.compile(r'^\s*from\s+yfinance\b', re.MULTILINE)

#: The word the app used to write for a field Yahoo holds no value for, as a
#: **string literal**: the English word appears in half a dozen docstrings
#: talking about something else entirely — an annualized rate over a zero
#: horizon, the unit price of a position nobody holds — and none of those is
#: the subject.
_NAMES_THE_SENTINEL = re.compile(r"""['"]undefined['"]""")


def _offenders(root, pattern):
    """The files of one root whose text matches, this one excepted."""
    scanned = sorted(root.rglob('*.py'))
    # Asserted per root, for the reason written on the clock guard above: a
    # root that stopped resolving reads no file and reports clean for ever.
    assert len(scanned) > 20, root
    return sorted(path.relative_to(_APP).as_posix() for path in scanned
                  if path.resolve() != _THIS and pattern.search(path.read_text()))


def test_the_market_edge_is_imported_in_one_module():
    """#846, checked on the source: one edge, one import.

    The sibling of `test_the_pure_modules_are_pure_at_the_import`, and it holds
    the other half of the same rule. Purity is measurable at the import because
    a pure module imports **nothing** heavy; the market edge is measurable
    there too, because it is the one module that may. Between the two,
    `yfinance` has exactly one door in the tree — and it is the absence of that
    door that made three divergent translations of one payload possible, every
    path that wanted to speak to Yahoo having to be a method of the same class.

    `app/tests/` is policed beside `app/src/`, because the suite's one faked
    external edge is that same door (`monkeypatch.setattr(market.yf, "Ticker",
    ...)`): a test binding the library itself would be a second one.
    """
    binders = (_offenders(_APP / 'src', _BINDS_YFINANCE)
               + _offenders(_APP / 'tests', _BINDS_YFINANCE))
    assert binders == [_MARKET]

    # And in the product, the exception classes come in at the same door.
    assert _offenders(_APP / 'src', _READS_FROM_YFINANCE) == [_MARKET]


def test_the_sentinel_is_written_nowhere_at_all():
    """#845: the word was never Yahoo's, and the app has stopped saying it.

    It was **set** as a default on three keys in one method, **removed** in two
    others that did not remove it the same way, and **not removed** by the
    translation towards the quotation columns — so it reached
    `symbol_quote.currency`, came back out as a currency, and was named as one
    half of a pair that does not exist. #846 gathered the four readings into
    `market_info`; this ticket deleted the value itself, which is what makes the
    guard an emptiness rather than a location.

    `yfinance==1.5.2` contains no occurrence of the string. Two comments in the
    tree asserted the opposite for six months, which is the whole reason the
    guard is written over the **suite** as well: a fixture stating that Yahoo
    answers this word is a fixture that re-teaches the belief, and the next
    reader would write the third divergent removal against it.
    """
    assert _offenders(_APP / 'src', _NAMES_THE_SENTINEL) == []
    assert _offenders(_APP / 'tests', _NAMES_THE_SENTINEL) == []


#: The ceiling one class may occupy, counted in **lines that do something**:
#: every line of its extent that is neither blank, nor a comment, nor a
#: docstring. #842 opened the runtime class at 2 737 lines of file — 788 of
#: which did something — and 47 methods, and asked for ~500; #847 to #850 took
#: the four workloads out and renamed what was left, and this is what holds the
#: split.
#:
#: **Raw extent was measured and rejected**, and the number is why: the four
#: classes the split produced span 1 018, 608, 484 and 253 lines of file, of
#: which 324, 223, 146 and 73 do anything at all. Two thirds of this tree is
#: the design record — the reason a pass is gated where it is, the defect a
#: guard exists to refuse — and a ceiling on raw lines is a ceiling on writing
#: that down. It would have been met, here and in the three tickets before this
#: one, by deleting prose rather than by moving a concern, which is the
#: opposite of what #842 asked for.
#:
#: 350 rather than 500 because the measure changed: it is set where it bites —
#: `BackfillWorkload`, the largest of the four at 324, is twenty-six lines from
#: it — so a fifth concern written back into any of them fails here rather than
#: being noticed by a reader two years later. Raising it is a conversation, not
#: a keystroke.
_CLASS_CEILING = 350


def _class_extents(path: Path) -> dict:
    """``{class name: lines that do something}`` for one module.

    `ast` and `tokenize` rather than a regex, so a decorator, a nested class or
    a string containing `class ` cannot move the count — and so that a comment
    is told from the code it sits above by the tokenizer rather than by a
    guess at indentation.
    """
    source = path.read_text(encoding='utf-8')
    tree = ast.parse(source)
    lines = source.splitlines()

    silent = set()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            silent.add(token.start[0])
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef,
                             ast.FunctionDef, ast.AsyncFunctionDef)):
            if ast.get_docstring(node, clean=False) is not None:
                first = node.body[0]
                silent.update(range(first.lineno, first.end_lineno + 1))

    extents = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        extents[node.name] = sum(
            1 for n in range(node.lineno, node.end_lineno + 1)
            if lines[n - 1].strip() and n not in silent)
    return extents


def test_no_class_in_the_product_outgrows_a_reading():
    """#850, and the ceiling #842 asked for.

    The runtime class carried four workloads under one lock and one cache
    before #847 to #850 took them out one at a time — the scrape, the backfill,
    the performance recompute, then the ingestion. Nothing about that split
    *holds*, though: a fifth concern written back into one of the four, or a
    writer growing a second one, would rebuild the same object under a
    different name, and the only thing that noticed last time was a reader
    opening the file two years later.

    Held on the **product** alone. The suite's own files run long by nature —
    one module's behaviour, stated case by case — and a class there is a
    fixture rather than a thing anybody has to hold in their head.
    """
    oversized = {}
    for path in sorted((_APP / 'src').rglob('*.py')):
        for name, extent in _class_extents(path).items():
            if extent > _CLASS_CEILING:
                oversized[f'{path.name}:{name}'] = extent

    assert oversized == {}, (
        f"classes over {_CLASS_CEILING} lines of code: {oversized}. A class "
        f"that has grown a second concern belongs in two modules, the way #847 "
        f"to #850 took four workloads out of one.")
