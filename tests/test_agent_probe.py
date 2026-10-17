"""*Tester la connexion*: ``POST /api/agent/test`` (#1115, #1269).

The provider is an ``httpx2.MockTransport``: what is asserted is the request the
route makes with the candidate, what it says of each answer, and what it keeps
(a pass only). The key must appear in neither the response nor the log.
"""
import functools
import logging

import httpx2
import pytest

from api import create_app
from application import agent
from application import agent_probe
from test_agent import KEY, configured
from test_mcp_server import build_runtime


@pytest.fixture
def client(tmp_path):
    runtime, _ = build_runtime(tmp_path)
    return create_app(runtime).test_client()


def provider(monkeypatch, answer):
    """Route the probe's one request to ``answer(request)``; keep the requests."""
    seen = []

    def handler(request):
        seen.append(request)
        return answer(request)

    monkeypatch.setattr(agent_probe, 'models', functools.partial(
        agent_probe.models, transport=httpx2.MockTransport(handler)))
    return seen


def test_anthropic_lists_its_models_newest_first_and_preselects_one(
        client, monkeypatch):
    configured(client, provider='anthropic', key=KEY)
    seen = provider(monkeypatch, lambda request: httpx2.Response(200, json={
        'data': [
            {'id': 'claude-old', 'display_name': 'Claude Old',
             'created_at': '2025-01-01T00:00:00Z'},
            {'id': 'claude-new', 'display_name': 'Claude New',
             'created_at': '2026-09-01T00:00:00Z'},
        ]}))

    answer = client.post('/api/agent/test')

    assert answer.status_code == 200
    body = answer.get_json()
    assert body.pop('config') == client.get('/api/agent/config').get_json()
    assert body == {
        'provider': 'anthropic',
        'models': [{'id': 'claude-new', 'name': 'Claude New'},
                   {'id': 'claude-old', 'name': 'Claude Old'}],
        'preselected': 'claude-new',
    }
    assert seen[0].url.host == 'api.anthropic.com'
    assert seen[0].headers['x-api-key'] == KEY


def test_the_stored_model_stays_preselected_while_it_is_served(
        client, monkeypatch):
    configured(client, provider='openai', model='gpt-b', key=KEY)
    provider(monkeypatch, lambda request: httpx2.Response(200, json={
        'data': [{'id': 'gpt-a', 'created': 2}, {'id': 'gpt-b', 'created': 1},
                 {'id': 'text-embedding-3-small', 'created': 3},
                 {'id': 'whisper-1', 'created': 4}]}))

    body = client.post('/api/agent/test').get_json()

    assert [m['id'] for m in body['models']] == ['gpt-a', 'gpt-b']
    assert body['preselected'] == 'gpt-b'


def test_ollama_is_asked_for_its_tags_and_needs_no_key(client, monkeypatch):
    configured(client, provider='ollama', base_url='http://ollama:11434/')
    seen = provider(monkeypatch, lambda request: httpx2.Response(200, json={
        'models': [{'name': 'llama3.2:3b', 'modified_at': '2026-01-01'},
                   {'name': 'qwen3:8b', 'modified_at': '2026-05-01'}]}))

    body = client.post('/api/agent/test').get_json()

    assert str(seen[0].url) == 'http://ollama:11434/api/tags'
    assert 'authorization' not in seen[0].headers
    assert body['preselected'] == 'qwen3:8b'


def test_a_gateway_is_asked_beside_its_chat_completions(client, monkeypatch):
    configured(client, provider='openai_compatible',
               base_url='https://openrouter.ai/api/v1', key=KEY)
    seen = provider(monkeypatch, lambda request: httpx2.Response(
        200, json={'data': [{'id': 'b'}, {'id': 'a'}]}))

    body = client.post('/api/agent/test').get_json()

    assert str(seen[0].url) == 'https://openrouter.ai/api/v1/models'
    assert seen[0].headers['authorization'] == f'Bearer {KEY}'
    # No dates: the gateway's own order stands.
    assert [m['id'] for m in body['models']] == ['b', 'a']


def test_a_refusal_is_the_providers_own_sentence_and_never_the_key(
        client, monkeypatch, caplog):
    configured(client, provider='openai', key=KEY)
    provider(monkeypatch, lambda request: httpx2.Response(401, json={
        'error': {'message': f'Incorrect API key provided: {KEY}.'}}))

    with caplog.at_level(logging.DEBUG):
        answer = client.post('/api/agent/test')

    assert answer.status_code == 502
    assert answer.mimetype == 'application/problem+json'
    body = answer.get_json()
    assert body['type'] == '/problems/provider-refused'
    assert body['reason'] == 'key'
    assert body['provider'] == 'OpenAI'
    assert body['detail'] == f'OpenAI: Incorrect API key provided: …{KEY[-4:]}.'
    assert KEY not in answer.get_data(as_text=True)
    assert KEY not in caplog.text
    assert f'…{KEY[-4:]}' in caplog.text


def test_a_success_names_no_key_in_its_answer_or_its_log(
        client, monkeypatch, caplog):
    configured(client, provider='anthropic', key=KEY)
    provider(monkeypatch, lambda request: httpx2.Response(
        200, json={'data': [{'id': 'claude-x'}]}))

    with caplog.at_level(logging.DEBUG):
        answer = client.post('/api/agent/test')

    assert answer.status_code == 200
    assert KEY not in answer.get_data(as_text=True)
    # The last four are the configuration's to show, and nothing else's.
    body = answer.get_json()
    assert body['config']['key']['last4'] == KEY[-4:]
    del body['config']
    assert KEY[-4:] not in str(body)
    assert KEY not in caplog.text


def test_a_provider_out_of_reach_is_said_so(client, monkeypatch):
    configured(client, provider='ollama', base_url='http://ollama:11434')

    def unreachable(request):
        raise httpx2.ConnectError('Connection refused', request=request)
    provider(monkeypatch, unreachable)

    body = client.post('/api/agent/test').get_json()

    assert body['reason'] == 'unreachable'
    assert body['detail'] == ('Ollama: cannot be reached at '
                              'http://ollama:11434/api/tags (Connection refused)')


def test_an_answer_that_is_not_a_listing_is_said_so(client, monkeypatch):
    configured(client, provider='openai_compatible',
               base_url='http://litellm:4000')
    provider(monkeypatch, lambda request: httpx2.Response(
        200, text='<html>proxy</html>'))

    body = client.post('/api/agent/test').get_json()

    assert body['reason'] == 'unreadable'


def test_an_html_refusal_is_said_in_a_line(client, monkeypatch):
    configured(client, provider='openai_compatible',
               base_url='http://litellm:4000')
    provider(monkeypatch, lambda request: httpx2.Response(
        503, text='<html>\n  Bad gateway\n</html>'))

    body = client.post('/api/agent/test').get_json()

    assert body['detail'] == ('OpenAI-compatible endpoint: '
                              '<html> Bad gateway </html>')


@pytest.mark.parametrize('fields, missing', [
    ({}, 'provider'),
    ({'provider': 'anthropic'}, 'key'),
    ({'provider': 'ollama'}, 'base_url'),
])
def test_nothing_is_called_before_the_config_can_be_tested(
        client, monkeypatch, fields, missing):
    if fields:
        configured(client, **fields)
    seen = provider(monkeypatch, lambda request: httpx2.Response(200))

    answer = client.post('/api/agent/test')

    assert answer.status_code == 422
    assert answer.get_json()['key'] == missing
    assert seen == []


def test_an_empty_body_tests_the_stored_configuration(client, monkeypatch):
    configured(client, provider='anthropic', key=KEY, enabled=True,
               model='claude-x')
    before = client.get('/api/agent/config').get_json()
    seen = provider(monkeypatch, lambda request: httpx2.Response(
        200, json={'data': [{'id': 'claude-x'}]}))

    answer = client.post('/api/agent/test', json={})

    assert answer.status_code == 200
    assert seen[0].headers['x-api-key'] == KEY
    assert answer.get_json()['config'] == before
    assert client.get('/api/agent/config').get_json() == before


def test_a_long_message_is_cut(client, monkeypatch):
    configured(client, provider='openai', key=KEY)
    provider(monkeypatch, lambda request: httpx2.Response(
        400, json={'error': {'message': 'x' * 5000}}))

    body = client.post('/api/agent/test').get_json()

    assert body['detail'] == 'OpenAI: ' + 'x' * 300


def test_an_answer_that_drips_past_the_deadline_is_cut(client, monkeypatch):
    configured(client, provider='openai_compatible',
               base_url='http://litellm:4000')
    clock = iter(range(0, 1000, 4))
    monkeypatch.setattr(agent_probe.time, 'monotonic', lambda: next(clock))

    def drip():
        while True:
            yield b' '
    provider(monkeypatch, lambda request: httpx2.Response(
        200, content=drip()))

    body = client.post('/api/agent/test').get_json()

    assert body['reason'] == 'unreachable'
    assert 'no whole answer within 10 seconds' in body['detail']


def listing(request):
    return httpx2.Response(200, json={'data': [
        {'id': 'claude-new', 'display_name': 'Claude New'}]})


def stored(client):
    return client.get('/api/agent/config').get_json()


def test_a_refused_key_is_not_stored(client, monkeypatch):
    configured(client, provider='anthropic', key=KEY, enabled=True,
               model='claude-x')
    before = stored(client)
    provider(monkeypatch, lambda request: httpx2.Response(401, json={
        'type': 'error', 'error': {'type': 'authentication_error',
                                   'message': 'invalid x-api-key'}}))

    answer = client.post('/api/agent/test', json={
        'provider': 'anthropic', 'key': 'test-key-the-wrong-one'})

    assert answer.status_code == 502
    assert answer.get_json()['reason'] == 'key'
    assert answer.get_json()['detail'] == 'Anthropic: invalid x-api-key'
    assert stored(client) == before
    assert before['key']['last4'] == 'abcd' and before['enabled'] is True


def test_a_failed_test_on_another_provider_keeps_the_stored_one(
        client, monkeypatch):
    configured(client, provider='anthropic', key=KEY, enabled=True,
               model='claude-x')
    before = stored(client)
    provider(monkeypatch, lambda request: httpx2.Response(403, json={
        'error': {'message': 'unsupported region'}}))

    answer = client.post('/api/agent/test', json={
        'provider': 'openai', 'key': 'test-key-for-openai-0'})

    assert answer.get_json()['reason'] == 'refused'
    assert stored(client) == before


def test_a_passed_key_is_stored_and_switches_the_agent_off(
        client, monkeypatch):
    configured(client, provider='anthropic', key=KEY, enabled=True,
               model='claude-x')
    provider(monkeypatch, listing)

    answer = client.post('/api/agent/test', json={
        'provider': 'anthropic', 'key': 'test-key-the-new-one-wxyz'})

    body = answer.get_json()
    assert answer.status_code == 200
    assert body['config']['key']['last4'] == 'wxyz'
    assert body['config']['enabled'] is False
    assert body['config']['model'] == 'claude-x'
    assert body['models'] == [{'id': 'claude-new', 'name': 'Claude New'}]
    assert body['preselected'] == 'claude-new'
    assert stored(client) == body['config']


def test_the_same_key_keeps_the_agent_on(client, monkeypatch):
    configured(client, provider='anthropic', key=KEY, enabled=True,
               model='claude-x')
    before = stored(client)
    provider(monkeypatch, listing)

    client.post('/api/agent/test', json={'provider': 'anthropic', 'key': KEY})

    assert stored(client) == before


def test_a_move_clears_the_model_and_its_name(client, monkeypatch):
    configured(client, provider='anthropic', key=KEY, enabled=True,
               model='claude-x', model_name='Claude X')
    provider(monkeypatch, lambda request: httpx2.Response(
        200, json={'data': [{'id': 'gpt-a'}]}))

    body = client.post('/api/agent/test', json={
        'provider': 'openai', 'key': 'test-key-for-openai-0'}).get_json()

    assert body['config']['provider'] == 'openai'
    assert body['config']['enabled'] is False
    assert (body['config']['model'], body['config']['model_name']) == (None, None)
    assert body['preselected'] == 'gpt-a'


def test_the_stored_key_is_used_only_for_its_own_provider_and_address(
        client, monkeypatch):
    configured(client, provider='openai_compatible', key=KEY,
               base_url='http://litellm:4000')
    seen = provider(monkeypatch, lambda request: httpx2.Response(
        200, json={'data': [{'id': 'm'}]}))

    other = client.post('/api/agent/test', json={
        'provider': 'openai_compatible', 'base_url': 'http://other:4000'})
    assert other.status_code == 200
    assert 'authorization' not in seen[0].headers

    answer = client.post('/api/agent/test', json={
        'provider': 'openai', 'base_url': None})
    assert answer.status_code == 422 and answer.get_json()['key'] == 'key'
    assert len(seen) == 1


@pytest.mark.parametrize('body, key', [
    ({'provider': 'anthropic', 'key': 'short'}, 'key'),
    ({'provider': 'openai_compatible', 'base_url': 'ftp://x'}, 'base_url'),
    ({'provider': 'mistral'}, 'provider'),
    ({'enabled': True}, 'enabled'),
    ({'model': 'claude-x'}, 'model'),
])
def test_a_bad_or_unknown_field_is_refused_before_any_request(
        client, monkeypatch, body, key):
    configured(client, provider='anthropic', key=KEY)
    before = stored(client)
    seen = provider(monkeypatch, listing)

    answer = client.post('/api/agent/test', json=body)

    assert answer.status_code == 422
    assert answer.get_json()['key'] == key
    assert seen == [] and stored(client) == before


def test_a_row_changed_during_the_probe_is_not_written(client, monkeypatch):
    configured(client, provider='anthropic', key=KEY, enabled=True,
               model='claude-x')

    def changes_the_row(request):
        client.put('/api/agent/config', json={'enabled': False})
        client.delete('/api/agent/key')
        return listing(request)
    provider(monkeypatch, changes_the_row)

    answer = client.post('/api/agent/test', json={
        'provider': 'anthropic', 'key': 'test-key-the-new-one-wxyz'})

    assert answer.status_code == 409
    assert answer.get_json()['type'] == '/problems/conflict'
    assert stored(client)['key'] == {'set': False, 'last4': None, 'set_at': None}


@pytest.mark.parametrize('ending', ['pass', 'refusal'])
def test_a_candidate_key_is_in_neither_the_answer_nor_the_log(
        client, monkeypatch, caplog, ending):
    candidate = 'test-key-candidate-0123456789'
    configured(client, provider='anthropic', key=KEY)
    if ending == 'pass':
        provider(monkeypatch, listing)
    else:
        provider(monkeypatch, lambda request: httpx2.Response(401, json={
            'error': {'message': f'invalid x-api-key {candidate}'}}))

    with caplog.at_level(logging.DEBUG):
        answer = client.post('/api/agent/test', json={
            'provider': 'anthropic', 'key': candidate})

    text = answer.get_data(as_text=True)
    assert candidate not in text and candidate not in caplog.text
    assert KEY not in text and KEY not in caplog.text
    if ending == 'refusal':
        assert answer.get_json()['detail'] == (
            f'Anthropic: invalid x-api-key …{candidate[-4:]}')


GATEWAY = ('openai_compatible', 'http://litellm:4000')


@pytest.mark.parametrize('name, kind, status, body, reason', [
    (n, k, st, bd, r)
    for n, k in (('anthropic', None), ('openai', None), GATEWAY,
                 ('ollama', 'http://ollama:11434'))
    for st, bd, r in (
        (401, {'error': {'message': 'no'}}, 'key'),
        (402, {'error': {'message': 'pay'}}, 'quota'),
        (400, {'error': {'message': 'Your credit balance is too low'}}, 'quota'),
        (429, {'error': {'code': 'insufficient_quota'}}, 'quota'),
        (429, {'error': {'type': 'rate_limit_error'}}, 'rate_limit'),
        (500, {}, 'overloaded'), (502, {}, 'overloaded'),
        (503, {}, 'overloaded'), (504, {}, 'overloaded'),
        (529, {}, 'overloaded'),
        (403, {'error': {'message': 'region'}}, 'refused'),
        (400, {'error': {'message': 'odd'}}, 'refused'),
        (404, {}, 'address' if k else 'refused'))
])
def test_a_refusal_is_classified(client, monkeypatch, name, kind, status,
                                 body, reason):
    fields = {'provider': name}
    if name in agent.KEY_REQUIRED or name == 'openai_compatible':
        fields['key'] = 'test-key-classified-0'
    if kind:
        fields['base_url'] = kind
    seen = provider(monkeypatch, lambda request: httpx2.Response(
        status, json=body))

    answer = client.post('/api/agent/test', json=fields)

    assert answer.status_code == 502, answer.get_json()
    assert answer.get_json()['reason'] == reason
    assert len(seen) == 1 and stored(client)['key']['set'] is False


def test_a_gateway_404_is_an_address(client, monkeypatch):
    provider(monkeypatch, lambda request: httpx2.Response(404, text='nope'))

    body = client.post('/api/agent/test', json={
        'provider': 'openai_compatible',
        'base_url': 'https://openrouter.ai/api'}).get_json()

    assert body['reason'] == 'address'
