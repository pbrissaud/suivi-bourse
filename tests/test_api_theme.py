"""The theme in the store (#1248): ``/api/theme`` writes it, ``/api/theme.css`` serves it.

tweakcn is reached by ``POST /api/theme/import`` and by nothing else.
"""
import json
import logging
from pathlib import Path

import duckdb
import pytest

from api import settings as settings_api
from application import tweakcn
from test_web_api import build_client_and_store

ENTRY = json.loads(
    (Path(__file__).resolve().parent / 'fixtures' / 'tweakcn-claude.json').read_text())
STORED = tweakcn.normalize(ENTRY['cssVars'])
SMALL = {'theme': {}, 'light': {'primary': 'red'}, 'dark': {'primary': 'blue'}}


def _never(url):
    raise AssertionError(f'fetched {url}')


@pytest.fixture
def http(tmp_path):
    client, opened = build_client_and_store(tmp_path)
    client.application.config['TWEAKCN_FETCH'] = _never
    client.opened = opened
    return client


def _css(http):
    response = http.get('/api/theme.css')
    assert response.status_code == 200
    assert response.mimetype == 'text/css'
    assert response.headers['Cache-Control'] == 'no-cache'
    return response.get_data(as_text=True)


def test_nothing_stored_reads_null_and_serves_the_default_without_fetching(http):
    assert http.get('/api/theme').get_json() is None
    assert _css(http) == '/* default theme */'


def test_a_put_theme_is_stored_and_served(http):
    answer = http.put('/api/theme', json=SMALL)

    assert answer.status_code == 200 and answer.get_json() == SMALL
    assert http.get('/api/theme').get_json() == SMALL
    assert 'html:root{\n  --primary: red;\n}' in _css(http)


@pytest.mark.parametrize('body, key', [
    ({'light': {'background': 'red; } body { display:none'}, 'dark': {'background': 'x'}},
     'background'),
    ({'light': {'gain': 'red'}, 'dark': {'gain': 'red'}}, 'gain'),
    ({'light': {'tracking-normal': '0em'}, 'dark': {}}, 'tracking-normal'),
])
def test_a_hand_written_body_is_refused_by_name_and_nothing_stored(http, body, key):
    http.put('/api/theme', json=SMALL)

    answer = http.put('/api/theme', json=body)

    assert answer.status_code == 422 and answer.get_json()['key'] == key
    assert http.get('/api/theme').get_json() == SMALL


def test_a_pasted_entry_is_cleaned_and_stores_what_an_import_stores(http):
    unsafe = 'red; } body { display:none'
    pasted = {**ENTRY, 'cssVars': {**ENTRY['cssVars'],
                                   'light': {**ENTRY['cssVars']['light'], 'background': unsafe}}}

    answer = http.put('/api/theme', json=pasted)

    assert answer.status_code == 200
    assert 'background' not in answer.get_json()['light']
    assert 'display:none' not in _css(http)
    assert http.put('/api/theme', json=ENTRY).get_json() == STORED
    http.application.config['TWEAKCN_FETCH'] = lambda url: json.dumps(ENTRY).encode()
    assert http.post('/api/theme/import', json={'id': 'claude'}).get_json() == STORED


def test_an_import_stores_the_theme(http):
    calls = []

    def fetch(url):
        calls.append(url)
        return json.dumps(ENTRY).encode()

    http.application.config['TWEAKCN_FETCH'] = fetch
    answer = http.post('/api/theme/import', json={'id': 'claude'})

    assert answer.status_code == 200 and answer.get_json() == STORED
    assert calls == ['https://tweakcn.com/r/themes/claude']
    http.application.config['TWEAKCN_FETCH'] = _never
    assert f"--primary: {ENTRY['cssVars']['light']['primary']};" in _css(http)


def test_a_bad_id_is_422_and_a_failed_fetch_502_and_nothing_is_overwritten(http):
    http.put('/api/theme', json=SMALL)

    assert http.post('/api/theme/import', json={'id': '../x'}).status_code == 422

    def fails(url):
        raise OSError('HTTP 404')

    http.application.config['TWEAKCN_FETCH'] = fails
    answer = http.post('/api/theme/import', json={'id': 'claude'})
    assert answer.status_code == 502 and 'HTTP 404' in answer.get_json()['detail']
    assert http.get('/api/theme').get_json() == SMALL


def test_delete_goes_back_to_the_default(http):
    http.put('/api/theme', json=SMALL)

    assert http.delete('/api/theme').status_code == 204

    assert http.get('/api/theme').get_json() is None
    assert _css(http) == '/* default theme */'


def test_font_imports_lead_the_stylesheet(http):
    font = {'font-sans': 'Outfit, sans-serif'}
    http.put('/api/theme', json={'light': font, 'dark': font})

    body = _css(http)
    assert body.startswith('@import url("https://fonts.googleapis.com/css2?family=Outfit')
    assert body.index('@import') < body.index('html:root{')


@pytest.mark.parametrize('error', [duckdb.Error('boom'), RuntimeError('boom')])
def test_a_store_error_serves_the_default(http, monkeypatch, caplog, error):
    def broken():
        raise error

    monkeypatch.setattr(settings_api, '_store', broken)
    with caplog.at_level(logging.WARNING):
        assert _css(http) == '/* default theme */'
    assert any('boom' in record.getMessage() for record in caplog.records)


def test_an_unparseable_row_reads_null_and_serves_the_default(http, caplog):
    http.opened.execute("INSERT INTO setting (key, value) VALUES ('theme', 'not json')")

    with caplog.at_level(logging.WARNING):
        assert http.get('/api/theme').get_json() is None
        assert _css(http) == '/* default theme */'
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 2
