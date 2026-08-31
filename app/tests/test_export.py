"""The export, and the round trip it exists to make round (issue #710).

The store is the truth of the ledger since #697, which closes a door: a
portfolio that used to be a folder anybody could copy is a binary DuckDB file.
The export re-opens it, and the claim it makes is strong enough to be asserted
rather than described — **the format of the export is the format of the
import**, so re-dropping an exported file into a *fresh* install rebuilds the
same ledger.

That is what the round-trip test below does, and through the real path on both
ends: a real store, a real drop folder,
:meth:`main.ConfigurationManager.reload` doing the import and the replay. The
comparison is on ``position`` and ``account_state`` — the two tables the replay
owns — because two ledgers that replay to the same positions and the same cash
are the same ledger.
"""
import csv
import io
from datetime import date

import pytest

import accounts as accounts_module
import entries
import ledger
import main
import positions as positions_module
import settings_registry
import workloads
import store as store_module
from events import export as events_export
from events.loader import BASE_CURRENCY_COLUMN, EventLoader, EventLoaderError
from events.schemas import Event, EventType
from store_reads import PortfolioReader

#: A ledger with something of every shape in it: two accounts, a valued grant
#: and a dilution, a partial sale, cash events, a fee, a note carrying a comma,
#: and a fractional quantity that only survives a round trip if the export
#: renders a double the short way.
_LEDGER = (
    "date,event_type,account,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-02,DEPOSIT,pea,,,,,1.50,2000.00,January transfer\n"
    "2024-01-15,BUY,pea,AI.PA,Air Liquide,10,168.40,2.50,,\n"
    "2024-02-01,BUY,cto,MC.PA,LVMH,0.34898399999999996,720.00,1.00,,Fractional\n"
    "2024-03-01,DIVIDEND,pea,AI.PA,Air Liquide,,,,32.00,\"2023 dividend, net\"\n"
    "2024-05-20,GRANT,pea,AI.PA,Air Liquide,1,,,,Dilution\n"
    "2024-06-10,GRANT,cto,MC.PA,LVMH,2,700.00,,,Valued award\n"
    "2024-09-15,SELL,pea,AI.PA,Air Liquide,4,181.20,2.50,,\n"
    "2024-10-01,WITHDRAWAL,cto,,,,,0.50,100.00,\n"
)

_ACCOUNTS = (
    "id,type,label\n"
    "pea,PEA,PEA Boursorama\n"
    "cto,CTO,Compte-titres\n"
)

#: The columns of a file that declares a currency, for the tests that write one
#: by hand rather than exporting it.
_DECLARING_HEADER = (
    "date,event_type,account,symbol,name,quantity,unit_price,fee,amount,"
    f"notes,{BASE_CURRENCY_COLUMN}\n"
)


def install(root, files, currency=None):
    """A real install: a store with those files' rows in it, and one publication.

    ``currency`` writes the dial the way ``PUT /api/settings`` would, before the
    rows land, so a test can set up an install that has already answered the
    question. The files are read into the store here rather than by the manager,
    which scans no directory since ADR-0032 — what is asserted downstream is the
    ledger, and the ledger is in the store either way.
    """
    root.mkdir(parents=True, exist_ok=True)
    drop = root / 'events'
    drop.mkdir(exist_ok=True)
    written = {}
    for name, text in files.items():
        path = drop / name
        path.write_text(text, encoding='utf-8')
        written[name] = path

    opened = store_module.open_store(root / 'store.duckdb')
    if currency is not None:
        opened.execute(
            'INSERT INTO setting (key, value) VALUES (?, ?) '
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            ['base_currency', currency])
    # **The header decides which road a file takes**, exactly as the product
    # decides it (ADR-0032): a declaration is written by the accounts gestures,
    # a ledger by :func:`entries.create_many` — which is what the upload route
    # calls. The folder is a fixture's shape and nothing reads it on its own.
    for path in written.values():
        if accounts_module.is_accounts_file(path):
            _declare_from(opened, path)
    for path in written.values():
        if not accounts_module.is_accounts_file(path):
            _write_events(opened, path)
    manager = main.ConfigurationManager(config_dir=str(root), opened_store=opened)
    manager.reload()
    return manager, opened


def _declared_rows(path):
    """The fixture file's ``id,type,label`` rows, read here and nowhere else.

    Reading it is the fixture's own business since ADR-0034: no accounts file
    enters the app any more, so the parser that used to live in :mod:`accounts`
    is gone and what a test writes for its own convenience it also reads.
    """
    with open(path, newline='', encoding='utf-8') as handle:
        return [
            (row['id'].strip(), row['type'].strip(),
             (row.get('label') or '').strip() or row['id'].strip())
            for row in csv.DictReader(handle)
            if (row.get('id') or '').strip()
        ]


def _declare_from(opened, path):
    """The file's accounts, declared the way the app declares them (ADR-0034)."""
    for account_id, account_type, label in _declared_rows(path):
        if account_id in accounts_module.account_ids(opened):
            opened.execute(
                'UPDATE account SET type = ?, label = ? WHERE id = ?',
                [account_type, label, account_id])
            continue
        accounts_module.create_account(opened, account_id, account_type, label)


def _write_events(opened, path):
    """One event file into the store, by the road the upload takes."""
    loader = EventLoader(str(path))
    rows = loader.load()
    entries.create_many(
        opened, rows,
        base_currency=ledger.currency_to_adopt(opened, loader.declared_currency))


def export_of(opened):
    """The **one** file an install exports, exactly as the route renders it.

    One and not two since ADR-0034: there is no accounts file to read back, so
    an ``accounts.csv`` beside the events would be a backup nothing restores.
    The accounts are redeclared by hand, which is what the restores below do.
    """
    return events_export.render_events(ledger.read_events(opened),
                                       opened.setting('base_currency'))


def portfolio_of(opened):
    """The accounts-and-positions file, by the route's own three reads (#836).

    All three are queries on the open store and none of them is the published
    snapshot, which is the criterion — a backup, and a report beside it, are of
    what is *stored*.
    """
    return events_export.render_portfolio(
        accounts_module.read_accounts(opened),
        positions_module.read_account_states(opened),
        PortfolioReader(opened).positions(),
        opened.setting('base_currency'))


def quote(opened, symbol, price, currency='EUR'):
    """One observed quote, laid down the way the scrape lays it down.

    The ``symbol`` row is what the foreign key asks for and it belongs to the
    configuration path, so it is inserted here rather than reached for through
    the market writer — the same shape :func:`conftest.declare_positions` uses.
    """
    opened.execute('INSERT INTO symbol (symbol) VALUES (?) '
                   'ON CONFLICT (symbol) DO NOTHING', [symbol])
    opened.execute(
        'INSERT INTO symbol_quote (symbol, currency, last_price_native, '
        '                          last_price_converted) VALUES (?, ?, ?, ?) '
        'ON CONFLICT (symbol) DO UPDATE SET '
        '  currency = excluded.currency, '
        '  last_price_native = excluded.last_price_native, '
        '  last_price_converted = excluded.last_price_converted',
        [symbol, currency, price, price])


def figures(opened):
    """The ledger as figures: the two tables the replay owns."""
    return {
        'positions': opened.query(
            'SELECT account, symbol, name, quantity, cost_basis, realized_gain, '
            '       received_dividend FROM position ORDER BY account, symbol'),
        'cash': opened.query(
            'SELECT account, cash_balance, net_contributed FROM account_state '
            'ORDER BY account'),
    }


def rows_of(text):
    """An exported file back into its cells, without going through the loader."""
    return list(csv.DictReader(io.StringIO(text)))


def empty_store(root):
    """A store with a drop folder beside it and nothing in either."""
    root.mkdir(parents=True, exist_ok=True)
    (root / 'events').mkdir(exist_ok=True)
    return store_module.open_store(root / 'store.duckdb')


# --------------------------------------------------------------------- #
# What the file looks like
# --------------------------------------------------------------------- #

def test_the_export_carries_the_import_format_columns(tmp_path):
    """The header is the import format's, so the file is not a second format."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    events_csv = export_of(opened)
    opened.close()

    header = events_csv.splitlines()[0].split(',')
    assert tuple(header) == events_export.EVENT_COLUMNS
    # Every column the loader knows is in it, or a round trip loses a field.
    assert EventLoader.ALL_COLUMNS <= set(header)


def test_every_row_states_the_reporting_currency(tmp_path):
    """The one precision the format needed: the file carries its own unit."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    events_csv = export_of(opened)
    opened.close()

    rows = rows_of(events_csv)
    assert rows
    assert {row[BASE_CURRENCY_COLUMN] for row in rows} == {'EUR'}


def test_an_unanswered_install_exports_a_blank_currency_column(tmp_path):
    """Blank is the honest answer, and it imports everywhere.

    An install that never answered has interpreted nothing, so its file has
    nothing to state — and a file stating nothing is one no other install will
    refuse.
    """
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    events_csv = export_of(opened)
    opened.close()

    assert {row[BASE_CURRENCY_COLUMN] for row in rows_of(events_csv)} == {''}


def test_an_absent_value_is_an_empty_cell_never_the_word_none(tmp_path):
    """``None`` is what a CSV writes as nothing, and reads back as nothing."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    events_csv = export_of(opened)
    opened.close()

    assert 'None' not in events_csv
    deposit = next(row for row in rows_of(events_csv)
                   if row['event_type'] == 'DEPOSIT')
    assert deposit['symbol'] == '' and deposit['quantity'] == ''


# --------------------------------------------------------------------- #
# The round trip — the criterion the whole ticket rests on
# --------------------------------------------------------------------- #

def test_reimporting_an_export_rebuilds_the_same_ledger(tmp_path):
    """Export, drop into a fresh install, and the figures coincide.

    Through the ordinary import path on both ends: no special reader, no
    migration, no flag. The comparison is on ``position`` and ``account_state``
    because those are the ledger *as figures*, which is what a user would notice
    differing.
    """
    _, source = install(tmp_path / 'source',
                        {'2024.csv': _LEDGER, 'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    events_csv = export_of(source)
    before = figures(source)
    source.close()

    _, restored = install(tmp_path / 'restored', {
        'suivi-bourse-events.csv': events_csv,
        'accounts.csv': _ACCOUNTS,
    })
    after = figures(restored)
    # The declaration the file carried, taken up by an install that had none —
    # which is what makes this whole test run without a single settings write.
    assert restored.setting('base_currency') == 'EUR'
    restored.close()

    assert after == before


def test_the_round_trip_is_idempotent(tmp_path):
    """Exporting the restored install gives the same bytes back.

    The property that makes a backup a backup: restore, export again, and the
    file has not drifted — no re-rendered float, no re-ordered row.
    """
    _, source = install(tmp_path / 'source',
                        {'2024.csv': _LEDGER, 'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    events_csv = export_of(source)
    source.close()

    _, restored = install(tmp_path / 'restored', {
        'suivi-bourse-events.csv': events_csv,
        'accounts.csv': _ACCOUNTS,
    })
    again = export_of(restored)
    restored.close()

    assert again == events_csv


# --------------------------------------------------------------------- #
# The declaration on the way back in
# --------------------------------------------------------------------- #

def test_a_declared_currency_is_taken_by_a_store_that_has_none(tmp_path):
    """The app *reads* a declaration rather than *asserting* one (ADR-0021).

    Which is what distinguishes it from the "your v4 amounts are in your
    reporting currency" installation fact, and what makes the headless round
    trip work without a single ``curl``.
    """
    _, source = install(tmp_path / 'source',
                        {'2024.csv': _LEDGER, 'accounts.csv': _ACCOUNTS},
                        currency='USD')
    events_csv = export_of(source)
    source.close()

    _, restored = install(tmp_path / 'restored', {
        'suivi-bourse-events.csv': events_csv,
        'accounts.csv': _ACCOUNTS,
    })
    assert restored.setting('base_currency') == 'USD'
    restored.close()


def test_a_declaration_that_disagrees_with_a_recorded_ledger_is_refused(tmp_path):
    """Adopting it would re-read every stored amount in another unit.

    The dial's own rule, not a second one: free while the ledger is empty, fixed
    from the first recorded event. Here events are recorded, so the import is
    refused **whole** — nothing of the file lands, and the dial does not move.
    """
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    disagreeing = tmp_path / 'a' / 'events' / 'later.csv'
    disagreeing.write_text(
        _DECLARING_HEADER +
        "2024-11-02,BUY,pea,AI.PA,Air Liquide,1,170.00,,,,USD\n",
        encoding='utf-8')

    before = opened.query('SELECT count(*) FROM event')[0][0]

    with pytest.raises(settings_registry.InvalidSetting) as raised:
        _write_events(opened, disagreeing)

    assert raised.value.key == 'base_currency'
    assert opened.setting('base_currency') == 'EUR'
    # Refused **whole**: not one row of the file landed.
    assert opened.query('SELECT count(*) FROM event')[0][0] == before
    opened.close()


def test_a_disagreement_is_taken_while_nothing_is_recorded(tmp_path):
    """An empty ledger has interpreted nothing, so nothing can be reinterpreted.

    The same predicate ``settings.save`` applies to the form. Two spellings of
    *"may this install still answer"* would eventually disagree, and the symptom
    would be a portfolio silently changing currency.
    """
    opened = empty_store(tmp_path / 'a')
    opened.execute(
        "INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR')")

    landing = tmp_path / 'a' / 'events' / 'restore.csv'
    landing.write_text(
        _DECLARING_HEADER +
        "2024-11-02,BUY,default,AI.PA,Air Liquide,1,170.00,,,,USD\n",
        encoding='utf-8')
    _write_events(opened, landing)

    assert opened.setting('base_currency') == 'USD'
    opened.close()


def test_a_file_declaring_two_currencies_is_refused(tmp_path):
    """One file, one reporting currency — it is a fact about the whole file."""
    path = tmp_path / 'two.csv'
    path.write_text(
        f"date,event_type,symbol,name,quantity,unit_price,{BASE_CURRENCY_COLUMN}\n"
        "2024-01-15,BUY,AI.PA,Air Liquide,1,168.40,EUR\n"
        "2024-01-16,BUY,AI.PA,Air Liquide,1,168.40,USD\n",
        encoding='utf-8')

    with pytest.raises(EventLoaderError, match='two reporting currencies'):
        EventLoader(str(path)).load()


def test_a_declaration_that_is_not_a_currency_is_refused(tmp_path):
    """``EURO`` is the mistake that actually happens, and the registry owns it."""
    opened = empty_store(tmp_path / 'a')
    path = tmp_path / 'a' / 'events' / 'bad.csv'
    path.write_text(
        f"date,event_type,symbol,name,quantity,unit_price,{BASE_CURRENCY_COLUMN}\n"
        "2024-01-15,BUY,AI.PA,Air Liquide,1,168.40,EURO\n",
        encoding='utf-8')

    with pytest.raises(settings_registry.InvalidSetting):
        _write_events(opened, path)

    assert opened.setting('base_currency') is None
    opened.close()


def test_a_file_without_the_column_declares_nothing(tmp_path):
    """A hand-written file leaves the column out, and nothing is assumed."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    assert opened.setting('base_currency') is None
    opened.close()


def test_the_running_process_takes_up_a_currency_an_import_declared(tmp_path):
    """The dial reaches the scrape path, not only the table (issue #710).

    A dial is read once at boot into the attributes every cycle re-reads, and
    the API's write path assigns them again. An import is the third writer of
    one of them, and without this the row would be in the store while the
    process went on converting nothing until the next restart — invisibly, since
    a missing currency writes ``NULL`` conversions rather than failing anything.
    """
    root = tmp_path / 'a'
    opened = empty_store(root)
    manager = main.ConfigurationManager(config_dir=str(root), opened_store=opened)
    manager.reload()

    metrics = workloads.Workloads(manager)
    metrics.apply_dials(settings_registry.defaults())
    assert metrics.base_currency is None

    landing = root / 'events' / 'restore.csv'
    landing.write_text(
        _DECLARING_HEADER +
        "2024-11-02,BUY,default,AI.PA,Air Liquide,1,170.00,,,,CHF\n",
        encoding='utf-8')
    # The shape of a write through the API since ADR-0032: the rows land in the
    # store, and the replay that follows carries the dial into the process.
    _write_events(opened, landing)
    metrics.ingest(force=True)

    assert metrics.base_currency == 'CHF'
    opened.close()


# --------------------------------------------------------------------- #
# The workbook — one sheet per year (issue #796)
# --------------------------------------------------------------------- #

def workbook_rows(payload):
    """An exported workbook back into ``{sheet: [row, ...]}``, cells and all."""
    import openpyxl
    book = openpyxl.load_workbook(io.BytesIO(payload), data_only=True)
    sheets = {}
    for sheet in book.worksheets:
        rows = list(sheet.iter_rows(values_only=True))
        header = [str(cell) for cell in rows[0]]
        sheets[sheet.title] = [dict(zip(header, row)) for row in rows[1:]]
    book.close()
    return sheets


def test_the_workbook_has_one_sheet_per_year_of_the_exported_events(tmp_path):
    """The years are the ledger's own, and no other tab exists.

    A workbook with a tab per year is what a person opens a spreadsheet for —
    and the tabs are **read** off the events rather than laid out from a range,
    so a ledger that skips a year skips a tab.
    """
    _, opened = install(tmp_path / 'a', {
        '2024.csv': _LEDGER,
        '2026.csv': ("date,event_type,account,symbol,name,quantity,unit_price,"
                     "fee,amount,notes\n"
                     "2026-02-02,DEPOSIT,pea,,,,,,500.00,Later\n"),
        'accounts.csv': _ACCOUNTS})
    sheets = workbook_rows(events_export.render_events_workbook(
        ledger.read_events(opened), opened.setting('base_currency')))
    opened.close()

    assert list(sheets) == ['2024', '2026']
    assert len(sheets['2024']) == 8
    assert len(sheets['2026']) == 1


def test_every_sheet_of_the_workbook_carries_the_import_header(tmp_path):
    """Each tab is a file the loader reads, which is what makes it importable."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    payload = events_export.render_events_workbook(
        ledger.read_events(opened), opened.setting('base_currency'))
    opened.close()

    sheets = workbook_rows(payload)
    for rows in sheets.values():
        assert rows
        for row in rows:
            assert set(row) == set(events_export.EVENT_COLUMNS)
            assert row[BASE_CURRENCY_COLUMN] == 'EUR'


def test_an_empty_ledger_still_makes_a_workbook(tmp_path):
    """Emptiness is a state: a workbook with no sheet at all is not a file."""
    opened = empty_store(tmp_path / 'a')
    sheets = workbook_rows(events_export.render_events_workbook([], None))
    opened.close()

    assert list(sheets) == [events_export.UNDATED_SHEET]
    assert sheets[events_export.UNDATED_SHEET] == []


def test_a_note_that_begins_with_an_equals_sign_stays_a_note(tmp_path):
    """A spreadsheet reads ``=`` as a formula, and a ledger's note is text.

    Left to the default binding the cell would come back as a formula string
    the loader stores verbatim on the way in — and Excel would evaluate it.
    """
    payload = events_export.render_events_workbook([
        Event(date=date(2024, 1, 2), event_type=EventType.DEPOSIT,
              account='pea', amount=10.0, notes='=SUM(A1:A2)'),
    ])

    assert workbook_rows(payload)['2024'][0]['notes'] == '=SUM(A1:A2)'


def rounded(measured):
    """The figures, at the precision a **workbook** carries.

    ``openpyxl`` writes a double as ``%.16g``, which is one significant digit
    short of the shortest string that reads back as the same double — so a
    broker's ``0.34898399999999996`` comes back as ``0.348984`` from a workbook
    where it survives a CSV bit for bit. That is the whole reason the *CSV*
    keeps the backup's name: this file is the reading copy, and the difference
    is named here rather than left for somebody to find in a diff.
    """
    return {name: [tuple(round(cell, 9) if isinstance(cell, float) else cell
                         for cell in row)
                   for row in rows]
            for name, rows in measured.items()}


def test_a_control_character_costs_a_cell_and_never_the_workbook(tmp_path):
    """A note pasted out of a PDF must not take the whole file down.

    OOXML cannot hold ``\x00``–``\x1f`` and ``openpyxl`` refuses the cell, so
    with nothing done one vertical tab in one note would make
    ``GET /api/export/events.xlsx`` a ``500`` **for the entire ledger** — and
    invisibly, the CSV going on working, until the reader picks the other entry.
    The character leaves; the row, the file and the other 284 rows stay.
    """
    events = [Event(date=date(2024, 1, 2), event_type=EventType.DEPOSIT,
                    account='pea', amount=10.0, notes='bad\x01char')]

    assert workbook_rows(
        events_export.render_events_workbook(events))['2024'][0]['notes'] == \
        'badchar'
    # The CSV is the backup and keeps the byte: text is what text is, and
    # nothing in that format refuses it.
    assert 'bad\x01char' in events_export.render_events(events)


def test_reimporting_the_workbook_rebuilds_the_same_ledger(tmp_path):
    """The tabs are a shape, never a second format: the file re-enters whole."""
    _, source = install(tmp_path / 'source',
                        {'2024.csv': _LEDGER, 'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    payload = events_export.render_events_workbook(
        ledger.read_events(source), source.setting('base_currency'))
    before = figures(source)
    source.close()

    restored_root = tmp_path / 'restored'
    manager, restored = install(restored_root,
                                {'accounts.csv': _ACCOUNTS})
    workbook = restored_root / 'events' / 'suivi-bourse-events.xlsx'
    workbook.write_bytes(payload)
    # The workbook goes in the way a workbook goes in: through the road the
    # upload takes, which is where the loader reads every worksheet of it —
    # then the replay that follows every write, which is what fills the two
    # tables ``figures`` reads.
    _write_events(restored, workbook)
    manager.replay()
    after = figures(restored)
    assert restored.setting('base_currency') == 'EUR'
    restored.close()

    assert rounded(after) == rounded(before)


# --------------------------------------------------------------------- #
# The selection — the chips, server-side (issue #796)
# --------------------------------------------------------------------- #

def test_a_selection_that_reduces_nothing_is_the_whole_ledger(tmp_path):
    """No parameter is *no reduction*, never *no match*."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    events = ledger.read_events(opened)
    opened.close()

    assert events_export.select(events, events_export.NO_SELECTION) == events
    assert not events_export.NO_SELECTION.reduces


def test_a_selection_keeps_what_the_chips_retain(tmp_path):
    """The four parameters are the table's four, and they compose."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    events = ledger.read_events(opened)
    opened.close()

    def kept(**parameters):
        selection = events_export.Selection(**parameters)
        assert selection.reduces
        return events_export.select(events, selection)

    assert {event.event_type for event in kept(event_type='BUY')} == \
        {EventType.BUY}
    assert {event.account for event in kept(account='cto')} == {'cto'}
    assert {event.symbol for event in kept(symbols=('AI.PA',))} == {'AI.PA'}
    # Composed, and the two reductions are an intersection.
    assert len(kept(event_type='BUY', account='pea')) == 1


def test_the_search_reads_what_the_table_shows_accents_folded(tmp_path):
    """The ticker, the label and the account — folded, as a French ear hears."""
    _, opened = install(tmp_path / 'a', {
        '2024.csv': ("date,event_type,account,symbol,name,quantity,unit_price,"
                     "fee,amount,notes\n"
                     "2024-01-02,DEPOSIT,pea,,,,,,2000.00,Versement de février\n"
                     "2024-01-15,BUY,pea,AI.PA,Air Liquide,10,168.40,,,\n"),
        'accounts.csv': _ACCOUNTS})
    events = ledger.read_events(opened)
    opened.close()

    def found(query):
        return [event.event_type.value for event
                in events_export.select(events,
                                        events_export.Selection(query=query))]

    assert found('FEVRIER') == ['DEPOSIT']
    assert found('février') == ['DEPOSIT']
    assert found('ai.pa') == ['BUY']
    # The account column is searched too: it is one of the three the table shows.
    assert len(found('pea')) == 2
    assert found('nothing here') == []


def test_a_selection_of_no_row_is_a_file_with_no_row(tmp_path):
    """A reduction that retains nothing is a header, never an error."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    events = ledger.read_events(opened)
    opened.close()

    rendered = events_export.render_events(
        events_export.select(events, events_export.Selection(account='zzz')))

    assert rendered == ','.join(events_export.EVENT_COLUMNS) + '\n'


def test_a_selected_export_is_importable_like_any_other(tmp_path):
    """A reduction is not a backup, and it is still a file this app reads.

    Which is the whole reason the reduction is taken **here** rather than
    regenerated in the front: the rows leave through the one renderer that owns
    the importable form.
    """
    _, source = install(tmp_path / 'source',
                        {'2024.csv': _LEDGER, 'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    selected = events_export.render_events(
        events_export.select(ledger.read_events(source),
                             events_export.Selection(account='cto')),
        source.setting('base_currency'))
    source.close()

    _, restored = install(tmp_path / 'restored', {
        'accounts.csv': _ACCOUNTS,
        'suivi-bourse-selection.csv': selected,
    })
    accounts_held = {row[0] for row in restored.query(
        'SELECT DISTINCT account FROM event')}
    restored.close()

    assert accounts_held == {'cto'}


# --------------------------------------------------------------------- #
# The period — the fifth member of the reduction (issue #810)
# --------------------------------------------------------------------- #

def test_the_period_retains_the_two_days_it_names(tmp_path):
    """Both bounds are **inclusive**, which is what the chip states.

    A ledger dated to the day (ADR-0008) has no instant to be before or after,
    so a half-open interval would drop the last day of every year a reader asks
    for — silently, in a file that looks complete.
    """
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    events = ledger.read_events(opened)
    opened.close()

    kept = events_export.select(events, events_export.Selection(
        since=date(2024, 3, 1), until=date(2024, 9, 15)))

    assert [event.date for event in kept] == [
        date(2024, 3, 1), date(2024, 5, 20), date(2024, 6, 10),
        date(2024, 9, 15),
    ]


def test_one_bound_opens_the_interval_on_the_other_side(tmp_path):
    """*Everything since 2024-06-10* is a reduction, and a legitimate one."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    events = ledger.read_events(opened)
    opened.close()

    since = events_export.select(events, events_export.Selection(
        since=date(2024, 6, 10)))
    until = events_export.select(events, events_export.Selection(
        until=date(2024, 1, 15)))

    assert [event.date for event in since] == [
        date(2024, 6, 10), date(2024, 9, 15), date(2024, 10, 1),
    ]
    assert [event.date for event in until] == [
        date(2024, 1, 2), date(2024, 1, 15),
    ]


def test_the_period_composes_with_the_four_others(tmp_path):
    """The five members are one reduction, and it is an intersection."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    events = ledger.read_events(opened)
    opened.close()

    kept = events_export.select(events, events_export.Selection(
        account='pea', since=date(2024, 2, 1), until=date(2024, 6, 30)))

    assert [(event.account, event.date) for event in kept] == [
        ('pea', date(2024, 3, 1)), ('pea', date(2024, 5, 20)),
    ]


def test_a_reduction_on_the_period_alone_is_still_a_reduction():
    """``reduces`` counts it, which is what names the file a *selection*.

    An export reduced on the dates alone is an extract of one year; under the
    backup's name that partial file would replace the whole one on the reader's
    own disk.
    """
    assert events_export.Selection(since=date(2024, 1, 1)).reduces
    assert events_export.Selection(until=date(2024, 12, 31)).reduces
    assert not events_export.Selection().reduces


# --------------------------------------------------------------------- #
# Accounts and positions — the entry that is a report (issue #836)
# --------------------------------------------------------------------- #

def test_the_report_states_each_account_then_the_positions_under_it(tmp_path):
    """The file's shape: an account, then what is held in it (spec #787).

    The order is the reading order of the menu entry that names it — *comptes
    et positions* — and it is the order that lets a spreadsheet fold on the
    first column with nothing sorted first.
    """
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    rows = rows_of(portfolio_of(opened))
    opened.close()

    assert [(row['account'], row['symbol']) for row in rows] == [
        ('cto', ''), ('cto', 'MC.PA'),
        ('default', ''),
        ('pea', ''), ('pea', 'AI.PA'),
    ]


def test_the_report_carries_the_columns_the_menu_entry_promises(tmp_path):
    """*Soldes, PRU et valorisations* — the three, and the file states them."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    text = portfolio_of(opened)
    opened.close()

    assert text.splitlines()[0].split(',') == \
        list(events_export.PORTFOLIO_COLUMNS)
    for column in ('cash_balance', 'unit_cost', 'market_value'):
        assert column in events_export.PORTFOLIO_COLUMNS


def test_a_figure_appears_once_and_a_name_repeats(tmp_path):
    """The cash is on the account's row alone; the label is on every row.

    It is what makes a money column of this file summable: a balance repeated
    beside each position would be counted once per holding — a figure nobody
    can use and everybody would.
    """
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    rows = {(row['account'], row['symbol']): row
            for row in rows_of(portfolio_of(opened))}
    opened.close()

    account, position = rows[('pea', '')], rows[('pea', 'AI.PA')]
    assert account['cash_balance'] != ''
    assert account['net_contributed'] != ''
    assert position['cash_balance'] == ''
    assert position['net_contributed'] == ''
    # The name is not a figure, so it repeats: a filter on *PEA Boursorama* has
    # to reach the holdings and not the balance line alone.
    assert account['account_label'] == 'PEA Boursorama'
    assert position['account_label'] == 'PEA Boursorama'
    assert position['account_type'] == 'PEA'
    # And nothing of the position is on the account's own row.
    assert account['quantity'] == '' and account['market_value'] == ''


def test_an_account_with_no_cash_ledger_has_empty_cells_never_zeros(tmp_path):
    """``0.00`` and *no cash has ever moved here* are two states (ADR-0006).

    The seeded ``default`` account is the one every install owns and nobody has
    used, so the store holds no ``account_state`` row for it — and the file says
    so with an empty cell rather than with a balance of nothing.
    """
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    rows = {(row['account'], row['symbol']): row
            for row in rows_of(portfolio_of(opened))}
    opened.close()

    assert rows[('default', '')]['cash_balance'] == ''
    assert rows[('default', '')]['net_contributed'] == ''


def test_the_valuation_is_the_quantity_at_the_observed_price(tmp_path):
    """What the holding is worth, and the unit cost it is measured against."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    quote(opened, 'AI.PA', 200.00)
    rows = {(row['account'], row['symbol']): row
            for row in rows_of(portfolio_of(opened))}
    (quantity, cost_basis), = opened.query(
        "SELECT quantity, cost_basis FROM position "
        " WHERE account = 'pea' AND symbol = 'AI.PA'")
    opened.close()

    held = rows[('pea', 'AI.PA')]
    assert float(held['quantity']) == pytest.approx(quantity)
    assert float(held['price']) == pytest.approx(200.00)
    assert float(held['market_value']) == pytest.approx(quantity * 200.00)
    # The PMP, and it is the one division the product makes (ADR-0003).
    assert float(held['unit_cost']) == pytest.approx(cost_basis / quantity)


def test_a_position_nobody_has_priced_has_no_valuation(tmp_path):
    """No quote, no price, no market value — and never a zero (ADR-0004).

    The carrying convention is a *rendering* of the page and stays there: it
    needs the published snapshot's holding windows to know that no price is
    coming, and this file is read from the store alone. So the cell is empty,
    which is what the page draws as an em dash.
    """
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    quote(opened, 'AI.PA', 200.00)
    rows = {(row['account'], row['symbol']): row
            for row in rows_of(portfolio_of(opened))}
    opened.close()

    unpriced = rows[('cto', 'MC.PA')]
    assert unpriced['price'] == ''
    assert unpriced['market_value'] == ''
    # What the position *does* know is stated all the same: a cost is not a
    # price, and it is the figure the reader has left.
    assert float(unpriced['cost_basis']) > 0
    assert float(unpriced['unit_cost']) > 0


def test_every_row_of_the_report_states_the_reporting_currency(tmp_path):
    """One file, one unit — the events export's rule, on the same axis."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    rows = rows_of(portfolio_of(opened))
    opened.close()

    assert {row[BASE_CURRENCY_COLUMN] for row in rows} == {'EUR'}


def test_an_unanswered_install_reports_a_blank_currency_column(tmp_path):
    """Nothing has been interpreted, so the file states nothing."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    rows = rows_of(portfolio_of(opened))
    opened.close()

    assert {row[BASE_CURRENCY_COLUMN] for row in rows} == {''}


def test_the_report_is_refused_by_the_import_rather_than_half_read(tmp_path):
    """It is a **report**, and the import says so in one sentence (ADR-0034).

    This is the property that lets the fourth entry exist at all. ADR-0034
    retired ``accounts.csv`` because a file nothing reads back *looks* like a
    restorable backup; a file the loader turns away by name — for want of
    ``date`` and ``event_type`` — cannot be mistaken for half a restore, and
    nothing about the declaration has moved: an account is still born in the app
    and nowhere else.
    """
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS},
                        currency='EUR')
    text = portfolio_of(opened)
    opened.close()

    back = tmp_path / 'b'
    back.mkdir(parents=True, exist_ok=True)
    path = back / 'suivi-bourse-portfolio.csv'
    path.write_text(text, encoding='utf-8')

    with pytest.raises(EventLoaderError) as refused:
        EventLoader(str(path)).load()
    assert 'date' in str(refused.value) and 'event_type' in str(refused.value)


def test_an_install_with_nothing_in_it_reports_its_one_account(tmp_path):
    """A header and the seeded row: the file exists and says what there is.

    Not an empty file — every install owns the ``default`` account (ADR-0013),
    so a report with no row at all would be one that had failed to look.
    """
    opened = empty_store(tmp_path / 'a')
    rows = rows_of(portfolio_of(opened))
    opened.close()

    assert [(row['account'], row['symbol']) for row in rows] == [
        ('default', ''),
    ]
