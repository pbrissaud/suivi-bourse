"""
The store: its shape, its seed, and the two rules the shape encodes (#696).

Everything here runs against a **real DuckDB file** in ``tmp_path`` — the
``store`` fixture — because the store is embedded and mocking it would mock half
the product. Nothing reads or writes domain rows yet; what is pinned is what the
tickets that follow will build on and could silently break:

* the fifteen tables exist on a brand-new file, and a second boot on the same
  file adds nothing to it — nor does it re-run a schema step (#926);
* ``price_point`` carries no key of any kind while the others keep theirs
  — a primary key here costs +563 MB of *resident* memory on a 319 MB
  base, because a DuckDB ART index is a second copy whose buffers the buffer
  manager does not own;
* an observed instant is ``TIMESTAMPTZ`` and a calendar day is ``DATE``, never
  the reverse — and the connection is pinned to UTC, which the type does not
  buy: a bare literal is read in the *host's* zone;
* a setting absent from the table reads as the code's default, and
  the boot completes the table without ever overwriting an answer.
"""

from datetime import date
import time
from pathlib import Path

import duckdb
import pytest

from application import settings_registry
from application import store as store_module


# --------------------------------------------------------------------------- #
# A fresh file, and a second boot on it
# --------------------------------------------------------------------------- #

def test_a_new_file_carries_the_fifteen_tables(store):
    assert sorted([row[0] for row in store.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'")]) == sorted(store_module.TABLES)
    # **Fifteen since #926** — ``schema_step``, which is the one table that is
    # about the store rather than about the portfolio: it says what generation
    # this file is. The fourteenth was #752's ``account_fact``.
    assert len(store_module.TABLES) == 15


def test_a_new_file_declares_no_provenance_at_all(store):
    """**Criterion 2 of #816**, on a store the DDL has just created.

    ``import_source`` existed because a mounted file was re-read and had to be
    named to be revoked; the three columns on ``event`` existed to point at it.
    A file is a payload now, so a fresh store declares neither. An older store
    kept them as inert residue that nothing reads and nothing writes, and #926
    wrote no step for them — but the three on ``event`` went all the same, swept
    up by ``drop_account_type``: that step rebuilds ``event`` from the current
    DDL, and a table recreated from the DDL is the DDL's table.
    ``account.source_id`` survives, because ``account`` is altered rather than
    rebuilt. The asymmetry is real and costs nothing: nobody reads either.
    """
    assert 'import_source' not in [row[0] for row in store.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'")]

    columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'event'")}
    assert columns.isdisjoint({'source_id', 'source_sheet', 'source_row'})
    # And nothing in the DDL text mentions the table either, so no foreign key
    # can be pointing at one that is not created.
    assert 'import_source' not in store_module.DDL


def test_a_new_file_declares_no_provenance_on_an_account_either(store):
    """``account.source_id`` said which accounts file had declared a row; there is
    no accounts file, so a fresh store declares no such column.

    On an **older** store it survives as inert residue, and since #926 that is
    a decision rather than a fatality: a schema step could drop it, and none
    does, because nobody reads it and a step that buys nothing is a step that
    can only cost. The column ``type`` is the one that earned a step — it was
    ``NOT NULL``, so the writer had to keep feeding it a word no reader had.
    """
    columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'account'")}
    assert columns == {'id', 'label'}
    assert 'source_id' not in store_module.DDL


def test_a_new_file_is_seeded_with_the_default_account(store):
    rows = store.query('SELECT id, label FROM account')

    assert rows == [store_module.DEFAULT_ACCOUNT_ROW]


def test_a_new_file_is_seeded_with_every_dial_that_has_a_default(store):
    stored = dict(store.query('SELECT key, value FROM setting'))

    assert stored == settings_registry.seeded_defaults()
    # ... and the one dial with no default is absent rather than guessed. The
    # reporting currency is asked, and "not answered yet" has to stay a state:
    # a default would silently interpret every amount already imported.
    assert 'base_currency' not in stored


def test_a_second_boot_on_the_same_file_duplicates_nothing(store, tmp_path):
    """Idempotence is what makes "a new dial needs no step" true.

    The DDL, the account seed and the settings completion all run again at every
    start; if any of them wrote a second time, the account table would grow a
    row per restart and the answer a human gave would be overwritten by the
    code's default.
    """
    store.execute("UPDATE setting SET value = '600' WHERE key = 'regular_interval'")
    store.close()

    reopened = store_module.open_store(tmp_path / 'store.duckdb')
    try:
        assert sorted([row[0] for row in reopened.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'")]) == sorted(store_module.TABLES)
        assert reopened.query('SELECT count(*) FROM account') == [(1,)]
        assert reopened.query('SELECT count(*) FROM setting') == \
            [(len(settings_registry.seeded_defaults()),)]
        # The edited value survived: completing the table is an insert of what
        # is missing, never an upsert of what is there.
        assert reopened.setting('regular_interval') == 600
    finally:
        reopened.close()


def test_a_dial_added_later_is_inserted_without_a_step(store, tmp_path,
                                                       monkeypatch):
    """The whole point of seeding at every boot rather than at creation.

    Schema steps exist since #926 and this is still not one of them: completing
    the settings table at every boot already makes a later dial an insert. A
    mechanism being available is not a reason to route through it.
    """
    store.close()
    monkeypatch.setitem(settings_registry.BY_KEY, 'a_later_dial',
                        settings_registry.SettingSpec(
                            'a_later_dial', '7', settings_registry.INTEGER, int,
                            settings_registry.NEXT_CYCLE,
                            'added in a later version'))
    monkeypatch.setattr(
        settings_registry, 'SETTINGS',
        settings_registry.SETTINGS + (settings_registry.BY_KEY['a_later_dial'],))

    reopened = store_module.open_store(tmp_path / 'store.duckdb')
    try:
        assert reopened.setting('a_later_dial') == 7
    finally:
        reopened.close()


def test_the_default_account_is_not_resurrected_at_the_next_boot(store, tmp_path):
    """Seeded at creation, and only there — a deletion is a decision."""
    store.execute("DELETE FROM account WHERE id = 'default'")
    store.close()

    reopened = store_module.open_store(tmp_path / 'store.duckdb')
    try:
        assert reopened.query('SELECT count(*) FROM account') == [(0,)]
    finally:
        reopened.close()


# --------------------------------------------------------------------------- #
# The constraints, and the one table that has none
# --------------------------------------------------------------------------- #

def _constraints(store):
    return store.query(
        "SELECT table_name, constraint_type FROM duckdb_constraints() "
        "WHERE constraint_type <> 'NOT NULL'")


def test_price_point_carries_no_key_at_all(store):
    """The measured asymmetry of the schema, asserted rather than commented.

    A primary key on this table is +563 MB of resident memory on a 319 MB base
    and a 15× slower rebuild, because a DuckDB ART index is a second copy of the
    data outside the buffer manager. Uniqueness lives in the writers instead
    (delete the range, then insert it), and the integrity an index would buy is
    bought for free elsewhere: this is the only table no human-written file
    feeds, so a typo'd ticker is refused on the event row, where it enters.
    """
    assert [c for c in _constraints(store) if c[0] == 'price_point'] == []


def test_the_other_fourteen_tables_keep_their_keys(store):
    """A few thousand rows cost nothing, so the constraint earns its place."""
    with_keys = {table for table, kind in _constraints(store)
                 if kind == 'PRIMARY KEY'}

    assert with_keys == set(store_module.TABLES) - {'price_point'}


def test_the_foreign_keys_hold(store):
    """The integrity the price table declines is real everywhere else."""
    with pytest.raises(Exception):
        store.execute(
            "INSERT INTO account_state (account, cash_balance, net_contributed) "
            "VALUES ('nope', 0, 0)")


# --------------------------------------------------------------------------- #
# Two kinds of time, never mixed
# --------------------------------------------------------------------------- #

def test_an_observed_instant_is_timestamptz_and_a_calendar_day_is_a_date(store):
    types = {
        (table, column): kind
        for table, column, kind in store.query(
            "SELECT table_name, column_name, data_type "
            "FROM information_schema.columns "
            "WHERE data_type IN ('TIMESTAMP WITH TIME ZONE', 'TIMESTAMP', 'DATE')")
    }

    instants = [
        ('symbol_quote', 'fetched_at'),
        ('symbol_quote', 'last_price_ts'), ('price_point', 'ts'),
        ('installation_fact', 'first_seen_at'),
        ('installation_fact', 'acknowledged_at'),
    ]
    days = [
        ('event', 'date'), ('symbol_quote', 'oldest_window_tried'),
        ('symbol_quote', 'newest_window_tried'),
        ('account_metrics', 'day'), ('portfolio_totals', 'day'),
    ]

    assert {types[key] for key in instants} == {'TIMESTAMP WITH TIME ZONE'}
    assert {types[key] for key in days} == {'DATE'}
    # No naive timestamp anywhere: a stored instant with no zone is the one
    # shape that reads as correct and is wrong by hours.
    assert 'TIMESTAMP' not in set(types.values())


def test_the_connection_speaks_utc_whatever_the_host_says(tmp_path, monkeypatch):
    """The other half of "always UTC", and the type does not buy it.

    DuckDB takes ``TimeZone`` from the host, and a **literal** is read in
    whatever it says: from ``Australia/Sydney``, inserting
    ``'2024-01-01 10:00:00'`` into a ``TIMESTAMPTZ`` stores the previous day at
    23:00 UTC, without an error and differently from the container. An *aware*
    datetime round-trips correctly on its own — the literal is the trap, and the
    writers that follow are written in literals (the backfill's
    ``DELETE … WHERE ts >= ? AND ts < ?`` range, spec #695 § 5). Hence the host
    zone is forced to a non-UTC one here: on a UTC machine the assertion would
    hold for free and pin nothing.
    """
    monkeypatch.setenv('TZ', 'Australia/Sydney')
    time.tzset()
    try:
        opened = store_module.open_store(tmp_path / 'store.duckdb')
        try:
            assert opened.query("SELECT current_setting('TimeZone')") == [('UTC',)]

            opened.execute(
                "INSERT INTO price_point (symbol, ts, price_native) "
                "VALUES ('A', '2024-01-01 10:00:00', 1.0)")

            assert opened.query(
                "SELECT strftime(ts AT TIME ZONE 'UTC', '%Y-%m-%d %H:%M:%S') "
                "FROM price_point") == [('2024-01-01 10:00:00',)]
        finally:
            opened.close()
    finally:
        monkeypatch.undo()
        time.tzset()


# --------------------------------------------------------------------------- #
# The registry is the source, the table is the mirror
# --------------------------------------------------------------------------- #

def test_an_absent_key_reads_as_the_codes_default(store):
    store.execute("DELETE FROM setting WHERE key = 'backfill_delay'")

    assert store.setting('backfill_delay') == \
        settings_registry.default_for('backfill_delay')


def test_a_blank_value_reads_as_the_codes_default(store):
    """What an emptied form field writes, and it is not "zero seconds"."""
    store.execute("UPDATE setting SET value = '  ' WHERE key = 'staleness_horizon'")

    assert store.setting('staleness_horizon') == 900


def test_an_unposed_reporting_currency_reads_as_none(store):
    assert store.setting('base_currency') is None


def test_an_unknown_dial_is_not_a_dial(store):
    with pytest.raises(KeyError):
        store.setting('there_is_no_such_setting')


# --------------------------------------------------------------------------- #
# Opening, and failing to
# --------------------------------------------------------------------------- #

def test_opening_creates_the_directory_it_was_pointed_at(tmp_path):
    opened = store_module.open_store(tmp_path / 'a' / 'b' / 'store.duckdb')
    try:
        assert (tmp_path / 'a' / 'b' / 'store.duckdb').exists()
    finally:
        opened.close()


def test_an_unreadable_file_is_named_rather_than_generic(tmp_path):
    """The whole reason the store is opened in the master (#696).

    A file that is not a store must arrive as :class:`StoreUnavailable`, whose
    handling is the named exit — never as something a caller could mistake for
    "the portfolio is empty".
    """
    not_a_store = tmp_path / 'store.duckdb'
    not_a_store.write_bytes(b'this is not a duckdb file' * 100)

    with pytest.raises(store_module.StoreUnavailable, match=str(not_a_store)):
        store_module.open_store(not_a_store)


def test_the_store_path_follows_its_boot_variable(monkeypatch, tmp_path):
    monkeypatch.setenv(store_module.STORE_DIR_VAR, str(tmp_path / 'data'))

    assert store_module.store_path() == \
        tmp_path / 'data' / store_module.STORE_FILENAME


def test_a_blank_boot_variable_falls_back_to_the_default_directory(monkeypatch):
    """Compose renders an undefined substitution as the empty string."""
    monkeypatch.setenv(store_module.STORE_DIR_VAR, '   ')

    assert store_module.store_path().parent == \
        Path(store_module.DEFAULT_STORE_DIR).expanduser()


def test_ping_fails_once_the_store_is_closed(store):
    store.ping()
    store.close()

    with pytest.raises(Exception):
        store.ping()


# --------------------------------------------------------------------------- #
# The generation, and the steps that move between two (#926)
# --------------------------------------------------------------------------- #

#: The schema as it stood before ``schema_step`` existed: ``account`` carries a
#: ``type`` and nothing records a generation. It is written out in full rather
#: than derived from :data:`store.DDL`, because what is being asserted is that
#: *this* shape — the one in the wild — opens and is brought forward. A store
#: built from today's DDL would prove nothing about yesterday's.
_GENERATION_ZERO_DDL = """
CREATE TABLE account (id VARCHAR PRIMARY KEY, type VARCHAR NOT NULL, label VARCHAR NOT NULL);
CREATE TABLE symbol (symbol VARCHAR PRIMARY KEY);
CREATE TABLE event (
    id BIGINT PRIMARY KEY, date DATE NOT NULL, event_type VARCHAR NOT NULL,
    account VARCHAR NOT NULL REFERENCES account(id),
    symbol VARCHAR REFERENCES symbol(symbol),
    name VARCHAR, quantity DOUBLE, unit_price DOUBLE, fee DOUBLE,
    amount DOUBLE, notes VARCHAR);
"""

#: What #816 left on a store older still: the three provenance columns that
#: pointed at the mounted file an event came from. Nothing declares them today
#: and nothing reads them, and they are exactly what a rebuild from the current
#: DDL cannot put back.
_PRE_816_RESIDUE = (
    'ALTER TABLE event ADD COLUMN source_id VARCHAR;'
    'ALTER TABLE event ADD COLUMN source_sheet VARCHAR;'
    'ALTER TABLE event ADD COLUMN source_row BIGINT;')


def _generation_zero(path, residue=False):
    """A store of the shape shipped before this ticket, with rows in it."""
    connection = duckdb.connect(str(path))
    connection.execute("SET TimeZone='UTC'")
    connection.execute(_GENERATION_ZERO_DDL)
    if residue:
        connection.execute(_PRE_816_RESIDUE)
    connection.execute(
        "INSERT INTO account VALUES ('default', 'OTHER', 'Default account'), "
        "('pea', 'PEA', 'My PEA')")
    connection.execute("INSERT INTO symbol VALUES ('AAPL')")
    connection.execute(
        "INSERT INTO event (id, date, event_type, account, symbol, quantity, "
        "unit_price) VALUES (1, '2024-01-02', 'BUY', 'pea', 'AAPL', 3, 100.0), "
        "(2, '2024-01-03', 'DEPOSIT', 'pea', NULL, NULL, NULL)")
    connection.close()


def test_an_older_store_is_brought_forward_without_losing_a_row(tmp_path):
    """The rows the owner typed survive the reconstruction the step performs.

    DuckDB refuses to alter a table another one references, so dropping a column
    of ``account`` means lifting the five tables that point at it out, altering,
    letting the DDL declare them again and putting the rows back. That is the
    gesture this pins: the ledger is the product, and a schema step that loses a
    line of it has lost the thing the schema was holding.
    """
    path = tmp_path / 'old.duckdb'
    _generation_zero(path)

    opened = store_module.open_store(path)
    try:
        assert opened.query(
            'SELECT id, label FROM account ORDER BY id') == [
                ('default', 'Default account'), ('pea', 'My PEA')]
        assert opened.query(
            'SELECT id, event_type, account, symbol, quantity, unit_price '
            'FROM event ORDER BY id') == [
                (1, 'BUY', 'pea', 'AAPL', 3.0, 100.0),
                (2, 'DEPOSIT', 'pea', None, None, None)]
        # And the column is gone, which is the whole of the first step.
        assert {row[0] for row in opened.query(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'account'")} == {'id', 'label'}
    finally:
        opened.close()


#: ``symbol_quote`` as it was shipped before #854 — every column of today's
#: DDL but the forward pass's anchor. It is the shape the step exists for, and
#: the one no fresh file can ever have.
_PRE_854_SYMBOL_QUOTE = """
CREATE TABLE symbol_quote (
    symbol                VARCHAR PRIMARY KEY REFERENCES symbol(symbol),
    currency              VARCHAR, exchange VARCHAR, quote_type VARCHAR,
    dividend_yield        DOUBLE, pe_ratio DOUBLE, market_cap DOUBLE,
    fetched_at            TIMESTAMPTZ,
    last_price_native     DOUBLE, last_price_converted DOUBLE,
    last_fx_rate          DOUBLE, last_price_ts TIMESTAMPTZ,
    oldest_window_tried   DATE);
"""


def test_a_store_that_predates_the_forward_anchor_gets_the_column(tmp_path):
    """The gesture the ``IF NOT EXISTS`` DDL cannot make (issue #854).

    ``CREATE TABLE IF NOT EXISTS`` does not reach a table it finds, so a column
    added to the DDL reaches a **new** file and no other — and CI creates only
    new files, where the DDL *is* the whole schema. Left to the DDL alone, every
    store in circulation would open cleanly here and raise a Binder Error on the
    first forward pass, with nothing in the suite able to see it.
    """
    path = tmp_path / 'old.duckdb'
    _generation_zero(path)
    connection = duckdb.connect(str(path))
    connection.execute(_PRE_854_SYMBOL_QUOTE)
    connection.execute(
        "INSERT INTO symbol_quote (symbol, last_price_native, "
        "oldest_window_tried) VALUES ('AAPL', 187.0, DATE '2021-05-04')")
    connection.close()

    opened = store_module.open_store(path)
    try:
        # The column is there, and the backward anchor beside it is untouched.
        assert opened.query(
            'SELECT last_price_native, oldest_window_tried, '
            '       newest_window_tried FROM symbol_quote') == [
                (187.0, date(2021, 5, 4), None)]
    finally:
        opened.close()


def test_a_step_that_has_run_does_not_run_again(tmp_path):
    """Forward only, and idempotent — asserted on the mark, not on the column.

    A second boot must leave one identical schema, and it must reach it without
    re-running anything: the reconstruction is cheap on a new file and is not on
    a large one, and a step run twice would rebuild the derived tables for
    nothing every single start.
    """
    path = tmp_path / 'old.duckdb'
    _generation_zero(path)

    first = store_module.open_store(path)
    marks = first.query('SELECT step, applied_at FROM schema_step')
    shape = first.query(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_schema = 'main' ORDER BY table_name, column_name")
    first.close()

    second = store_module.open_store(path)
    try:
        # Same marks, same instants: nothing was applied a second time.
        assert second.query('SELECT step, applied_at FROM schema_step') == marks
        assert second.query(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = 'main' ORDER BY table_name, column_name") \
            == shape
    finally:
        second.close()


def test_a_fresh_file_records_the_same_generation_as_one_brought_forward(
        store, tmp_path):
    """A new store walks the list too, changes nothing, and records it.

    **Generation zero is unlabelled**, and the absence reads without erroring: a
    store that predates the table carries no row, and the DDL creates the table a
    line before it is asked, which is what makes the question answerable at all.
    What it records once brought forward is the assertion here.

    The steps are written to be a no-op where they are not needed, so there is
    **one** generation and not two: a file created today and a file brought
    forward from before carry the same marks, and the next step that lands can
    read the list rather than asking where the file came from.
    """
    fresh = store.query('SELECT step FROM schema_step')
    assert fresh == [(name,) for name, _ in store_module.STEPS]

    old = tmp_path / 'old.duckdb'
    _generation_zero(old)
    brought = store_module.open_store(old)
    try:
        assert brought.query('SELECT step FROM schema_step') == fresh
    finally:
        brought.close()


def test_a_step_that_fails_leaves_the_store_exactly_as_it_was(tmp_path,
                                                              monkeypatch):
    """Half a step is not a state this store is ever left in.

    Each step runs inside its own transaction with its own mark, so a failure
    rolls back the schema *and* the mark together — the alternative being a
    store that believes a step ran and carries half of it.
    """
    path = tmp_path / 'old.duckdb'
    _generation_zero(path)

    def explodes(connection):
        connection.execute('ALTER TABLE symbol RENAME TO symbole')
        raise RuntimeError('the step gave up halfway')

    monkeypatch.setattr(store_module, 'STEPS', (('boom', explodes),))

    with pytest.raises(store_module.StoreUnavailable):
        store_module.open_store(path)

    connection = duckdb.connect(str(path))
    try:
        tables = {row[0] for row in connection.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main'").fetchall()}
        assert 'symbol' in tables and 'symbole' not in tables
        assert connection.execute(
            'SELECT count(*) FROM schema_step').fetchone() == (0,)
    finally:
        connection.close()


def test_a_store_carrying_a_column_the_ddl_no_longer_declares_still_opens(
        tmp_path):
    """The oldest stores in the wild, and the ones the step is *for*.

    A store from before #816 carries ``event.source_id``, ``source_sheet`` and
    ``source_row``: three columns today's DDL does not declare. The step rebuilds
    ``event`` from that DDL, so the copy has more columns than the table the rows
    go back into — and an ``INSERT … SELECT *`` hands fourteen values to an
    eleven-column table and raises. It would raise at **every** boot, too: the
    mark rolls back with the step, so the app would never open that store again.

    The rows go back by shared column name instead. The residue does not survive
    — a table recreated from the DDL is the DDL's table — and that is the whole
    of what is lost, because nothing has read those three since #816.
    """
    path = tmp_path / 'ancient.duckdb'
    _generation_zero(path, residue=True)

    opened = store_module.open_store(path)
    try:
        assert opened.query(
            'SELECT id, event_type, account, quantity FROM event ORDER BY id') \
            == [(1, 'BUY', 'pea', 3.0), (2, 'DEPOSIT', 'pea', None)]
        assert {row[0] for row in opened.query(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'event'")}.isdisjoint(
                {'source_id', 'source_sheet', 'source_row'})
        assert opened.query('SELECT step FROM schema_step') == \
            [(name,) for name, _ in store_module.STEPS]
    finally:
        opened.close()


def test_a_table_declared_after_this_step_does_not_break_it(tmp_path,
                                                            monkeypatch):
    """The trap a hand-written list of dependents would have set.

    A step runs on **old** stores, and CI only ever exercises fresh ones where
    every step is a no-op — so a list of *who references account* would go stale
    silently and fail on the one population it exists for, permanently: the
    rollback means the next boot fails identically. :func:`store.rebuilding` asks
    the catalogue instead, so a sixth dependent declared in a later version is
    lifted out with the other five without anybody remembering to say so.
    """
    later = store_module.DDL + (
        'CREATE TABLE IF NOT EXISTS account_note ('
        '  account VARCHAR PRIMARY KEY REFERENCES account(id),'
        '  note VARCHAR NOT NULL);')
    monkeypatch.setattr(store_module, 'DDL', later)

    path = tmp_path / 'old.duckdb'
    _generation_zero(path)

    opened = store_module.open_store(path)
    try:
        assert {row[0] for row in opened.query(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'account'")} == {'id', 'label'}
        assert opened.query('SELECT count(*) FROM account_note') == [(0,)]
    finally:
        opened.close()
