"""The complete list of schema steps the app hands the store (#1198)."""
import ast
from pathlib import Path

import duckdb

from application import schema_steps
from application import store as store_module
from application import store_ddl, store_steps

#: The marks a store migrated before #1198 carries, written out rather than
#: read from the code: they are what is on the disks.
RELEASED = (
    'drop_account_type',
    'add_newest_window_tried',
    'add_symbol_classification',
    'drop_split_adjusted_prices',
    'add_splits_read_at',
    'drop_dividend_adjusted_prices',
    'refetch_prices_bucketed_in_utc',
    'fold_symbol_case',
    'cap_dividend_fee_at_amount',
    'add_event_amounts_currency',
    'add_agent_model_name',
    'add_agent_thinking',
    'follow_the_references',
    'add_symbol_quote_long_name',
    'forget_ticker_names',
)


def test_the_list_is_todays_names_in_todays_order():
    """A name is an identity forever: renamed or reordered, a store in the
    wild runs a step a second time, or runs one before the step it followed."""
    assert tuple(name for name, _ in schema_steps.STEPS) == RELEASED


def test_a_store_migrated_before_the_split_opens_without_running_a_step(
        tmp_path):
    """A store carrying the released marks, opened with the app's list, runs
    nothing: the marks and their instants stay exactly as they were. The marks
    are the released names, not the code's, so a renamed step fails here."""
    path = tmp_path / 'migrated.duckdb'
    store_module.open_store(path, schema_steps.STEPS).close()
    connection = duckdb.connect(str(path))
    connection.execute('DELETE FROM schema_step')
    connection.executemany(
        "INSERT INTO schema_step (step, applied_at) "
        "VALUES (?, TIMESTAMPTZ '2026-10-01 00:00:00+00')",
        [[name] for name in RELEASED])
    marks = connection.execute(
        'SELECT step, applied_at FROM schema_step ORDER BY step').fetchall()
    connection.close()

    opened = store_module.open_store(path, schema_steps.STEPS)
    try:
        assert opened.query(
            'SELECT step, applied_at FROM schema_step ORDER BY step') == marks
    finally:
        opened.close()


def test_the_store_imports_nothing_above_it():
    """The cycle #1198 broke: the store reaches only what sits below it, and a
    deferred import inside a function counts as much as one at the top."""
    imported = set()
    # The store is three modules since #1201: connection, DDL and steps.
    nodes = (node for module in (store_module, store_ddl, store_steps)
             for node in ast.walk(ast.parse(Path(module.__file__).read_text())))
    for node in nodes:
        if isinstance(node, ast.ImportFrom):
            # ``from .entries import x`` and ``from . import entries`` are
            # spelled relative to ``application``, where the store lives.
            module = '.'.join(filter(None, (
                'application' if node.level else None, node.module)))
            if module == 'application':
                imported.update(f'application.{alias.name}'
                                for alias in node.names)
            else:
                imported.add(module)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    assert {name for name in imported if name.startswith('application')} == {
        'application.boot_env', 'application.settings_registry',
        'application.incoming', 'application.events.schemas',
        'application.store', 'application.store_ddl', 'application.store_steps'}


def test_the_amounts_currency_step_adds_a_null_column_and_keeps_rows(tmp_path):
    """A store from before #1261 keeps every event, and none of them is stated."""
    # The table as the released DDL spelled it, before the column existed.
    column = "    notes         VARCHAR,\n    amounts_currency VARCHAR);"
    assert column in store_module.DDL
    legacy = store_module.DDL.replace(column, "    notes         VARCHAR);")

    path = tmp_path / 'old.duckdb'
    connection = duckdb.connect(str(path))
    connection.execute(legacy)
    connection.execute("INSERT INTO account (id, label) VALUES ('default', 'Default')")
    connection.execute("INSERT INTO symbol VALUES ('AAPL')")
    connection.execute(
        "INSERT INTO event (id, date, event_type, account, symbol, quantity, "
        "                   unit_price) "
        "VALUES (1, DATE '2024-01-15', 'BUY', 'default', 'AAPL', 1, 150)")
    # Every earlier step already ran, as on a store in the wild: otherwise
    # `fold_symbol_case` rebuilds `event` from today's DDL and adds the column
    # by itself, and this test would not be testing the step.
    connection.executemany(
        "INSERT INTO schema_step (step, applied_at) "
        "VALUES (?, TIMESTAMPTZ '2026-10-01 00:00:00+00')",
        [[name] for name in RELEASED
         if name != 'add_event_amounts_currency'])
    connection.close()

    opened = store_module.open_store(path, schema_steps.STEPS)
    try:
        assert opened.query('SELECT id, unit_price, amounts_currency FROM event') \
            == [(1, 150.0, None)]
    finally:
        opened.close()


def _migrated(tmp_path, settings):
    """A store at the step before ours, holding ``settings``, then opened."""
    path = tmp_path / 'follow.duckdb'
    store_module.open_store(path, schema_steps.STEPS).close()
    connection = duckdb.connect(str(path))
    connection.execute(
        "DELETE FROM schema_step WHERE step = 'follow_the_references'")
    connection.execute('DELETE FROM setting WHERE key LIKE ?', ['benchmark_%'])
    for key, value in settings.items():
        connection.execute(
            'INSERT INTO setting (key, value) VALUES (?, ?)', [key, value])
    connection.close()

    opened = store_module.open_store(path, schema_steps.STEPS)
    try:
        return dict(opened.query(
            "SELECT key, value FROM setting WHERE key LIKE 'benchmark_%'"))
    finally:
        opened.close()


def test_an_install_follows_its_reference_first_then_every_consulted_one(
        tmp_path):
    rows = _migrated(tmp_path, {'benchmark_symbol': 'CSPX.AS',
                                'benchmark_consulted': 'CW8.PA,CSPX.AS,C40.PA'})

    assert rows['benchmark_symbols'] == 'CSPX.AS,CW8.PA,C40.PA'
    assert rows['benchmark_symbol'] == 'CSPX.AS'
    assert rows['benchmark_consulted'] == 'CSPX.AS,CW8.PA,C40.PA'


def test_an_off_list_reference_is_cleared_and_not_followed(tmp_path):
    rows = _migrated(tmp_path, {'benchmark_symbol': 'WPEA.PA',
                                'benchmark_consulted': 'CW8.PA'})

    assert rows['benchmark_symbol'] == ''
    assert rows['benchmark_symbols'] == 'CW8.PA'


def test_an_install_that_compared_against_nothing_gets_no_row(tmp_path):
    assert _migrated(tmp_path, {}) == {}


def _before(tmp_path, *steps):
    """A store opened with every step, then put back before ``steps``."""
    path = tmp_path / 'before.duckdb'
    store_module.open_store(path, schema_steps.STEPS).close()
    connection = duckdb.connect(str(path))
    connection.executemany('DELETE FROM schema_step WHERE step = ?',
                           [[name] for name in steps])
    return path, connection


def test_the_long_name_step_adds_a_null_column_and_keeps_the_quote(tmp_path):
    """A store from before #1386 keeps its quotes, and none of them has a name."""
    # The table as the released DDL spelled it, before the column existed.
    column = "    long_name             VARCHAR,                   -- what Yahoo calls it (#1386)\n"
    assert column in store_module.DDL
    legacy = store_module.DDL.replace(column, "")

    path = tmp_path / 'old.duckdb'
    connection = duckdb.connect(str(path))
    connection.execute(legacy)
    connection.execute("INSERT INTO symbol VALUES ('AAPL')")
    connection.execute(
        "INSERT INTO symbol_quote (symbol, currency) VALUES ('AAPL', 'USD')")
    # Every earlier step already ran, as on a store in the wild.
    connection.executemany(
        "INSERT INTO schema_step (step, applied_at) "
        "VALUES (?, TIMESTAMPTZ '2026-10-01 00:00:00+00')",
        [[name] for name in RELEASED
         if name not in ('add_symbol_quote_long_name', 'forget_ticker_names')])
    connection.close()

    opened = store_module.open_store(path, schema_steps.STEPS)
    try:
        assert opened.query(
            'SELECT currency, long_name FROM symbol_quote') == [('USD', None)]
    finally:
        opened.close()


def test_the_ticker_names_are_forgotten_once_and_only_those(tmp_path):
    """``name = symbol`` was the app's fallback, never a declaration (#1386)."""
    path, connection = _before(tmp_path, 'forget_ticker_names')
    connection.execute("INSERT INTO symbol VALUES ('SAP.DE'), ('AAPL')")
    connection.execute("INSERT INTO account (id, label) VALUES ('default', 'D') "
                       "ON CONFLICT DO NOTHING")
    connection.execute(
        "INSERT INTO event (id, date, event_type, account, symbol, name, "
        "                   quantity, unit_price) VALUES "
        "(1, DATE '2024-01-15', 'BUY', 'default', 'SAP.DE', 'SAP.DE', 1, 100), "
        "(2, DATE '2024-01-16', 'BUY', 'default', 'AAPL', 'Apple Inc', 1, 100)")
    connection.close()

    for _ in range(2):  # the second open runs nothing, and changes nothing
        opened = store_module.open_store(path, schema_steps.STEPS)
        try:
            assert opened.query('SELECT id, name FROM event ORDER BY id') == [
                (1, None), (2, 'Apple Inc')]
        finally:
            opened.close()
