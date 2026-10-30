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
