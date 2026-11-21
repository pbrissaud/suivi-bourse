"""The one outbound GET the app makes on a click: a timeout and a size cap."""
import time
import urllib.request

# Cloudflare's browser integrity check answers 403 to urllib's default
# ``Python-urllib/3.x``, so a docs site behind it never served the registry.
USER_AGENT = 'suivi-bourse (+https://github.com/pbrissaud/suivi-bourse)'


def bounded_get(url: str, max_bytes: int, timeout: float = 5) -> bytes:
    """The body at ``url``, or an exception: not a 200, larger than
    ``max_bytes``, or not all read within ``timeout`` seconds.

    ``urlopen``'s timeout bounds each socket operation, so a server trickling
    bytes would hold the request for ever; the body is read in chunks against
    one deadline instead. ``read1`` returns what one socket read brought, where
    ``read(n)`` would wait for all ``n`` bytes.
    """
    # ponytail: the deadline is checked between reads, each bounded by
    # ``timeout``, so a trickling server is cut within 2 x ``timeout``; DNS has
    # no bound of its own. A worker thread with a hard join, if that matters.
    deadline = time.monotonic() + timeout
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise OSError(f'HTTP {response.status}')
        raw = b''
        while len(raw) <= max_bytes:
            if time.monotonic() > deadline:
                raise TimeoutError(f'no full answer within {timeout:g} s')
            chunk = response.read1(min(65536, max_bytes + 1 - len(raw)))
            if not chunk:
                break
            raw += chunk
    if len(raw) > max_bytes:
        raise OSError(f'body larger than {max_bytes} bytes')
    return raw


__all__ = ['bounded_get']
