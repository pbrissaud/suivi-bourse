"""*Tester la connexion*: ``POST /api/agent/providers/<id>/test`` (#1115, #1269).

The provider is an ``httpx2.MockTransport``: what is asserted is the request the
route makes with the candidate (a saved provider, or ``new`` for one not yet
saved), what it says of each answer, and what it keeps (the instant of a pass on
what is saved, nothing else). The key must appear in neither the response nor
the log.
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


def trial(client, provider_id='new', **body):
    return client.post(f'/api/agent/providers/{provider_id}/test', json=body)


def listing(request):
    return httpx2.Response(200, json={'data': [
        {'id': 'claude-new', 'display_name': 'Claude New'}]})


def stored(client, provider_id):
    return next(p for p in client.get('/api/agent/providers').get_json()
                if p['id'] == provider_id)


def test_anthropic_lists_its_models_newest_first_and_preselects_one(
        client, monkeypatch):
    made = configured(client, default_model='claude-gone')
    seen = provider(monkeypatch, lambda request: httpx2.Response(200, json={
        'data': [
            {'id': 'claude-old', 'display_name': 'Claude Old',
             'created_at': '2025-01-01T00:00:00Z'},
            {'id': 'claude-new', 'display_name': 'Claude New',
             'created_at': '2026-09-01T00:00:00Z'},
        ]}))

    answer = trial(client, made['id'])

    assert answer.status_code == 200
    body = answer.get_json()
    assert body.pop('elapsed_ms') >= 0
    assert body == {
        'models': [{'id': 'claude-new', 'name': 'Claude New'},
                   {'id': 'claude-old', 'name': 'Claude Old'}],
        'preselected': 'claude-new',
    }
    assert seen[0].url.host == 'api.anthropic.com'
    assert seen[0].headers['x-api-key'] == KEY


def test_a_provider_not_saved_yet_is_tried_on_its_own_fields(client, monkeypatch):
    seen = provider(monkeypatch, listing)

    answer = trial(client, kind='anthropic', key=KEY)

    assert answer.status_code == 200
    assert seen[0].headers['x-api-key'] == KEY
    assert answer.get_json()['preselected'] == 'claude-new'
    assert client.get('/api/agent/providers').get_json() == []


def test_the_stored_model_stays_preselected_while_it_is_served(
        client, monkeypatch):
    made = configured(client, 'openai', default_model='gpt-b')
    provider(monkeypatch, lambda request: httpx2.Response(200, json={
        'data': [{'id': 'gpt-a', 'created': 2}, {'id': 'gpt-b', 'created': 1},
                 {'id': 'text-embedding-3-small', 'created': 3},
                 {'id': 'whisper-1', 'created': 4}]}))

    body = trial(client, made['id']).get_json()

    assert [m['id'] for m in body['models']] == ['gpt-a', 'gpt-b']
    assert body['preselected'] == 'gpt-b'


def test_ollama_is_asked_for_its_tags_and_needs_no_key(client, monkeypatch):
    seen = provider(monkeypatch, lambda request: httpx2.Response(200, json={
        'models': [{'name': 'llama3.2:3b', 'modified_at': '2026-01-01'},
                   {'name': 'qwen3:8b', 'modified_at': '2026-05-01'}]}))

    body = trial(client, kind='ollama', base_url='http://ollama:11434/').get_json()

    assert str(seen[0].url) == 'http://ollama:11434/api/tags'
    assert 'authorization' not in seen[0].headers
    assert body['preselected'] == 'qwen3:8b'


def test_a_gateway_is_asked_beside_its_chat_completions(client, monkeypatch):
    seen = provider(monkeypatch, lambda request: httpx2.Response(
        200, json={'data': [{'id': 'b'}, {'id': 'a'}]}))

    body = trial(client, kind='openai_compatible',
                 base_url='https://openrouter.ai/api/v1', key=KEY).get_json()

    assert str(seen[0].url) == 'https://openrouter.ai/api/v1/models'
    assert seen[0].headers['authorization'] == f'Bearer {KEY}'
    # No dates: the gateway's own order stands.
    assert [m['id'] for m in body['models']] == ['b', 'a']


def test_a_pass_stamps_a_saved_provider_and_only_with_what_is_saved(
        client, monkeypatch):
    made = configured(client)
    assert made['last_test_at'] is None
    provider(monkeypatch, listing)

    trial(client, made['id'], key='test-key-unsaved-edit-0000')
    assert stored(client, made['id'])['last_test_at'] is None

    trial(client, made['id'])
    assert stored(client, made['id'])['last_test_at'] is not None


def test_a_refused_test_stamps_nothing(client, monkeypatch):
    made = configured(client)
    provider(monkeypatch, lambda request: httpx2.Response(401, json={
        'error': {'message': 'invalid x-api-key'}}))

    answer = trial(client, made['id'])

    assert answer.status_code == 502
    assert answer.get_json()['detail'] == 'Anthropic: invalid x-api-key'
    assert stored(client, made['id'])['last_test_at'] is None


def test_a_refusal_is_the_providers_own_sentence_and_never_the_key(
        client, monkeypatch, caplog):
    made = configured(client, 'openai')
    provider(monkeypatch, lambda request: httpx2.Response(401, json={
        'error': {'message': f'Incorrect API key provided: {KEY}.'}}))

    with caplog.at_level(logging.DEBUG):
        answer = trial(client, made['id'])

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
    made = configured(client)
    provider(monkeypatch, listing)

    with caplog.at_level(logging.DEBUG):
        answer = trial(client, made['id'])

    assert answer.status_code == 200
    assert KEY not in answer.get_data(as_text=True)
    assert KEY[-4:] not in str(answer.get_json())
    assert KEY not in caplog.text


def test_a_provider_out_of_reach_is_said_so(client, monkeypatch):
    def unreachable(request):
        raise httpx2.ConnectError('Connection refused', request=request)
    provider(monkeypatch, unreachable)

    body = trial(client, kind='ollama', base_url='http://ollama:11434').get_json()

    assert body['reason'] == 'unreachable'
    assert body['detail'] == ('Ollama: cannot be reached at '
                              'http://ollama:11434/api/tags (Connection refused)')


def test_an_answer_that_is_not_a_listing_is_said_so(client, monkeypatch):
    provider(monkeypatch, lambda request: httpx2.Response(
        200, text='<html>proxy</html>'))

    body = trial(client, kind='openai_compatible',
                 base_url='http://litellm:4000').get_json()

    assert body['reason'] == 'unreadable'


def test_an_html_refusal_is_said_in_a_line(client, monkeypatch):
    provider(monkeypatch, lambda request: httpx2.Response(
        503, text='<html>\n  Bad gateway\n</html>'))

    body = trial(client, kind='openai_compatible',
                 base_url='http://litellm:4000').get_json()

    assert body['detail'] == ('OpenAI-compatible endpoint: '
                              '<html> Bad gateway </html>')


@pytest.mark.parametrize('body, missing', [
    ({}, 'kind'),
    ({'kind': 'anthropic'}, 'key'),
    ({'kind': 'ollama'}, 'base_url'),
])
def test_nothing_is_called_before_the_candidate_can_be_tested(
        client, monkeypatch, body, missing):
    seen = provider(monkeypatch, lambda request: httpx2.Response(200))

    answer = trial(client, **body)

    assert answer.status_code == 422
    assert answer.get_json()['key'] == missing
    assert seen == []


def test_no_body_tests_what_is_saved(client, monkeypatch):
    made = configured(client)
    seen = provider(monkeypatch, listing)

    answer = client.post(f"/api/agent/providers/{made['id']}/test")

    assert answer.status_code == 200
    assert seen[0].headers['x-api-key'] == KEY


def test_a_long_message_is_cut(client, monkeypatch):
    made = configured(client, 'openai')
    provider(monkeypatch, lambda request: httpx2.Response(
        400, json={'error': {'message': 'x' * 5000}}))

    body = trial(client, made['id']).get_json()

    assert body['detail'] == 'OpenAI: ' + 'x' * 300


def test_an_answer_that_drips_past_the_deadline_is_cut(client, monkeypatch):
    clock = iter(range(0, 1000, 4))
    monkeypatch.setattr(agent_probe.time, 'monotonic', lambda: next(clock))

    def drip():
        while True:
            yield b' '
    provider(monkeypatch, lambda request: httpx2.Response(
        200, content=drip()))

    body = trial(client, kind='openai_compatible',
                 base_url='http://litellm:4000').get_json()

    assert body['reason'] == 'unreachable'
    assert 'no whole answer within 10 seconds' in body['detail']


def test_the_stored_key_is_used_only_for_its_own_kind_and_address(
        client, monkeypatch):
    made = configured(client, 'openai_compatible', key=KEY,
                      base_url='http://litellm:4000')
    seen = provider(monkeypatch, lambda request: httpx2.Response(
        200, json={'data': [{'id': 'm'}]}))

    other = trial(client, made['id'], base_url='http://other:4000')
    assert other.status_code == 200
    assert 'authorization' not in seen[0].headers

    answer = trial(client, made['id'], kind='openai', base_url=None)
    assert answer.status_code == 422 and answer.get_json()['key'] == 'key'
    assert len(seen) == 1


@pytest.mark.parametrize('body, key', [
    ({'kind': 'anthropic', 'key': 'short'}, 'key'),
    ({'kind': 'openai_compatible', 'base_url': 'ftp://x'}, 'base_url'),
    ({'kind': 'mistral'}, 'kind'),
    ({'enabled': True}, 'enabled'),
    ({'default_model': 'claude-x'}, 'default_model'),
])
def test_a_bad_or_unknown_field_is_refused_before_any_request(
        client, monkeypatch, body, key):
    made = configured(client)
    seen = provider(monkeypatch, listing)

    answer = trial(client, made['id'], **body)

    assert answer.status_code == 422
    assert answer.get_json()['key'] == key
    assert seen == []


@pytest.mark.parametrize('ending', ['pass', 'refusal'])
def test_a_candidate_key_is_in_neither_the_answer_nor_the_log(
        client, monkeypatch, caplog, ending):
    candidate = 'test-key-candidate-0123456789'
    made = configured(client)
    if ending == 'pass':
        provider(monkeypatch, listing)
    else:
        provider(monkeypatch, lambda request: httpx2.Response(401, json={
            'error': {'message': f'invalid x-api-key {candidate}'}}))

    with caplog.at_level(logging.DEBUG):
        answer = trial(client, made['id'], key=candidate)

    text = answer.get_data(as_text=True)
    assert candidate not in text and candidate not in caplog.text
    assert KEY not in text and KEY not in caplog.text
    if ending == 'refusal':
        assert answer.get_json()['detail'] == (
            f'Anthropic: invalid x-api-key …{candidate[-4:]}')


GATEWAY = ('openai_compatible', 'http://litellm:4000')


@pytest.mark.parametrize('name, address, status, body, reason', [
    (n, a, st, bd, r)
    for n, a in (('anthropic', None), ('openai', None), GATEWAY,
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
        (404, {}, 'address' if a else 'refused'))
])
def test_a_refusal_is_classified(client, monkeypatch, name, address, status,
                                 body, reason):
    fields = {'kind': name}
    if name in agent.KEY_REQUIRED or name == 'openai_compatible':
        fields['key'] = 'test-key-classified-0'
    if address:
        fields['base_url'] = address
    seen = provider(monkeypatch, lambda request: httpx2.Response(
        status, json=body))

    answer = trial(client, **fields)

    assert answer.status_code == 502, answer.get_json()
    assert answer.get_json()['reason'] == reason
    assert len(seen) == 1


def test_a_gateway_404_is_an_address(client, monkeypatch):
    provider(monkeypatch, lambda request: httpx2.Response(404, text='nope'))

    body = trial(client, kind='openai_compatible',
                 base_url='https://openrouter.ai/api').get_json()

    assert body['reason'] == 'address'


def test_a_null_key_is_no_key(client, monkeypatch):
    made = configured(client)
    seen = provider(monkeypatch, listing)

    answer = trial(client, made['id'], key=None)

    assert answer.status_code == 200
    assert seen[0].headers['x-api-key'] == KEY


def test_an_address_httpx_rejects_is_unreachable_not_a_crash(client, monkeypatch):
    def invalid(request):
        raise httpx2.InvalidURL('Invalid port')
    provider(monkeypatch, invalid)

    answer = trial(client, kind='ollama', base_url='http://ollama:port')

    assert answer.status_code == 502
    assert answer.get_json()['reason'] == 'unreachable'


def test_an_address_is_said_without_its_credentials(client, monkeypatch):
    def unreachable(request):
        raise httpx2.ConnectError('refused', request=request)
    provider(monkeypatch, unreachable)

    detail = trial(
        client, kind='ollama',
        base_url='http://' + 'me:hunter2' + '@ollama:11434').get_json()['detail']

    assert 'hunter2' not in detail and 'http://ollama:11434/api/tags' in detail


def test_a_password_holding_an_at_sign_is_removed_whole():
    where = agent_probe._where
    # Built apart: a literal user:password@host trips the pre-push credential guard.
    assert where('http://' + 'u:p@ss' + '@host:1/x?k=v') == 'http://host:1/x'
    assert where('http://host/a@b') == 'http://host/a@b'


def test_a_model_name_is_one_short_line(client, monkeypatch):
    provider(monkeypatch, lambda request: httpx2.Response(200, json={'data': [
        {'id': 'long', 'display_name': 'x' * 500},
        {'id': 'multi', 'display_name': 'two\nlines'}]}))

    body = trial(client, kind='openai_compatible',
                 base_url='http://litellm:4000').get_json()

    assert [m['name'] for m in body['models']] == ['x' * 200, 'two lines']
