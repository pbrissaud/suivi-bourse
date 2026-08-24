"""The ledger in the store, and the one door a file has (#697, #811, ADR-0032).

The seam is the one #695's Testing Decisions name: a **real** DuckDB store in
``tmp_path``. Nothing here asserts that a method was called; every assertion is
a ``SELECT`` against the store or a payload off the API.

**The folder half of this file is gone with the folder** (#816). What it covered
was never the folder: it was the loader, the validator and the aggregator — the
header that decides the genre, the file refused whole, the events sorted by date
whatever their order — and those behaviours survive the mount and are asserted
below on ``POST /api/events/import``. What did *not* survive is everything the
mount was the reason for: the source row, the fingerprint, the re-drop that
replaced, and the revocation. There is one population of rows now, and the
gestures that reach a row of it are :mod:`test_entries`' subject.

What is left above the route's own section is what reads the ledger and what
fingerprints it — the two things every page and every job go through.
"""
import io
from dataclasses import replace
from datetime import date

import openpyxl
import pytest

import entries
import ledger
import uploads
from events import EventLoader
from events.schemas import DEFAULT_ACCOUNT, EventType
from test_web_api import ACCOUNTS_FILE, build_client, build_client_and_store
from web import problem


ONE_BUY = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
)


def _write(store, path, body):
    """One file into the store, by the road ``POST /api/events/import`` takes."""
    path.write_text(body, encoding="utf-8")
    return entries.create_many(store, EventLoader(str(path)).load())


def _events(store):
    """Every event row, as ``(date, type, symbol, quantity)`` tuples."""
    return store.query(
        'SELECT date, event_type, symbol, quantity FROM event ORDER BY id')


def test_an_event_cannot_name_a_symbol_that_has_no_row(store):
    """The foreign key is why the ordering inside an import is load-bearing.

    The criterion says ``symbol`` is written *at ingestion, before any yfinance
    call*. What makes that a rule rather than a habit is this refusal: an event
    naming ``AAPL`` before ``AAPL`` exists is rejected by the store itself. The
    scrape therefore cannot be the writer of that row — it runs long after the
    event needed it — which is the schema's generating rule (one writer per row)
    showing up as a constraint.
    """
    with pytest.raises(Exception, match="(?i)constraint|foreign key"):
        store.execute(
            'INSERT INTO event (id, date, event_type, account, symbol) '
            "VALUES (1, DATE '2024-01-15', 'BUY', 'default', 'AAPL')")


def test_read_events_returns_sorted_typed_events(store, tmp_path):
    """Events come back as ``events.schemas.Event``, date-sorted across files."""
    _write(store, tmp_path / "b-2024.csv",
           "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
           "2024-06-01,BUY,MSFT,Microsoft,5,380.00,2.50,,Later\n")
    _write(store, tmp_path / "a-2023.csv",
           "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
           "2023-01-05,BUY,AAPL,Apple Inc,1,100.00,,,Earlier\n")

    events = ledger.read_events(store)

    assert [e.date for e in events] == [date(2023, 1, 5), date(2024, 6, 1)]
    assert [e.event_type for e in events] == [EventType.BUY, EventType.BUY]
    assert [e.account for e in events] == [DEFAULT_ACCOUNT, DEFAULT_ACCOUNT]
    assert events[0].name == "Apple Inc"
    assert events[0].unit_price == 100.00


def test_cash_events_land_with_no_symbol(store, tmp_path):
    """``DEPOSIT``/``WITHDRAWAL`` carry no share, so ``event.symbol`` is NULL."""
    _write(store, tmp_path / "cash.csv",
           "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes,"
           "account\n"
           "2024-01-01,DEPOSIT,,,,,1.50,1000,Opening,default\n")

    assert store.query('SELECT symbol, amount, fee FROM event') == [(None, 1000.0, 1.5)]
    assert store.query('SELECT count(*) FROM symbol') == [(0,)]


def test_the_ledger_stamp_changes_only_when_the_ledger_does(store, tmp_path):
    """The replay's cache key: it follows writes, and nothing else.

    Since #816 it fingerprints the **rows**, which is the only thing that still
    moves: a correction in place changes no count and there is no source left to
    hash. The second half below is exactly the case a count would miss.
    """
    _write(store, tmp_path / "2024.csv", ONE_BUY)
    first = ledger.stamp(store)

    assert ledger.stamp(store) == first

    ((key,),) = store.query('SELECT id FROM event')
    (row,) = ledger.read_events(store)
    entries.update(store, key, replace(row, quantity=12.0))

    assert ledger.stamp(store) != first
    assert store.query('SELECT count(*) FROM event') == [(1,)]


def test_the_stamp_is_none_on_a_store_nothing_has_touched(store):
    """A fresh install has nothing to fingerprint, which is a state not a hole."""
    assert ledger.stamp(store) is None


def test_the_last_write_is_recorded_by_the_writer(store, tmp_path):
    """*Nothing has entered your ledger since…* — and a correction counts (#816).

    ``import_source.imported_at`` answered this while a file was a row; the
    writer stamps the instant now, so a deletion and a rewrite in place move it
    where a count of imports never did.
    """
    assert ledger.last_write(store) is None

    _write(store, tmp_path / "2024.csv", ONE_BUY)
    after_import = ledger.last_write(store)
    assert after_import is not None
    assert after_import.tzinfo is not None

    ((key,),) = store.query('SELECT id FROM event')
    entries.remove(store, key)
    assert ledger.last_write(store) >= after_import


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

    with pytest.raises(ImportError):
        import cerberus  # noqa: F401


# --------------------------------------------------------------------------- #
# The one door a file has: POST /api/events/import (issue #811, ADR-0032)
#
# What used to sit above this line was the **drop folder**, and it left with the
# mount (#815, #816). What survived the move is here: the header decides the
# genre, a file is refused whole, the events are sorted by date whatever the file
# says. #803's trap is that this file reads as a test of the folder and is not
# one — it is a test of the loader, the validator and the aggregator, which
# changed door and not meaning.
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
    """*Indistinguishable from a typed one* is a schema, not a sentiment (#816).

    There is no column that could tell the two apart and no table naming a file:
    a second population would need one, and would show up right here.
    """
    client, opened = build_client_and_store(tmp_path)

    _upload(client, ONE_BUY.encode('utf-8'))

    tables = {row[0] for row in opened.query(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'main'")}
    assert 'import_source' not in tables
    columns = {row[0] for row in opened.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'event'")}
    assert columns.isdisjoint({'source_id', 'source_sheet', 'source_row'})


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
    # Nothing on the wire says where the row came from, because nothing in the
    # store does (ADR-0032).
    assert set(event).isdisjoint(
        {'source_id', 'source_sheet', 'source_row', 'source_filename',
         'provenance'})


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


def test_an_oversold_file_is_refused_in_its_own_words(tmp_path):
    """The case #811 made ordinary, and the sentence it used to get (#824).

    The owner exports 2024 at their broker and hands it over; every ``SELL`` of
    a position opened in 2023 oversells, and the whole file is refused — which
    is right. What was wrong is what they were told: ``/problems/conflict``'s
    one sentence says *what this names is already there, or something still
    rests on it*, and nothing here exists already and nothing rests on anything.

    So the refusal carries its own type and the three facts the true sentence
    needs, as data. ``gesture`` reads ``write``: a file that oversells is not
    the news a withdrawal breaking a later sale is.
    """
    client, opened = build_client_and_store(tmp_path)
    _upload(client, ONE_BUY.encode('utf-8'))
    body = (
        "date,event_type,symbol,name,quantity,unit_price\n"
        "2024-02-01,SELL,AAPL,Apple Inc,25,190.00\n"
    ).encode('utf-8')

    response = _upload(client, body, filename="broker-2024.csv")

    assert response.status_code == 409
    assert response.mimetype == 'application/problem+json'
    refusal = response.get_json()
    assert refusal['type'] == problem.TYPE_UNREPLAYABLE
    assert refusal['gesture'] == 'write'
    assert (refusal['symbol'], refusal['wanted'], refusal['owned']) == (
        'AAPL', 25.0, 10.0)
    assert refusal['day'] == '2024-02-01'
    # The server's own English, word for word — the ``detail`` a log and a
    # ``curl`` read, and the one string ADR-0024 keeps off a page.
    assert refusal['detail'] == (
        'Cannot sell 25.0 shares of AAPL (only 10.0 owned) on 2024-02-01')
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
