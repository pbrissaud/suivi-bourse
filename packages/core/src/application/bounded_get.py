"""The one outbound GET the app makes on a click: a timeout and a size cap."""
import urllib.request

# Cloudflare's browser integrity check answers 403 to urllib's default
# ``Python-urllib/3.x``, so a docs site behind it never served the registry.
USER_AGENT = 'suivi-bourse (+https://github.com/pbrissaud/suivi-bourse)'


def bounded_get(url: str, max_bytes: int, timeout: float = 5) -> bytes:
    """The body at ``url``, or an exception: not a 200, or larger than ``max_bytes``."""
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise OSError(f'HTTP {response.status}')
        raw = response.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise OSError(f'body larger than {max_bytes} bytes')
    return raw


__all__ = ['bounded_get']
