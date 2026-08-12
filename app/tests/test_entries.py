"""The event somebody typed here, and the three gestures it earns (issue #764).

The seam is :mod:`test_ledger`'s: a **real** DuckDB store in ``tmp_path``, the
real ingestion beside it, and every assertion a ``SELECT`` against the store —
never the fact that a function was called.

What this file is about is the **population**, because that is the whole of what
the ticket settles. :mod:`ledger` writes rows a file provisioned and offers no
row-level gesture on them, on purpose (#697). :mod:`entries` writes rows nobody
provisioned and offers three, on purpose (ADR-0005: the create form is the
onboarding, so a typo in it must not be permanent). Each test below names which
of the two it is looking at.
"""
from datetime import date

import pytest

import entries
import ledger
from events.aggregator import AggregationError
from events.schemas import Event, EventType


ONE_BUY = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
)


def _draft(**overrides) -> Event:
    """A draft in the shape the create form sends — **no name** (ADR-0020)."""
    fields = {
        'date': date(2024, 6, 3),
        'event_type': EventType.BUY,
        'symbol': 'AAPL',
        'quantity': 2.0,
        'unit_price': 100.0,
        'fee': 1.0,
        'notes': 'Typed here',
    }
    fields.update(overrides)
    return Event(**fields)


def _drop(store, tmp_path, body=ONE_BUY, name='2024.csv'):
    folder = tmp_path / 'events'
    folder.mkdir(exist_ok=True)
    (folder / name).write_text(body, encoding='utf-8')
    ledger.sync_drop_folder(store, folder)


# --------------------------------------------------------------------------- #
# What a typed row is, and is not
# --------------------------------------------------------------------------- #

def test_a_typed_row_carries_no_provenance_at_all(store):
    """``source_id NULL`` is what *created in the app* **is** (spec #695 § 6).

    The same column that makes it editable, and the same one the export
    deliberately does not carry (#710).
    """
    created = entries.create(store, _draft())

    assert store.query(
        'SELECT source_id, source_sheet, source_row FROM event') == [
            (None, None, None)]
    assert created.id is not None
    assert created.source_id is None


def test_the_name_comes_off_the_ledger_or_falls_back(store, tmp_path):
    """The form never asks for it: a name is the security's, not the event's.

    Left ``NULL`` the row would fail ``EventValidator``'s *name is required* on
    the next build — in the gunicorn master, i.e. a boot nobody can repair from
    an app that is down.
    """
    _drop(store, tmp_path)

    entries.create(store, _draft())
    entries.create(store, _draft(symbol='MSFT'))

    assert set(store.query(
        'SELECT symbol, name FROM event WHERE source_id IS NULL')) == {
            ('AAPL', 'Apple Inc'), ('MSFT', 'MSFT')}


def test_a_blank_account_is_the_seeded_bucket(store):
    """One expression, no branch — :func:`ledger._insert_events`' own rule."""
    entries.create(store, _draft(account=''))

    assert store.query('SELECT account FROM event') == [('default',)]


def test_the_security_gets_its_row_before_the_event_references_it(store):
    """``event.symbol`` has a foreign key; the ingestion is what satisfies it."""
    entries.create(store, _draft(symbol='NVDA'))

    assert store.query('SELECT symbol FROM symbol') == [('NVDA',)]


def test_a_typed_row_is_read_back_with_its_key(store):
    """:func:`ledger.read_events` carries ``event.id``, which is the address."""
    created = entries.create(store, _draft())

    (event,) = ledger.read_events(store)
    assert event.id == created.id
    assert event.source_filename is None


# --------------------------------------------------------------------------- #
# Nothing is written when anything refuses
# --------------------------------------------------------------------------- #

def test_a_refused_event_leaves_no_row_behind(store):
    """The single-row check, the write and the replay are one transaction."""
    with pytest.raises(entries.InvalidEntry) as refusal:
        entries.create(store, _draft(unit_price=None))

    assert refusal.value.field == 'unit_price'
    assert store.query('SELECT count(*) FROM event') == [(0,)]
    # Not even the symbol row it would have needed.
    assert store.query('SELECT count(*) FROM symbol') == [(0,)]


def test_the_refusal_carries_the_validator_s_own_sentence(store):
    """One owner, or a typed event and an imported one obey two products."""
    with pytest.raises(entries.InvalidEntry) as refusal:
        entries.create(store, _draft(event_type=EventType.DEPOSIT,
                                     amount=100.0))

    # A cash event carries no share: the validator's words, and its field.
    assert 'cash events carry no share' in str(refusal.value)
    assert refusal.value.field == 'symbol'


def test_an_insertion_that_oversells_is_refused_by_the_replay(store):
    """Overselling is a property of the ledger, not of the row.

    So the row is legal on its own and the ledger it would make is not — which
    is the assertion :func:`ledger.import_file` makes at the end of its own
    transaction, for the same reason.
    """
    entries.create(store, _draft(quantity=1.0))

    with pytest.raises(AggregationError):
        entries.create(store, _draft(date=date(2024, 6, 10),
                                     event_type=EventType.SELL, quantity=9.0))

    assert store.query('SELECT count(*) FROM event') == [(1,)]


def test_a_removal_that_oversells_is_refused_the_same_way(store):
    """The same fact from the other side: taking a purchase away.

    Without it the store would be left holding a ledger that fails the next
    boot, and the boot is fatal in the gunicorn master.
    """
    bought = entries.create(store, _draft(quantity=10.0))
    entries.create(store, _draft(date=date(2024, 6, 10),
                                 event_type=EventType.SELL, quantity=10.0,
                                 unit_price=120.0))

    with pytest.raises(AggregationError):
        entries.remove(store, bought.id)

    assert store.query('SELECT count(*) FROM event') == [(2,)]


# --------------------------------------------------------------------------- #
# The population: what came from a file is refused by name
# --------------------------------------------------------------------------- #

def test_an_imported_row_is_refused_and_the_refusal_names_it(store, tmp_path):
    """Read-only is unchanged for the rows it was written for (#697).

    The refusal carries the file **and** the source id, because the gesture the
    owner has instead is forgetting that import — and a page linking to it needs
    the id rather than a sentence to re-parse.
    """
    _drop(store, tmp_path)
    ((key,),) = store.query('SELECT id FROM event')

    with pytest.raises(entries.ImportedEntry) as refusal:
        entries.update(store, key, _draft())
    assert refusal.value.filename == '2024.csv'
    assert refusal.value.source_id is not None

    with pytest.raises(entries.ImportedEntry):
        entries.remove(store, key)

    assert store.query('SELECT count(*) FROM event') == [(1,)]


def test_an_unknown_id_is_its_own_refusal(store):
    """*No such row* and *this row came from a file* are two pieces of news."""
    with pytest.raises(entries.UnknownEntry):
        entries.remove(store, 9999)


# --------------------------------------------------------------------------- #
# The rewrite
# --------------------------------------------------------------------------- #

def test_an_update_rewrites_the_whole_row(store):
    """An event's fields are not independent: a merge leaves a row nobody typed.

    Turning a purchase into a transfer must take the quantity with it — the
    validator refuses a cash event carrying one, so a partial patch would write
    a ledger that fails the next build.
    """
    created = entries.create(store, _draft())

    entries.update(store, created.id,
                   Event(date=date(2024, 6, 4),
                         event_type=EventType.DEPOSIT, amount=500.0,
                         notes='Virement'))

    assert store.query(
        'SELECT event_type, symbol, quantity, amount FROM event') == [
            ('DEPOSIT', None, None, 500.0)]


def test_an_update_cannot_forge_a_provenance(store, tmp_path):
    """The store decides where a row came from, never the caller.

    A draft carrying a ``source_id`` is not a row that becomes read-only: those
    members are stripped on the way in, which is what keeps *"a row that carries
    a provenance came from a file"* (ADR-0020) a true statement rather than a
    convention a client could break.
    """
    _drop(store, tmp_path)
    ((source_id,),) = store.query('SELECT id FROM import_source')
    created = entries.create(store, _draft(source_id=source_id,
                                           source_row=7, id=1))

    assert store.query(
        'SELECT source_id, source_row FROM event WHERE id = ?',
        [created.id]) == [(None, None)]


def test_the_module_writes_only_rows_it_may_write(store, tmp_path):
    """The split is structural, and this is the assertion of it on the surface.

    Every gesture goes through the same refusal, so no future caller can reach
    an imported row by picking a different entry point.
    """
    _drop(store, tmp_path)
    ((imported,),) = store.query('SELECT id FROM event')

    for gesture in (lambda: entries.update(store, imported, _draft()),
                    lambda: entries.remove(store, imported)):
        with pytest.raises(entries.ImportedEntry):
            gesture()

    assert set(entries.__all__) == {
        'UnknownEntry', 'ImportedEntry', 'InvalidEntry',
        'create', 'update', 'remove'}
