"""The agent's configuration, its model and its prompt cache (#1114, #1190).

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


def configured(client, **fields):
    """Write ``fields``, the key after the provider it belongs to and before
    ``enabled``."""
    key = fields.pop('key', None)
    enabled = fields.pop('enabled', None)
    answer = client.put('/api/agent/config', json=fields)
    assert answer.status_code == 200, answer.get_json()
    if key:
        answer = client.put('/api/agent/key', json={'key': key})
        assert answer.status_code == 200, answer.get_json()
    if enabled is not None:
        answer = client.put('/api/agent/config', json={'enabled': enabled})
        assert answer.status_code == 200, answer.get_json()
    return answer.get_json()


# ------------------------------------------------------------ the model --

def config(provider, base_url=None, key=KEY):
    return {**agent.EMPTY, 'enabled': True, 'provider': provider,
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


def two_turns(tmp_path, model_for, answer):
    """The JSON bodies of two turns, the second continuing the first, over
    the MCP server's real tools. ``model_for(http_client)`` builds the model."""
    import asyncio
    import json

    import httpx2

    from application import mcp_server
    bodies = []

    def handler(request):
        sent = json.loads(request.content)
        bodies.append(sent)
        if sent.get('stream') and 'system' in sent:
            return httpx2.Response(200, content=''.join(
                f'event: {name}\ndata: {json.dumps(data)}\n\n'
                for name, data in ANSWER_EVENTS).encode(),
                headers={'content-type': 'text/event-stream'})
        return httpx2.Response(200, json=answer)

    async def run():
        client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
        runtime, _ = build_runtime(tmp_path)
        assistant = agent.build_agent(
            model_for(client), mcp_server.build_server(runtime))
        first = await assistant.run('Mes positions ?')
        await assistant.run('Et le CTO ?', message_history=first.all_messages())
    asyncio.run(run())
    return bodies


def test_the_agent_asks_for_the_cache(tmp_path):
    from application import mcp_server
    runtime, _ = build_runtime(tmp_path)
    assistant = agent.build_agent(
        agent.build_model(config('anthropic')),
        mcp_server.build_server(runtime))
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

def test_the_agent_is_off_and_keyless_until_configured(client):
    assert client.get('/api/agent/config').get_json() == {
        'enabled': False, 'provider': None, 'model': None, 'base_url': None,
        'key': {'set': False, 'last4': None, 'set_at': None}}


def test_a_key_is_served_back_as_its_last_four_characters_only(client):
    client.put('/api/agent/key', json={'key': KEY})
    shown = client.get('/api/agent/config')

    assert shown.get_json()['key']['set'] is True
    assert shown.get_json()['key']['last4'] == 'abcd'
    assert shown.get_json()['key']['set_at']
    for path in ('/api/agent/config', '/api/settings', '/api/config'):
        assert KEY not in client.get(path).get_data(as_text=True), path


def test_deleting_the_key_switches_a_provider_that_needs_one_off(client):
    configured(client, key=KEY, enabled=True, provider='anthropic',
               model='claude-sonnet-5-5')

    answer = client.delete('/api/agent/key').get_json()

    assert answer['enabled'] is False and answer['disabled'] is True
    assert answer['key'] == {'set': False, 'last4': None, 'set_at': None}
    assert client.get('/api/agent/config').get_json()['enabled'] is False


def test_a_compatible_endpoint_stays_on_without_its_key(client):
    configured(client, key=KEY, enabled=True, provider='openai_compatible',
               model='m', base_url='http://litellm:4000')

    answer = client.delete('/api/agent/key').get_json()

    assert answer['enabled'] is True and 'disabled' not in answer


@pytest.mark.parametrize('fields, missing', [
    ({}, 'provider'),
    ({'provider': 'anthropic'}, 'model'),
    ({'provider': 'anthropic', 'model': 'm'}, 'key'),
    ({'provider': 'ollama', 'model': 'm'}, 'base_url'),
    ({'provider': 'openai_compatible', 'model': 'm'}, 'base_url'),
])
def test_switching_on_names_what_is_missing(client, fields, missing):
    answer = client.put('/api/agent/config', json={**fields, 'enabled': True})

    assert answer.status_code == 422
    assert answer.get_json()['key'] == missing


def test_switching_provider_under_an_enabled_agent_switches_it_off(client):
    configured(client, enabled=True, provider='ollama', model='llama',
               base_url='http://ollama:11434')

    answer = client.put('/api/agent/config',
                        json={'provider': 'anthropic', 'base_url': None})

    assert answer.status_code == 200
    assert answer.get_json()['enabled'] is False
    assert answer.get_json()['disabled'] is True


@pytest.mark.parametrize('body', [
    {'provider': 'openai', 'base_url': None},
    {'base_url': 'http://other:4000'},
    {'provider': 'ollama', 'base_url': 'http://ollama:11434'},
])
def test_another_provider_or_address_forgets_the_key(client, body):
    configured(client, key=KEY, provider='openai_compatible',
               base_url='http://litellm:4000')

    answer = client.put('/api/agent/config', json=body).get_json()

    assert answer['key'] == {'set': False, 'last4': None, 'set_at': None}


def test_the_same_provider_and_address_keep_the_key(client):
    configured(client, key=KEY, provider='openai_compatible',
               base_url='http://litellm:4000')

    answer = client.put('/api/agent/config', json={
        'provider': 'openai_compatible', 'base_url': 'http://litellm:4000',
        'model': 'm'}).get_json()

    assert answer['key']['last4'] == 'abcd'


def test_a_new_provider_with_enabled_true_is_refused_without_its_key(client):
    configured(client, key=KEY, enabled=True, provider='anthropic', model='m')

    answer = client.put('/api/agent/config',
                        json={'provider': 'openai', 'enabled': True})

    assert answer.status_code == 422 and answer.get_json()['key'] == 'key'
    assert client.get('/api/agent/config').get_json()['key']['set'] is True


@pytest.mark.parametrize('body, key', [
    ({'provider': 'mistral'}, 'provider'),
    ({'enabled': 'yes'}, 'enabled'),
    ({'base_url': 'ftp://x'}, 'base_url'),
    ({'provider': 'anthropic', 'base_url': 'https://x'}, 'base_url'),
    ({'api_key': KEY}, 'api_key'),
])
def test_a_bad_value_is_refused_by_name(client, body, key):
    answer = client.put('/api/agent/config', json=body)

    assert answer.status_code == 422
    assert answer.get_json()['key'] == key
    assert KEY not in answer.get_data(as_text=True)


def test_a_pasted_key_loses_its_newline(client):
    answer = client.put('/api/agent/key', json={'key': f'  {KEY}\n'})

    assert answer.status_code == 200
    assert answer.get_json()['key']['last4'] == 'abcd'


def test_a_key_too_short_or_for_ollama_is_refused(client):
    assert client.put('/api/agent/key', json={'key': 'short'}).status_code == 422
    configured(client, provider='ollama')
    answer = client.put('/api/agent/key', json={'key': KEY})

    assert answer.status_code == 422 and answer.get_json()['key'] == 'key'
    assert KEY not in answer.get_data(as_text=True)
