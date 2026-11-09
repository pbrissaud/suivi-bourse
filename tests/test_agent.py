"""The agent's providers, its model and its prompt cache (#1114, #1190).

The routes are driven through Flask's test client over a real store, as the
rest of ``/api`` is; no provider is ever called.
"""
import pytest

from api import create_app
from application import agent
from test_mcp_server import build_runtime

KEY = 'test-key-0123456789abcd'


@pytest.fixture
def client(tmp_path):
    runtime, _ = build_runtime(tmp_path)
    return create_app(runtime).test_client()


def configured(client, kind='anthropic', **fields):
    """A default provider that can run, and the agent on. Returns the provider."""
    fields = {'kind': kind, 'default_model': 'claude-sonnet-5-5',
              **({'key': KEY} if kind in agent.KEY_REQUIRED else {}), **fields}
    made = client.post('/api/agent/providers', json=fields)
    assert made.status_code == 201, made.get_json()
    on = client.put('/api/agent/config', json={'enabled': True})
    assert on.status_code == 200, on.get_json()
    return made.get_json()


# ------------------------------------------------------------ the model --

def config(provider, base_url=None, key=KEY):
    return {**agent.BLANK, 'provider': provider,
            'model': 'some-model', 'base_url': base_url, 'api_key': key}


def test_anthropic_is_an_anthropic_model():
    from pydantic_ai.models.anthropic import AnthropicModel
    assert isinstance(agent.build_model(config('anthropic')), AnthropicModel)


def test_openai_and_a_compatible_endpoint_are_both_openai_chat_models():
    from pydantic_ai.models.openai import OpenAIChatModel
    openai = agent.build_model(config('openai'))
    compatible = agent.build_model(
        config('openai_compatible', 'https://openrouter.ai/api/v1'))

    assert isinstance(openai, OpenAIChatModel)
    assert isinstance(compatible, OpenAIChatModel)
    assert compatible.base_url.rstrip('/') == 'https://openrouter.ai/api/v1'


def test_a_compatible_endpoint_runs_without_a_key():
    model = agent.build_model(
        config('openai_compatible', 'http://litellm:4000', key=None))
    assert model.base_url.rstrip('/') == 'http://litellm:4000'


def test_ollama_is_spoken_to_on_its_v1_path():
    from pydantic_ai.models.ollama import OllamaModel
    model = agent.build_model(config('ollama', 'http://ollama:11434/', None))

    assert isinstance(model, OllamaModel)
    assert model.base_url.rstrip('/') == 'http://ollama:11434/v1'


def test_the_prompt_holds_the_two_rules():
    assert 'never recommend' in agent.SYSTEM_PROMPT
    assert 'comes from a tool result' in agent.SYSTEM_PROMPT


def test_the_prompt_names_an_account_by_its_label_and_quotes_no_field():
    assert 'by its `label`, never by its `id`' in agent.SYSTEM_PROMPT
    assert "never quote a tool's field names" in agent.SYSTEM_PROMPT


def test_the_prompt_says_how_to_state_a_return():
    assert 'Lead with the money-weighted return' in agent.SYSTEM_PROMPT


# ------------------------------------------------------ the prompt cache --

ANSWER = {'id': 'msg_1', 'type': 'message', 'role': 'assistant',
          'model': 'claude-sonnet-5-5',
          'content': [{'type': 'text', 'text': 'ok'}],
          'stop_reason': 'end_turn',
          'usage': {'input_tokens': 10, 'output_tokens': 1}}

#: :data:`ANSWER` as the Messages API streams it: Pydantic AI asks Anthropic
#: for a stream even under ``Agent.run``.
ANSWER_EVENTS = [
    ('message_start', {'type': 'message_start', 'message': {
        **ANSWER, 'content': [], 'stop_reason': None}}),
    ('content_block_start', {'type': 'content_block_start', 'index': 0,
                             'content_block': {'type': 'text', 'text': ''}}),
    ('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                             'delta': {'type': 'text_delta', 'text': 'ok'}}),
    ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
    ('message_delta', {'type': 'message_delta',
                       'delta': {'stop_reason': 'end_turn'},
                       'usage': {'output_tokens': 1}}),
    ('message_stop', {'type': 'message_stop'}),
]

CHAT_ANSWER = {'id': 'c1', 'object': 'chat.completion', 'created': 0,
               'model': 'm', 'choices': [{
                   'index': 0, 'finish_reason': 'stop',
                   'message': {'role': 'assistant', 'content': 'ok'}}],
               'usage': {'prompt_tokens': 10, 'completion_tokens': 1,
                         'total_tokens': 11}}


def run_turns(tmp_path, steps):
    """The JSON bodies each step sent, a step being ``(model_for, answer,
    thinking, events)``: a turn that continues the history of the one before,
    over the MCP server's real tools. ``model_for(http_client)`` builds the
    model, ``events`` is what an Anthropic stream carries."""
    import asyncio
    import json

    import httpx2

    from application import mcp_server

    def handler_of(bodies, answer, events):
        def handler(request):
            sent = json.loads(request.content)
            bodies.append(sent)
            if sent.get('stream') and 'system' in sent:
                return httpx2.Response(200, content=''.join(
                    f'event: {name}\ndata: {json.dumps(data)}\n\n'
                    for name, data in events).encode(),
                    headers={'content-type': 'text/event-stream'})
            return httpx2.Response(200, json=answer)
        return handler

    async def run():
        runtime, _ = build_runtime(tmp_path)
        server = mcp_server.build_server(runtime)
        history, sent = [], []
        for model_for, answer, thinking, events in steps:
            bodies = []
            client = httpx2.AsyncClient(transport=httpx2.MockTransport(
                handler_of(bodies, answer, events)))
            assistant = agent.build_agent(
                model_for(client), server, thinking=thinking)
            result = await assistant.run(
                'Et le CTO ?' if history else 'Mes positions ?',
                message_history=history)
            history = result.all_messages()
            sent += bodies
        return sent
    return asyncio.run(run())


def two_turns(tmp_path, model_for, answer):
    """The JSON bodies of two turns, the second continuing the first."""
    step = (model_for, answer, 'low', ANSWER_EVENTS)
    return run_turns(tmp_path, [step, step])


def test_the_agent_asks_for_the_cache(tmp_path):
    from application import mcp_server
    runtime, _ = build_runtime(tmp_path)
    assistant = agent.build_agent(
        agent.build_model(config('anthropic')),
        mcp_server.build_server(runtime), thinking='low')
    assert assistant.model_settings['cache'] is True


def test_anthropic_caches_the_tools_the_prompt_and_the_conversation(tmp_path):
    import json

    from pydantic_ai.models.anthropic import AnthropicModel
    from pydantic_ai.providers.anthropic import AnthropicProvider
    first, second = two_turns(tmp_path, lambda client: AnthropicModel(
        'claude-sonnet-5-5',
        provider=AnthropicProvider(api_key=KEY, http_client=client)), ANSWER)

    for sent in (first, second):
        assert 'cache_control' in sent['tools'][-1]
        assert 'cache_control' in sent['system'][-1]
        assert 'cache_control' in sent
    assert json.dumps(first['system']) == json.dumps(second['system'])
    assert json.dumps(first['tools']) == json.dumps(second['tools'])


@pytest.mark.parametrize('provider, base_url', [
    ('ollama', 'http://ollama:11434'), ('openai', None)])
def test_ollama_and_an_older_gpt_get_no_breakpoint(tmp_path, provider, base_url):
    import json

    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.models.ollama import OllamaModel
    from pydantic_ai.providers.ollama import OllamaProvider
    from pydantic_ai.providers.openai import OpenAIProvider

    def model_for(client):
        if provider == 'ollama':
            return OllamaModel('llama3', provider=OllamaProvider(
                base_url=base_url + '/v1', http_client=client))
        return OpenAIChatModel('gpt-4o', provider=OpenAIProvider(
            api_key=KEY, http_client=client))

    for sent in two_turns(tmp_path, model_for, CHAT_ANSWER):
        assert 'cache_control' not in json.dumps(sent)
        assert 'prompt_cache_breakpoint' not in json.dumps(sent)


# ------------------------------------------------------------ the routes --

def test_the_agent_is_off_and_has_no_provider_until_configured(client):
    assert client.get('/api/agent/config').get_json() == {
        'enabled': False, 'reasoning': 'low'}
    assert client.get('/api/agent/providers').get_json() == []


def test_the_config_holds_enabled_and_reasoning_only(client):
    configured(client)

    assert client.get('/api/agent/config').get_json() == {
        'enabled': True, 'reasoning': 'low'}


def test_the_first_provider_is_the_default_and_the_second_is_not(client):
    first = client.post('/api/agent/providers', json={
        'kind': 'anthropic', 'key': KEY}).get_json()
    second = client.post('/api/agent/providers', json={
        'kind': 'ollama', 'base_url': 'http://ollama:11434'}).get_json()

    assert (first['is_default'], second['is_default']) == (True, False)
    assert [p['id'] for p in client.get('/api/agent/providers').get_json()] == [
        first['id'], second['id']]


def test_a_key_is_served_back_as_its_last_four_characters_only(client):
    made = client.post('/api/agent/providers', json={
        'kind': 'anthropic', 'key': KEY, 'label': 'Maison'})

    assert made.status_code == 201
    shown = client.get('/api/agent/providers').get_json()[0]
    assert shown['key']['set'] is True
    assert shown['key']['last4'] == 'abcd'
    assert shown['key']['set_at']
    for path in ('/api/agent/config', '/api/agent/providers', '/api/settings',
                 '/api/config'):
        assert KEY not in client.get(path).get_data(as_text=True), path
    assert KEY not in made.get_data(as_text=True)


@pytest.mark.parametrize('body, key', [
    ({}, 'kind'),
    ({'kind': 'mistral'}, 'kind'),
    ({'kind': 'anthropic'}, 'key'),
    ({'kind': 'openai'}, 'key'),
    ({'kind': 'ollama'}, 'base_url'),
    ({'kind': 'openai_compatible'}, 'base_url'),
    ({'kind': 'anthropic', 'key': KEY, 'base_url': 'https://x'}, 'base_url'),
    ({'kind': 'ollama', 'base_url': 'http://o', 'key': KEY}, 'key'),
    ({'kind': 'ollama', 'base_url': 'ftp://x'}, 'base_url'),
    ({'kind': 'anthropic', 'key': 'short'}, 'key'),
    ({'kind': 'anthropic', 'key': KEY, 'label': 'x' * 61}, 'label'),
    ({'kind': 'anthropic', 'key': KEY, 'default_model': 'two\nlines'}, 'default_model'),
    ({'kind': 'anthropic', 'key': KEY, 'api_key': KEY}, 'api_key'),
])
def test_a_provider_that_cannot_run_is_refused_by_name(client, body, key):
    answer = client.post('/api/agent/providers', json=body)

    assert answer.status_code == 422
    assert answer.get_json()['key'] == key
    assert KEY not in answer.get_data(as_text=True)
    assert client.get('/api/agent/providers').get_json() == []


def test_a_compatible_endpoint_needs_no_key(client):
    made = client.post('/api/agent/providers', json={
        'kind': 'openai_compatible', 'base_url': 'http://litellm:4000'})

    assert made.status_code == 201
    assert made.get_json()['key'] == {'set': False, 'last4': None, 'set_at': None}


def test_switching_on_needs_a_default_provider_with_a_model(client):
    refused = client.put('/api/agent/config', json={'enabled': True})
    assert refused.status_code == 422 and refused.get_json()['key'] == 'enabled'

    client.post('/api/agent/providers', json={'kind': 'anthropic', 'key': KEY})
    modelless = client.put('/api/agent/config', json={'enabled': True})
    assert modelless.status_code == 422

    default = client.get('/api/agent/providers').get_json()[0]
    client.patch(f"/api/agent/providers/{default['id']}",
                 json={'default_model': 'claude-sonnet-5-5'})
    assert client.put('/api/agent/config', json={'enabled': True}).get_json() == {
        'enabled': True, 'reasoning': 'low'}


def test_deleting_the_last_provider_switches_the_agent_off(client):
    made = configured(client)

    answer = client.delete(f"/api/agent/providers/{made['id']}")

    assert answer.get_json() == {'id': made['id'], 'removed': True, 'disabled': True}
    assert client.get('/api/agent/config').get_json()['enabled'] is False
    assert client.get('/api/agent/providers').get_json() == []


def test_deleting_the_default_hands_it_to_the_oldest_left(client):
    first = configured(client)
    second = client.post('/api/agent/providers', json={
        'kind': 'ollama', 'base_url': 'http://ollama:11434',
        'default_model': 'llama'}).get_json()
    third = client.post('/api/agent/providers', json={
        'kind': 'openai', 'key': KEY}).get_json()

    answer = client.delete(f"/api/agent/providers/{first['id']}")

    assert answer.get_json()['disabled'] is False
    listed = client.get('/api/agent/providers').get_json()
    assert [(p['id'], p['is_default']) for p in listed] == [
        (second['id'], True), (third['id'], False)]
    assert client.get('/api/agent/config').get_json()['enabled'] is True


def test_deleting_the_default_for_one_without_a_model_switches_the_agent_off(client):
    first = configured(client)
    client.post('/api/agent/providers', json={'kind': 'openai', 'key': KEY})

    answer = client.delete(f"/api/agent/providers/{first['id']}")

    assert answer.get_json()['disabled'] is True
    assert client.get('/api/agent/config').get_json()['enabled'] is False


def test_the_default_moves_to_the_provider_asked(client):
    first = configured(client)
    second = client.post('/api/agent/providers', json={
        'kind': 'openai', 'key': KEY, 'default_model': 'gpt-x'}).get_json()

    answer = client.put(f"/api/agent/providers/{second['id']}/default")

    assert answer.get_json()['is_default'] is True
    listed = client.get('/api/agent/providers').get_json()
    assert [(p['id'], p['is_default']) for p in listed] == [
        (second['id'], True), (first['id'], False)]


@pytest.mark.parametrize('method, path', [
    ('patch', '/api/agent/providers/nope'),
    ('delete', '/api/agent/providers/nope'),
    ('put', '/api/agent/providers/nope/default'),
    ('post', '/api/agent/providers/nope/test'),
])
def test_an_unknown_provider_is_a_404(client, method, path):
    assert getattr(client, method)(path, json={}).status_code == 404


@pytest.mark.parametrize('body', [
    {'kind': 'openai', 'base_url': None},
    {'base_url': 'http://other:4000'},
    {'kind': 'ollama', 'base_url': 'http://ollama:11434'},
])
def test_another_kind_or_address_forgets_the_key_and_the_model(client, body):
    made = client.post('/api/agent/providers', json={
        'kind': 'openai_compatible', 'base_url': 'http://litellm:4000',
        'key': KEY, 'default_model': 'm'}).get_json()

    answer = client.patch(f"/api/agent/providers/{made['id']}", json=body)

    # openai needs a key, so it is refused by name; the others keep nothing.
    if body.get('kind') == 'openai':
        assert answer.status_code == 422 and answer.get_json()['key'] == 'key'
    else:
        assert answer.get_json()['key'] == {
            'set': False, 'last4': None, 'set_at': None}
        assert answer.get_json()['default_model'] is None


def test_the_same_kind_and_address_keep_the_key_and_a_new_key_replaces_it(client):
    made = client.post('/api/agent/providers', json={
        'kind': 'openai_compatible', 'base_url': 'http://litellm:4000',
        'key': KEY}).get_json()
    path = f"/api/agent/providers/{made['id']}"

    kept = client.patch(path, json={
        'base_url': 'http://litellm:4000', 'default_model': 'm'}).get_json()
    assert kept['key']['last4'] == 'abcd' and kept['default_model'] == 'm'

    moved = client.patch(path, json={
        'base_url': 'http://other:4000', 'key': 'test-key-other-0000'}).get_json()
    assert moved['key']['last4'] == '0000'

    gone = client.patch(path, json={'key': None}).get_json()
    assert gone['key']['set'] is False


def test_clearing_the_model_of_the_default_switches_the_agent_off(client):
    made = configured(client)

    answer = client.patch(f"/api/agent/providers/{made['id']}",
                          json={'default_model': None})

    assert answer.get_json()['disabled'] is True
    assert client.get('/api/agent/config').get_json()['enabled'] is False


@pytest.mark.parametrize('body, key', [
    ({'enabled': 'yes'}, 'enabled'),
    ({'provider': 'anthropic'}, 'provider'),
    ({'thinking': 'low'}, 'thinking'),
    *[({'reasoning': value}, 'reasoning')
      for value in ('off', 'xhigh', '', None, 3)],
])
def test_a_bad_config_value_is_refused_by_name(client, body, key):
    answer = client.put('/api/agent/config', json=body)

    assert answer.status_code == 422
    assert answer.get_json()['key'] == key


def test_the_old_single_config_routes_are_gone(client):
    assert client.delete('/api/agent/key').status_code in (404, 405)
    assert client.post('/api/agent/test').status_code in (404, 405)


# -------------------------------------------------------------- privacy --

def test_a_hosted_provider_sends_the_figures_to_it(client):
    made = client.post('/api/agent/providers', json={
        'kind': 'anthropic', 'key': KEY}).get_json()

    assert made['privacy'] == {
        'local': False, 'fr': 'Vos chiffres sont envoyés à Anthropic.',
        'en': 'Your figures are sent to Anthropic.'}


def test_a_label_names_the_provider_in_the_sentence(client):
    made = client.post('/api/agent/providers', json={
        'kind': 'anthropic', 'key': KEY, 'label': 'Mon proxy'}).get_json()

    assert made['privacy']['fr'] == 'Vos chiffres sont envoyés à Mon proxy.'


@pytest.mark.parametrize('url', [
    'http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434',
    'http://192.168.1.20:4000', 'http://10.0.0.3/v1', 'http://172.16.4.2',
])
def test_an_address_on_this_machine_or_a_private_network_stays_here(
        client, url):
    made = client.post('/api/agent/providers', json={
        'kind': 'ollama', 'base_url': url}).get_json()

    assert made['privacy'] == {
        'local': True, 'fr': 'Vos chiffres restent sur ce serveur.',
        'en': 'Your figures stay on this server.'}


def test_a_name_is_resolved_and_every_address_must_be_private(monkeypatch):
    import socket

    def answers(*addresses):
        def getaddrinfo(host, port):
            return [(socket.AF_INET, 0, 0, '', (a, 0)) for a in addresses]
        return getaddrinfo

    monkeypatch.setattr(socket, 'getaddrinfo', answers('172.18.0.2'))
    assert agent.is_private('http://ollama:11434') is True
    monkeypatch.setattr(socket, 'getaddrinfo', answers('172.18.0.2', '93.184.216.34'))
    assert agent.is_private('http://ollama:11434') is False
    monkeypatch.setattr(socket, 'getaddrinfo', answers('93.184.216.34'))
    assert agent.is_private('https://llm.example.com') is False

    def unresolved(host, port):
        raise socket.gaierror('no such host')
    monkeypatch.setattr(socket, 'getaddrinfo', unresolved)
    assert agent.is_private('http://nowhere.invalid') is False
    assert agent.is_private(None) is False


def test_refusal_reads_the_status_before_the_body():
    body = {'error': {'type': 'insufficient_quota', 'message': 'no credit'}}
    assert agent.refusal(401, body, 'turn') == 'key'
    assert agent.refusal(403, body, 'test') == 'refused'
    assert agent.refusal(429, body, 'turn') == 'quota'
    assert agent.refusal(429, {'error': 'slow down'}, 'turn') == 'rate_limit'
    assert agent.refusal(404, None, 'turn') == 'model'
    assert agent.refusal(None, None, 'turn') == 'unreachable'


def test_said_masks_the_key_before_it_cuts():
    long = 'x' * (agent.SAID_MAX - 4) + KEY

    said = agent.said({'error': {'message': long}}, secret=KEY)

    assert len(said) <= agent.SAID_MAX
    assert KEY[:6] not in said


def test_said_is_one_line_and_falls_back_to_the_text():
    assert agent.said(None, '<html>\n  Bad\n gateway </html>') == '<html> Bad gateway </html>'
    assert agent.said({'error': {'message': ''}}, 'plain text') == 'plain text'
    assert agent.said('overloaded', 'ignored') == 'overloaded'


@pytest.mark.parametrize('status, body, reason', [
    (429, {'error': {'type': 'insufficient_quota'}}, 'quota'),
    (429, None, 'rate_limit'),
    (402, 'pay up', 'quota'),
    (400, {'error': {'message': 'Your credit balance is too low'}}, 'quota'),
    (400, 'bad request', 'refused'),
])
def test_refusal_reads_quota_wherever_the_provider_puts_it(status, body, reason):
    assert agent.refusal(status, body, 'turn') == reason


def test_a_404_is_an_address_only_for_a_provider_that_takes_one():
    assert agent.refusal(404, None, 'test') == 'address'
    assert agent.refusal(404, None, 'test', 'openai_compatible') == 'address'
    assert agent.refusal(404, None, 'test', 'anthropic') == 'refused'
    assert agent.refusal(404, None, 'turn', 'openai_compatible') == 'model'


# ---------------------------------------------------------- the reasoning --

@pytest.mark.parametrize('level', agent.THINKING)
def test_each_reasoning_level_is_kept_without_touching_the_rest(client, level):
    configured(client)
    client.put('/api/agent/config',
               json={'reasoning': 'medium' if level == 'low' else 'low'})

    answer = client.put('/api/agent/config', json={'reasoning': level})

    assert answer.get_json() == {'enabled': True, 'reasoning': level}
    assert client.get('/api/agent/config').get_json() == {
        'enabled': True, 'reasoning': level}


def test_a_bad_reasoning_level_leaves_the_row_unchanged(client):
    configured(client)
    client.put('/api/agent/config', json={'reasoning': 'high'})

    answer = client.put('/api/agent/config', json={'reasoning': 'off'})

    assert answer.status_code == 422
    assert client.get('/api/agent/config').get_json()['reasoning'] == 'high'


def test_a_turn_runs_on_the_provider_the_request_names_then_the_thread_s():
    def listed(*kinds):
        return [{**agent.BLANK, 'id': f'p{i}', 'provider': kind, 'model': f'm{i}',
                 'api_key': KEY, 'is_default': i == 0}
                for i, kind in enumerate(kinds)]

    providers = listed('anthropic', 'openai', 'openai')
    # Nothing said: the default and its model.
    assert agent.choose(providers, None, None, None)['id'] == 'p0'
    assert agent.choose(providers, None, None, None)['model'] == 'm0'
    # The request wins, and so does its model.
    chosen = agent.choose(providers, 'p2', 'gpt-x', {'provider_id': 'p1', 'model': 'old'})
    assert (chosen['id'], chosen['model']) == ('p2', 'gpt-x')
    # The thread carries on, on its model.
    chosen = agent.choose(providers, None, None, {'provider_id': 'p1', 'model': 'old'})
    assert (chosen['id'], chosen['model']) == ('p1', 'old')
    # A thread stored before ids names its kind: the first of that kind.
    chosen = agent.choose(providers, None, None, {'provider': 'openai', 'model': 'old'})
    assert (chosen['id'], chosen['model']) == ('p1', 'old')
    # Its provider is gone: the default, on the default's model.
    chosen = agent.choose(providers, None, None, {'provider_id': 'gone', 'model': 'old'})
    assert (chosen['id'], chosen['model']) == ('p0', 'm0')
    # Switching provider drops the thread's model.
    chosen = agent.choose(providers, 'p1', None, {'provider_id': 'p0', 'model': 'old'})
    assert (chosen['id'], chosen['model']) == ('p1', 'm1')


def test_a_turn_with_no_provider_or_model_is_refused_by_name():
    bare = [{**agent.BLANK, 'id': 'p0', 'provider': 'ollama', 'model': None,
             'is_default': True}]
    for providers, asked, key in (([], None, 'provider_id'),
                                  (bare, 'gone', 'provider_id'),
                                  (bare, None, 'model')):
        with pytest.raises(agent.InvalidAgentConfig) as raised:
            agent.choose(providers, asked, None, None)
        assert raised.value.key == key


def test_the_thinking_level_is_what_the_agent_is_built_with(tmp_path):
    from application import mcp_server
    runtime, _ = build_runtime(tmp_path)
    assistant = agent.build_agent(
        agent.build_model(config('anthropic')),
        mcp_server.build_server(runtime), thinking='high')
    assert assistant.model_settings['thinking'] == 'high'


def anthropic(name):
    from pydantic_ai.models.anthropic import AnthropicModel
    from pydantic_ai.providers.anthropic import AnthropicProvider
    return lambda client: AnthropicModel(
        name, provider=AnthropicProvider(api_key=KEY, http_client=client))


def openai(name):
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider
    return lambda client: OpenAIChatModel(
        name, provider=OpenAIProvider(api_key=KEY, http_client=client))


def only(tmp_path, model_for, answer, thinking):
    """The one body a single turn sent."""
    return run_turns(tmp_path, [(model_for, answer, thinking, ANSWER_EVENTS)])[0]


@pytest.mark.parametrize('name', ['claude-opus-5-5', 'claude-sonnet-5-5'])
def test_an_anthropic_model_thinks_adaptively_at_the_chosen_effort(tmp_path, name):
    sent = only(tmp_path, anthropic(name), ANSWER, 'low')

    assert sent['thinking']['type'] == 'adaptive'
    assert sent['output_config']['effort'] == 'low'


def test_gpt_5_5_gets_a_reasoning_effort(tmp_path):
    sent = only(tmp_path, openai('gpt-5.5'), CHAT_ANSWER, 'medium')

    assert sent['reasoning_effort'] == 'medium'


def test_a_model_that_does_not_reason_is_sent_nothing_and_answers(tmp_path):
    sent = only(tmp_path, openai('gpt-4.1'), CHAT_ANSWER, 'high')

    assert 'reasoning_effort' not in sent


THOUGHT_EVENTS = [
    ANSWER_EVENTS[0],
    ('content_block_start', {'type': 'content_block_start', 'index': 0,
                             'content_block': {'type': 'thinking',
                                               'thinking': '', 'signature': ''}}),
    ('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                             'delta': {'type': 'thinking_delta',
                                       'thinking': 'Look at the positions.'}}),
    ('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                             'delta': {'type': 'signature_delta',
                                       'signature': 'sig-1'}}),
    ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
    ('content_block_start', {'type': 'content_block_start', 'index': 1,
                             'content_block': {'type': 'text', 'text': ''}}),
    ('content_block_delta', {'type': 'content_block_delta', 'index': 1,
                             'delta': {'type': 'text_delta', 'text': 'ok'}}),
    ('content_block_stop', {'type': 'content_block_stop', 'index': 1}),
    *ANSWER_EVENTS[-2:],
]


def test_raising_the_level_mid_thread_keeps_the_thinking_in_the_history(tmp_path):
    model = anthropic('claude-sonnet-5-5')
    first, second = run_turns(tmp_path, [
        (model, ANSWER, 'low', THOUGHT_EVENTS),
        (model, ANSWER, 'high', ANSWER_EVENTS)])

    assert first['output_config']['effort'] == 'low'
    assert second['output_config']['effort'] == 'high'
    thought = [block for message in second['messages']
               if isinstance(message['content'], list)
               for block in message['content'] if block['type'] == 'thinking']
    assert thought == [{'type': 'thinking', 'thinking': 'Look at the positions.',
                        'signature': 'sig-1'}]


def test_a_thread_that_thought_on_anthropic_continues_on_openai(tmp_path):
    first, second = run_turns(tmp_path, [
        (anthropic('claude-sonnet-5-5'), ANSWER, 'low', THOUGHT_EVENTS),
        (openai('gpt-5.5'), CHAT_ANSWER, 'low', ANSWER_EVENTS)])

    assert first['thinking']['type'] == 'adaptive'
    assert second['reasoning_effort'] == 'low'
    assert [m['role'] for m in second['messages']][-1] == 'user'
