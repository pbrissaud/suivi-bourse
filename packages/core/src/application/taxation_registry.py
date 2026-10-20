"""The taxation models the documentation site publishes, read on a click (#1290).

``website/static/taxation.json`` is generated from ``website/taxation/<cc>.json``
and served with the docs. The one outbound call is the owner's explicit import;
nothing here stores anything, and a rate in that file is never a rate in this code.
Pure: the fetcher is injected, ``http_fetch`` is the one the app passes.
"""
import json
from typing import Callable, List, Optional

from application import taxation
from application.bounded_get import bounded_get

URL = 'https://pbrissaud.github.io/suivi-bourse/taxation.json'
MAX_BYTES = 256 * 1024


class FetchFailed(Exception):
    """The registry did not come back as a JSON list."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def http_fetch(url: str) -> bytes:
    """The registry file, or an exception."""
    return bounded_get(url, MAX_BYTES)


def _item(entry: object) -> Optional[dict]:
    """``entry`` as a listed item, ``refused`` saying why it cannot be picked."""
    if not isinstance(entry, dict):
        return None
    fields = {key: entry.get(key) for key in ('id', 'country', 'name', 'kind', 'parameters')}
    if not all(isinstance(fields[key], str) for key in ('id', 'country', 'name', 'kind')):
        return None
    try:
        fields['parameters'] = taxation.validate(fields['kind'], fields['parameters'])
        fields['refused'] = None
    except taxation.ModelRejected as exc:
        fields['refused'] = str(exc)
    return fields


def fetch(fetcher: Callable[[str], bytes]) -> List[dict]:
    """Every wrapper of the registry, the ones this app refuses flagged and kept."""
    try:
        data = json.loads(fetcher(URL))
    except Exception as exc:  # the fetcher is injected; anything it raises is a failed fetch
        raise FetchFailed(f'{type(exc).__name__}: {exc}') from exc
    if not isinstance(data, list):
        raise FetchFailed('invalid registry JSON')
    return [item for item in map(_item, data) if item is not None]


__all__ = ['URL', 'MAX_BYTES', 'FetchFailed', 'http_fetch', 'fetch']
