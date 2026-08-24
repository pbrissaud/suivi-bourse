"""The event somebody typed here, and the gestures it earns (issue #764).

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
from events import export as events_export
from events.aggregator import AggregationError
from events.schemas import Event, EventType


ONE_BUY = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
)

#: An accounts source (issue #698) — what turns a blank ``account`` column from
#: *means default* into an error, on both roads.
ACCOUNTS_FILE = (
    "id,type,label\n"
    "pea,PEA,Plan d'épargne en actions\n"
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


def test_a_blank_account_is_refused_once_something_is_declared(store, tmp_path):
    """#698's rule, and it has to fire on **both** roads or there are two.

    A blank ``account`` means ``default`` until something is declared and is an
    error afterwards. Resolving the blank before the validator runs is how this
    road loses the case: the file path refuses the same row whole, and an install
    that declared ``pea`` grows the phantom ``default`` the rule exists against.
    """
    _drop(store, tmp_path, body=ACCOUNTS_FILE, name='accounts.csv')

    for blank in (None, '', '   '):
        with pytest.raises(entries.InvalidEntry) as refusal:
            entries.create(store, _draft(account=blank))
        assert refusal.value.field == 'account'

    assert store.query('SELECT count(*) FROM event') == [(0,)]
    assert store.query(
        "SELECT count(*) FROM account WHERE id = 'default'") == [(1,)]


def test_the_file_road_refuses_that_same_blank(store, tmp_path):
    """The comparison the test above is only half of — one product, one rule."""
    _drop(store, tmp_path, body=ACCOUNTS_FILE, name='accounts.csv')
    _drop(store, tmp_path, body=ONE_BUY, name='2024.csv')

    assert store.query('SELECT count(*) FROM event') == [(0,)]


def test_a_declared_account_is_written_as_it_was_named(store, tmp_path):
    """The refusal above is about the blank, never about naming an account."""
    _drop(store, tmp_path, body=ACCOUNTS_FILE, name='accounts.csv')

    created = entries.create(store, _draft(account='pea'))

    assert store.query('SELECT account FROM event') == [('pea',)]
    assert created.account == 'pea'


def test_an_undeclared_account_is_refused_by_name(store):
    """The other half of ``_validate_account``, and it fires in every install."""
    with pytest.raises(entries.InvalidEntry) as refusal:
        entries.create(store, _draft(account='pea'))

    assert refusal.value.field == 'account'
    assert store.query('SELECT count(*) FROM event') == [(0,)]


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

    Every gesture that **addresses one row by its key** goes through the same
    refusal, so no future caller can reach an imported row by picking a
    different entry point.

    ``create_many`` joins the surface at #811 and needs no refusal of its own:
    it only ever **inserts**, and what it inserts carries ``source_id NULL`` like
    everything else here. ``remove_selection`` joins it at #814 and is the one
    name deliberately outside the split (ADR-0032): its subject is the
    reduction, it addresses no key, and it is asserted just below on what it
    does rather than on a refusal it does not make. What would break the split
    is a *sixth* name addressing a row by its key, which is what this set is
    here to notice.

    The forecast's three names join it at #813 and are outside the split for a
    reason stronger than ``remove_selection``'s: they address no row **and write
    none**. ``content_key`` is a pure function of one event, ``split_duplicates``
    reads the ledger, and ``judge`` runs the two refusals over a list — a
    ``?dry_run=1`` that had left a row behind would fail this file's own
    subject, so they are listed here to be counted rather than to be excused.
    """
    _drop(store, tmp_path)
    ((imported,),) = store.query('SELECT id FROM event')

    for gesture in (lambda: entries.update(store, imported, _draft()),
                    lambda: entries.remove(store, imported)):
        with pytest.raises(entries.ImportedEntry):
            gesture()

    assert set(entries.__all__) == {
        'DUPLICATE_KEY_COLUMNS',
        'UnknownEntry', 'ImportedEntry', 'InvalidEntry',
        'create', 'create_many', 'update', 'remove', 'remove_selection',
        'content_key', 'split_duplicates', 'judge'}


# --------------------------------------------------------------------------- #
# The bulk removal: the reduction is the subject, and the row's origin is not
# --------------------------------------------------------------------------- #

def test_the_bulk_removal_takes_an_imported_row_like_any_other(store, tmp_path):
    """What ``update`` and ``remove`` refuse by name, this one simply removes.

    The whole of ADR-0032's *the removal is the gesture*: undoing an import has
    to reach the rows the import laid down, and a bulk delete that stopped at
    each of them would leave the reader exactly where losing ``forget_import``
    put them. The typed row beside it is untouched, so what is asserted is the
    **reduction** and not *everything*.
    """
    _drop(store, tmp_path)
    entries.create(store, _draft(date=date(2024, 8, 1), symbol='MSFT'))

    removed = entries.remove_selection(
        store, events_export.Selection(symbols=('AAPL',)))

    assert removed == 1
    assert store.query('SELECT symbol FROM event') == [('MSFT',)]


def test_a_reduction_that_retains_nothing_removes_nothing(store):
    """Zero is a state, not a complaint — the export's empty file, one road over."""
    entries.create(store, _draft())

    assert entries.remove_selection(
        store, events_export.Selection(account='zzz')) == 0
    assert store.query('SELECT count(*) FROM event') == [(1,)]


def test_a_bulk_removal_that_would_oversell_is_refused_whole(store):
    """A reduction can take the purchases and leave the sales (issue #814).

    The single-row refusal on a wider perimeter, and it has to roll back the
    **whole** reduction: a ledger committed half-deleted is one that raises on
    every reload, and that raise is fatal in the gunicorn master.
    """
    entries.create(store, _draft(quantity=10.0))
    entries.create(store, _draft(date=date(2024, 6, 10),
                                 event_type=EventType.SELL, quantity=10.0,
                                 unit_price=120.0))

    with pytest.raises(AggregationError):
        entries.remove_selection(
            store, events_export.Selection(event_type='BUY'))

    assert store.query('SELECT count(*) FROM event') == [(2,)]


# --------------------------------------------------------------------------- #
# The duplicate key: at the import, and in no constraint anywhere (#813)
# --------------------------------------------------------------------------- #

def test_the_duplicate_key_is_the_eight_members_and_not_the_other_two(store):
    """``name`` and ``notes`` are out, and that is the whole decision.

    Asserted on the function rather than through a file, because it is the one
    place the rule is *stated*: two events differing only in what a reader wrote
    on them key alike, and two differing in any of the eight do not.
    """
    typed = _draft()

    assert entries.content_key(typed) == entries.content_key(
        _draft(name='Apple Incorporated', notes='ordre du matin'))
    for member in ('quantity', 'unit_price', 'fee'):
        assert entries.content_key(typed) != entries.content_key(
            _draft(**{member: 999.0}))
    assert entries.content_key(typed) != entries.content_key(
        _draft(date=date(2024, 6, 4)))
    assert entries.content_key(typed) != entries.content_key(
        _draft(symbol='MSFT'))


def test_a_blank_account_keys_as_the_default_row_it_becomes(store):
    """The one member the key resolves instead of reading.

    A draft with no account is written as ``default``; read back out of the
    store it says ``default``. The key has to see one thing there or a stored
    row would never match the file it came from.
    """
    created = entries.create(store, _draft(account=None))
    (read_back,) = ledger.read_events(store)

    assert created.account == 'default'
    assert entries.content_key(_draft(account=None)) == \
        entries.content_key(read_back)
    assert entries.content_key(_draft(account='  ')) == \
        entries.content_key(read_back)


def test_the_split_reads_the_ledger_and_the_file_and_writes_nothing(store):
    """``(fresh, duplicates)`` partitions the file, and the store is untouched.

    Three drafts against a ledger holding the first: one is already there, one
    repeats a line of the file itself, one is new. The partition is exhaustive —
    nothing is dropped between the two lists — and no row is written by asking.
    """
    entries.create(store, _draft())
    repeated = _draft(date=date(2024, 7, 1), symbol='MSFT')

    fresh, duplicates = entries.split_duplicates(
        store, [_draft(), repeated, repeated])

    assert len(fresh) == 1 and len(duplicates) == 2
    assert fresh[0].symbol == 'MSFT'
    assert store.query('SELECT count(*) FROM event') == [(1,)]


def test_two_strictly_identical_typed_events_both_land(store):
    """An order filled twice stays recordable **from the keyboard** (story 7).

    The reason the key is not a constraint, asserted where the constraint would
    have bitten: :func:`entries.create` asks nothing about duplicates, and the
    ledger carries the two rows with two keys of its own.
    """
    first = entries.create(store, _draft())
    second = entries.create(store, _draft())

    assert first.id != second.id
    assert store.query('SELECT count(*) FROM event') == [(2,)]
    assert entries.content_key(first) == entries.content_key(second)


def test_the_duplicate_key_is_declared_in_no_constraint_of_the_store(store):
    """The criterion, read off a **real** store rather than off a string.

    DuckDB publishes what it was actually asked to enforce, so this is the
    schema answering rather than the DDL's text: the ``event`` table has exactly
    one uniqueness constraint, it is the surrogate primary key, and none of the
    eight members of the content key takes part in one. A `UNIQUE` over them
    would make an order filled twice impossible to record at all.
    """
    enforced = store.query(
        "SELECT constraint_type, constraint_column_names "
        "FROM duckdb_constraints() WHERE table_name = 'event' "
        "AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')")

    assert enforced == [('PRIMARY KEY', ['id'])]
    keyed = {column for _, columns in enforced for column in columns}
    assert keyed.isdisjoint(entries.DUPLICATE_KEY_COLUMNS)
