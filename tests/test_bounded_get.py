"""The outbound GET names itself: Cloudflare refuses urllib's default User-Agent."""
import io
from unittest import mock

import pytest

from application import bounded_get as module


@pytest.fixture(autouse=True)
def no_proxy(monkeypatch):
    """The loopback servers here are asked directly, whatever ``*_proxy`` the
    environment carries."""
    monkeypatch.setattr(module.urllib.request, 'getproxies', lambda: {})


class _Response(io.BytesIO):
    status = 200


def test_the_request_carries_the_app_user_agent():
    with mock.patch.object(module, '_open',
                           return_value=_Response(b'[]')) as urlopen:
        assert module.bounded_get('https://docs.example/taxation.json', 10) == b'[]'
    request = urlopen.call_args.args[0]
    assert request.full_url == 'https://docs.example/taxation.json'
    assert request.get_header('User-agent') == module.USER_AGENT


class _Trickle:
    """A body served a byte at a time, each byte a second late."""
    status = 200

    def __init__(self, clock):
        self.clock = clock

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read1(self, n):
        self.clock[0] += 1
        return b'x'


def test_a_body_trickled_past_the_deadline_is_refused():
    import pytest
    clock = [0.0]
    with mock.patch.object(module.time, 'monotonic', lambda: clock[0]), \
            mock.patch.object(module, '_open',
                              return_value=_Trickle(clock)):
        with pytest.raises(TimeoutError):
            module.bounded_get('https://slow.example', 100, timeout=5)
    assert clock[0] <= 7


def test_a_body_is_read_whole_across_chunks():
    with mock.patch.object(module, '_open',
                           return_value=_Response(b'a' * 200_000)):
        assert module.bounded_get('https://docs.example/x', 200_000) == b'a' * 200_000


def test_a_real_server_trickling_its_body_is_cut_at_the_deadline():
    """Over a socket: ``read(n)`` would block until ``n`` bytes came."""
    import http.server
    import threading
    import time

    import pytest

    class Trickle(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Length', '1000')
            self.end_headers()
            for _ in range(1000):
                self.wfile.write(b'x')
                self.wfile.flush()
                time.sleep(0.1)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Trickle)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            module.bounded_get(f'http://127.0.0.1:{server.server_port}/', 10_000,
                               timeout=1)
        assert time.monotonic() - started < 1.5
    finally:
        server.shutdown()
        server.server_close()


def test_a_server_slow_to_send_its_headers_is_cut_at_the_deadline():
    """The bound covers ``urlopen`` too: no header ever comes."""
    import socket
    import time

    import pytest

    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    try:
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            module.bounded_get(f'http://127.0.0.1:{listener.getsockname()[1]}/',
                               100, timeout=0.5)
        assert time.monotonic() - started < 1
    finally:
        listener.close()


def _serving(handler):
    """A local HTTP server running ``handler``'s ``do_GET``; its base URL."""
    import http.server
    import threading

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}'


def test_the_request_is_stopped_at_the_deadline_not_only_left_behind():
    """Headers trickled for ever: past the deadline the worker's socket is
    shut, the worker ends, and the server sees the connection go."""
    import http.server
    import threading
    import time

    import pytest

    gone = threading.Event()

    class Trickle(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            try:
                self.wfile.write(b'HTTP/1.1 200 OK\r\n')
                while True:
                    self.wfile.write(b'X-Slow: x\r\n')
                    self.wfile.flush()
                    time.sleep(0.05)
            except OSError:
                gone.set()

        def log_message(self, *args):
            pass

    before = {t for t in threading.enumerate() if t.name == 'bounded_get'}
    server, base = _serving(Trickle)
    try:
        with pytest.raises(TimeoutError):
            module.bounded_get(f'{base}/', 100, timeout=0.5)
        assert gone.wait(2), 'the server still holds the connection'
        workers = [t for t in threading.enumerate()
                   if t.name == 'bounded_get' and t not in before]
        for worker in workers:
            worker.join(2)
        assert not any(t.is_alive() for t in workers)
    finally:
        server.shutdown()
        server.server_close()


def test_a_redirect_is_still_followed():
    import http.server

    class Moved(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/old':
                self.send_response(302)
                self.send_header('Location', '/new')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'[]')

        def log_message(self, *args):
            pass

    server, base = _serving(Moved)
    try:
        assert module.bounded_get(f'{base}/old', 10) == b'[]'
    finally:
        server.shutdown()
        server.server_close()


def test_a_handshake_started_late_still_ends_by_the_deadline(monkeypatch):
    """Through a proxy slow to answer CONNECT, the TLS handshake starts late,
    on a socket TLS detaches: its own deadline must fall by the request's,
    not ``timeout`` after it started."""
    import socket
    import threading
    import time
    import urllib.error

    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    port = listener.getsockname()[1]
    monkeypatch.setattr(module.urllib.request, 'getproxies',
                        lambda: {'https': f'http://127.0.0.1:{port}'})

    def proxy():
        connection, _ = listener.accept()
        with connection:
            asked = b''
            while b'\r\n\r\n' not in asked:
                asked += connection.recv(4096)
            time.sleep(0.6)
            try:
                connection.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
                # A handshake record announcing 16 kB, then its body in drips.
                record = b'\x16\x03\x03\x40\x00\x02\x00\x3f\xfc'
                for byte in record + b'\x00' * 16380:
                    connection.sendall(bytes([byte]))
                    time.sleep(0.05)
            except OSError:
                pass
    threading.Thread(target=proxy, daemon=True).start()

    before = {t for t in threading.enumerate() if t.name == 'bounded_get'}
    try:
        started = time.monotonic()
        # The handshake's own timeout and the caller's deadline now fall at
        # the same instant: either may be the one raised.
        with pytest.raises((TimeoutError, urllib.error.URLError)):
            module.bounded_get('https://searx.example/', 100, timeout=1)
        workers = [t for t in threading.enumerate()
                   if t.name == 'bounded_get' and t not in before]
        for worker in workers:
            worker.join(2)
        assert not any(t.is_alive() for t in workers)
        # Before, the handshake ran a full timeout from its late start: 1.6 s.
        assert time.monotonic() - started < 1.3, 'the handshake outlived the deadline'
    finally:
        listener.close()
