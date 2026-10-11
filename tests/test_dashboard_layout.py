"""The dashboard's saved layout: one ``setting`` row, its shape checked, its cards not.

The front owns the registry of cards (eng review D2), so the server refuses
what is not a layout and keeps an id it has never heard of: the front's
``normalizeLayout`` drops that id on the way back in.
"""
import pytest

from application import dashboard_layout
from test_web_api import build_client_and_store


LAYOUT = {
    'version': 1,
    'blocks': [
        {'id': 'gain-breakdown', 'width': 'half', 'hidden': False},
        {'id': 'rhythm', 'width': 'half', 'hidden': False},
        {'id': 'movers', 'width': 'full', 'hidden': True},
    ],
}


def test_nothing_saved_reads_as_null(tmp_path):
    client, _ = build_client_and_store(tmp_path)

    answer = client.get('/api/dashboard/layout')

    assert answer.status_code == 200
    assert answer.get_json() is None


def test_a_saved_layout_reads_back_as_written(tmp_path):
    client, opened = build_client_and_store(tmp_path)

    assert client.put('/api/dashboard/layout', json=LAYOUT).status_code == 200

    assert client.get('/api/dashboard/layout').get_json() == LAYOUT
    assert dashboard_layout.read(opened) == LAYOUT


def test_a_second_save_replaces_the_first(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    client.put('/api/dashboard/layout', json=LAYOUT)
    smaller = {'version': 1, 'blocks': [
        {'id': 'movers', 'width': 'half', 'hidden': False}]}

    client.put('/api/dashboard/layout', json=smaller)

    assert client.get('/api/dashboard/layout').get_json() == smaller


def test_an_unknown_card_is_kept_for_the_front_to_drop(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    layout = {'version': 1, 'blocks': [
        {'id': 'a-card-from-the-future', 'width': 'full', 'hidden': False}]}

    assert client.put('/api/dashboard/layout', json=layout).status_code == 200
    assert client.get('/api/dashboard/layout').get_json() == layout


def test_extra_fields_are_not_stored(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    layout = {'version': 1, 'extra': 'no', 'blocks': [
        {'id': 'rhythm', 'width': 'half', 'hidden': False, 'colour': 'red'}]}

    client.put('/api/dashboard/layout', json=layout)

    assert client.get('/api/dashboard/layout').get_json() == {
        'version': 1,
        'blocks': [{'id': 'rhythm', 'width': 'half', 'hidden': False}]}


def test_delete_forgets_the_layout(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    client.put('/api/dashboard/layout', json=LAYOUT)

    assert client.delete('/api/dashboard/layout').status_code == 204
    assert client.get('/api/dashboard/layout').get_json() is None


def test_delete_with_nothing_saved_is_still_a_204(tmp_path):
    client, _ = build_client_and_store(tmp_path)

    assert client.delete('/api/dashboard/layout').status_code == 204


def _block(**overrides):
    return {'id': 'rhythm', 'width': 'half', 'hidden': False, **overrides}


@pytest.mark.parametrize('body', [
    None,
    [],
    {'blocks': []},
    {'version': 2, 'blocks': []},
    {'version': '1', 'blocks': []},
    {'version': 1},
    {'version': 1, 'blocks': {}},
    {'version': 1, 'blocks': ['rhythm']},
    {'version': 1, 'blocks': [_block(id='')]},
    {'version': 1, 'blocks': [_block(id='x' * 65)]},
    {'version': 1, 'blocks': [_block(id=7)]},
    {'version': 1, 'blocks': [_block(width='third')]},
    {'version': 1, 'blocks': [_block(hidden='no')]},
    {'version': 1, 'blocks': [_block(hidden=0)]},
    {'version': 1, 'blocks': [_block(), _block()]},
    {'version': 1, 'blocks': [_block(id=f'card-{n}') for n in range(51)]},
], ids=[
    'no-body', 'a-list', 'no-version', 'version-2', 'version-as-text',
    'no-blocks', 'blocks-as-object', 'block-as-text', 'empty-id', 'long-id',
    'numeric-id', 'unknown-width', 'hidden-as-text', 'hidden-as-zero',
    'duplicate-id', 'fifty-one-cards',
])
def test_a_body_that_is_not_a_layout_is_refused_and_nothing_is_written(
        tmp_path, body):
    client, _ = build_client_and_store(tmp_path)
    client.put('/api/dashboard/layout', json=LAYOUT)

    answer = client.put('/api/dashboard/layout', json=body)

    assert answer.status_code == 422
    assert answer.get_json()['detail']
    assert client.get('/api/dashboard/layout').get_json() == LAYOUT


def test_the_exact_bounds_are_accepted(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    layout = {'version': 1, 'blocks': [
        {'id': f'{n:0>64}', 'width': 'full', 'hidden': True}
        for n in range(50)]}

    assert client.put('/api/dashboard/layout', json=layout).status_code == 200


def test_a_stored_value_that_is_not_json_reads_as_null(tmp_path):
    client, opened = build_client_and_store(tmp_path)
    opened.execute(
        'INSERT INTO setting (key, value) VALUES (?, ?)',
        [dashboard_layout.KEY, '{not json'])

    assert client.get('/api/dashboard/layout').get_json() is None


def test_a_write_from_a_foreign_origin_is_refused(tmp_path):
    client, _ = build_client_and_store(tmp_path)

    answer = client.put('/api/dashboard/layout', json=LAYOUT,
                        headers={'Origin': 'https://elsewhere.example'})

    assert answer.status_code == 403
    assert client.get('/api/dashboard/layout').get_json() is None


def test_the_layout_is_not_a_dial_on_the_settings_page(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    client.put('/api/dashboard/layout', json=LAYOUT)

    keys = [one['key'] for one in client.get('/api/settings').get_json()['settings']]

    assert dashboard_layout.KEY not in keys
