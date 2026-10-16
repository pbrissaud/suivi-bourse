"""Whether a newer release is out (#1237): the comparison and the cadence."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from application import update_check

NOW = datetime(2026, 10, 16, 12, tzinfo=timezone.utc)
NOTES = 'https://github.com/pbrissaud/suivi-bourse/releases/tag/v5.3.0'


def _release(tag='v5.3.0', url=NOTES):
    return {'tag_name': tag, 'html_url': url}


def test_a_newer_stable_release_is_named_with_its_notes():
    assert update_check.newer(_release(), '5.2.0') == {'version': '5.3.0', 'url': NOTES}


@pytest.mark.parametrize('release, running', [
    (_release('v5.2.0'), '5.2.0'),                 # up to date
    (_release('v5.1.0'), '5.2.0'),                 # older
    (_release('v5.3.0rc1'), '5.2.0'),              # pre-release
    (_release('latest'), '5.2.0'),                 # not a version
    (_release(), 'deadbeef'),                      # running is not one either
    (_release(), None),                            # no version to compare
    (_release(url='https://evil.example/x'), '5.2.0'),  # a link we do not draw
    ({'message': 'API rate limit exceeded'}, '5.2.0'),
    (None, '5.2.0'),
])
def test_anything_else_is_nothing(release, running):
    assert update_check.newer(release, running) is None


def test_one_attempt_per_six_hours_whatever_its_outcome():
    calls = []

    def fetch(url):
        calls.append(url)
        if len(calls) == 1:
            raise OSError('HTTP 403')
        return json.dumps(_release()).encode()

    checker = update_check.Checker(fetch)
    assert checker.latest('5.2.0', NOW) is None
    assert checker.latest('5.2.0', NOW + timedelta(hours=5, minutes=59)) is None
    assert calls == [update_check.URL]

    assert checker.latest('5.2.0', NOW + update_check.EVERY) == {'version': '5.3.0', 'url': NOTES}
    assert checker.latest('5.2.0', NOW + timedelta(hours=7)) == {'version': '5.3.0', 'url': NOTES}
    assert len(calls) == 2


def test_a_body_that_is_not_a_release_is_a_failed_check():
    checker = update_check.Checker(lambda url: b'[]')
    assert checker.latest('5.2.0', NOW) is None


class _Response:
    def __init__(self, status, body):
        self.status, self._body = status, body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, limit):
        return self._body[:limit]


def test_http_fetch_refuses_an_error_or_an_oversized_body(monkeypatch):
    replies = iter([_Response(200, b'{}'), _Response(500, b''),
                    _Response(200, b'x' * (update_check.MAX_BYTES + 1))])
    monkeypatch.setattr(update_check.urllib.request, 'urlopen',
                        lambda request, timeout: next(replies))
    assert update_check.http_fetch(update_check.URL) == b'{}'
    for _ in range(2):
        with pytest.raises(OSError):
            update_check.http_fetch(update_check.URL)
