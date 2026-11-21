"""The outbound GET names itself: Cloudflare refuses urllib's default User-Agent."""
import io
from unittest import mock

from application import bounded_get as module


class _Response(io.BytesIO):
    status = 200


def test_the_request_carries_the_app_user_agent():
    with mock.patch.object(module.urllib.request, 'urlopen',
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
            mock.patch.object(module.urllib.request, 'urlopen',
                              return_value=_Trickle(clock)):
        with pytest.raises(TimeoutError):
            module.bounded_get('https://slow.example', 100, timeout=5)
    assert clock[0] <= 7


def test_a_body_is_read_whole_across_chunks():
    with mock.patch.object(module.urllib.request, 'urlopen',
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
        assert time.monotonic() - started < 2
    finally:
        server.shutdown()
        server.server_close()
