"""Accounts are declared by a file, and a bad file does not get in (#698).

The seam is #695's: a **real** DuckDB store in ``tmp_path`` and the real import
running on it. Nothing here asserts that a method was called — the ticket's
rules are rules about *rows*, and about which gestures the store refuses:

1. an accounts file declares accounts, with its ``source_id``, and what came
   from a file is read-only;
2. **all** account sources are imported before **all** event sources;
3. an event file naming an undeclared account is not imported **at all**, and
   the message names the account to declare;
4. a blank ``account`` column means ``default`` until something is declared, and
   is an error afterwards;
5. an account is undeletable while an event names it — and so, in cascade, is
   the import that declared it;
6. the v4 ``settings.yaml`` is named, never read (that half lives in
   ``test_configuration_manager.py``, next to ``config.yaml``'s);
7. the seeded ``default`` row is always there, so nothing branches on *"are
   accounts declared"*.

The first test in the file is the last acceptance criterion — a v4 install's
files importing untouched, and a multi-account file refused whole — and it is
deliberately first: it is the one a user meets.
"""

from datetime import date

import pytest

import accounts as accounts_module
import ledger
from events import EventAggregator, EventLoader, EventValidator, Portfolio, Account
from events.schemas import Event, EventType, ShareState, DEFAULT_ACCOUNT
from main import ConfigurationManager


# A single-account v4's file: no `account` column at all, which is what makes it
# import without a single edit.
V4_SINGLE_ACCOUNT = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-02,DEPOSIT,,,,,,2000.00,January transfer\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
)

# The same portfolio split over two accounts, with nothing declaring them.
TWO_ACCOUNTS_UNDECLARED = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes,account\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,,pea\n"
    "2024-01-16,BUY,AAPL,Apple Inc,5,160.00,1.00,,,cto\n"
)

ACCOUNTS_FILE = (
    "id,type,label\n"
    "pea,PEA,PEA Bourso\n"
    "cto,CTO,CTO Degiro\n"
)


def _drop(tmp_path, **files):
    """Write ``name.csv: text`` pairs into a drop folder and return it."""
    folder = tmp_path / "drop"
    folder.mkdir(exist_ok=True)
    for name, text in files.items():
        (folder / name.replace('_', '.')).write_text(text, encoding="utf-8")
    return folder


def _accounts(store):
    """Every account row, as ``(id, type, label, source_id)`` tuples."""
    return store.query(
        'SELECT id, type, label, source_id FROM account ORDER BY id')


def _event_accounts(store):
    return [row[0] for row in store.query(
        'SELECT account FROM event ORDER BY id')]


def _refusal(outcomes, filename):
    (outcome,) = [o for o in outcomes if o.filename == filename]
    return outcome


# --------------------------------------------------------------------------- #
# The seam: coming from v4, with and without a declaration
# --------------------------------------------------------------------------- #

def test_a_v4_single_account_install_imports_untouched(store, tmp_path):
    """The one continuity that survives between the two versions.

    It survives because *"a blank account column means `default`"* is v4's rule
    **minus its opt-in** — including on the cash events, where v4 demanded an
    account even with none declared.
    """
    drop = _drop(tmp_path, **{'2024_csv': V4_SINGLE_ACCOUNT})

    (outcome,) = ledger.sync_drop_folder(store, drop)

    assert outcome.outcome == ledger.IMPORTED
    assert outcome.rows == 2
    assert _event_accounts(store) == [DEFAULT_ACCOUNT, DEFAULT_ACCOUNT]
    # The seeded row is the whole declaration, and nothing else appeared.
    assert _accounts(store) == [(DEFAULT_ACCOUNT, 'OTHER', 'Default account', None)]
    assert accounts_module.declared_portfolio(store) is None


def test_a_multi_account_file_without_a_declaration_is_refused_whole(store, tmp_path):
    """Not partially — and the message names the account to declare.

    A single value in the column could be folded into ``default`` without
    losing anything; two cannot, and guessing would pile one account's events
    onto another silently. So the refusal is the answer, and it is the whole
    file's: the first row is as absent from the store as the second.
    """
    drop = _drop(tmp_path, **{'2024_csv': TWO_ACCOUNTS_UNDECLARED})

    (outcome,) = ledger.sync_drop_folder(store, drop)

    assert outcome.outcome == ledger.REFUSED
    assert "'pea' is not declared" in outcome.error
    assert "id, type, label" in outcome.error       # how to declare it
    assert store.query('SELECT count(*) FROM event') == [(0,)]
    assert ledger.list_imports(store) == []


def test_declaring_the_accounts_lets_the_same_file_in(store, tmp_path):
    """The gesture the refusal above asks for, and its effect on the ledger."""
    drop = _drop(tmp_path,
                 **{'2024_csv': TWO_ACCOUNTS_UNDECLARED,
                    'accounts_csv': ACCOUNTS_FILE})

    outcomes = ledger.sync_drop_folder(store, drop)

    assert _refusal(outcomes, 'accounts.csv').outcome == ledger.IMPORTED
    assert _refusal(outcomes, '2024.csv').outcome == ledger.IMPORTED
    assert _event_accounts(store) == ['pea', 'cto']


# --------------------------------------------------------------------------- #
# The order, and what a declaration arriving later does to what is already in
# --------------------------------------------------------------------------- #

def test_account_sources_are_imported_before_event_sources(store, tmp_path):
    """All of them before all of them — never alphabetically.

    ``zzz.csv`` declares what ``2024.csv`` names, so a folder walked in name
    order would refuse the events on the first pass and accept them on the
    second. A folder whose meaning depends on how many times it was scanned is
    the bug this rule exists against.
    """
    drop = _drop(tmp_path,
                 **{'2024_csv': TWO_ACCOUNTS_UNDECLARED,
                    'zzz_csv': ACCOUNTS_FILE})

    outcomes = ledger.sync_drop_folder(store, drop)

    assert [o.filename for o in outcomes] == ['zzz.csv', '2024.csv']
    assert all(o.outcome == ledger.IMPORTED for o in outcomes)


def test_a_declaration_arriving_later_re_keys_the_events_it_names(store, tmp_path):
    """The events were written under ``default``; declaring re-imports them.

    Leaving them there would show the user the accounts they just declared next
    to a ledger that ignores them — and the file's fingerprint has not moved, so
    only the declaration having moved can be what re-imports it.
    """
    drop = _drop(tmp_path, **{'2024_csv': TWO_ACCOUNTS_UNDECLARED})
    ledger.sync_drop_folder(store, drop)
    assert store.query('SELECT count(*) FROM event') == [(0,)]

    (drop / 'accounts.csv').write_text(ACCOUNTS_FILE, encoding="utf-8")
    ledger.sync_drop_folder(store, drop)

    assert _event_accounts(store) == ['pea', 'cto']


def test_a_blank_column_becomes_an_error_once_an_account_is_declared(store, tmp_path):
    """The rule's second half, and the typo it keeps refusing.

    The v4 file imported cleanly a moment ago; the declaration is what makes the
    blank cell an omission rather than a choice. The rows it wrote before stay
    exactly where they were — a refused import changes nothing.
    """
    drop = _drop(tmp_path, **{'2024_csv': V4_SINGLE_ACCOUNT})
    ledger.sync_drop_folder(store, drop)

    (drop / 'accounts.csv').write_text(ACCOUNTS_FILE, encoding="utf-8")
    outcomes = ledger.sync_drop_folder(store, drop)

    refused = _refusal(outcomes, '2024.csv')
    assert refused.outcome == ledger.REFUSED
    assert "account is required" in refused.error
    assert _event_accounts(store) == [DEFAULT_ACCOUNT, DEFAULT_ACCOUNT]

    # And the forced pass happens **once**: the rollback left the fingerprint
    # where it was, so the next scan reports the folder unchanged rather than
    # re-parsing every file on every filesystem event. The retry rides on the
    # user's fix — writing the account column is what moves the fingerprint.
    again = _refusal(ledger.sync_drop_folder(store, drop), '2024.csv')
    assert again.outcome == ledger.UNCHANGED

    (drop / '2024.csv').write_text(
        "date,event_type,symbol,name,quantity,unit_price,account\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n", encoding="utf-8")
    fixed = _refusal(ledger.sync_drop_folder(store, drop), '2024.csv')
    assert fixed.outcome == ledger.IMPORTED
    assert _event_accounts(store) == ['pea']


# --------------------------------------------------------------------------- #
# The accounts file itself
# --------------------------------------------------------------------------- #

def test_the_header_says_what_a_file_is_not_its_name(store, tmp_path):
    """No filename has a special meaning in v5 (spec #695 § 6)."""
    drop = _drop(tmp_path, **{'ui_csv': ACCOUNTS_FILE})

    (outcome,) = ledger.sync_drop_folder(store, drop)

    assert outcome.kind == ledger.KIND_ACCOUNTS
    assert {row[0] for row in _accounts(store)} == {DEFAULT_ACCOUNT, 'pea', 'cto'}


def test_an_imported_account_carries_its_source_and_is_read_only(store, tmp_path):
    drop = _drop(tmp_path, **{'accounts_csv': ACCOUNTS_FILE})
    ledger.sync_drop_folder(store, drop)

    (source,) = ledger.list_imports(store, kind=ledger.KIND_ACCOUNTS)
    pea = next(a for a in accounts_module.read_accounts(store) if a.id == 'pea')

    assert pea.source_id == source.id
    assert pea.editable is False
    assert (pea.type, pea.label) == ('PEA', 'PEA Bourso')

    with pytest.raises(accounts_module.ReadOnlyAccount):
        accounts_module.update_account(store, 'pea', label="Renamed")


def test_a_re_drop_removes_the_accounts_the_file_stopped_declaring(store, tmp_path):
    drop = _drop(tmp_path, **{'accounts_csv': ACCOUNTS_FILE})
    ledger.sync_drop_folder(store, drop)

    (drop / 'accounts.csv').write_text("id,type,label\npea,PEA,PEA Bourso\n",
                                       encoding="utf-8")
    ledger.sync_drop_folder(store, drop)

    assert {row[0] for row in _accounts(store)} == {DEFAULT_ACCOUNT, 'pea'}


def test_overwriting_an_accounts_file_with_events_retires_its_accounts(store, tmp_path):
    """A source declares one kind of thing at a time.

    Overwriting the file is a re-drop like any other, so the accounts go with
    the declaration that named them — and if an event named one, the re-drop is
    refused whole, which is the cascade refusal seen from its other side.
    """
    drop = _drop(tmp_path, **{'accounts_csv': ACCOUNTS_FILE})
    ledger.sync_drop_folder(store, drop)

    (drop / 'accounts.csv').write_text(V4_SINGLE_ACCOUNT, encoding="utf-8")
    (outcome,) = ledger.sync_drop_folder(store, drop)

    assert outcome.outcome == ledger.IMPORTED
    assert [row[0] for row in _accounts(store)] == [DEFAULT_ACCOUNT]
    assert _event_accounts(store) == [DEFAULT_ACCOUNT, DEFAULT_ACCOUNT]


def test_a_steady_folder_imports_nothing_twice(store, tmp_path):
    """The always-on watch costs one hash per file per event, and no write.

    It matters here beyond #697's fingerprint: the declaration is compared
    before and after the accounts pass, so a second scan that found it unmoved
    must **not** force the event files through again.
    """
    drop = _drop(tmp_path, **{'accounts_csv': ACCOUNTS_FILE,
                              '2024_csv': TWO_ACCOUNTS_UNDECLARED})
    ledger.sync_drop_folder(store, drop)

    outcomes = ledger.sync_drop_folder(store, drop)

    assert [o.outcome for o in outcomes] == [ledger.UNCHANGED, ledger.UNCHANGED]


def test_the_label_falls_back_to_the_id(store, tmp_path):
    """``label`` is ``NOT NULL``: a row cannot decline to name itself."""
    drop = _drop(tmp_path, **{'accounts_csv': "id,type\npea,PEA\n"})
    ledger.sync_drop_folder(store, drop)

    pea = next(a for a in accounts_module.read_accounts(store) if a.id == 'pea')
    assert pea.label == 'pea'


def test_a_file_declaring_one_id_twice_is_refused(store, tmp_path):
    drop = _drop(tmp_path, **{
        'accounts_csv': "id,type,label\npea,PEA,First\npea,CTO,Second\n"})

    (outcome,) = ledger.sync_drop_folder(store, drop)

    assert outcome.outcome == ledger.REFUSED
    assert "declared twice" in outcome.error
    assert _accounts(store) == [(DEFAULT_ACCOUNT, 'OTHER', 'Default account', None)]


def test_two_files_declaring_one_id_is_refused(store, tmp_path):
    """Two declarations of one account cannot both be the truth."""
    drop = _drop(tmp_path,
                 **{'a_csv': "id,type,label\npea,PEA,From A\n",
                    'b_csv': "id,type,label\npea,PEA,From B\n"})

    outcomes = ledger.sync_drop_folder(store, drop)

    assert _refusal(outcomes, 'a.csv').outcome == ledger.IMPORTED
    assert "already declared" in _refusal(outcomes, 'b.csv').error
    assert next(a for a in accounts_module.read_accounts(store)
                if a.id == 'pea').label == 'From A'


def test_an_accounts_file_that_cannot_stand_leaves_no_import_behind(store, tmp_path):
    """All-or-nothing, the same contract an event file gets."""
    drop = _drop(tmp_path, **{'accounts_csv': "id,type,label\n,PEA,No id\n"})

    (outcome,) = ledger.sync_drop_folder(store, drop)

    assert outcome.outcome == ledger.REFUSED
    assert "id is required" in outcome.error
    assert ledger.list_imports(store) == []


def test_an_accounts_file_can_be_a_workbook(store, tmp_path):
    """The events' format, both halves of it."""
    openpyxl = pytest.importorskip("openpyxl")
    folder = tmp_path / "drop"
    folder.mkdir()
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Comptes"
    sheet.append(["id", "type", "label"])
    sheet.append(["pea", "PEA", "PEA Bourso"])
    workbook.save(folder / "accounts.xlsx")

    (outcome,) = ledger.sync_drop_folder(store, folder)

    assert outcome.outcome == ledger.IMPORTED
    assert {row[0] for row in _accounts(store)} == {DEFAULT_ACCOUNT, 'pea'}


# --------------------------------------------------------------------------- #
# Undeletable while an event names it (ADR-0013)
# --------------------------------------------------------------------------- #

def test_an_account_an_event_names_cannot_be_removed(store, tmp_path):
    drop = _drop(tmp_path, **{'accounts_csv': ACCOUNTS_FILE,
                              '2024_csv': TWO_ACCOUNTS_UNDECLARED})
    ledger.sync_drop_folder(store, drop)

    with pytest.raises(accounts_module.AccountInUse):
        accounts_module.delete_account(store, 'pea')


def test_forgetting_an_accounts_import_is_refused_in_cascade(store, tmp_path):
    """The cascade is **refused**, never performed.

    Forgetting is meant to be undone by re-dropping the file; one that took a
    year of events with it on the way out would not be. The user's move is to
    forget the event imports first, and the message says so.
    """
    drop = _drop(tmp_path, **{'accounts_csv': ACCOUNTS_FILE,
                              '2024_csv': TWO_ACCOUNTS_UNDECLARED})
    ledger.sync_drop_folder(store, drop)
    declaring = next(i for i in ledger.list_imports(store)
                     if i.kind == ledger.KIND_ACCOUNTS)

    with pytest.raises(accounts_module.AccountInUse,
                       match="while an event names it"):
        ledger.forget_import(store, declaring.id)

    # Nothing moved: not the accounts, not the events, not the import row.
    assert {row[0] for row in _accounts(store)} == {DEFAULT_ACCOUNT, 'pea', 'cto'}
    assert len(ledger.list_imports(store)) == 2

    # Forget what rests on it, and the declaration goes.
    events_import = next(i for i in ledger.list_imports(store)
                         if i.kind == ledger.KIND_EVENTS)
    ledger.forget_import(store, events_import.id)
    ledger.forget_import(store, declaring.id)

    assert _accounts(store) == [(DEFAULT_ACCOUNT, 'OTHER', 'Default account', None)]


def test_a_refused_cascade_removes_nothing_at_all(store, tmp_path):
    """The refusal is decided before the first deletion, not during.

    ``forget_import`` runs outside a transaction, so a refusal raised halfway
    through the accounts would leave the earlier ones deleted **and** the
    gesture refused — and the file's fingerprint being unchanged, no later scan
    would ever bring them back. ``aaa`` sorts before ``zzz``, so it is the one a
    loop-and-raise would have taken with it.
    """
    drop = _drop(tmp_path, **{
        'accounts_csv': "id,type,label\naaa,CTO,First\nzzz,PEA,Last\n",
        '2024_csv': (
            "date,event_type,symbol,name,quantity,unit_price,account\n"
            "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,zzz\n")})
    ledger.sync_drop_folder(store, drop)
    declaring = next(i for i in ledger.list_imports(store)
                     if i.kind == ledger.KIND_ACCOUNTS)

    with pytest.raises(accounts_module.AccountInUse):
        ledger.forget_import(store, declaring.id)

    assert {row[0] for row in _accounts(store)} == {DEFAULT_ACCOUNT, 'aaa', 'zzz'}


def test_a_file_that_becomes_a_declaration_leaves_no_events_behind(store, tmp_path):
    """The mirror of the retiring above: the events go with the kind.

    Otherwise they would hang off a source marked ``accounts``, invisible to
    every gesture that reasons about kinds.
    """
    drop = _drop(tmp_path, **{'book_csv': V4_SINGLE_ACCOUNT})
    ledger.sync_drop_folder(store, drop)
    assert store.query('SELECT count(*) FROM event') == [(2,)]

    (drop / 'book.csv').write_text(ACCOUNTS_FILE, encoding="utf-8")
    (outcome,) = ledger.sync_drop_folder(store, drop)

    assert outcome.outcome == ledger.IMPORTED
    assert outcome.kind == ledger.KIND_ACCOUNTS
    assert store.query('SELECT count(*) FROM event') == [(0,)]


def test_a_declaration_that_would_break_the_ledger_is_refused(store, tmp_path):
    """Dropping a source's events can leave another file's SELLs unbacked.

    Committing that is a store that raises on every reload — and the raise is
    fatal at boot, so the API that could forget the import would never come up
    to be asked. It is refused inside the transaction instead.
    """
    drop = _drop(tmp_path, **{
        'buys_csv': (
            "date,event_type,symbol,name,quantity,unit_price\n"
            "2024-01-15,BUY,AAPL,Apple Inc,10,150.00\n"),
        'sells_csv': (
            "date,event_type,symbol,name,quantity,unit_price\n"
            "2024-06-15,SELL,AAPL,Apple Inc,10,180.00\n")})
    ledger.sync_drop_folder(store, drop)
    assert store.query('SELECT count(*) FROM event') == [(2,)]

    (drop / 'buys.csv').write_text(ACCOUNTS_FILE, encoding="utf-8")
    (outcome,) = [o for o in ledger.sync_drop_folder(store, drop)
                  if o.filename == 'buys.csv']

    assert outcome.outcome == ledger.REFUSED
    assert store.query('SELECT count(*) FROM event') == [(2,)]
    assert [row[0] for row in _accounts(store)] == [DEFAULT_ACCOUNT]


def test_an_excel_utf8_export_is_recognised_despite_its_byte_order_mark(store, tmp_path):
    """Excel's own "CSV UTF-8" writes a BOM, and it must not hide the header.

    Under plain ``utf-8`` the first column reads ``﻿id``, so the file is
    not even taken for a declaration — it is refused as an event file missing
    the ``date`` column it never claimed to have.
    """
    folder = tmp_path / "drop"
    folder.mkdir()
    (folder / "accounts.csv").write_text(ACCOUNTS_FILE, encoding="utf-8-sig")

    (outcome,) = ledger.sync_drop_folder(store, folder)

    assert outcome.outcome == ledger.IMPORTED
    assert outcome.kind == ledger.KIND_ACCOUNTS
    assert {row[0] for row in _accounts(store)} == {DEFAULT_ACCOUNT, 'pea', 'cto'}


def test_the_default_account_is_never_removed(store, tmp_path):
    """There is always at least one account; sometimes it is called ``default``.

    Even when a file takes it over and is then forgotten: the ownership goes,
    the row stays. Nothing in the app may branch on "are accounts declared", so
    nothing may be able to empty the table.
    """
    with pytest.raises(accounts_module.AccountInUse):
        accounts_module.delete_account(store, DEFAULT_ACCOUNT)

    drop = _drop(tmp_path, **{
        'accounts_csv': "id,type,label\ndefault,CTO,Renamed\n"})
    ledger.sync_drop_folder(store, drop)
    (source,) = ledger.list_imports(store)
    ledger.forget_import(store, source.id)

    assert [row[0] for row in _accounts(store)] == [DEFAULT_ACCOUNT]
    assert accounts_module.account_ids(store) == {DEFAULT_ACCOUNT}


# --------------------------------------------------------------------------- #
# Declared in the app
# --------------------------------------------------------------------------- #

def test_an_account_created_in_the_app_is_editable(store):
    created = accounts_module.create_account(store, 'pea', 'PEA', 'PEA Bourso')

    assert created.source_id is None and created.editable

    accounts_module.update_account(store, 'pea', label="PEA Fortuneo")
    assert next(a for a in accounts_module.read_accounts(store)
                if a.id == 'pea').label == "PEA Fortuneo"

    accounts_module.delete_account(store, 'pea')
    assert accounts_module.account_ids(store) == {DEFAULT_ACCOUNT}


def test_two_accounts_cannot_share_an_id(store):
    accounts_module.create_account(store, 'pea', 'PEA')
    with pytest.raises(accounts_module.DuplicateAccount):
        accounts_module.create_account(store, 'pea', 'CTO')


def test_creating_an_account_makes_a_blank_column_an_error(store, tmp_path):
    """An account created in the app declares as much as a file does.

    Answering otherwise would let a blank column keep meaning ``default`` while
    a real account existed — which is exactly the second account's events piling
    onto the first.
    """
    accounts_module.create_account(store, 'pea', 'PEA')
    drop = _drop(tmp_path, **{'2024_csv': V4_SINGLE_ACCOUNT})

    (outcome,) = ledger.sync_drop_folder(store, drop)

    assert outcome.outcome == ledger.REFUSED
    assert "account is required" in outcome.error


# --------------------------------------------------------------------------- #
# What the app publishes from the table
# --------------------------------------------------------------------------- #

def test_the_declaration_is_none_until_something_is_declared(store):
    """``None`` is ergonomics, not a discriminant (ADR-0013).

    The table is never empty — the pages ask "is there a declaration to show",
    and the seeded row is not one.
    """
    assert accounts_module.declared_portfolio(store) is None
    assert accounts_module.account_ids(store) == {DEFAULT_ACCOUNT}
    assert accounts_module.accounts_are_declared(store) is False


def test_the_unnamed_default_stays_out_of_the_published_declaration(store, tmp_path):
    """An install that declared two accounts must not grow a phantom third."""
    drop = _drop(tmp_path, **{'accounts_csv': ACCOUNTS_FILE})
    ledger.sync_drop_folder(store, drop)

    portfolio = accounts_module.declared_portfolio(store)
    assert portfolio.ids() == {'pea', 'cto'}


def test_a_default_bucket_that_holds_events_is_published(store, tmp_path):
    """The mixed state a late declaration leaves: it is a real account there.

    ``2024.csv`` was imported before anything was declared, so its rows sit in
    ``default``; it is then refused (its column is blank), so they stay. Hiding
    the bucket would hide a third of the portfolio.
    """
    drop = _drop(tmp_path, **{'2024_csv': V4_SINGLE_ACCOUNT})
    ledger.sync_drop_folder(store, drop)
    (drop / 'accounts.csv').write_text(ACCOUNTS_FILE, encoding="utf-8")
    ledger.sync_drop_folder(store, drop)

    portfolio = accounts_module.declared_portfolio(store)
    assert portfolio.ids() == {'pea', 'cto', DEFAULT_ACCOUNT}


def test_the_manager_publishes_the_declaration_from_the_store(tmp_path):
    """End to end through ``ConfigurationManager``: a file, then a snapshot."""
    events = tmp_path / "events"
    events.mkdir()
    (events / "accounts.csv").write_text(ACCOUNTS_FILE, encoding="utf-8")
    (events / "2024.csv").write_text(TWO_ACCOUNTS_UNDECLARED, encoding="utf-8")

    cm = ConfigurationManager(config_dir=str(tmp_path))
    snapshot = cm.current()

    assert snapshot.accounts.ids() == {'pea', 'cto'}
    by_account = {s["account"]: s for s in snapshot.shares}
    assert set(by_account) == {'pea', 'cto'}
    assert by_account['pea']["estate"]["quantity"] == 10
    assert by_account['cto']["estate"]["quantity"] == 5


def test_a_declaration_changing_republishes_the_snapshot(tmp_path):
    """The declaration joins the cache key, or the page keeps the old list."""
    events = tmp_path / "events"
    events.mkdir()
    cm = ConfigurationManager(config_dir=str(tmp_path))
    before = cm.current()

    accounts_module.create_account(cm._require_store(), 'pea', 'PEA')

    after = cm.reload()
    assert after is not before
    assert after.accounts.ids() == {'pea'}


# --------------------------------------------------------------------------- #
# schemas: Account / Portfolio
# --------------------------------------------------------------------------- #

def test_portfolio_ids_and_get():
    portfolio = Portfolio(accounts=[
        Account(id="PEA", type="PEA", label="Mon PEA"),
        Account(id="CTO", type="CTO", label="CTO", source_id=3),
    ])
    assert portfolio.ids() == {"PEA", "CTO"}
    assert portfolio.get("PEA").label == "Mon PEA"
    assert portfolio.get("PEA").editable is True
    assert portfolio.get("CTO").editable is False
    assert portfolio.get("UNKNOWN") is None


# --------------------------------------------------------------------------- #
# loader: the account column of an event file
# --------------------------------------------------------------------------- #

def test_loader_reads_account_column_from_csv(tmp_path):
    csv_path = tmp_path / "events.csv"
    csv_path.write_text(TWO_ACCOUNTS_UNDECLARED, encoding="utf-8")

    events = EventLoader(str(csv_path)).load()
    assert [e.account for e in events] == ["pea", "cto"]


def test_loader_account_none_when_column_absent(tmp_path):
    csv_path = tmp_path / "events.csv"
    csv_path.write_text(V4_SINGLE_ACCOUNT, encoding="utf-8")
    events = EventLoader(str(csv_path)).load()
    assert {e.account for e in events} == {None}


def test_loader_reads_account_column_from_xlsx(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    xlsx_path = tmp_path / "events.xlsx"
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["date", "event_type", "symbol", "name", "quantity",
                  "unit_price", "fee", "amount", "notes", "account"])
    sheet.append(["2024-01-15", "BUY", "AAPL", "Apple Inc", 10, 150.0, 2.5,
                  None, None, "pea"])
    sheet.append(["2024-01-16", "BUY", "AAPL", "Apple Inc", 5, 160.0, 1.0,
                  None, None, "cto"])
    workbook.save(xlsx_path)

    events = EventLoader(str(xlsx_path)).load()
    assert sorted(e.account for e in events) == ["cto", "pea"]


# --------------------------------------------------------------------------- #
# validator: the two halves of the account rule
# --------------------------------------------------------------------------- #

def _buy(account=None):
    return Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
                 quantity=10, unit_price=150.0, fee=2.5, account=account)


def test_validator_lets_a_blank_account_through_until_one_is_declared():
    ok, errors = EventValidator(account_ids={DEFAULT_ACCOUNT}).validate(
        [_buy(account=None)])
    assert ok and errors == []


def test_validator_requires_an_account_once_one_is_declared():
    validator = EventValidator(account_ids={DEFAULT_ACCOUNT, "pea"},
                               accounts_declared=True)
    ok, errors = validator.validate([_buy(account=None)])
    assert not ok
    assert any("account is required" in e for e in errors)


def test_validator_refuses_an_account_nobody_declared():
    """Whether or not anything else is declared — a typo is a typo."""
    validator = EventValidator(account_ids={DEFAULT_ACCOUNT})
    ok, errors = validator.validate([_buy(account="livretA")])
    assert not ok
    assert any("'livretA' is not declared" in e for e in errors)


def test_validator_accepts_a_declared_account_id():
    validator = EventValidator(account_ids={DEFAULT_ACCOUNT, "pea"},
                               accounts_declared=True)
    ok, errors = validator.validate([_buy(account="pea")])
    assert ok and errors == []


# --------------------------------------------------------------------------- #
# aggregator: (account, symbol) keying, and no branch left
# --------------------------------------------------------------------------- #

def _two_account_events():
    return [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5, account="pea"),
        Event(date(2024, 1, 16), EventType.BUY, "AAPL", "Apple Inc",
              quantity=5, unit_price=160.0, fee=1.0, account="cto"),
    ]


def test_aggregate_keys_by_account_symbol():
    shares = EventAggregator().aggregate(_two_account_events())

    by_account = {s["account"]: s for s in shares}
    assert set(by_account) == {"pea", "cto"}
    # Each account keeps its own weighted cost price.
    assert by_account["pea"]["purchase"]["cost_price"] == 150.0
    assert by_account["cto"]["purchase"]["cost_price"] == 160.0


def test_aggregate_falls_back_to_default_for_a_blank_column():
    events = [_buy(account=None),
              Event(date(2024, 1, 16), EventType.BUY, "AAPL", "Apple Inc",
                    quantity=5, unit_price=160.0, fee=1.0)]
    shares = EventAggregator().aggregate(events)

    assert len(shares) == 1
    assert shares[0]["account"] == DEFAULT_ACCOUNT
    assert shares[0]["estate"]["quantity"] == 15


def test_position_at_scoped_to_account():
    timeline = EventAggregator().replay(_two_account_events())

    pea = timeline.position_at("pea", "AAPL", date(2024, 2, 1))
    cto = timeline.position_at("cto", "AAPL", date(2024, 2, 1))

    assert pea["estate"]["quantity"] == 10
    assert cto["estate"]["quantity"] == 5
    # CTO's first event is 2024-01-16: before it, no state (never an error).
    assert timeline.position_at("cto", "AAPL", date(2024, 1, 15)) is None


# --------------------------------------------------------------------------- #
# The account key survives the aggregated share dict
# --------------------------------------------------------------------------- #

def test_the_aggregated_share_dict_carries_its_account():
    share = ShareState(name="Apple", symbol="AAPL", account="pea").to_dict()

    assert share["account"] == "pea"
    assert share["symbol"] == "AAPL"
