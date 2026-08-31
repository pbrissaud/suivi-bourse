"""The one writer of the ledger, and the gestures a row earns (#764, #816).

The seam is :mod:`test_ledger`'s: a **real** DuckDB store in ``tmp_path`` and
every assertion a ``SELECT`` against it — never the fact that a function was
called.

What this file was about was the **population**, and since #816 there is one.
A row a file laid down and a row somebody typed are the same row: one writer
wrote them, they carry the same columns, and the three gestures that address a
row by its key reach both. So the tests that used to prove the *split* prove its
absence instead — an uploaded row is corrected and removed exactly like a typed
one, which is ADR-0032's whole point and this ticket's own seam.
"""
from datetime import date

import pytest

from application import accounts as accounts_module
from application import entries
from application import ledger
from application.events import EventLoader
from application.events import export as events_export
from application.events.aggregator import AggregationError
from application.events.schemas import Event, EventType


ONE_BUY = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
)

#: Two more rows of the same file, so a gesture on one line can be shown to
#: leave the others exactly where they were — which is story 14's whole point.
TWO_MORE = (
    "2024-02-15,BUY,MSFT,Microsoft,4,380.00,2.50,,Second\n"
    "2024-03-15,BUY,MSFT,Microsoft,1,390.00,2.50,,Third\n"
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


def _upload(store, tmp_path, body=ONE_BUY, name='2024.csv'):
    """One file into the store, by the road ``POST /api/events/import`` takes.

    :func:`entries.create_many` is what the route calls, so what lands here is
    what an upload lands — and nothing about these rows says they arrived in
    company.
    """
    path = tmp_path / name
    path.write_text(body, encoding='utf-8')
    return entries.create_many(store, EventLoader(str(path)).load())


def _declare(store, account_id='pea', account_type='PEA',
             label="Plan d'épargne en actions"):
    """One account, declared the way the app declares it (ADR-0034)."""
    return accounts_module.create_account(store, account_id, account_type,
                                          label)


# --------------------------------------------------------------------------- #
# What a typed row is, and is not
# --------------------------------------------------------------------------- #

def test_a_row_carries_no_provenance_at_all(store):
    """There is no column left to carry one (ADR-0032, #816).

    Asserted on the **schema** and not on a value: three provenance columns all
    reading ``NULL`` is what a typed row used to be, and what this states is that
    the columns are gone — so nothing can put a value back into them.
    """
    created = entries.create(store, _draft())

    columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'event'")}
    assert columns.isdisjoint({'source_id', 'source_sheet', 'source_row'})
    assert created.id is not None


def test_the_name_comes_off_the_ledger_or_falls_back(store, tmp_path):
    """The form never asks for it: a name is the security's, not the event's.

    Left ``NULL`` the row would fail ``EventValidator``'s *name is required* on
    the next build — i.e. a boot nobody can repair from an app that is down.
    """
    _upload(store, tmp_path)

    entries.create(store, _draft())
    entries.create(store, _draft(symbol='MSFT'))

    assert set(store.query(
        'SELECT symbol, name FROM event WHERE notes = ?',
        ['Typed here'])) == {('AAPL', 'Apple Inc'), ('MSFT', 'MSFT')}


def test_a_blank_account_is_the_seeded_bucket(store):
    """One expression and no branch — ``event.account or DEFAULT_ACCOUNT``."""
    entries.create(store, _draft(account=''))

    assert store.query('SELECT account FROM event') == [('default',)]


def test_a_blank_account_is_refused_once_something_is_declared(store, tmp_path):
    """#698's rule, and it has to fire on **both** roads or there are two.

    A blank ``account`` means ``default`` until something is declared and is an
    error afterwards. Resolving the blank before the validator runs is how this
    gesture would lose the case: the same row inside a file is refused whole, and
    an install that declared ``pea`` would grow the phantom ``default`` the rule
    exists against.
    """
    _declare(store)

    for blank in (None, '', '   '):
        with pytest.raises(entries.InvalidEntry) as refusal:
            entries.create(store, _draft(account=blank))
        assert refusal.value.field == 'account'

    assert store.query('SELECT count(*) FROM event') == [(0,)]
    assert store.query(
        "SELECT count(*) FROM account WHERE id = 'default'") == [(1,)]


def test_a_whole_file_is_refused_for_that_same_blank(store, tmp_path):
    """One product, one rule — and a file is refused **whole** for it.

    The comparison the test above is only half of, and since #816 it is the same
    function refusing on both sides: nothing is written, the other rows the file
    carried included.
    """
    _declare(store)

    with pytest.raises(entries.InvalidEntry) as refusal:
        _upload(store, tmp_path, body=ONE_BUY + TWO_MORE)

    assert refusal.value.field == 'account'
    assert store.query('SELECT count(*) FROM event') == [(0,)]


def test_a_declared_account_is_written_as_it_was_named(store, tmp_path):
    """The refusal above is about the blank, never about naming an account."""
    _declare(store)

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
    boot, and a boot that fails is fatal.
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

def test_an_uploaded_row_is_corrected_and_removed_like_any_other(store, tmp_path):
    """**The ticket's seam** (ADR-0032, #816, stories 13 and 14).

    A row a file laid down used to be refused by both gestures — ``409``, naming
    the import to forget — so a typo in one line cost the revocation of every
    other line of the file. It is corrected in place now, and removed on its own,
    and the two rows beside it are not consulted.
    """
    _upload(store, tmp_path, body=ONE_BUY + TWO_MORE)
    keys = [row[0] for row in store.query('SELECT id FROM event ORDER BY id')]
    assert len(keys) == 3

    entries.update(store, keys[0],
                   _draft(date=date(2024, 1, 15), quantity=12.0))
    assert store.query(
        'SELECT quantity FROM event WHERE id = ?', [keys[0]]) == [(12.0,)]

    entries.remove(store, keys[0])
    assert [row[0] for row in
            store.query('SELECT id FROM event ORDER BY id')] == keys[1:]


def test_an_unknown_id_is_its_own_refusal(store):
    """*No such row* is the one thing a gesture on a key is refused for."""
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


def test_a_draft_cannot_choose_its_own_key(store):
    """The store decides the address of a row, never the caller.

    ``id`` is stripped on the way in, so a body naming one does not overwrite the
    row that already answers to it: it lands as the next row, like every other.
    """
    first = entries.create(store, _draft())
    second = entries.create(store, _draft(id=first.id, quantity=3.0))

    assert second.id != first.id
    assert store.query('SELECT count(*) FROM event') == [(2,)]


def test_this_module_is_the_writer_of_the_event_table(store, tmp_path):
    """**Criterion 4 of #816**, checked on the source rather than promised.

    Every ``INSERT INTO event`` / ``UPDATE event`` / ``DELETE FROM event`` in
    the two source packages is below, or in :mod:`reassignment` — which is the **named, bounded
    exception** ADR-0032 keeps by name: it rewrites one column in bulk, it
    addresses no row by its key, and it is a module of its own precisely so that
    a reader counting the writers finds it. What is gone is the *second* writer:
    :mod:`ledger` wrote whole files in and whole files out, and the sentence
    *"the import path has no row-level write"* was a rule two modules had to keep
    true between them. There is one population now, so there is nothing left for
    it to be true about.

    The surface below is the second half of the same statement: five gestures and
    three forecasts, and **no exception among them named after where a row came
    from**. ``ImportedEntry`` was the sixth name here and it is not one any more.
    """
    import re
    from pathlib import Path

    # The two packages by name, never `src/` itself: the front lives there too
    # and walking it would walk `node_modules`.
    src = Path(__file__).resolve().parents[1] / 'src'
    pattern = re.compile(
        r"(?:INSERT INTO event|UPDATE event|DELETE FROM event)\b")
    writers = sorted(path.relative_to(src).as_posix()
                     for package in ('application', 'api')
                     for path in (src / package).rglob('*.py')
                     if pattern.search(path.read_text()))

    assert writers == ['application/entries.py', 'application/reassignment.py']
    assert set(entries.__all__) == {
        'DUPLICATE_KEY_COLUMNS', 'AMOUNT_PRECISION',
        'UnknownEntry', 'InvalidEntry', 'Duplicate',
        'create', 'create_many', 'update', 'remove', 'remove_selection',
        'content_key', 'split_duplicates', 'judge'}


# --------------------------------------------------------------------------- #
# The bulk removal: the reduction is the subject, and the row's origin is not
# --------------------------------------------------------------------------- #

def test_the_bulk_removal_takes_an_uploaded_row_like_any_other(store, tmp_path):
    """The whole of ADR-0032's *the removal is the gesture*.

    Undoing an import reaches the rows the import laid down without asking any of
    them where they came from. The typed row beside them is untouched, so what is
    asserted is the **reduction** and not *everything*.
    """
    _upload(store, tmp_path)
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
    every reload, and that raise is fatal at boot.
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


def test_the_workbook_the_app_exports_re_imports_as_duplicates(store,
                                                               tmp_path):
    """The app's own ``.xlsx``, handed straight back, is recognised as itself.

    The round trip through the real file: the ledger goes out through
    :func:`events.export.render_events_workbook` — the bytes
    ``GET /api/export/events.xlsx`` answers — and comes back through
    :class:`events.loader.EventLoader`, the road ``POST /api/events/import``
    takes. Nothing here is simulated; the workbook is written and parsed.

    ``openpyxl`` serializes a double as ``%.16g``, so a broker's
    ``0.34898399999999996`` leaves as ``0.348984``. Read exactly, the key missed
    on all four of its numeric members and the import answered **0 duplicates**
    over a file it had just written itself — then wrote a second, subtly
    different copy of the whole ledger, into the one table the positions, the
    prices and the curves are all derived from. The four members are covered on
    purpose: ``quantity`` and ``unit_price`` on the purchase, ``amount`` and
    ``fee`` on the dividend.
    """
    entries.create(store, _draft(
        quantity=0.34898399999999996, unit_price=1234.5678901234567, fee=2.5))
    entries.create(store, _draft(
        date=date(2024, 6, 10), event_type=EventType.DIVIDEND, quantity=None,
        unit_price=None, amount=8.499999999999998,
        fee=0.30000000000000004))
    held = ledger.read_events(store)

    workbook = tmp_path / 'events.xlsx'
    workbook.write_bytes(events_export.render_events_workbook(held, 'EUR'))
    returned = EventLoader(str(workbook)).load()
    fresh, duplicates = entries.split_duplicates(store, returned)

    assert len(returned) == 2
    assert [duplicate.held.id for duplicate in duplicates] == [1, 2]
    assert fresh == []
    entries.create_many(store, fresh)
    assert store.query('SELECT count(*) FROM event') == [(2,)]


def test_the_key_still_separates_two_amounts_a_double_can_tell_apart(store):
    """The other half: canonical is not tolerant (:data:`AMOUNT_PRECISION`).

    Sixteen significant digits is the export's precision and not a slack around
    a number, so two amounts that differ anywhere the file can carry the
    difference stay two facts — down to the last digit ``%.16g`` writes.
    """
    assert entries.content_key(_draft(unit_price=1234.567890123456)) != \
        entries.content_key(_draft(unit_price=1234.567890123457))
    assert entries.content_key(_draft(fee=0.348984)) != \
        entries.content_key(_draft(fee=0.348985))
    assert entries.content_key(_draft(quantity=None)) != \
        entries.content_key(_draft(quantity=0.0))


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
