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

import pytest

import accounts as accounts_module
import ledger
import main
import settings_registry
import store as store_module
from events import export as events_export
from events.loader import BASE_CURRENCY_COLUMN, EventLoader, EventLoaderError

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
    """A real install: a drop folder, a store, and one publication.

    The gesture a user makes, in the order they make it — files first, then the
    app opens the store and imports them. ``currency`` writes the dial the way
    ``PUT /api/settings`` would, before any import, so a test can set up an
    install that has already answered the question.
    """
    root.mkdir(parents=True, exist_ok=True)
    drop = root / 'events'
    drop.mkdir(exist_ok=True)
    for name, text in files.items():
        (drop / name).write_text(text, encoding='utf-8')

    opened = store_module.open_store(root / 'store.duckdb')
    if currency is not None:
        opened.execute(
            'INSERT INTO setting (key, value) VALUES (?, ?) '
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            ['base_currency', currency])
    manager = main.ConfigurationManager(config_dir=str(root), opened_store=opened)
    manager.reload()
    return manager, opened


def export_of(opened):
    """The two files an install exports, exactly as the routes render them."""
    return (
        events_export.render_events(ledger.read_events(opened),
                                    opened.setting('base_currency')),
        events_export.render_accounts(events_export.declared_accounts(
            accounts_module.read_accounts(opened),
            store_module.DEFAULT_ACCOUNT_ROW)),
    )


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
    events_csv, _ = export_of(opened)
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
    events_csv, _ = export_of(opened)
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
    events_csv, _ = export_of(opened)
    opened.close()

    assert {row[BASE_CURRENCY_COLUMN] for row in rows_of(events_csv)} == {''}


def test_an_absent_value_is_an_empty_cell_never_the_word_none(tmp_path):
    """``None`` is what a CSV writes as nothing, and reads back as nothing."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    events_csv, _ = export_of(opened)
    opened.close()

    assert 'None' not in events_csv
    deposit = next(row for row in rows_of(events_csv)
                   if row['event_type'] == 'DEPOSIT')
    assert deposit['symbol'] == '' and deposit['quantity'] == ''


def test_the_accounts_export_leaves_an_untouched_default_out(tmp_path):
    """A row every install owns is not a declaration.

    Exporting it would make *"I declared nothing"* into a file that declares
    something — and re-importing that file would give the seeded row a
    ``source_id``, making the one account every install has read-only and
    forgettable.
    """
    single = _LEDGER.replace(',pea,', ',default,').replace(',cto,', ',default,')
    _, opened = install(tmp_path / 'a', {'2024.csv': single})
    _, accounts_csv = export_of(opened)
    opened.close()

    assert rows_of(accounts_csv) == []


def test_the_accounts_export_carries_what_was_declared(tmp_path):
    """And the declared ones do come out, with their type and their label."""
    _, opened = install(tmp_path / 'a', {'2024.csv': _LEDGER,
                                         'accounts.csv': _ACCOUNTS})
    _, accounts_csv = export_of(opened)
    opened.close()

    assert rows_of(accounts_csv) == [
        {'id': 'cto', 'type': 'CTO', 'label': 'Compte-titres'},
        {'id': 'pea', 'type': 'PEA', 'label': 'PEA Boursorama'},
    ]


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
    events_csv, accounts_csv = export_of(source)
    before = figures(source)
    source.close()

    _, restored = install(tmp_path / 'restored', {
        'suivi-bourse-events.csv': events_csv,
        'suivi-bourse-accounts.csv': accounts_csv,
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
    events_csv, accounts_csv = export_of(source)
    source.close()

    _, restored = install(tmp_path / 'restored', {
        'suivi-bourse-events.csv': events_csv,
        'suivi-bourse-accounts.csv': accounts_csv,
    })
    again, _ = export_of(restored)
    restored.close()

    assert again == events_csv


# --------------------------------------------------------------------- #
# The declaration on the way back in
# --------------------------------------------------------------------- #

def test_a_declared_currency_is_taken_by_a_store_that_has_none(tmp_path):
    """The app *reads* a declaration rather than *asserting* one (ADR-0021).

    Which is what distinguishes it from the "your v4 amounts are in your
    reporting currency" advisory, and what makes the headless round trip work
    without a single ``curl``.
    """
    _, source = install(tmp_path / 'source',
                        {'2024.csv': _LEDGER, 'accounts.csv': _ACCOUNTS},
                        currency='USD')
    events_csv, accounts_csv = export_of(source)
    source.close()

    _, restored = install(tmp_path / 'restored', {
        'suivi-bourse-events.csv': events_csv,
        'suivi-bourse-accounts.csv': accounts_csv,
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

    with pytest.raises(settings_registry.InvalidSetting) as raised:
        ledger.import_file(opened, disagreeing)

    assert raised.value.key == 'base_currency'
    assert opened.setting('base_currency') == 'EUR'
    assert opened.query(
        "SELECT count(*) FROM import_source WHERE filename = 'later.csv'"
    )[0][0] == 0
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
    ledger.import_file(opened, landing)

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
        ledger.import_file(opened, path)

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

    metrics = main.SuiviBourseMetrics(manager)
    metrics.apply_dials(settings_registry.defaults())
    assert metrics.base_currency is None

    (root / 'events' / 'restore.csv').write_text(
        _DECLARING_HEADER +
        "2024-11-02,BUY,default,AI.PA,Air Liquide,1,170.00,,,,CHF\n",
        encoding='utf-8')
    metrics.ingest()

    assert metrics.base_currency == 'CHF'
    opened.close()
