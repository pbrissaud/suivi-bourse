"""*Tester la connexion*: ``POST /api/agent/test`` (#1115).

The provider is an ``httpx2.MockTransport``: what is asserted is the request the
route makes with the stored config, and what it says of each answer. The key
must appear in neither the response nor the log.
"""
import functools
import logging

import httpx2
import pytest

from api import create_app
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
    assert answer.get_json() == {
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
    assert body['reason'] == 'refused'
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
    assert KEY[-4:] not in answer.get_data(as_text=True)
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


def test_a_test_writes_nothing(client, monkeypatch):
    configured(client, provider='anthropic', key=KEY)
    before = client.get('/api/agent/config').get_json()
    provider(monkeypatch, lambda request: httpx2.Response(
        200, json={'data': [{'id': 'claude-x'}]}))

    client.post('/api/agent/test')

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
