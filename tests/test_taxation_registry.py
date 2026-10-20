"""The taxation registry the docs site publishes, and the one route that reads it (#1290)."""
import importlib.util
import json
from pathlib import Path

import pytest

from application import taxation, taxation_registry
from test_web_api import build_client_and_store

ROOT = Path(__file__).resolve().parents[1]
PUBLISHED = ROOT / 'website' / 'static' / 'taxation.json'

_spec = importlib.util.spec_from_file_location(
    'sync_taxation_registry', ROOT / 'scripts' / 'sync_taxation_registry.py')
sync_taxation_registry = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync_taxation_registry)

FLAT = {'id': 'xx/flat', 'country': 'XX', 'name': 'Flat', 'kind': 'flat_realised',
        'parameters': {'rate': 0.3}}
FUTURE = {'id': 'xx/new', 'country': 'XX', 'name': 'New', 'kind': 'a_kind_from_later',
          'parameters': {}}


def _serving(data):
    return lambda url: data if isinstance(data, bytes) else json.dumps(data).encode()


def test_the_published_file_is_generated_from_the_country_files():
    assert PUBLISHED.read_text(encoding='utf-8') == sync_taxation_registry.render(), \
        'run: uv run python scripts/sync_taxation_registry.py'


def test_every_published_item_passes_validate_and_none_has_a_null_model():
    items = json.loads(PUBLISHED.read_text(encoding='utf-8'))
    assert items
    for item in items:
        assert taxation.validate(item['kind'], item['parameters']) == item['parameters']
    countries = [json.loads(p.read_text(encoding='utf-8')) for p in (ROOT / 'website' / 'taxation').glob('*.json')]
    importable = {w['id'] for c in countries for w in c['wrappers'] if w['model'] is not None}
    assert {i['id'] for i in items} == importable


def test_a_refused_item_is_listed_with_its_reason_and_the_rest_stays():
    items = taxation_registry.fetch(_serving([FLAT, FUTURE]))
    assert items[0] == {**FLAT, 'refused': None}
    assert 'a_kind_from_later' in items[1]['refused']


@pytest.mark.parametrize('body', [b'not json', b'{}'])
def test_a_registry_that_is_not_a_list_fails(body):
    with pytest.raises(taxation_registry.FetchFailed):
        taxation_registry.fetch(_serving(body))


def test_an_entry_that_is_not_an_item_is_skipped():
    assert taxation_registry.fetch(_serving([1, {'id': 3}, {**FLAT, 'name': '  '}])) == []


def test_the_first_of_two_items_sharing_an_id_wins():
    items = taxation_registry.fetch(_serving([FLAT, {**FLAT, 'name': 'Other'}]))
    assert [i['name'] for i in items] == ['Flat']


def test_an_exception_of_the_fetcher_is_a_failed_fetch():
    def fails(url):
        raise OSError('HTTP 404')

    with pytest.raises(taxation_registry.FetchFailed, match='HTTP 404'):
        taxation_registry.fetch(fails)


@pytest.fixture
def http(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    return client


def test_the_route_lists_and_stores_nothing(http):
    http.application.config['TAXATION_REGISTRY_FETCH'] = _serving([FLAT, FUTURE])

    answer = http.post('/api/taxation-models/registry')

    assert answer.status_code == 200
    assert [i['id'] for i in answer.get_json()['items']] == ['xx/flat', 'xx/new']
    assert http.get('/api/taxation-models').get_json()['models'] == []


def test_a_failed_fetch_is_a_502_and_the_models_stay_writable(http):
    def fails(url):
        raise OSError('HTTP 503')

    http.application.config['TAXATION_REGISTRY_FETCH'] = fails
    answer = http.post('/api/taxation-models/registry')
    assert answer.status_code == 502 and 'HTTP 503' in answer.get_json()['detail']
    assert http.post('/api/taxation-models', json={
        'name': 'Mine', 'kind': 'flat_realised', 'parameters': {'rate': 0.1}}).status_code == 201


def test_reading_the_models_never_fetches(http):
    def never(url):
        raise AssertionError(f'fetched {url}')

    http.application.config['TAXATION_REGISTRY_FETCH'] = never
    assert http.get('/api/taxation-models').status_code == 200
