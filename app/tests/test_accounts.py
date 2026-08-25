"""Accounts are declared in the app, and a bad file does not get in (#698, #816).

The seam is #695's: a **real** DuckDB store in ``tmp_path`` and the real writer
running on it. Nothing here asserts that a method was called — the rules are
rules about *rows*, and about which gestures the store refuses:

1. an event file naming an undeclared account is not written **at all**, and
   the message names the account to declare;
2. a blank ``account`` column means ``default`` until something is declared, and
   is an error afterwards;
3. an account is undeletable while an event names it (ADR-0013);
4. the v4 ``settings.yaml`` is named, never read (that half lives in
   ``test_configuration_manager.py``, next to ``config.yaml``'s);
5. the seeded ``default`` row is always there, so nothing branches on *"are
   accounts declared"*.

**The accounts-file half of this file left with ADR-0032** (#816): there is no
``import_source`` to hang a declaration off, no revocation by source, and no
re-drop that replaces. What survived the move is the **header reader** — the
upload has to recognise a declaration in order to refuse it by name — and every
rule above, which was never about the folder.

The first test in the file is a v4 install's file landing untouched, and it is
deliberately first: it is the one a user meets.
"""

from datetime import date

import pytest

import accounts as accounts_module
import entries
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


def _file(tmp_path, name, text):
    """One file on disk, the way a reader hands one over."""
    folder = tmp_path / "drop"
    folder.mkdir(exist_ok=True)
    path = folder / name
    path.write_text(text, encoding="utf-8")
    return path


def _upload(store, tmp_path, text, name='2024.csv'):
    """One event file into the store, by the road the upload route takes."""
    return entries.create_many(
        store, EventLoader(str(_file(tmp_path, name, text))).load())


def _declare(store, text):
    """The accounts a fixture wants, declared the way the app declares them.

    An account is born in the app and nowhere else (ADR-0034), so what a file
    used to do in one gesture is three calls here. The file stays the fixture's
    shape because it is what these tests spell — nothing reads it on its own.
    """
    import io
    import csv as csv_module
    for row in csv_module.DictReader(io.StringIO(text)):
        accounts_module.create_account(store, row['id'], row['type'],
                                       row.get('label'))


def _accounts(store):
    """Every account row, as ``(id, type, label)`` tuples."""
    return store.query(
        'SELECT id, type, label FROM account ORDER BY id')


def _event_accounts(store):
    return [row[0] for row in store.query(
        'SELECT account FROM event ORDER BY id')]


# --------------------------------------------------------------------------- #
# The seam: coming from v4, with and without a declaration
# --------------------------------------------------------------------------- #

def test_a_v4_single_account_install_imports_untouched(store, tmp_path):
    """The one continuity that survives between the two versions.

    It survives because *"a blank account column means `default`"* is v4's rule
    **minus its opt-in** — including on the cash events, where v4 demanded an
    account even with none declared.
    """
    written = _upload(store, tmp_path, V4_SINGLE_ACCOUNT)

    assert len(written) == 2
    assert _event_accounts(store) == [DEFAULT_ACCOUNT, DEFAULT_ACCOUNT]
    # The seeded row is the whole declaration, and nothing else appeared.
    assert _accounts(store) == [(DEFAULT_ACCOUNT, 'OTHER', 'Default account')]
    assert accounts_module.declared_portfolio(store) is None


def test_a_multi_account_file_without_a_declaration_is_refused_whole(store, tmp_path):
    """Not partially — and the message names the account to declare.

    A single value in the column could be folded into ``default`` without
    losing anything; two cannot, and guessing would pile one account's events
    onto another silently. So the refusal is the answer, and it is the whole
    file's: the first row is as absent from the store as the second.
    """
    with pytest.raises(entries.InvalidEntry) as refusal:
        _upload(store, tmp_path, TWO_ACCOUNTS_UNDECLARED)

    assert "'pea' is not declared" in str(refusal.value)
    assert store.query('SELECT count(*) FROM event') == [(0,)]


def test_declaring_the_accounts_lets_the_same_file_in(store, tmp_path):
    """The gesture the refusal above asks for, and its effect on the ledger.

    It names the app because that is where an account is born (ADR-0034): the
    refusal above says *declare it*, and this is what declaring it is.
    """
    _declare(store, ACCOUNTS_FILE)

    _upload(store, tmp_path, TWO_ACCOUNTS_UNDECLARED)

    assert _event_accounts(store) == ['pea', 'cto']


# --------------------------------------------------------------------------- #
# The order, and what a declaration arriving later does to what is already in
# --------------------------------------------------------------------------- #

def test_a_blank_column_becomes_an_error_once_an_account_is_declared(store, tmp_path):
    """The rule's second half, and the typo it keeps refusing.

    The v4 file landed cleanly a moment ago; the declaration is what makes the
    blank cell an omission rather than a choice. The rows written before stay
    exactly where they were — a refused import changes nothing — and the fix is
    the reader's: a file with the column filled in goes straight in.
    """
    _upload(store, tmp_path, V4_SINGLE_ACCOUNT, name='old.csv')
    _declare(store, ACCOUNTS_FILE)

    with pytest.raises(entries.InvalidEntry) as refusal:
        _upload(store, tmp_path, V4_SINGLE_ACCOUNT, name='again.csv')

    assert "account is required" in str(refusal.value)
    assert _event_accounts(store) == [DEFAULT_ACCOUNT, DEFAULT_ACCOUNT]

    _upload(store, tmp_path,
            "date,event_type,symbol,name,quantity,unit_price,account\n"
            "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n", name='fixed.csv')
    assert _event_accounts(store) == [DEFAULT_ACCOUNT, DEFAULT_ACCOUNT, 'pea']


# --------------------------------------------------------------------------- #
# The accounts file itself
# --------------------------------------------------------------------------- #

def test_the_header_says_what_a_file_is_not_its_name(store, tmp_path):
    """No filename has a special meaning in v5 (spec #695 § 6).

    The rule the upload still leans on: a declaration is recognised by its
    header so it can be **refused by name** (ADR-0034), and ``ui.csv`` is a file
    like any other.
    """
    assert accounts_module.is_accounts_file(
        _file(tmp_path, 'ui.csv', ACCOUNTS_FILE)) is True
    assert accounts_module.is_accounts_file(
        _file(tmp_path, 'accounts.csv', V4_SINGLE_ACCOUNT)) is False


def test_a_declaration_is_recognised_in_a_workbook_too(store, tmp_path):
    """The events' format has two halves, and the guard holds on both.

    ``is_accounts_file`` survives one job (ADR-0034, criterion 2): letting the
    upload **refuse a declaration by name**. A ``.xlsx`` is handed over exactly
    as a ``.csv`` is, so the recognition has to reach through the workbook
    reader too — and it is the only road left to it. Asserted on the ``.csv``
    alone, the criterion would leave that half unguarded, and a zealous pass
    would take it away with nobody the wiser.
    """
    openpyxl = pytest.importorskip("openpyxl")

    def _workbook(name, header, row):
        book = openpyxl.Workbook()
        sheet = book.active
        sheet.title = "Comptes"
        sheet.append(header)
        sheet.append(row)
        path = tmp_path / name
        book.save(path)
        return path

    declaration = _workbook("ui.xlsx", ["id", "type", "label"],
                            ["pea", "PEA", "PEA Bourso"])
    events = _workbook("accounts.xlsx",
                       ["date", "event_type", "symbol", "quantity",
                        "unit_price"],
                       ["2024-01-15", "BUY", "AAPL", 10, 150.0])

    assert accounts_module.is_accounts_file(declaration) is True
    # And the name decides nothing here either: the second workbook is called
    # after the accounts and carries events, so it goes to the event loader.
    assert accounts_module.is_accounts_file(events) is False


def test_the_label_falls_back_to_the_id(store):
    """``label`` is ``NOT NULL``: a row cannot decline to name itself."""
    accounts_module.create_account(store, 'pea', 'PEA')

    pea = next(a for a in accounts_module.read_accounts(store) if a.id == 'pea')
    assert pea.label == 'pea'


# --------------------------------------------------------------------------- #
# Undeletable while an event names it (ADR-0013)
# --------------------------------------------------------------------------- #

def test_an_account_an_event_names_cannot_be_removed(store, tmp_path):
    """ADR-0013's rule, and it is the one that does **not** move (#816)."""
    _declare(store, ACCOUNTS_FILE)
    _upload(store, tmp_path, TWO_ACCOUNTS_UNDECLARED)

    with pytest.raises(accounts_module.AccountInUse):
        accounts_module.delete_account(store, 'pea')


def test_an_excel_utf8_export_is_recognised_despite_its_byte_order_mark(store, tmp_path):
    """Excel's own "CSV UTF-8" writes a BOM, and it must not hide the header.

    Under plain ``utf-8`` the first column reads ``﻿id``, so the file would not
    even be taken for a declaration — and the upload would refuse it as an event
    file missing the ``date`` column it never claimed to have, which is the one
    refusal that teaches nothing.
    """
    folder = tmp_path / "drop"
    folder.mkdir(exist_ok=True)
    (folder / "accounts.csv").write_text(ACCOUNTS_FILE, encoding="utf-8-sig")

    assert accounts_module.is_accounts_file(folder / "accounts.csv") is True


def test_the_default_account_is_never_removed(store):
    """There is always at least one account; sometimes it is called ``default``.

    Nothing in the app may branch on "are accounts declared", so nothing may be
    able to empty the table — including a rename, which is how an install with a
    page and no file declares its one account.
    """
    with pytest.raises(accounts_module.AccountInUse):
        accounts_module.delete_account(store, DEFAULT_ACCOUNT)

    accounts_module.update_account(store, DEFAULT_ACCOUNT, label='Renamed')
    with pytest.raises(accounts_module.AccountInUse):
        accounts_module.delete_account(store, DEFAULT_ACCOUNT)

    assert accounts_module.account_ids(store) == {DEFAULT_ACCOUNT}


def test_an_account_declared_here_is_renamed_and_removed_here(store):
    """An account is born in the app, so every gesture on it is the app's."""
    created = accounts_module.create_account(store, 'pea', 'PEA', 'PEA Bourso')

    assert (created.id, created.type, created.label) == \
        ('pea', 'PEA', 'PEA Bourso')

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

    with pytest.raises(entries.InvalidEntry) as refusal:
        _upload(store, tmp_path, V4_SINGLE_ACCOUNT)

    assert "account is required" in str(refusal.value)
    assert store.query('SELECT count(*) FROM event') == [(0,)]


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


def test_the_unnamed_default_stays_out_of_the_published_declaration(store):
    """An install that declared two accounts must not grow a phantom third."""
    _declare(store, ACCOUNTS_FILE)

    portfolio = accounts_module.declared_portfolio(store)
    assert portfolio.ids() == {'pea', 'cto'}


def test_a_default_bucket_that_holds_events_is_published(store, tmp_path):
    """The mixed state a late declaration leaves: it is a real account there.

    ``2024.csv`` landed before anything was declared, so its rows sit in
    ``default``; a second upload of it would be refused now (its column is
    blank), so they stay. Hiding the bucket would hide a third of the portfolio.
    """
    _upload(store, tmp_path, V4_SINGLE_ACCOUNT)
    _declare(store, ACCOUNTS_FILE)

    portfolio = accounts_module.declared_portfolio(store)
    assert portfolio.ids() == {'pea', 'cto', DEFAULT_ACCOUNT}


def test_the_manager_publishes_the_declaration_from_the_store(tmp_path):
    """End to end through ``ConfigurationManager``: a ledger, then a snapshot.

    The rows reach the store first and the manager replays them: it scans no
    directory since ADR-0032, so what a snapshot is built from is the store and
    only the store.
    """
    cm = ConfigurationManager(config_dir=str(tmp_path))
    _declare(cm.store, ACCOUNTS_FILE)
    _upload(cm.store, tmp_path, TWO_ACCOUNTS_UNDECLARED)
    snapshot = cm.current()

    assert snapshot.accounts.ids() == {'pea', 'cto'}
    by_account = {s["account"]: s for s in snapshot.shares}
    assert set(by_account) == {'pea', 'cto'}
    assert by_account["pea"]["quantity"] == 10
    assert by_account['cto']["quantity"] == 5


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
        Account(id="CTO", type="CTO", label="CTO"),
    ])
    assert portfolio.ids() == {"PEA", "CTO"}
    assert portfolio.get("PEA").label == "Mon PEA"
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
    # Each account keeps its own cost basis (the PMP is per account anyway).
    assert by_account["pea"]["cost_basis"] == 10 * 150.0 + 2.5
    assert by_account["cto"]["cost_basis"] == 5 * 160.0 + 1.0


def test_aggregate_falls_back_to_default_for_a_blank_column():
    events = [_buy(account=None),
              Event(date(2024, 1, 16), EventType.BUY, "AAPL", "Apple Inc",
                    quantity=5, unit_price=160.0, fee=1.0)]
    shares = EventAggregator().aggregate(events)

    assert len(shares) == 1
    assert shares[0]["account"] == DEFAULT_ACCOUNT
    assert shares[0]["quantity"] == 15


def test_position_at_scoped_to_account():
    timeline = EventAggregator().replay(_two_account_events())

    pea = timeline.position_at("pea", "AAPL", date(2024, 2, 1))
    cto = timeline.position_at("cto", "AAPL", date(2024, 2, 1))

    assert pea["quantity"] == 10
    assert cto["quantity"] == 5
    # CTO's first event is 2024-01-16: before it, no state (never an error).
    assert timeline.position_at("cto", "AAPL", date(2024, 1, 15)) is None


# --------------------------------------------------------------------------- #
# The account key survives the aggregated share dict
# --------------------------------------------------------------------------- #

def test_the_aggregated_share_dict_carries_its_account():
    share = ShareState(name="Apple", symbol="AAPL", account="pea").to_dict()

    assert share["account"] == "pea"
    assert share["symbol"] == "AAPL"
