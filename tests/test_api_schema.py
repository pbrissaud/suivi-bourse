"""The committed schema the front's API types are generated from (#1204)."""
import json
import pytest
from pydantic import TypeAdapter, ValidationError

from application import api_schema
from application.mcp_server import Position


def test_the_committed_schema_is_the_one_the_python_states():
    assert json.loads(api_schema.TARGET.read_text()) == api_schema.schema(), (
        'src/web/src/lib/api.schema.json is stale: run '
        '`uv run python -m application.api_schema --write`, then '
        '`pnpm gen:api` in src/web')


def test_the_schema_names_exactly_the_seven_shapes():
    assert set(api_schema.schema()['$defs']) == {
        'Account', 'AccountsPayload', 'Converted', 'Fundamentals', 'Position',
        'Positions', 'Price'}


def test_a_quantity_is_never_null_and_may_be_nan():
    position = {
        'account': 'pea', 'symbol': 'AAPL', 'name': None, 'quantity': 1.0,
        'cost_basis': 1.0, 'realised': 0.0, 'dividends': 0.0, 'price': None,
        'converted': None, 'closed_at': None, 'terminal': True,
        'fundamentals': None}
    adapter = TypeAdapter(Position)

    with pytest.raises(ValidationError):
        adapter.validate_python({**position, 'quantity': None})
    adapter.validate_python({**position, 'quantity': float('nan')})
