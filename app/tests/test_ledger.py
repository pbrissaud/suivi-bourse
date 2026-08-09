"""The ledger in the store, with its provenance (issue #697, spec #695 § 6).

The seam is the one #695's Testing Decisions name: a **real** DuckDB store in
``tmp_path`` and the real ingestion running on it. Nothing here asserts that a
method was called; every assertion is a ``SELECT`` against the store, because
the three rules this ticket carries are rules about *rows*:

1. re-dropping the same filename **replaces** its rows;
2. an **import** is forgotten, never a line;
3. removing the file from disk does **nothing**.

The first test in the file is the four-gesture scenario of the last acceptance
criterion, and it is deliberately first: it is the seam, and each of the three
rules above is one of its gestures.
"""
from datetime import date

import pytest

import ledger
from events.schemas import DEFAULT_ACCOUNT, EventType


ONE_BUY = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
)

# The same file, corrected: the quantity was wrong the first time round.
ONE_BUY_CORRECTED = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-15,BUY,AAPL,Apple Inc,12,150.00,2.50,,Initial purchase\n"
)


def _events(store):
    """Every event row, as ``(date, type, symbol, quantity)`` tuples."""
    return store.query(
        'SELECT date, event_type, symbol, quantity FROM event ORDER BY id')


def _sources(store):
    """Every import_source row, as ``(filename, kind)`` tuples."""
    return store.query(
        'SELECT filename, kind FROM import_source ORDER BY filename')


# --------------------------------------------------------------------------- #
# The seam: four gestures, and the store checked after each one
# --------------------------------------------------------------------------- #

def test_drop_redrop_forget_delete(store, tmp_path):
    """Drop a file, re-drop it corrected, forget its import, delete it.

    One test rather than four because the interesting part is what each gesture
    leaves behind for the next: a forgotten import must not come back when the
    file is deleted, and a deleted file must not take a re-imported row with it.
    """
    drop = tmp_path / "drop"
    drop.mkdir()
    dropped = drop / "2024.csv"

    # ── Gesture 1: drop a file ──────────────────────────────────────────
    dropped.write_text(ONE_BUY, encoding="utf-8")
    ledger.sync_drop_folder(store, drop)

    assert _sources(store) == [("2024.csv", ledger.KIND_EVENTS)]
    assert _events(store) == [(date(2024, 1, 15), "BUY", "AAPL", 10.0)]
    # The symbol got its row at ingestion — before anything ever asks Yahoo
    # about it — or the foreign key on the event would have refused the row.
    assert store.query('SELECT symbol FROM symbol') == [("AAPL",)]

    # ── Gesture 2: re-drop the same name, corrected ─────────────────────
    dropped.write_text(ONE_BUY_CORRECTED, encoding="utf-8")
    ledger.sync_drop_folder(store, drop)

    # Replaced, not doubled. One source, one event, the corrected quantity.
    assert _sources(store) == [("2024.csv", ledger.KIND_EVENTS)]
    assert _events(store) == [(date(2024, 1, 15), "BUY", "AAPL", 12.0)]

    # ── Gesture 3: forget the import ────────────────────────────────────
    (source,) = ledger.list_imports(store)
    removed = ledger.forget_import(store, source.id)

    assert removed == 1
    assert _sources(store) == []
    assert _events(store) == []
    # The symbol row survives its events on purpose: forgetting an import is
    # reversible, and #695 § 10 keeps the orphan series that hangs off it.
    assert store.query('SELECT symbol FROM symbol') == [("AAPL",)]

    # ── Gesture 4: delete the file from disk ────────────────────────────
    # It is still on disk at this point, and a sync would re-import it — which
    # is the correct behaviour and not what this gesture is about. Delete it
    # first, then sync: the store must not change either way.
    dropped.unlink()
    ledger.sync_drop_folder(store, drop)

    assert _sources(store) == []
    assert _events(store) == []


def test_deleting_a_file_leaves_its_rows_alone(store, tmp_path):
    """The other half of gesture 4: the store is the truth, so the rows stay.

    Gesture 4 above deletes a file whose import was already forgotten, which
    proves the deletion does not *resurrect* anything. This proves the
    converse — the one the user actually notices — that deleting a file whose
    import is still live does not take the ledger down with it.
    """
    drop = tmp_path / "drop"
    drop.mkdir()
    dropped = drop / "2024.csv"
    dropped.write_text(ONE_BUY, encoding="utf-8")
    ledger.sync_drop_folder(store, drop)

    dropped.unlink()
    ledger.sync_drop_folder(store, drop)

    assert _sources(store) == [("2024.csv", ledger.KIND_EVENTS)]
    assert _events(store) == [(date(2024, 1, 15), "BUY", "AAPL", 10.0)]


# --------------------------------------------------------------------------- #
# The symbol gets its row at ingestion, before anything asks Yahoo
# --------------------------------------------------------------------------- #

def test_an_event_cannot_name_a_symbol_that_has_no_row(store):
    """The foreign key is why the ordering inside an import is load-bearing.

    The criterion says ``symbol`` is written *at ingestion, before any yfinance
    call*. What makes that a rule rather than a habit is this refusal: an event
    naming ``AAPL`` before ``AAPL`` exists is rejected by the store itself. The
    scrape therefore cannot be the writer of that row — it runs long after the
    event needed it — which is the schema's generating rule (one writer per row)
    showing up as a constraint.
    """
    store.execute(
        'INSERT INTO import_source (id, filename, kind, imported_at, fingerprint) '
        "VALUES (1, 'x.csv', 'events', now(), 'deadbeef')")

    with pytest.raises(Exception, match="(?i)constraint|foreign key"):
        store.execute(
            'INSERT INTO event (id, date, event_type, account, symbol, source_id) '
            "VALUES (1, DATE '2024-01-15', 'BUY', 'default', 'AAPL', 1)")


def test_the_symbol_row_precedes_the_event_inside_one_import(store, tmp_path):
    """And the import writes it, so no yfinance call can have preceded it."""
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "2024.csv").write_text(ONE_BUY, encoding="utf-8")

    ledger.sync_drop_folder(store, drop)

    assert store.query(
        'SELECT count(*) FROM event e JOIN symbol s ON s.symbol = e.symbol'
    ) == [(1,)]


# --------------------------------------------------------------------------- #
# Provenance
# --------------------------------------------------------------------------- #

def test_an_import_lays_down_its_source_row(store, tmp_path):
    """`import_source` carries filename, kind, imported_at and fingerprint."""
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "2024.csv").write_text(ONE_BUY, encoding="utf-8")

    ledger.sync_drop_folder(store, drop)

    (source,) = ledger.list_imports(store)
    assert source.filename == "2024.csv"
    assert source.kind == ledger.KIND_EVENTS
    assert source.imported_at is not None
    assert source.fingerprint == ledger.fingerprint_of(drop / "2024.csv")


def test_events_reference_their_source_with_a_displayable_row(store, tmp_path):
    """"row 14 of 2024.csv" — the triplet is display, never a write address.

    The user story is #695 n°13 and the comment on #697 asks for it to be
    readable end to end, so this asserts the rendered label and not only the
    three columns behind it.
    """
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "2024.csv").write_text(
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,First\n"
        "2024-02-15,BUY,MSFT,Microsoft,5,380.00,2.50,,Second\n",
        encoding="utf-8")

    ledger.sync_drop_folder(store, drop)

    first, second = ledger.read_events(store)
    # Row 2 of the file is the first data row: row 1 is the header, and the
    # number a user is shown has to be the one their editor shows them.
    assert (first.source_sheet, first.source_row) == (None, 2)
    assert (second.source_sheet, second.source_row) == (None, 3)
    assert first.source_filename == "2024.csv"
    assert ledger.provenance_label(first) == "2024.csv, row 2"
    assert ledger.provenance_label(second) == "2024.csv, row 3"


def test_a_source_is_identified_by_its_filename(store, tmp_path):
    """Renaming a file is a **new** source, repairable by forgetting the old."""
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "2024.csv").write_text(ONE_BUY, encoding="utf-8")
    ledger.sync_drop_folder(store, drop)

    (drop / "2024.csv").rename(drop / "renamed.csv")
    ledger.sync_drop_folder(store, drop)

    # Two sources and two identical events: the rename duplicated the ledger,
    # which is the assumed cost §6 names. The repair is to forget one.
    assert [name for name, _ in _sources(store)] == ["2024.csv", "renamed.csv"]
    assert len(_events(store)) == 2

    old = next(s for s in ledger.list_imports(store) if s.filename == "2024.csv")
    ledger.forget_import(store, old.id)

    assert [name for name, _ in _sources(store)] == ["renamed.csv"]
    assert len(_events(store)) == 1


# --------------------------------------------------------------------------- #
# Idempotence, and what an unchanged file costs
# --------------------------------------------------------------------------- #

def test_an_unchanged_file_is_not_re_imported(store, tmp_path):
    """The fingerprint is what makes the always-on watch free.

    The folder is watched with no dial, so a sync can fire on any filesystem
    event — including one that changed nothing. An unchanged fingerprint has to
    be a no-op down to the ``imported_at`` stamp, or "the folder is watched
    always" would mean "the ledger is rewritten always".
    """
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "2024.csv").write_text(ONE_BUY, encoding="utf-8")

    first = ledger.sync_drop_folder(store, drop)
    (before,) = ledger.list_imports(store)

    second = ledger.sync_drop_folder(store, drop)
    (after,) = ledger.list_imports(store)

    assert [o.outcome for o in first] == [ledger.IMPORTED]
    assert [o.outcome for o in second] == [ledger.UNCHANGED]
    assert after.imported_at == before.imported_at


def test_non_event_files_are_ignored(store, tmp_path):
    """Only ``.csv``/``.xlsx`` are event files; the rest of the folder is not."""
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "2024.csv").write_text(ONE_BUY, encoding="utf-8")
    (drop / "notes.txt").write_text("nothing to see", encoding="utf-8")
    (drop / "settings.yaml").write_text("mode: events\n", encoding="utf-8")

    ledger.sync_drop_folder(store, drop)

    assert [name for name, _ in _sources(store)] == ["2024.csv"]


def test_a_missing_drop_folder_is_a_fresh_install_not_an_error(store, tmp_path):
    """A folder nobody has created yet is the nominal first boot."""
    assert ledger.sync_drop_folder(store, tmp_path / "never-created") == []
    assert _events(store) == []


# --------------------------------------------------------------------------- #
# A bad file is not imported at all
# --------------------------------------------------------------------------- #

def test_a_refused_file_leaves_no_row_behind(store, tmp_path):
    """Validation runs before the commit, so a refused file imports nothing."""
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "good.csv").write_text(ONE_BUY, encoding="utf-8")
    (drop / "bad.csv").write_text(
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2024-03-01,SELL,ZZZZ,Nothing,5,10.00,,,Selling what was never bought\n",
        encoding="utf-8")

    outcomes = ledger.sync_drop_folder(store, drop)

    by_name = {o.filename: o for o in outcomes}
    assert by_name["bad.csv"].outcome == ledger.REFUSED
    assert by_name["bad.csv"].error
    # The good file next to it still landed: a refusal is per source, because
    # #698 needs one bad file not to hold the whole folder hostage.
    assert by_name["good.csv"].outcome == ledger.IMPORTED
    assert [name for name, _ in _sources(store)] == ["good.csv"]
    assert [row[2] for row in _events(store)] == ["AAPL"]
    # Not even the symbol of the refused file: the whole import is one
    # transaction, so a rollback takes the ``symbol`` insert with it.
    assert store.query('SELECT symbol FROM symbol') == [("AAPL",)]


def test_a_re_drop_that_does_not_validate_keeps_the_previous_rows(store, tmp_path):
    """The correction is refused, and what was already good is untouched."""
    drop = tmp_path / "drop"
    drop.mkdir()
    dropped = drop / "2024.csv"
    dropped.write_text(ONE_BUY, encoding="utf-8")
    ledger.sync_drop_folder(store, drop)

    dropped.write_text(
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
        "2024-02-01,SELL,AAPL,Apple Inc,999,150.00,,,Oversold\n",
        encoding="utf-8")
    (outcome,) = ledger.sync_drop_folder(store, drop)

    assert outcome.outcome == ledger.REFUSED
    assert _events(store) == [(date(2024, 1, 15), "BUY", "AAPL", 10.0)]


# --------------------------------------------------------------------------- #
# Forgetting is the only destructive gesture, and it is in bulk
# --------------------------------------------------------------------------- #

def test_forgetting_removes_every_row_of_the_import(store, tmp_path):
    """In bulk: the import is the unit of revocation, never the line."""
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "2023.csv").write_text(ONE_BUY, encoding="utf-8")
    (drop / "2024.csv").write_text(
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2024-06-01,BUY,MSFT,Microsoft,5,380.00,2.50,,One\n"
        "2024-07-01,BUY,MSFT,Microsoft,5,390.00,2.50,,Two\n",
        encoding="utf-8")
    ledger.sync_drop_folder(store, drop)

    target = next(s for s in ledger.list_imports(store) if s.filename == "2024.csv")
    assert ledger.forget_import(store, target.id) == 2

    assert [name for name, _ in _sources(store)] == ["2023.csv"]
    assert [row[2] for row in _events(store)] == ["AAPL"]


def test_forgetting_an_unknown_import_is_a_named_refusal(store):
    """Not a silent no-op: the caller asked to revoke something that is not there."""
    with pytest.raises(ledger.UnknownImport):
        ledger.forget_import(store, 4242)


def test_the_module_offers_no_single_row_gesture():
    """No line-level edit exists, by inspection of the module's surface.

    The rule this guards is #697's second: read-only forbids the pointwise
    edit, not the bulk revocation. A helper that updated one event row would
    make a file-provisioned line editable, and the criterion names that as the
    thing not to build — so the absence is asserted rather than assumed.
    """
    surface = set(ledger.__all__)
    forbidden = {name for name in surface
                 if any(word in name.lower()
                        for word in ('update_event', 'edit', 'patch', 'delete_event'))}
    assert forbidden == set()


# --------------------------------------------------------------------------- #
# What the ledger hands back
# --------------------------------------------------------------------------- #

def test_read_events_returns_sorted_typed_events(store, tmp_path):
    """Events come back as ``events.schemas.Event``, date-sorted across files."""
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "b-2024.csv").write_text(
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2024-06-01,BUY,MSFT,Microsoft,5,380.00,2.50,,Later\n",
        encoding="utf-8")
    (drop / "a-2023.csv").write_text(
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2023-01-05,BUY,AAPL,Apple Inc,1,100.00,,,Earlier\n",
        encoding="utf-8")

    ledger.sync_drop_folder(store, drop)
    events = ledger.read_events(store)

    assert [e.date for e in events] == [date(2023, 1, 5), date(2024, 6, 1)]
    assert [e.event_type for e in events] == [EventType.BUY, EventType.BUY]
    assert [e.account for e in events] == [DEFAULT_ACCOUNT, DEFAULT_ACCOUNT]
    assert events[0].name == "Apple Inc"
    assert events[0].unit_price == 100.00


def test_cash_events_land_with_no_symbol(store, tmp_path):
    """``DEPOSIT``/``WITHDRAWAL`` carry no share, so ``event.symbol`` is NULL."""
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "cash.csv").write_text(
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes,account\n"
        "2024-01-01,DEPOSIT,,,,,1.50,1000,Opening,default\n",
        encoding="utf-8")

    ledger.sync_drop_folder(store, drop)

    assert store.query('SELECT symbol, amount, fee FROM event') == [(None, 1000.0, 1.5)]
    assert store.query('SELECT count(*) FROM symbol') == [(0,)]


def test_the_ledger_stamp_changes_only_when_the_ledger_does(store, tmp_path):
    """The replay's cache key: it follows writes, and nothing else."""
    drop = tmp_path / "drop"
    drop.mkdir()
    dropped = drop / "2024.csv"
    dropped.write_text(ONE_BUY, encoding="utf-8")
    ledger.sync_drop_folder(store, drop)
    first = ledger.stamp(store)

    ledger.sync_drop_folder(store, drop)
    assert ledger.stamp(store) == first

    dropped.write_text(ONE_BUY_CORRECTED, encoding="utf-8")
    ledger.sync_drop_folder(store, drop)
    assert ledger.stamp(store) != first


# --------------------------------------------------------------------------- #
# Where validation lives, and where it does not
# --------------------------------------------------------------------------- #

def test_validation_lives_in_the_ddl_and_in_validator_py_and_nowhere_else():
    """Two places, named (criterion 9), and the count is the assertion.

    ``events/loader.py``, ``events/schemas.py`` and ``events/validator.py``
    survive; what checked the *aggregated* share list — ``schema.yaml`` and
    Cerberus — left with #696, and no third checker replaced it. A constraint
    now goes where the error enters (ADR-0007): in the DDL, or in the row
    validator that reads the file.
    """
    import events.loader
    import events.schemas
    import events.validator
    import store as store_module

    assert events.loader.EventLoader is not None
    assert events.schemas.Event is not None
    assert events.validator.EventValidator is not None

    # The DDL is the other half, and it carries real constraints rather than
    # decoration: the foreign keys the ledger leans on are declared there.
    assert 'REFERENCES symbol(symbol)' in store_module.DDL
    assert 'REFERENCES account(id)' in store_module.DDL
    assert 'REFERENCES import_source(id)' in store_module.DDL

    with pytest.raises(ImportError):
        import cerberus  # noqa: F401
