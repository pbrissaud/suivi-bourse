"""The complete list of schema steps the app hands the store (#1198)."""
import ast
from pathlib import Path

from application import schema_steps
from application import store as store_module


def test_the_list_is_todays_names_in_todays_order():
    """A name is an identity forever: renamed or reordered, a store in the
    wild runs a step a second time, or runs one before the step it followed."""
    assert [name for name, _ in schema_steps.STEPS] == [
        'drop_account_type',
        'add_newest_window_tried',
        'add_symbol_classification',
        'drop_split_adjusted_prices',
        'add_splits_read_at',
        'drop_dividend_adjusted_prices',
        'refetch_prices_bucketed_in_utc',
        'fold_symbol_case',
        'cap_dividend_fee_at_amount',
    ]


def test_a_store_migrated_before_the_split_opens_without_running_a_step(
        tmp_path):
    """A store carrying every mark, opened with the app's list, runs nothing:
    the marks and their instants stay exactly as they were."""
    path = tmp_path / 'migrated.duckdb'
    created = store_module.open_store(path, schema_steps.STEPS)
    marks = created.query('SELECT step, applied_at FROM schema_step ORDER BY step')
    created.close()

    opened = store_module.open_store(path, schema_steps.STEPS)
    try:
        assert len(marks) == len(schema_steps.STEPS)
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
        if isinstance(node, ast.ImportFrom) and node.module == 'application':
            imported.update(f'application.{alias.name}' for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    assert {name for name in imported if name.startswith('application')} == {
        'application.boot_env', 'application.settings_registry',
        'application.incoming', 'application.events.schemas'}
