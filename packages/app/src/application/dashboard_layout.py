"""The dashboard's saved layout — one row of the ``setting`` table.

**Not a dial**: it lives beside the ledger's own internal keys (``ledger.py``'s
``LAST_WRITE_KEY``, ``CONSULTED_KEY``) and outside ``settings_registry``, so it
never shows up on the settings page as a value to type in.

**The server knows the shape, not the cards.** The registry of cards is the
front's (``src/web/src/features/dashboard/lib/dashboardBlocks.ts``): the
Docker build keeps the two halves apart, and a card the front does not know
is dropped by its ``normalizeLayout`` on the way back in. So an unknown id is
stored as sent, and what is refused here is a body that is not a layout at
all.
"""
import json
from typing import Any, Optional

KEY = 'dashboard_layout'

VERSION = 1

WIDTHS = ('half', 'full')

#: Bounds on what one installation can ask the store to keep. The catalogue
#: holds a dozen cards; fifty is room for it to grow and no room for a payload.
MAX_BLOCKS = 50
MAX_ID = 64


class InvalidLayout(ValueError):
    """A body that is not a layout this version writes."""


def validate(body: Any) -> dict:
    """The layout to store, or :class:`InvalidLayout` naming what is wrong."""
    if not isinstance(body, dict):
        raise InvalidLayout('a layout is a JSON object')
    version = body.get('version')
    # `type(...) is int`: in Python `True == 1` and `1.0 == 1`, and neither is
    # a version.
    if type(version) is not int or version != VERSION:
        raise InvalidLayout(f'a layout has version {VERSION}')
    blocks = body.get('blocks')
    if not isinstance(blocks, list):
        raise InvalidLayout("a layout has a 'blocks' list")
    if len(blocks) > MAX_BLOCKS:
        raise InvalidLayout(f'a layout holds at most {MAX_BLOCKS} cards')

    kept = []
    seen = set()
    for block in blocks:
        if not isinstance(block, dict):
            raise InvalidLayout('each card is a JSON object')
        block_id = block.get('id')
        if not isinstance(block_id, str) or not 0 < len(block_id) <= MAX_ID:
            raise InvalidLayout(
                f'each card has an id of 1 to {MAX_ID} characters')
        if block_id in seen:
            raise InvalidLayout(f'the card {block_id!r} appears twice')
        seen.add(block_id)
        if block.get('width') not in WIDTHS:
            raise InvalidLayout(
                f"the card {block_id!r} has a width of "
                f"{' or '.join(repr(width) for width in WIDTHS)}")
        if not isinstance(block.get('hidden'), bool):
            raise InvalidLayout(
                f"the card {block_id!r} says whether it is hidden, true or false")
        kept.append({'id': block_id, 'width': block['width'],
                     'hidden': block['hidden']})
    return {'version': VERSION, 'blocks': kept}


def read(store) -> Optional[Any]:
    """The stored layout as JSON, or ``None``: never saved, or unreadable.

    Returned as stored, not validated: the front's ``normalizeLayout`` is what
    turns any of it — a future version included — into cards it can draw.
    """
    rows = store.query('SELECT value FROM setting WHERE key = ?', [KEY])
    stored = rows[0][0] if rows else None
    if not stored:
        return None
    try:
        return json.loads(stored)
    except ValueError:
        return None


def write(store, layout: dict) -> None:
    """Keep ``layout``, which :func:`validate` has already returned."""
    store.execute(
        'INSERT INTO setting (key, value) VALUES (?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [KEY, json.dumps(layout, separators=(',', ':'))])


def delete(store) -> None:
    """Forget the layout: the front goes back to the registry's defaults."""
    store.execute('DELETE FROM setting WHERE key = ?', [KEY])
