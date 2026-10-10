"""``GET /api/theme.css``: Atelier unless ``SB_TWEAKCN_THEME`` names a theme (#1130)."""
import json
import logging
from pathlib import Path

import pytest

from api import api as api_module
from api import create_app

CLAUDE = (Path(__file__).resolve().parent / 'fixtures' / 'tweakcn-claude.json').read_bytes()


def _raises(url):
    raise ConnectionError(url)


@pytest.fixture
def client(tmp_path):
    def build(theme_id, fetch):
        api_module._served = None
        app = create_app(None)
        app.config.update(TWEAKCN_THEME=theme_id, TWEAKCN_CACHE_DIR=tmp_path,
                          TWEAKCN_FETCH=fetch)
        return app.test_client()
    yield build
    api_module._served = None


def test_unset_serves_the_default_without_fetching(client):
    def never(url):
        raise AssertionError(url)

    response = client(None, never).get('/api/theme.css')
    assert response.status_code == 200
    assert response.get_data(as_text=True) == '/* default theme */'
    assert response.mimetype == 'text/css'
    assert response.headers['Cache-Control'] == 'no-cache'


def test_a_named_theme_is_served_and_fetched_once(client):
    calls = []

    def fetch(url):
        calls.append(url)
        return CLAUDE

    http = client('claude', fetch)
    body = http.get('/api/theme.css').get_data(as_text=True)
    http.get('/api/theme.css')
    primary = json.loads(CLAUDE)['cssVars']['light']['primary']
    assert 'html:root{\n' in body and f'--primary: {primary};' in body
    assert calls == ['https://tweakcn.com/r/themes/claude']


@pytest.mark.parametrize('cached', [True, False])
def test_a_failed_fetch_serves_the_cache_or_the_default_and_warns_once(
        client, tmp_path, caplog, cached):
    if cached:
        (tmp_path / 'tweakcn-claude.json').write_bytes(CLAUDE)
    http = client('claude', _raises)
    with caplog.at_level(logging.WARNING):
        bodies = [http.get('/api/theme.css').get_data(as_text=True) for _ in range(2)]
    assert bodies[0] == bodies[1]
    assert ('html:root{' in bodies[0]) is cached
    if not cached:
        assert bodies[0] == '/* default theme */'
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert 'tweakcn theme claude' in warnings[0].getMessage()


@pytest.mark.parametrize('bad', ['../x', 'a' * 65, 'Claude'])
def test_a_bad_id_serves_the_default(client, bad):
    def never(url):
        raise AssertionError(url)

    assert client(bad, never).get('/api/theme.css').get_data(as_text=True) == '/* default theme */'
