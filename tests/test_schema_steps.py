"""The complete list of schema steps the app hands the store (#1198)."""
import ast
from pathlib import Path

import duckdb

from application import schema_steps
from application import store as store_module

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
    source = Path(store_module.__file__).read_text()
    imported = set()
    for node in ast.walk(ast.parse(source)):
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
        'application.incoming', 'application.events.schemas'}
