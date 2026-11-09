"""What the agent's models exchanged, indexed from the threads, and the
providers the old single configuration became. No provider is called."""
from datetime import datetime, timezone

import duckdb
import pytest
from pydantic_ai.messages import (
    ModelRequest, ModelResponse, TextPart, ToolCallPart, UserPromptPart,
)
from pydantic_ai.usage import RequestUsage

from api import create_app
from application import agent, agent_threads, agent_usage, schema_steps
from application import store as store_module
from test_mcp_server import build_runtime


def at(day, hour=9):
    return datetime(2026, *day, hour, tzinfo=timezone.utc)


def answer(model, when, input_tokens, output_tokens, cached=0, calls=0,
           provider='anthropic'):
    parts = [ToolCallPart('list_positions', '{}', tool_call_id=f'c{when}')
             for _ in range(calls)] or [TextPart('ok')]
    return ModelResponse(
        parts=parts, model_name=model, provider_name=provider, timestamp=when,
        usage=RequestUsage(input_tokens=input_tokens, output_tokens=output_tokens,
                           cache_read_tokens=cached))


def thread(*responses):
    history = []
    for response in responses:
        history += [ModelRequest(parts=[UserPromptPart('q')]), response]
    return history


@pytest.fixture
def runtime(tmp_path):
    return build_runtime(tmp_path)[0]


def keep(runtime, thread_id, title, history):
    """The thread's file, and its rows, as a turn leaves them."""
    root = agent_threads.directory(runtime.store.path)
    agent_threads.write(root, agent_threads.saved(
        None, thread_id, title, history, 'anthropic', 'claude-x'))
    with runtime.config_manager.writing() as opened:
        agent_usage.record(opened, thread_id, history)


def test_a_row_per_model_response_with_the_usage_and_the_tool_calls():
    history = thread(answer('claude-x', at((3, 2)), 1000, 50, cached=800, calls=2))
    history.append(ModelResponse(parts=[TextPart('app')]))  # no model: not counted

    assert agent_usage.rows('t1', history) == [(
        't1', 1, at((3, 2)), 'claude-x', 'anthropic', 1000, 50, 800, 0, 1, 2)]


def test_saving_a_thread_again_replaces_its_rows_and_forgetting_drops_them(runtime):
    keep(runtime, 't1', 'Un', thread(answer('m', at((3, 2)), 10, 1)))
    keep(runtime, 't1', 'Un', thread(answer('m', at((3, 2)), 10, 1),
                                      answer('m', at((3, 3)), 20, 2)))
    count = 'SELECT count(*) FROM agent_usage'
    assert runtime.store.query(count) == [(2,)]

    with runtime.config_manager.writing() as opened:
        agent_usage.forget(opened, 't1')
    assert runtime.store.query(count) == [(0,)]


def test_the_stats_add_up_the_split_the_weeks_the_models_and_the_threads(runtime):
    keep(runtime, 'a', 'Dividendes', thread(
        answer('claude-x', at((1, 6)), 1000, 100, cached=800, calls=1),
        answer('claude-x', at((1, 7)), 1200, 80, cached=1000)))
    # Three weeks later: the weeks between are in the series, empty.
    keep(runtime, 'b', 'Frais', thread(
        answer('qwen3', at((1, 27)), 300, 30, provider='ollama')))
    keep(runtime, 'old', 'L\'an dernier', [
        ModelRequest(parts=[UserPromptPart('q')]),
        answer('claude-x', datetime(2025, 12, 30, tzinfo=timezone.utc), 99, 9)])
    client = create_app(runtime).test_client()

    shown = client.get('/api/agent/stats?range=MAX').get_json()

    assert shown['range'] == 'MAX'
    assert shown['totals'] == {
        'tokens': 99 + 9 + 1000 + 100 + 1200 + 80 + 300 + 30,
        'input': 99 + 1000 + 1200 + 300, 'output': 9 + 100 + 80 + 30,
        'cache_read': 1800, 'fresh': 99 + 1000 + 1200 + 300 - 1800,
        'threads': 3, 'requests': 4, 'tool_calls': 1}
    assert [m['model'] for m in shown['models']] == ['claude-x', 'qwen3']
    assert shown['models'][0] == {
        'model': 'claude-x', 'provider': 'anthropic', 'requests': 3,
        'tokens': 99 + 9 + 1000 + 100 + 1200 + 80, 'cache_read': 1800,
        'cache_ratio': 1800 / 2299}
    assert shown['threads'][0]['id'] == 'a'
    assert shown['threads'][0]['title'] == 'Dividendes'
    assert shown['threads'][0]['requests'] == 2
    assert shown['threads'][0]['last_at'].startswith('2026-01-07')
    weeks = {w['week']: w for w in shown['weeks']}
    assert weeks['2026-01-05'] == {
        'week': '2026-01-05', 'cache_read': 1800, 'fresh': 400,
        'output': 180}
    assert weeks['2026-01-12'] == {
        'week': '2026-01-12', 'cache_read': 0, 'fresh': 0, 'output': 0}
    assert weeks['2025-12-29']['fresh'] == 99


def test_the_default_range_starts_on_the_first_of_january(runtime):
    keep(runtime, 'a', 'Cette année', thread(
        answer('m', datetime.now(timezone.utc).replace(month=1, day=2), 10, 1)))
    keep(runtime, 'old', 'Avant', thread(
        answer('m', datetime(2020, 5, 5, tzinfo=timezone.utc), 500, 5)))
    client = create_app(runtime).test_client()

    shown = client.get('/api/agent/stats').get_json()

    assert shown['range'] == 'YTD'
    assert shown['since'] == f"{datetime.now(timezone.utc).year}-01-01"
    assert shown['totals']['tokens'] == 11
    assert client.get('/api/agent/stats?range=MAX').get_json()['totals']['tokens'] == 516
    assert client.get('/api/agent/stats?range=2W').status_code == 400


def test_no_usage_is_zeros_and_no_weeks_to_draw_for_all_time(runtime):
    client = create_app(runtime).test_client()

    shown = client.get('/api/agent/stats?range=MAX').get_json()

    assert shown['totals']['tokens'] == 0 and shown['weeks'] == []
    assert shown['models'] == [] and shown['threads'] == []


def test_the_stats_carry_no_price(runtime):
    keep(runtime, 'a', 'x', thread(answer('m', at((1, 6)), 10, 1)))
    text = create_app(runtime).test_client().get('/api/agent/stats').get_data(as_text=True)

    assert 'cost' not in text and 'price' not in text and 'eur' not in text.lower()


# ------------------------------------------------------------ the steps --

def old_store(tmp_path):
    """A store as it was before: one provider in ``agent_config``, two threads
    on disk, and neither step run."""
    path = tmp_path / 'old.duckdb'
    store_module.open_store(path, schema_steps.STEPS).close()
    connection = duckdb.connect(str(path))
    connection.execute(
        "INSERT INTO agent_config (id, enabled, provider, model, model_name, "
        "base_url, api_key, key_set_at, thinking, updated_at) VALUES "
        "(1, TRUE, 'openai_compatible', 'qwen3', 'Qwen', 'http://litellm:4000', "
        "'test-key-0001', TIMESTAMPTZ '2026-10-02 00:00:00+00', 'high', "
        "TIMESTAMPTZ '2026-10-01 00:00:00+00')")
    connection.execute("DELETE FROM schema_step WHERE step IN "
                       "('move_agent_provider', 'backfill_agent_usage')")
    connection.close()
    root = agent_threads.directory(path)
    for thread_id, history in (
            ('t1', thread(answer('qwen3', at((10, 2)), 100, 10, cached=60),
                          answer('qwen3', at((10, 3)), 200, 20, calls=1))),
            ('t2', thread(answer('qwen3', at((10, 4)), 50, 5)))):
        agent_threads.write(root, agent_threads.saved(
            None, thread_id, 'Fil', history, 'openai_compatible', 'qwen3'))
    (root / 'broken.json').write_text('[]')
    return path


def test_the_one_provider_of_before_becomes_the_default_one(tmp_path):
    path = old_store(tmp_path)

    opened = store_module.open_store(path, schema_steps.STEPS)
    try:
        [provider] = agent.providers(opened)
        assert (provider['provider'], provider['base_url'], provider['api_key'],
                provider['model'], provider['is_default'], provider['label']) == (
            'openai_compatible', 'http://litellm:4000', 'test-key-0001',
            'qwen3', True, None)
        assert provider['key_set_at'] == at((10, 2), 0)
        # What the row keeps is the agent's own, and the key is held once.
        assert agent.read(opened)['enabled'] is True
        assert agent.read(opened)['thinking'] == 'high'
        assert opened.query('SELECT provider, api_key, model FROM agent_config'
                            ) == [(None, None, None)]
    finally:
        opened.close()


def test_the_step_runs_once_and_a_store_that_never_had_a_provider_gets_none(tmp_path):
    path = old_store(tmp_path)
    store_module.open_store(path, schema_steps.STEPS).close()
    again = store_module.open_store(path, schema_steps.STEPS)
    try:
        assert len(agent.providers(again)) == 1
    finally:
        again.close()

    fresh = store_module.open_store(tmp_path / 'fresh.duckdb', schema_steps.STEPS)
    try:
        assert agent.providers(fresh) == []
    finally:
        fresh.close()


def test_the_threads_of_before_are_indexed_and_a_broken_one_is_skipped(tmp_path):
    path = old_store(tmp_path)

    opened = store_module.open_store(path, schema_steps.STEPS)
    try:
        assert opened.query(
            'SELECT thread_id, seq, model, input_tokens, cache_read_tokens, '
            'tool_calls FROM agent_usage ORDER BY thread_id, seq') == [
                ('t1', 1, 'qwen3', 100, 60, 0), ('t1', 3, 'qwen3', 200, 0, 1),
                ('t2', 1, 'qwen3', 50, 0, 0)]
    finally:
        opened.close()


def test_a_thread_of_before_carries_on_on_the_provider_of_its_kind(tmp_path):
    path = old_store(tmp_path)
    opened = store_module.open_store(path, schema_steps.STEPS)
    try:
        listed = agent.providers(opened)
        stored = agent_threads.read(agent_threads.directory(path), 't1')
    finally:
        opened.close()

    chosen = agent.choose(listed, None, None, stored)

    assert (chosen['id'], chosen['model']) == (listed[0]['id'], 'qwen3')
    assert stored['provider_id'] is None
