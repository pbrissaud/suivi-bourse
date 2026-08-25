"""
The store: its shape, its seed, and the two rules the shape encodes (#696).

Everything here runs against a **real DuckDB file** in ``tmp_path`` — the
``store`` fixture — because the store is embedded and mocking it would mock half
the product. Nothing reads or writes domain rows yet; what is pinned is what the
tickets that follow will build on and could silently break:

* the twelve tables exist on a brand-new file, and a second boot on the same
  file adds nothing to it;
* ``price_point`` carries no key of any kind while the other eleven keep theirs
  (ADR-0007) — a primary key here costs +563 MB of *resident* memory on a 319 MB
  base, because a DuckDB ART index is a second copy whose buffers the buffer
  manager does not own;
* an observed instant is ``TIMESTAMPTZ`` and a calendar day is ``DATE``, never
  the reverse — and the connection is pinned to UTC, which the type does not
  buy: a bare literal is read in the *host's* zone;
* a setting absent from the table reads as the code's default (ADR-0014), and
  the boot completes the table without ever overwriting an answer.
"""

import time
from pathlib import Path

import pytest

import settings_registry
import store as store_module


# --------------------------------------------------------------------------- #
# A fresh file, and a second boot on it
# --------------------------------------------------------------------------- #

def test_a_new_file_carries_the_eleven_tables(store):
    assert sorted(store.table_names()) == sorted(store_module.TABLES)
    assert len(store_module.TABLES) == 11


def test_a_new_file_declares_no_provenance_at_all(store):
    """**Criterion 2 of #816**, on a store the DDL has just created (ADR-0032).

    ``import_source`` existed because a mounted file was re-read and had to be
    named to be revoked; the three columns on ``event`` existed to point at it.
    A file is a payload now, so a fresh store declares neither — and there is no
    migration machinery, deliberately: an older store keeps them as inert
    residue that nothing reads and nothing writes.
    """
    assert 'import_source' not in store.table_names()

    columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'event'")}
    assert columns.isdisjoint({'source_id', 'source_sheet', 'source_row'})
    # And nothing in the DDL text mentions the table either, so no foreign key
    # can be pointing at one that is not created.
    assert 'import_source' not in store_module.DDL


def test_a_new_file_declares_no_provenance_on_an_account_either(store):
    """The accounts' own half of that, and it is ADR-0034's (#817).

    ``account.source_id`` said which accounts file had declared a row; there is
    no accounts file, so a fresh store declares no such column — the same inert
    residue on an older store, and the same absence of migration machinery.
    """
    columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'account'")}
    assert columns == {'id', 'type', 'label'}
    assert 'source_id' not in store_module.DDL


def test_a_new_file_is_seeded_with_the_default_account(store):
    rows = store.query('SELECT id, type, label FROM account')

    assert rows == [store_module.DEFAULT_ACCOUNT_ROW]


def test_a_new_file_is_seeded_with_every_dial_that_has_a_default(store):
    stored = dict(store.query('SELECT key, value FROM setting'))

    assert stored == settings_registry.seeded_defaults()
    # ... and the one dial with no default is absent rather than guessed. The
    # reporting currency is asked, and "not answered yet" has to stay a state:
    # a default would silently interpret every amount already imported.
    assert 'base_currency' not in stored


def test_a_second_boot_on_the_same_file_duplicates_nothing(store, tmp_path):
    """Idempotence is what makes "no migration for a new dial" true.

    The DDL, the account seed and the settings completion all run again at every
    start; if any of them wrote a second time, the account table would grow a
    row per restart and the answer a human gave would be overwritten by the
    code's default.
    """
    store.execute("UPDATE setting SET value = '600' WHERE key = 'regular_interval'")
    store.close()

    reopened = store_module.open_store(tmp_path / 'store.duckdb')
    try:
        assert sorted(reopened.table_names()) == sorted(store_module.TABLES)
        assert reopened.query('SELECT count(*) FROM account') == [(1,)]
        assert reopened.query('SELECT count(*) FROM setting') == \
            [(len(settings_registry.seeded_defaults()),)]
        # The edited value survived: completing the table is an insert of what
        # is missing, never an upsert of what is there.
        assert reopened.setting('regular_interval') == 600
    finally:
        reopened.close()


def test_a_dial_added_later_is_inserted_without_a_migration(store, tmp_path,
                                                            monkeypatch):
    """The whole point of seeding at every boot rather than at creation."""
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
# The constraints, and the one table that has none (ADR-0007)
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


def test_the_other_eleven_tables_keep_their_keys(store):
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
