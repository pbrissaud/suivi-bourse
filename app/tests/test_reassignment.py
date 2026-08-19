"""The reassignment — *réaffecter, jamais refuser* (issue #725, ADR-0013, ADR-0006).

The seam is :mod:`test_entries`': a **real** DuckDB store in ``tmp_path``, the
real ingestion beside it, and every assertion a ``SELECT`` against the store.

The state this file is about **cannot be reached on the real portfolio** — its
285 events all name an account, so ``default`` is nowhere — and the ticket makes
fabricating it an obligation rather than a convenience: an install that ran a
month before declaring anything has its whole history under the seeded row, and
that row then becomes undeletable the moment an event names it.
"""
from datetime import date

import pytest

import accounts as accounts_module
import entries
import ledger
import reassignment
from events.schemas import DEFAULT_ACCOUNT, Event, EventType


#: Three events with a **blank** ``account`` column — legal at the instant they
#: were imported, and stored under ``default`` by the rule then in force.
UNASSIGNED_CSV = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
    "2024-02-01,BUY,MSFT,Microsoft,5,380.00,2.50,,Initial purchase\n"
    "2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,2.40,Q1 2024 dividend\n"
)

ACCOUNTS_FILE = (
    "id,type,label\n"
    "pea,PEA,Plan d'épargne en actions\n"
    "cto,CTO,Compte-titres\n"
)


def _folder(tmp_path):
    folder = tmp_path / 'events'
    folder.mkdir(exist_ok=True)
    return folder


def _drop(store, tmp_path, body, name):
    folder = _folder(tmp_path)
    (folder / name).write_text(body, encoding='utf-8')
    ledger.sync_drop_folder(store, folder)


def _the_month_before_declaring(store, tmp_path):
    """The fabricated state: three imported events, all under ``default``."""
    _drop(store, tmp_path, UNASSIGNED_CSV, '2024.csv')
    assert reassignment.unassigned_events(store) == 3
    return store


def _accounts_of(store):
    return sorted(row[0] for row in store.query('SELECT account FROM event'))


# --------------------------------------------------------------------------- #
# The state, and the window that opens on it
# --------------------------------------------------------------------------- #

def test_the_blank_column_lands_under_the_seeded_row(store, tmp_path):
    """The rule in force at the import: blank means ``default`` (issue #698)."""
    _the_month_before_declaring(store, tmp_path)
    assert _accounts_of(store) == [DEFAULT_ACCOUNT] * 3


def test_reassignment_moves_every_unassigned_event_onto_the_declaration(
        store, tmp_path):
    _the_month_before_declaring(store, tmp_path)
    accounts_module.create_account(store, 'pea', 'PEA', 'Plan')

    with store.transaction():
        moved = reassignment.reassign_unassigned(store, 'pea')

    assert moved == 3
    assert _accounts_of(store) == ['pea'] * 3
    assert reassignment.unassigned_events(store) == 0


def test_the_imported_row_is_the_population(store, tmp_path):
    """Not *a row the app wrote*: the file was right under the rule then."""
    _the_month_before_declaring(store, tmp_path)
    sources = store.query(
        'SELECT count(*) FROM event WHERE source_id IS NOT NULL')[0][0]
    assert sources == 3

    accounts_module.create_account(store, 'pea', 'PEA', 'Plan')
    with store.transaction():
        reassignment.reassign_unassigned(store, 'pea')

    still_imported = store.query(
        'SELECT count(*) FROM event '
        'WHERE source_id IS NOT NULL AND account = ?', ['pea'])[0][0]
    assert still_imported == 3


def test_a_row_typed_here_carrying_default_goes_with_them(store, tmp_path):
    """One population, and it is the column's value — not the row's provenance."""
    _the_month_before_declaring(store, tmp_path)
    entries.create(store, Event(date(2024, 4, 1), EventType.BUY, 'AAPL',
                                'Apple Inc', quantity=1, unit_price=10.0))
    assert reassignment.unassigned_events(store) == 4

    accounts_module.create_account(store, 'pea', 'PEA', 'Plan')
    with store.transaction():
        assert reassignment.reassign_unassigned(store, 'pea') == 4


# --------------------------------------------------------------------------- #
# … and the window that never reopens
# --------------------------------------------------------------------------- #

def test_after_the_reassignment_nothing_moves_an_imported_row_again(
        store, tmp_path):
    """*Jamais ensuite* — and it is the ``WHERE`` that says so, not a flag."""
    _the_month_before_declaring(store, tmp_path)
    accounts_module.create_account(store, 'pea', 'PEA', 'Plan')
    accounts_module.create_account(store, 'cto', 'CTO', 'Titres')

    with store.transaction():
        reassignment.reassign_unassigned(store, 'pea')
    with store.transaction():
        again = reassignment.reassign_unassigned(store, 'cto')

    assert again == 0
    assert _accounts_of(store) == ['pea'] * 3


def test_an_imported_row_is_still_refused_by_the_row_level_gesture(
        store, tmp_path):
    """The exception is this module's alone: :mod:`entries` refuses as before."""
    _the_month_before_declaring(store, tmp_path)
    accounts_module.create_account(store, 'pea', 'PEA', 'Plan')
    with store.transaction():
        reassignment.reassign_unassigned(store, 'pea')

    (event_id,) = store.query(
        'SELECT id FROM event WHERE source_id IS NOT NULL LIMIT 1')[0]
    draft = Event(date(2024, 1, 15), EventType.BUY, 'AAPL', 'Apple Inc',
                  quantity=10, unit_price=150.0, account='cto')
    with pytest.raises(entries.ImportedEntry):
        entries.update(store, event_id, draft)


# --------------------------------------------------------------------------- #
# The bounds
# --------------------------------------------------------------------------- #

def test_the_seeded_row_is_not_a_target(store, tmp_path):
    _the_month_before_declaring(store, tmp_path)
    with pytest.raises(reassignment.NotReassignable):
        with store.transaction():
            reassignment.reassign_unassigned(store, DEFAULT_ACCOUNT)
    assert _accounts_of(store) == [DEFAULT_ACCOUNT] * 3


def test_an_undeclared_target_is_refused(store, tmp_path):
    _the_month_before_declaring(store, tmp_path)
    with pytest.raises(accounts_module.UnknownAccount):
        with store.transaction():
            reassignment.reassign_unassigned(store, 'pea')
    assert _accounts_of(store) == [DEFAULT_ACCOUNT] * 3


def test_nothing_declared_means_no_target_at_all(store, tmp_path):
    """The window opens **at** the first declaration, and never before it.

    Nothing states that as a second predicate: a target that is neither the
    seeded row nor an unknown id *is* a declaration, so the instant is the
    target's own existence.
    """
    _the_month_before_declaring(store, tmp_path)
    assert accounts_module.accounts_are_declared(store) is False
    for candidate in (DEFAULT_ACCOUNT, 'pea'):
        with pytest.raises((reassignment.NotReassignable,
                            accounts_module.UnknownAccount)):
            with store.transaction():
                reassignment.reassign_unassigned(store, candidate)


# --------------------------------------------------------------------------- #
# What it leaves behind
# --------------------------------------------------------------------------- #

def test_the_unassigned_line_disappears_from_the_declaration(store, tmp_path):
    """``default`` leaves ``declared_portfolio`` the moment nothing names it."""
    _the_month_before_declaring(store, tmp_path)
    accounts_module.create_account(store, 'pea', 'PEA', 'Plan')
    before = accounts_module.declared_portfolio(store)
    assert sorted(before.ids()) == ['default', 'pea']

    with store.transaction():
        reassignment.reassign_unassigned(store, 'pea')

    after = accounts_module.declared_portfolio(store)
    assert sorted(after.ids()) == ['pea']


def test_the_seeded_row_becomes_removable_again(store, tmp_path):
    """Not a promise the module makes — a consequence the owner can observe."""
    _the_month_before_declaring(store, tmp_path)
    accounts_module.create_account(store, 'pea', 'PEA', 'Plan')
    with store.transaction():
        reassignment.reassign_unassigned(store, 'pea')
    assert accounts_module.is_named_by_events(store, DEFAULT_ACCOUNT) is False


def test_the_ledger_it_leaves_is_replayed_before_the_commit(store, tmp_path):
    """:mod:`entries`' last assertion, for the same reason: a ledger that does
    not replay committed here fails the **boot**, in the gunicorn master."""
    _the_month_before_declaring(store, tmp_path)
    accounts_module.create_account(store, 'pea', 'PEA', 'Plan')
    with store.transaction():
        reassignment.reassign_unassigned(store, 'pea')

    from events import EventAggregator
    shares = EventAggregator().aggregate(ledger.read_events(store))
    assert {share['account'] for share in shares} == {'pea'}


def test_a_declaration_by_file_reaches_the_same_window(store, tmp_path):
    """The other road (issue #698): the accounts source declares, the event
    file is refused for its now-blank column, and the rows stay under
    ``default`` — which is the exact state this gesture exists for."""
    _the_month_before_declaring(store, tmp_path)
    _drop(store, tmp_path, ACCOUNTS_FILE, 'accounts.csv')

    assert accounts_module.accounts_are_declared(store) is True
    assert reassignment.unassigned_events(store) == 3

    with store.transaction():
        assert reassignment.reassign_unassigned(store, 'pea') == 3


# --------------------------------------------------------------------------- #
# … and the row that stopped being the seed
# --------------------------------------------------------------------------- #

def test_a_renamed_seed_is_a_declaration_and_its_events_are_assigned(
        store, tmp_path):
    """The N = 1 gesture #729 exists for, and it changes what these rows *are*.

    Renaming the seeded row is how an install with a page and no file declares
    its one account (``accounts_are_declared`` stays false — it counts rows
    beside ``default`` — so the blank column goes on meaning ``default``, which
    is right). What is no longer right is calling those events *unassigned*:
    they name the account their owner named, and moving them onto a second
    account declared later would take 285 events off the one line the owner
    themselves wrote a name on, irreversibly.
    """
    _the_month_before_declaring(store, tmp_path)
    accounts_module.update_account(store, DEFAULT_ACCOUNT, label='Mon PEA')

    assert reassignment.unassigned_events(store) == 0

    accounts_module.create_account(store, 'cto', 'CTO', 'Titres')
    with store.transaction():
        assert reassignment.reassign_unassigned(store, 'cto') == 0
    assert _accounts_of(store) == [DEFAULT_ACCOUNT] * 3


def test_a_retyped_seed_is_a_declaration_too(store, tmp_path):
    """The other seeded column, and it is one rule on both (``as_declared``)."""
    _the_month_before_declaring(store, tmp_path)
    accounts_module.update_account(store, DEFAULT_ACCOUNT, account_type='PEA')

    assert reassignment.unassigned_events(store) == 0


def test_a_file_that_took_the_seeded_row_over_declares_it(store, tmp_path):
    """#698 lets a file name ``default`` and take it over; that is a
    declaration like any other, and its events are assigned."""
    _the_month_before_declaring(store, tmp_path)
    _drop(store, tmp_path,
          "id,type,label\ndefault,PEA,Mon PEA\npea,PEA,Second\n", 'accounts.csv')

    assert reassignment.unassigned_events(store) == 0
    with store.transaction():
        assert reassignment.reassign_unassigned(store, 'pea') == 0


def test_the_seed_wearing_the_seed_s_own_words_is_not_a_declaration(
        store, tmp_path):
    """The other edge: an owner may legitimately name their account exactly
    what the seed named it, and the comparison is all the store's lack of
    migration machinery leaves (``accounts.as_declared``). Untouched, the row
    is the one nobody declared and its events are the ones to move."""
    _the_month_before_declaring(store, tmp_path)
    assert reassignment.unassigned_events(store) == 3
