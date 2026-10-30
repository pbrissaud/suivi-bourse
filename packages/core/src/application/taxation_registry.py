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

MAX_BYTES = 256 * 1024


class FetchFailed(Exception):
    """The registry did not come back as a JSON list.

    ``unpublished``: the site answered 404, so it is up and has no registry for this build.
    """

    def __init__(self, reason: str, unpublished: bool = False):
        super().__init__(reason)
        self.reason = reason
        self.unpublished = unpublished


def registry_url(root: str) -> str:
    """The registry file of the documentation site at ``root`` (no trailing ``/``)."""
    return f'{root}/taxation.json'


def http_fetch(url: str) -> bytes:
    """The registry file, or an exception."""
    return bounded_get(url, MAX_BYTES)


def _item(entry: object) -> Optional[dict]:
    """``entry`` as a listed item, ``refused`` saying why it cannot be picked."""
    if not isinstance(entry, dict):
        return None
    fields = {key: entry.get(key) for key in ('id', 'country', 'name', 'kind', 'parameters')}
    if not all(isinstance(fields[key], str) and fields[key].strip()
               for key in ('id', 'country', 'name', 'kind')):
        return None
    try:
        fields['parameters'] = taxation.validate(fields['kind'], fields['parameters'])
        fields['refused'] = None
    except taxation.ModelRejected as exc:
        fields['refused'] = str(exc)
    return fields


def fetch(fetcher: Callable[[str], bytes], root: str) -> List[dict]:
    """Every wrapper of the registry, the ones this app refuses flagged and kept."""
    url = registry_url(root)
    try:
        data = json.loads(fetcher(url))
    except Exception as exc:  # the fetcher is injected; anything it raises is a failed fetch
        # urlopen raises HTTPError on a 404 before bounded_get looks at the status.
        raise FetchFailed(f'{type(exc).__name__}: {exc} ({url})',
                          unpublished=getattr(exc, 'code', None) == 404) from exc
    if not isinstance(data, list):
        raise FetchFailed('invalid registry JSON')
    items = {}
    for item in map(_item, data):
        # An id is the line's identity in the list: the first one wins.
        if item is not None:
            items.setdefault(item['id'], item)
    return list(items.values())


__all__ = ['MAX_BYTES', 'FetchFailed', 'registry_url', 'http_fetch', 'fetch']
