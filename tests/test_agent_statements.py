"""``POST /api/agent/statements``: a broker statement read by a model with no tool (#1120).

Driven through the ASGI app like the turns are. The extraction model is a
``FunctionModel`` that records what it was sent: the statement's text must reach
it, and nothing else of ours.
"""
import asyncio
import json
import logging
from datetime import date

import pytest
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from application import accounts as accounts_module
from application import agent, agent_routes, entries, statements
from application.events.schemas import Event, EventType
from test_agent_routes import (
    KEY, body, get, run, scripted, stored, switched_on,
)
from test_mcp_server import build_runtime

CANARY = 'CANARY-7f3a9c2e-do-not-leak'
TEXT = f'Relevé de positions au 30/06/2026\nAMUNDI MSCI WORLD  12  512,40  {CANARY}'
READ = {'kind': 'positions', 'as_of': '2026-06-30', 'currency': 'EUR',
        'total': 6148.8,
        'lines': [{'name': 'AMUNDI MSCI WORLD', 'ticker': 'CW8.PA',
                   'quantity': 12, 'unit_price': 512.4}]}


@pytest.fixture
def runtime(tmp_path):
    runtime, opened = build_runtime(tmp_path)
    accounts_module.create_account(opened, 'cto')
    entries.create_many(opened, [
        Event(date(2026, 1, 5), EventType.BUY, 'CW8.PA', 'Amundi MSCI World',
              quantity=10, unit_price=500.0, account='cto')])
    runtime.config_manager.reload()
    switched_on(runtime)
    return runtime


class Extractor:
    """A fake extraction model that records every call it gets."""

    def __init__(self, read=READ, fail=None):
        self.read, self.fail, self.seen, self.tools = read, fail, [], []

    def model(self):
        def answer(messages, info):
            self.seen.append(repr(messages))
            self.tools.append(list(info.function_tools))
            if self.fail:
                raise self.fail
            return ModelResponse(parts=[ToolCallPart(
                info.output_tools[0].name, self.read)])
        return FunctionModel(answer)


def send(thread_id='s1', **members):
    payload = {'thread_id': thread_id, 'account': 'cto',
               'provider': 'anthropic', 'name': 'releve.csv', 'text': TEXT,
               **members}

    async def work(client):
        return await client.post('/api/agent/statements', json=payload)
    return work


def reading(monkeypatch, extractor):
    monkeypatch.setattr(agent, 'build_model', scripted(extractor.model()))
    return extractor


def count(runtime, table):
    return runtime.store.query(f'SELECT count(*) FROM {table}')[0][0]


# ------------------------------------------------- the road, and its secret --

def test_a_statement_becomes_a_proposal_and_four_messages_in_the_thread(
        runtime, monkeypatch):
    extractor = reading(monkeypatch, Extractor())

    answer = run(runtime, send())

    assert answer.status_code == 201
    card = answer.json()['proposal']
    assert answer.json()['thread_id'] == 's1'
    assert card['status'] == 'ready' and card['count'] == 1
    assert card['title'] == 'Relevé releve.csv 30/06/2026'
    assert card['events'][0]['marks'] == ['statement', 'gap']
    assert count(runtime, 'event') == 1
    thread = run(runtime, get('/api/agent/threads/s1')).json()
    assert thread['messages'][0]['role'] == 'user'
    assert "J'ai lu le relevé : 1 événements proposés" in json.dumps(
        thread['messages'][-1], ensure_ascii=False)
    tool = next(p for m in thread['messages'] for p in m['parts']
                if p['type'].startswith('tool-') or p['type'] == 'dynamic-tool')
    assert tool['state'] == 'output-available'
    assert tool['output']['proposal_id'] == card['id']
    assert tool['output']['preview_url'] == f"/ledger?proposal={card['id']}"
    assert extractor.seen and CANARY in extractor.seen[0]


def test_the_raw_statement_reaches_the_extractor_and_nothing_else(
        runtime, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    extractor = reading(monkeypatch, Extractor())

    assert run(runtime, send()).status_code == 201

    assert CANARY in extractor.seen[0]
    thread_file = agent_routes_file(runtime, 's1')
    assert CANARY not in thread_file
    assert 'AMUNDI MSCI WORLD  12' not in thread_file
    rows = runtime.store.query('SELECT payload FROM proposal')
    assert CANARY not in json.dumps(rows, default=str)
    assert CANARY not in caplog.text


def test_the_next_turn_sees_the_four_messages_and_never_the_statement(
        runtime, monkeypatch):
    reading(monkeypatch, Extractor())
    assert run(runtime, send()).status_code == 201
    heard = []

    async def next_turn(messages, info):
        heard.append(repr(messages))
        yield 'Noted.'
    monkeypatch.setattr(agent, 'build_model', scripted(
        FunctionModel(stream_function=next_turn)))

    async def work(client):
        return await client.post('/api/agent/chat', json=body('s1', 'Merci'))
    assert run(runtime, work).status_code == 200

    [history] = heard
    assert "tool_name='propose_events'" in history
    assert "J'ai lu le relevé : 1 événements proposés" in history
    assert 'Relevé « releve.csv » donné pour le compte cto.' in history
    assert CANARY not in history
    assert '"name"' not in history and 'AMUNDI' not in history


def test_the_extractor_has_no_tool(runtime, monkeypatch):
    extractor = reading(monkeypatch, Extractor())
    assert run(runtime, send()).status_code == 201
    assert extractor.tools == [[]]

    built = agent.build_extractor(extractor.model(), statements.Extraction,
                                  statements.EXTRACTION_PROMPT)
    assert not [tool for toolset in built.toolsets
                for tool in getattr(toolset, 'tools', {})]


def agent_routes_file(runtime, thread_id):
    return (agent_routes.agent_threads.directory(runtime.store.path)
            / f'{thread_id}.json').read_text('utf-8')


# ------------------------------------------------------------- the refusals --

def test_an_agent_switched_off_answers_404(tmp_path):
    runtime, _ = build_runtime(tmp_path)
    assert run(runtime, send()).status_code == 404


@pytest.mark.parametrize('members', [{'provider': 'openai'}, {'provider': None}])
def test_a_provider_other_than_the_configured_one_is_409_and_no_model_is_called(
        runtime, monkeypatch, members):
    extractor = reading(monkeypatch, Extractor())

    answer = run(runtime, send(**members))

    assert answer.status_code == 409 and extractor.seen == []
    assert count(runtime, 'proposal') == 0


def test_a_request_without_a_provider_is_409(runtime, monkeypatch):
    extractor = reading(monkeypatch, Extractor())

    async def work(client):
        return await client.post('/api/agent/statements', json={
            'thread_id': 's1', 'account': 'cto', 'name': 'x', 'text': TEXT})
    assert run(runtime, work).status_code == 409 and extractor.seen == []


@pytest.mark.parametrize('members, status', [
    ({'text': 'x' * 50_001}, 400),
    ({'text': '   '}, 400),
    ({'text': 12}, 400),
    ({'thread_id': 'a/b'}, 400),
    ({'name': ''}, 400),
    ({'name': 'a\nb'}, 400),
    ({'account': 7}, 400),
    ({'account': 'nowhere'}, 422),
])
def test_a_bad_request_is_refused_before_any_model_call(
        runtime, monkeypatch, members, status):
    extractor = reading(monkeypatch, Extractor())

    assert run(runtime, send(**members)).status_code == status
    assert extractor.seen == [] and count(runtime, 'proposal') == 0


def test_the_largest_text_is_read(runtime, monkeypatch):
    extractor = reading(monkeypatch, Extractor())

    assert run(runtime, send(text='x' * 50_000)).status_code == 201
    assert extractor.seen


def test_a_body_past_64_kib_is_413(runtime, monkeypatch):
    extractor = reading(monkeypatch, Extractor())

    assert run(runtime, send(text='é' * 40_000)).status_code == 413
    assert extractor.seen == []


def test_a_thread_busy_with_a_turn_is_409(runtime, monkeypatch):
    release = asyncio.Event()

    async def slow(messages, info):
        await release.wait()
        yield 'late'
    monkeypatch.setattr(agent, 'build_model', scripted(
        FunctionModel(stream_function=slow)))

    async def work(client):
        first = asyncio.create_task(
            client.post('/api/agent/chat', json=body('s1')))
        await asyncio.sleep(0.2)
        refused = await client.post('/api/agent/statements', json={
            'thread_id': 's1', 'account': 'cto', 'provider': 'anthropic',
            'name': 'x', 'text': TEXT})
        release.set()
        await first
        return refused
    assert run(runtime, work).status_code == 409


def test_a_provider_error_is_502_with_a_sentence_and_the_key_masked(
        runtime, monkeypatch):
    reading(monkeypatch, Extractor(fail=ModelHTTPError(
        401, 'claude', {'error': {'message': f'invalid x-api-key {KEY}'}})))

    answer = run(runtime, send())

    assert answer.status_code == 502
    assert answer.json()['error'].startswith('Anthropic: invalid x-api-key')
    assert KEY not in answer.text and CANARY not in answer.text
    assert count(runtime, 'proposal') == 0
    assert agent_routes.agent_threads.read(
        agent_routes.agent_threads.directory(runtime.store.path), 's1') is None


def test_any_other_failure_is_502_without_the_text(runtime, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    reading(monkeypatch, Extractor(fail=RuntimeError(f'boom {CANARY}')))

    answer = run(runtime, send())

    assert answer.status_code == 502
    assert CANARY not in answer.text and CANARY not in caplog.text
    assert count(runtime, 'proposal') == 0


def test_an_extraction_that_does_not_validate_is_422_and_writes_nothing(
        runtime, monkeypatch):
    reading(monkeypatch, Extractor(read={'kind': 'nonsense', 'lines': []}))

    answer = run(runtime, send())

    assert answer.status_code == 422
    assert count(runtime, 'proposal') == 0 and stored(runtime, 's1') is None


def test_a_positions_statement_without_a_day_is_422(runtime, monkeypatch):
    reading(monkeypatch, Extractor(read={**READ, 'as_of': None}))

    answer = run(runtime, send())

    assert answer.status_code == 422 and 'gives no date' in answer.json()['error']
    assert count(runtime, 'proposal') == 0 and stored(runtime, 's1') is None


def test_a_statement_after_a_failed_turn_keeps_the_thread_readable(
        runtime, monkeypatch):
    reading(monkeypatch, Extractor())
    assert run(runtime, send()).status_code == 201

    assert run(runtime, send()).status_code == 201

    thread = stored(runtime, 's1')
    assert len(thread['messages']) == 8
