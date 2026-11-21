"""The one outbound GET the app makes on a click: a timeout and a size cap."""
import threading
import time
import urllib.request

# Cloudflare's browser integrity check answers 403 to urllib's default
# ``Python-urllib/3.x``, so a docs site behind it never served the registry.
USER_AGENT = 'suivi-bourse (+https://github.com/pbrissaud/suivi-bourse)'


def bounded_get(url: str, max_bytes: int, timeout: float = 5) -> bytes:
    """The body at ``url``, or an exception: not a 200, larger than
    ``max_bytes``, or not all read within ``timeout`` seconds.

    ``urlopen``'s timeout bounds each socket operation, not the whole request:
    a slow resolver, slow headers or a trickling body would hold the caller
    past it. The request runs on a daemon thread the caller waits for at most
    ``timeout``; left behind, the thread stops at its own deadline or at the
    next socket timeout, whichever comes first.
    """
    answer = {}

    def fetch():
        try:
            answer['raw'] = _get(url, max_bytes, timeout)
        except BaseException as exc:  # handed to the caller as it was raised
            answer['error'] = exc

    worker = threading.Thread(target=fetch, name='bounded_get', daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        raise TimeoutError(f'no full answer within {timeout:g} s')
    if 'error' in answer:
        raise answer['error']
    return answer['raw']


def _get(url: str, max_bytes: int, timeout: float) -> bytes:
    """The request itself. ``read1`` returns what one socket read brought,
    where ``read(n)`` would wait for all ``n`` bytes."""
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
