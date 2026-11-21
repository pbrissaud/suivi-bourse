"""The one outbound GET the app makes on a click: a timeout and a size cap."""
import http.client
import socket
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
    slow headers or a trickling body would hold it past it. The request runs on
    a thread the caller waits for at most ``timeout``; at the deadline the
    caller shuts the request's sockets, so the thread's blocked read fails and
    the thread ends with it.
    """
    answer = {}
    sockets = _Sockets()

    def fetch():
        try:
            answer['raw'] = _get(url, max_bytes, timeout, sockets)
        except BaseException as exc:  # handed to the caller as it was raised
            answer['error'] = exc

    worker = threading.Thread(target=fetch, name='bounded_get', daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        # ponytail: a name still resolving has no socket yet; getaddrinfo ends
        # on the system resolver's own timeout, then finds the request shut.
        sockets.shut()
        raise TimeoutError(f'no full answer within {timeout:g} s')
    if 'error' in answer:
        raise answer['error']
    return answer['raw']


class _Sockets:
    """The sockets one request opened, shut together at its deadline."""

    def __init__(self):
        self._lock = threading.Lock()
        self._open = []
        self._shut = False

    def add(self, sock) -> None:
        with self._lock:
            if not self._shut:
                self._open.append(sock)
                return
        sock.close()
        raise TimeoutError('the request was abandoned at its deadline')

    def shut(self) -> None:
        with self._lock:
            self._shut = True
            opened, self._open = self._open, []
        for sock in opened:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()


def _open(request, timeout: float, sockets: _Sockets):
    """``urlopen`` with its redirects and proxies, over connections whose
    sockets ``sockets`` holds."""
    def tracked(base):
        class Connection(base):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                create = self._create_connection

                def created(*args, **kwargs):
                    # The TCP socket, before TLS: shutting it aborts a stalled
                    # handshake too.
                    sock = create(*args, **kwargs)
                    sockets.add(sock)
                    return sock
                self._create_connection = created
        return Connection

    class Http(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(tracked(http.client.HTTPConnection), req)

    class Https(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(tracked(http.client.HTTPSConnection), req,
                                context=self._context)

    return urllib.request.build_opener(Http, Https).open(request, timeout=timeout)


def _get(url: str, max_bytes: int, timeout: float, sockets: _Sockets) -> bytes:
    """The request itself. ``read1`` returns what one socket read brought,
    where ``read(n)`` would wait for all ``n`` bytes."""
    deadline = time.monotonic() + timeout
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with _open(request, timeout, sockets) as response:
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
