"""``GET /api/system/release``: a release build asks, everything else is ``null`` (#1237)."""
import json

import pytest

from application import build_info, settings, store, update_check
from application import main
from api import create_app

NOTES = 'https://github.com/pbrissaud/suivi-bourse/releases/tag/v5.3.0'
RELEASE = build_info.describe({'RELEASE_VERSION': '5.2.0', 'SOURCE_COMMIT': 'deadbeef'})


@pytest.fixture
def client(tmp_path):
    opened = store.open_store(tmp_path / 'store.duckdb')
    runtime = main.Runtime(main.ConfigurationManager(config_dir=str(tmp_path),
                                                     opened_store=opened), None)
    runtime.store = opened
    calls = []

    def fetch(url):
        calls.append(url)
        return json.dumps({'tag_name': 'v5.3.0', 'html_url': NOTES}).encode()

    def build(build=RELEASE, on=True):
        runtime.build = build
        if not on:
            settings.save(opened, {'update_check': False})
        app = create_app(runtime)
        app.config['RELEASE_CHECKER'] = update_check.Checker(fetch)
        return app.test_client()

    build.calls = calls
    yield build
    opened.close()


def test_a_release_build_names_the_newer_release_once(client):
    http = client()
    expected = {'latest': {'version': '5.3.0', 'url': NOTES}}
    assert http.get('/api/system/release').get_json() == expected
    assert http.get('/api/system/release').get_json() == expected
    assert client.calls == [update_check.URL]


@pytest.mark.parametrize('build', [
    build_info.describe({'SOURCE_COMMIT': 'deadbeef'}),
    build_info.describe({}, checkout='deadbeef'),
    build_info.UNSTAMPED,
])
def test_a_build_with_no_version_never_asks(client, build):
    assert client(build).get('/api/system/release').get_json() == {'latest': None}
    assert client.calls == []


def test_the_dial_off_means_no_request_at_all(client):
    assert client(on=False).get('/api/system/release').get_json() == {'latest': None}
    assert client.calls == []
