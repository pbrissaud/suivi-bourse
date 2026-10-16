"""The JSON Schema the front's API types are generated from (#1204).

The shapes of ``/api/positions`` and ``/api/accounts`` were written three times,
and the TypeScript copy drifted from the other two without a word. It is now
generated: this module states the schema off the same ``TypedDict``\\ s the MCP
server publishes, ``src/web/src/lib/api.schema.json`` is its committed output,
and ``pnpm gen:api`` turns that into ``api.gen.ts``. ``tests/test_api_schema.py``
holds the file to the Python, and the ``web`` job holds the TypeScript to the
file.

    uv run python -m application.api_schema --write
"""
import json
import sys
from pathlib import Path

from pydantic import TypeAdapter

from application.account_facts import AccountsPayload
from application.mcp_server import Positions

#: Where the front reads it.
TARGET = Path(__file__).resolve().parents[4] / 'src/web/src/lib/api.schema.json'


def schema() -> dict:
    _, document = TypeAdapter.json_schemas(
        [('Positions', 'serialization', TypeAdapter(Positions)),
         ('AccountsPayload', 'serialization', TypeAdapter(AccountsPayload))],
        title='Api')
    # A property's title makes `json2ts` emit one alias per field
    # (`export type Quantity = number | null`); a definition's names the
    # interface, so it stays.
    for definition in document['$defs'].values():
        for prop in definition.get('properties', {}).values():
            prop.pop('title', None)
    return document


def render() -> str:
    return json.dumps(schema(), indent=2, sort_keys=True) + '\n'


if __name__ == '__main__':
    if '--write' in sys.argv[1:]:
        TARGET.write_text(render())
    else:
        sys.stdout.write(render())
