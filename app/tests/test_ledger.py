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

**And since #811 the file has a second half, which is the same subject through
another door.** What it covers was never the folder: it is the loader, the
validator and the aggregator — the header that decides the genre, the file
refused whole, the events sorted by date whatever their order. Those survive the
mount (ADR-0032) and are asserted below on ``POST /api/events/import``, on the
API's own seam. The two doors coexist deliberately for two tickets: the product
is never without a file entrance.
"""
import io
from datetime import date

import openpyxl
import pytest

import ledger
import uploads
from events.schemas import DEFAULT_ACCOUNT, EventType
from test_web_api import ACCOUNTS_FILE, build_client, build_client_and_store
from web import problem


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


def test_a_file_dropped_again_unchanged_says_so(store, tmp_path, mocker):
    """« Même fichier redéposé, rien n'a bougé » — a message, never a column (#728).

    The fingerprint is what notices it, and **nobody reads a hexadecimal**: what
    an identical fingerprint is worth is one sentence at the instant of the
    import, which is why the import list has no column for the hash and this
    line exists instead. It is said beside the two lines that already report a
    file — imported, refused — rather than in the caller, because the comparison
    that produces it is made here.

    The channel is the log because an import needs no interface at all: the drop
    folder is watched at all times (#697), so a file can land with no click and
    no browser open. And a sync fires on a filesystem event rather than on a
    timer, so this is said when something was dropped rather than every cycle.
    """
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "2024.csv").write_text(ONE_BUY, encoding="utf-8")

    first = mocker.patch.object(ledger.logger, "info")
    ledger.sync_drop_folder(store, drop)
    # Imported is not unchanged: the first pass has nothing of the sort to say.
    assert [c for c in first.call_args_list if "unchanged" in c.args[0].lower()] == []

    again = mocker.patch.object(ledger.logger, "info")
    ledger.sync_drop_folder(store, drop)

    (message,) = again.call_args_list
    assert "2024.csv" in message.args[0]
    assert "unchanged" in message.args[0].lower()


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
    """No line-level edit exists **here**, by inspection of the module's surface.

    The rule this guards is #697's second: read-only forbids the pointwise
    edit, not the bulk revocation. A helper that updated one event row would
    make a file-provisioned line editable, and the criterion names that as the
    thing not to build — so the absence is asserted rather than assumed.

    Since #764 the sentence names its population, and this assertion is what
    keeps the split **structural**: the three gestures a row somebody *typed*
    earns live in :mod:`entries`, whose every entry point refuses a row with a
    ``source_id`` (``tests/test_entries.py``). The import path having none is
    what makes *"a file's row is revoked, never edited"* true by construction
    rather than by care.
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


# --------------------------------------------------------------------------- #
# The same file, another door: POST /api/events/import (issue #811, ADR-0032)
#
# What is above this line is about the **drop folder**, which is still mounted
# and still watched — the mount leaves at #815, and until then the product is
# never without a file entrance. What is below it is the *behaviours* the three
# sections above prove, asserted through the route that will outlive them: the
# header decides the genre, a file is refused whole, the events are sorted by
# date whatever the file says. #803's trap is that this file reads as a test of
# the folder and is not one — it is a test of the loader, the validator and the
# aggregator, which change door and not meaning.
#
# The seam is the API's, on the same real store: the client is built by
# ``test_web_api``'s own builder rather than by a second copy of it, so the two
# files exercise one wiring.
# --------------------------------------------------------------------------- #

def _upload(client, body, filename="2024.csv", query=""):
    """Hand one file to the route, as a browser's own form would.

    ``query`` is the gesture's two parameters (#813) spelled as a client sends
    them: ``?dry_run=1`` previews, ``?write_duplicates=1`` writes what the ledger
    already has.
    """
    return client.post(
        f'/api/events/import{query}',
        data={'file': (io.BytesIO(body), filename)},
        content_type='multipart/form-data')


def _workbook(rows):
    """The same ledger as an ``.xlsx``, in memory."""
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    for row in rows:
        sheet.append(row)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def test_a_csv_uploaded_writes_its_lines(tmp_path):
    """The criterion, and the assertion is on the table rather than on a call."""
    client, opened = build_client_and_store(tmp_path)

    response = _upload(client, ONE_BUY.encode('utf-8'))

    assert response.status_code == 201
    assert _events(opened) == [(date(2024, 1, 15), "BUY", "AAPL", 10.0)]
    # The symbol got its row before the event referenced it — the foreign key
    # would have refused it otherwise, on this road as on the folder's.
    assert opened.query('SELECT symbol FROM symbol') == [("AAPL",)]


def test_an_xlsx_uploaded_writes_its_lines(tmp_path):
    """The second format, and it is the header that says what the file is."""
    client, opened = build_client_and_store(tmp_path)
    body = _workbook([
        ("date", "event_type", "symbol", "name", "quantity", "unit_price"),
        ("2024-01-15", "BUY", "AAPL", "Apple Inc", 10, 150.0),
    ])

    response = _upload(client, body, filename="ledger.xlsx")

    assert response.status_code == 201
    assert _events(opened) == [(date(2024, 1, 15), "BUY", "AAPL", 10.0)]


def test_an_uploaded_row_is_written_by_entries_and_carries_no_source(tmp_path):
    """*Indistinguishable from a typed one* is a column, not a sentiment.

    ``source_id NULL`` is what ``entries`` writes and what makes the row
    editable; a second population would show up right here.
    """
    client, opened = build_client_and_store(tmp_path)

    _upload(client, ONE_BUY.encode('utf-8'))

    assert opened.query('SELECT source_id FROM event') == [(None,)]
    assert opened.query('SELECT count(*) FROM import_source') == [(0,)]


def test_uploaded_events_are_sorted_by_date_whatever_the_file_order(tmp_path):
    """The spreadsheet's own order has no meaning (story 12)."""
    client, opened = build_client_and_store(tmp_path)
    unsorted = (
        "date,event_type,symbol,name,quantity,unit_price\n"
        "2024-09-15,BUY,AAPL,Apple Inc,1,190.00\n"
        "2023-01-05,BUY,AAPL,Apple Inc,1,100.00\n"
        "2024-06-01,BUY,AAPL,Apple Inc,1,150.00\n"
    ).encode('utf-8')

    _upload(client, unsorted)

    assert [row[0] for row in _events(opened)] == [
        date(2023, 1, 5), date(2024, 6, 1), date(2024, 9, 15)]


def test_an_uploaded_line_is_then_read_by_the_events_resource(tmp_path):
    """It joins the ledger everything else reads, not a second collection."""
    client = build_client(tmp_path)

    _upload(client, ONE_BUY.encode('utf-8'))
    payload = client.get('/api/events').get_json()

    (event,) = payload
    assert event['symbol'] == "AAPL"
    assert event['quantity'] == 10.0
    assert event['source_filename'] is None
    assert event['provenance'] is None


def test_the_receipt_says_what_the_gesture_produced(tmp_path):
    """Lines written, the period covered, the accounts and titles touched.

    One object, and the preview of #813 answers the same one before writing.
    """
    client = build_client(tmp_path)
    body = (
        "date,event_type,symbol,name,quantity,unit_price,fee,amount\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,\n"
        "2024-06-01,BUY,MSFT,Microsoft,5,380.00,2.50,\n"
        "2024-09-15,DIVIDEND,AAPL,Apple Inc,,,,8.50\n"
    ).encode('utf-8')

    receipt = _upload(client, body, filename="broker.csv").get_json()

    assert receipt['filename'] == "broker.csv"
    assert receipt['written'] == 3
    assert receipt['period'] == {'from': '2024-01-15', 'to': '2024-09-15'}
    assert receipt['accounts'] == ["default"]
    assert receipt['symbols'] == ["AAPL", "MSFT"]


def test_a_file_that_writes_nothing_has_a_receipt_with_no_period(tmp_path):
    """A header and no row under it: nothing written, and no period to state."""
    client = build_client(tmp_path)

    receipt = _upload(
        client, b"date,event_type,symbol,name,quantity,unit_price\n").get_json()

    assert receipt['written'] == 0
    assert receipt['period'] is None
    assert receipt['symbols'] == []


# --------------------------------------------------------------------------- #
# The receipt before the write, and the duplicates caught by content (#813)
#
# Two features and one subject: what the owner is told *before* the file costs
# anything. The assertions are on the store's contents and on the receipt's
# payload — never on a call — because both features are claims about rows: the
# preview's is that there are none, the dedup's is which ones there are.
# --------------------------------------------------------------------------- #

#: Three lines, three days, two securities — a file that is worth previewing.
THREE_LINES = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,\n"
    "2024-06-01,BUY,MSFT,Microsoft,5,380.00,2.50,\n"
    "2024-09-15,DIVIDEND,AAPL,Apple Inc,,,,8.50\n"
).encode('utf-8')


def test_a_dry_run_answers_the_receipt_and_writes_nothing(tmp_path):
    """The criterion, and the assertion is on the table rather than on a call.

    ``?dry_run=1`` reads, judges and answers; the store is exactly as it stood.
    The status is ``200`` and not ``201`` for the plainest of reasons: nothing
    was created, and there is nothing to come back to — the preview holds no
    server state at all (ADR-0032).
    """
    client, opened = build_client_and_store(tmp_path)

    response = _upload(client, THREE_LINES, filename="broker.csv",
                       query="?dry_run=1")

    assert response.status_code == 200
    receipt = response.get_json()
    assert receipt['filename'] == "broker.csv"
    assert receipt['written'] == 3
    assert receipt['period'] == {'from': '2024-01-15', 'to': '2024-09-15'}
    assert receipt['accounts'] == ["default"]
    assert receipt['symbols'] == ["AAPL", "MSFT"]
    # The whole of it: the ledger has not moved, and neither has anything the
    # ingestion derives from it.
    assert opened.query('SELECT count(*) FROM event') == [(0,)]
    assert opened.query('SELECT count(*) FROM symbol') == [(0,)]


def test_the_forecast_and_the_fact_are_the_same_object(tmp_path):
    """One shape, read twice — so the reader recognises after what they read
    before (ADR-0032). The two payloads are compared member for member."""
    client = build_client(tmp_path)

    forecast = _upload(client, THREE_LINES, query="?dry_run=1").get_json()
    fact = _upload(client, THREE_LINES).get_json()

    assert forecast == fact


def test_the_preview_refuses_what_the_write_would_refuse(tmp_path):
    """A forecast the commit could contradict is not a forecast (story 9).

    The file names an account nobody declared. The preview answers the same
    ``422``, with the same sentence naming the same account — and writes nothing,
    which on this road is not a rollback but the absence of a write.
    """
    client, opened = build_client_and_store(tmp_path)
    body = (
        "date,event_type,symbol,name,quantity,unit_price,account\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n"
    ).encode('utf-8')

    response = _upload(client, body, query="?dry_run=1")

    assert response.status_code == 422
    assert "'pea' is not declared" in response.get_json()['detail']
    assert opened.query('SELECT count(*) FROM event') == [(0,)]


def test_the_preview_sees_the_oversell_the_write_would_refuse(tmp_path):
    """The second judgement, and it is a property of the **ledger**.

    The preview replays the ledger the file would leave, so a sale of shares
    nobody holds is a ``409`` before it costs anything — the same status the
    write answers, from the same exception.
    """
    client, opened = build_client_and_store(tmp_path)
    _upload(client, ONE_BUY.encode('utf-8'))
    body = (
        "date,event_type,symbol,name,quantity,unit_price\n"
        "2024-02-01,SELL,AAPL,Apple Inc,999,190.00\n"
    ).encode('utf-8')

    response = _upload(client, body, filename="sale.csv", query="?dry_run=1")

    assert response.status_code == 409
    assert _events(opened) == [(date(2024, 1, 15), "BUY", "AAPL", 10.0)]


def test_a_second_upload_of_the_same_file_writes_nothing(tmp_path):
    """The gesture this dedup exists for: the owner re-uploads their export.

    Zero lines written, every one of them counted as a duplicate, and the
    ledger's row count unmoved — *the common case asks for no vigilance*
    (story 5). The receipt still describes the **file**, period and securities
    included, because that is what the reader is looking at.
    """
    client, opened = build_client_and_store(tmp_path)
    _upload(client, THREE_LINES, filename="broker.csv")

    receipt = _upload(client, THREE_LINES, filename="broker.csv").get_json()

    assert receipt['rows'] == 3
    assert receipt['written'] == 0
    assert receipt['duplicates'] == 3
    assert receipt['period'] == {'from': '2024-01-15', 'to': '2024-09-15'}
    assert opened.query('SELECT count(*) FROM event') == [(3,)]


def test_two_overlapping_files_write_only_the_difference(tmp_path):
    """What the filename could never see (ADR-0032).

    The replaced-by-name rule the drop folder had would have taken these for two
    unrelated files and recorded the January row twice. The content key sees the
    overlap for what it is: one row already held, one row new.
    """
    client, opened = build_client_and_store(tmp_path)
    january = (
        "date,event_type,symbol,name,quantity,unit_price,fee\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50\n"
    ).encode('utf-8')
    january_and_february = (
        "date,event_type,symbol,name,quantity,unit_price,fee\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50\n"
        "2024-02-01,BUY,MSFT,Microsoft,5,380.00,2.50\n"
    ).encode('utf-8')
    _upload(client, january, filename="export-2024-01.csv")

    receipt = _upload(client, january_and_february,
                      filename="export-2024-02.csv").get_json()

    assert receipt['written'] == 1
    assert receipt['duplicates'] == 1
    assert _events(opened) == [
        (date(2024, 1, 15), "BUY", "AAPL", 10.0),
        (date(2024, 2, 1), "BUY", "MSFT", 5.0)]


def test_a_line_the_file_repeats_is_a_duplicate_of_itself(tmp_path):
    """Compared against the ledger **and** against the file itself.

    An export appended to itself is the case, and nothing in the bytes tells it
    from an order filled twice — which is exactly why the second line is
    reported rather than decided upon, and why the flag below exists.
    """
    client, opened = build_client_and_store(tmp_path)
    twice = (
        "date,event_type,symbol,name,quantity,unit_price,fee\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50\n"
    ).encode('utf-8')

    receipt = _upload(client, twice).get_json()

    assert receipt['rows'] == 2
    assert receipt['written'] == 1
    assert receipt['duplicates'] == 1
    assert opened.query('SELECT count(*) FROM event') == [(1,)]


def test_the_explicit_flag_writes_the_duplicates_anyway(tmp_path):
    """Story 6: the owner really did place the same order twice.

    The app does not decide on their behalf what is a duplicate — it reports,
    skips, and offers. With the flag the comparison is not made at all, and the
    ledger carries both lines.
    """
    client, opened = build_client_and_store(tmp_path)
    one_buy = ONE_BUY.encode('utf-8')
    _upload(client, one_buy)

    receipt = _upload(client, one_buy,
                      query="?write_duplicates=1").get_json()

    assert receipt['written'] == 1
    assert receipt['duplicates'] == 0
    assert _events(opened) == [
        (date(2024, 1, 15), "BUY", "AAPL", 10.0),
        (date(2024, 1, 15), "BUY", "AAPL", 10.0)]


def test_the_preview_counts_the_duplicates_without_writing_either(tmp_path):
    """The two features meet: *what of it the ledger already has*, before a row.

    This is the sentence the owner reads to decide, and the store must be
    exactly as unchanged as it is on an empty preview.
    """
    client, opened = build_client_and_store(tmp_path)
    _upload(client, THREE_LINES)

    receipt = _upload(client, THREE_LINES, query="?dry_run=1").get_json()

    assert receipt['written'] == 0
    assert receipt['duplicates'] == 3
    assert opened.query('SELECT count(*) FROM event') == [(3,)]


def test_the_name_and_the_notes_are_not_part_of_the_key(tmp_path):
    """Annotating a row must not make it re-importable (ADR-0032).

    The second file is the first with a note added and the security renamed —
    the two members the key deliberately leaves out. It is the same purchase, and
    it is skipped.
    """
    client, opened = build_client_and_store(tmp_path)
    plain = (
        "date,event_type,symbol,name,quantity,unit_price,fee,notes\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,\n"
    ).encode('utf-8')
    annotated = (
        "date,event_type,symbol,name,quantity,unit_price,fee,notes\n"
        "2024-01-15,BUY,AAPL,Apple Incorporated,10,150.00,2.50,"
        "PEA - ordre du matin\n"
    ).encode('utf-8')
    _upload(client, plain)

    receipt = _upload(client, annotated).get_json()

    assert receipt['duplicates'] == 1
    assert opened.query('SELECT count(*) FROM event') == [(1,)]


def test_a_blank_account_column_keys_as_the_default_it_becomes(tmp_path):
    """The one member the key resolves rather than reads.

    A file with no ``account`` column writes ``default``, so a re-import of that
    same file has to hash to what the store holds or every account-less export
    would land twice. The two files below differ only in **carrying** the column.
    """
    client, opened = build_client_and_store(tmp_path)
    without = (
        "date,event_type,symbol,name,quantity,unit_price,fee\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50\n"
    ).encode('utf-8')
    with_default = (
        "date,event_type,symbol,name,quantity,unit_price,fee,account\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,default\n"
    ).encode('utf-8')
    _upload(client, without)

    receipt = _upload(client, with_default).get_json()

    assert receipt['duplicates'] == 1
    assert opened.query('SELECT count(*) FROM event') == [(1,)]


def test_the_receipt_counts_close_on_the_file(tmp_path):
    """``rows == written + duplicates``, at both moments and under the flag.

    The glossary's three numbers (`CONTEXT.md` § Receipt), asserted as an
    identity rather than as three separate figures: a client renders the skipped
    lines without subtracting anything, and a fourth column would have to come
    from somewhere.
    """
    client = build_client(tmp_path)
    _upload(client, ONE_BUY.encode('utf-8'))

    for query in ("", "?dry_run=1", "?write_duplicates=1"):
        receipt = _upload(client, THREE_LINES, query=query).get_json()
        assert receipt['rows'] == receipt['written'] + receipt['duplicates']


# --------------------------------------------------------------------------- #
# The refusals: each one names its subject, and none of them writes
# --------------------------------------------------------------------------- #

def test_an_unrecognised_header_is_refused_naming_the_column(tmp_path):
    """Not *the file is invalid*: the column that is missing (story 11)."""
    client, opened = build_client_and_store(tmp_path)
    body = b"day,kind,symbol\n2024-01-15,BUY,AAPL\n"

    response = _upload(client, body)

    assert response.status_code == 422
    assert response.mimetype == 'application/problem+json'
    assert 'event_type' in response.get_json()['detail']
    assert opened.query('SELECT count(*) FROM event') == [(0,)]


def test_an_undeclared_account_is_refused_naming_the_account(tmp_path):
    """The statement is new (story 9), and it is written rather than deduced.

    *Accounts before events* was a property of the order several files were
    imported in. One file per gesture makes it this: a file naming an account
    nobody declared is refused, and the refusal names the account so the reader
    knows what to declare.
    """
    client, opened = build_client_and_store(tmp_path)
    body = (
        "date,event_type,symbol,name,quantity,unit_price,account\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n"
    ).encode('utf-8')

    response = _upload(client, body)

    assert response.status_code == 422
    assert "'pea' is not declared" in response.get_json()['detail']
    assert opened.query('SELECT count(*) FROM event') == [(0,)]


def test_a_declared_account_is_written_as_the_file_named_it(tmp_path):
    """The refusal above is about the declaration, never about the column."""
    client, opened = build_client_and_store(tmp_path, accounts=ACCOUNTS_FILE)
    body = (
        "date,event_type,symbol,name,quantity,unit_price,account\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n"
    ).encode('utf-8')

    receipt = _upload(client, body).get_json()

    assert receipt['accounts'] == ["pea"]
    assert opened.query('SELECT account FROM event') == [("pea",)]


def test_a_v4_config_file_is_refused_by_its_name_and_points_at_the_migration(tmp_path):
    """The sentence the two ``legacy_*`` advisories said later and elsewhere.

    It is said at the instant of the gesture now (story 10, ADR-0032), which is
    the only moment at which the owner is holding the file.
    """
    client, opened = build_client_and_store(tmp_path)

    response = _upload(client, b"shares:\n  - name: Apple\n",
                       filename="config.yaml")

    assert response.status_code == 422
    detail = response.get_json()['detail']
    assert 'config.yaml' in detail
    assert 'coming-from-v4' in detail
    assert opened.query('SELECT count(*) FROM event') == [(0,)]


def test_an_accounts_file_is_refused_naming_what_it_recognised(tmp_path):
    """Accounts are born in the app and nowhere else (ADR-0034).

    Read off the **header**, never off the name, which is the rule that does
    not move: the file below is called after the events and declares accounts.
    """
    client, opened = build_client_and_store(tmp_path)

    response = _upload(client, ACCOUNTS_FILE.encode('utf-8'),
                       filename="2024.csv")

    assert response.status_code == 422
    assert 'accounts' in response.get_json()['detail']
    assert opened.query('SELECT count(*) FROM account WHERE id <> ?',
                        ['default']) == [(0,)]


def test_a_file_the_app_cannot_read_at_all_is_refused_naming_the_two_it_takes(tmp_path):
    """A ``.pdf`` is not a ledger, and the refusal says what a ledger is."""
    response = _upload(build_client(tmp_path), b"%PDF-1.4\n",
                       filename="statement.pdf")

    assert response.status_code == 422
    detail = response.get_json()['detail']
    assert '.csv' in detail and '.xlsx' in detail


def test_a_file_beyond_the_bound_is_refused_with_its_own_type(tmp_path):
    """A written bound beats a ``MemoryError`` (criterion 6)."""
    client, opened = build_client_and_store(tmp_path)
    oversized = b"x" * (uploads.MAX_UPLOAD_BYTES + 1)

    response = _upload(client, oversized)

    assert response.status_code == 413
    assert response.mimetype == 'application/problem+json'
    assert response.get_json()['type'] == problem.TYPE_TOO_LARGE
    assert opened.query('SELECT count(*) FROM event') == [(0,)]


def test_a_refused_upload_leaves_the_ledger_exactly_as_it_stood(tmp_path):
    """One bad row refuses the file whole — the loader's rule, at the door.

    The ledger below already holds an event, and what is uploaded is a file
    whose second line is not one the validator takes. Nothing of it lands, and
    what was there is untouched.
    """
    client, opened = build_client_and_store(tmp_path)
    _upload(client, ONE_BUY.encode('utf-8'))
    body = (
        "date,event_type,symbol,name,quantity,unit_price\n"
        "2024-02-01,BUY,MSFT,Microsoft,5,380.00\n"
        "2024-03-01,BUY,MSFT,Microsoft,5,\n"
    ).encode('utf-8')

    response = _upload(client, body, filename="second.csv")

    assert response.status_code == 422
    assert _events(opened) == [(date(2024, 1, 15), "BUY", "AAPL", 10.0)]


def test_a_ledger_that_would_not_replay_is_a_conflict(tmp_path):
    """Overselling is a property of the **ledger**, not of a row.

    The same answer ``POST /api/events`` gives, for the same reason: the file
    is well formed and the store's state refuses what it would make.
    """
    client, opened = build_client_and_store(tmp_path)
    _upload(client, ONE_BUY.encode('utf-8'))
    body = (
        "date,event_type,symbol,name,quantity,unit_price\n"
        "2024-02-01,SELL,AAPL,Apple Inc,999,190.00\n"
    ).encode('utf-8')

    response = _upload(client, body, filename="sale.csv")

    assert response.status_code == 409
    assert _events(opened) == [(date(2024, 1, 15), "BUY", "AAPL", 10.0)]


def test_the_route_wants_a_file_and_says_so(tmp_path):
    """A multipart body with no file part is a malformed request, not a refusal."""
    response = build_client(tmp_path).post(
        '/api/events/import', data={}, content_type='multipart/form-data')

    assert response.status_code == 400
    assert response.mimetype == 'application/problem+json'


def test_a_workbook_that_is_not_one_is_refused_rather_than_unexpected(tmp_path):
    """Untrusted bytes are refused, never *the app hit an error it did not expect*.

    A ``.xlsx`` that is not a zip raises out of openpyxl rather than as the
    loader's own error, and a refusal is the one thing the reader can act on
    about a file they chose themselves.
    """
    client, opened = build_client_and_store(tmp_path)

    response = _upload(client, b"not a workbook at all", filename="broker.xlsx")

    assert response.status_code == 422
    assert response.mimetype == 'application/problem+json'
    assert 'broker.xlsx' in response.get_json()['detail']
    assert opened.query('SELECT count(*) FROM event') == [(0,)]


# --------------------------------------------------------------------------- #
# The one thing a file says about itself, and it says it through both doors
# --------------------------------------------------------------------------- #

def test_an_uploaded_file_declaring_a_currency_is_taken_at_its_word(tmp_path):
    """#710's round trip, through the new door.

    The export writes ``base_currency`` on every line precisely so a store that
    has never answered the question takes the file's answer — *drop the export,
    and the install is the install it came from*. A door that read the column
    and dropped it would make that true of one entrance and not the other.
    """
    client, opened = build_client_and_store(tmp_path)
    body = (
        "date,event_type,symbol,name,quantity,unit_price,base_currency\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,EUR\n"
    ).encode('utf-8')

    assert _upload(client, body).status_code == 201

    assert opened.setting('base_currency') == 'EUR'


def test_a_currency_this_install_can_no_longer_take_is_refused_whole(tmp_path):
    """The dial's own mutability rule, not a second one invented at the door.

    Free while the ledger is empty, fixed from the first recorded event: adopting
    here would re-read every stored amount in another unit, which is the
    unrecoverable act ADR-0002 names. So the file is refused, and its rows with
    it — the refusal is about the file, and the file is one thing.
    """
    client, opened = build_client_and_store(tmp_path)
    _upload(client, (
        "date,event_type,symbol,name,quantity,unit_price,base_currency\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,EUR\n"
    ).encode('utf-8'))

    response = _upload(client, (
        "date,event_type,symbol,name,quantity,unit_price,base_currency\n"
        "2024-02-01,BUY,MSFT,Microsoft,5,380.00,USD\n"
    ).encode('utf-8'), filename="second.csv")

    assert response.status_code == 422
    assert opened.setting('base_currency') == 'EUR'
    assert [row[2] for row in _events(opened)] == ["AAPL"]


def test_a_security_named_once_in_a_file_is_named_on_every_row_of_it(tmp_path):
    """``create`` called N times would find the name; the batch must too.

    ``entries._settled`` reads the name off the ledger when a row leaves it
    blank — an attribute of the *security*, not of each of its events
    (ADR-0020). The batch prefetches that index for the scan it saves, and the
    index has to move as the file is walked or the tenth row of a file would be
    named differently from the first.
    """
    client, opened = build_client_and_store(tmp_path)
    body = (
        "date,event_type,symbol,name,quantity,unit_price\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00\n"
        "2024-02-15,BUY,AAPL,,5,160.00\n"
    ).encode('utf-8')

    _upload(client, body)

    assert opened.query('SELECT name FROM event ORDER BY id') == [
        ("Apple Inc",), ("Apple Inc",)]


def test_a_body_that_declares_no_length_is_still_bounded(tmp_path):
    """The bound that stops bytes already in flight, and it is werkzeug's.

    ``oversize`` reads a *declaration*, which a chunked upload does not make;
    without ``MAX_CONTENT_LENGTH`` the whole body is spooled to disk before
    anything here can refuse it.
    """
    client = build_client(tmp_path)

    assert client.application.config['MAX_CONTENT_LENGTH'] == uploads.MAX_BODY_BYTES
    assert uploads.MAX_BODY_BYTES > uploads.MAX_UPLOAD_BYTES


def test_a_file_of_exactly_the_bound_is_not_refused_by_its_envelope(tmp_path):
    """The two numbers measure two things, and only one of them is the file.

    A ``multipart/form-data`` body is the file plus a boundary, a part header
    and the filename, so an envelope compared to the file's **own** bound
    refuses a legal file while saying *a file may carry at most 8 MiB* about one
    that carries exactly 8 MiB.

    What is asserted is that the file **reaches the parser**: the body below is
    the bound to the byte and is refused for its header, which is a sentence
    about its content and therefore proof that neither size check spoke.
    """
    client, opened = build_client_and_store(tmp_path)
    body = b"nope\n" + b"x" * (uploads.MAX_UPLOAD_BYTES - len(b"nope\n"))

    response = _upload(client, body)

    assert len(body) == uploads.MAX_UPLOAD_BYTES
    assert response.status_code == 422
    assert 'event_type' in response.get_json()['detail']
    assert opened.query('SELECT count(*) FROM event') == [(0,)]
