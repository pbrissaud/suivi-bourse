"""The investor's profile (#1116): the agent proposes, only the app confirms.

The store is real under ``tmp_path``; time is injected.
"""
import json
import math
from datetime import datetime, timedelta, timezone

import pytest
from pydantic_ai.models.function import DeltaToolCall, FunctionModel

from api import create_app
from application import agent, profile
from test_agent_routes import chunks, post, run, scripted, switched_on
from test_mcp_server import _text, build_runtime, call, payload, rich_runtime

NOW = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
PROJECT = {'label': 'Maison', 'target_year': 2028}


def facts(opened):
    return opened.query('SELECT key FROM profile_fact')


@pytest.fixture
def opened(tmp_path):
    return build_runtime(tmp_path)[1]


@pytest.fixture
def client(tmp_path):
    runtime, _ = build_runtime(tmp_path)
    return create_app(runtime).test_client(), runtime


# ------------------------------------------------------------- validate --

@pytest.mark.parametrize('key, value', [
    ('income', {'amount': 54321}),
    ('marginal_rate', 0.3), ('marginal_rate', 0), ('marginal_rate', 0.6),
    ('risk_tolerance', 'dynamic'),
    ('project', {**PROJECT, 'amount': 300000}),
])
def test_a_valid_fact_is_taken(key, value):
    assert profile.validate(key, value, NOW) == value


@pytest.mark.parametrize('key, value, rule', [
    ('marginal_rate', 0.9, '0 to 0.6'),
    ('marginal_rate', True, '0 to 0.6'),
    ('marginal_rate', math.nan, '0 to 0.6'),
    ('marginal_rate', -0.1, '0 to 0.6'),
    ('risk_tolerance', 'yolo', 'prudent'),
    ('income', {'amount': -1}, '0 or more'),
    ('income', {'amount': math.inf}, '0 or more'),
    ('income', {'amount': 1, 'currency': 'USD'}, 'reporting currency'),
    ('project', {**PROJECT, 'target_year': 2025}, '2026 to 2076'),
    ('project', {**PROJECT, 'target_year': 2077}, '2026 to 2076'),
    ('project', {**PROJECT, 'target_year': True}, '2026 to 2076'),
    ('project', {**PROJECT, 'label': 'x' * 81}, '1 to 80'),
    ('project', {**PROJECT, 'label': 'a\nb'}, '1 to 80'),
    ('project', {**PROJECT, 'amount': False}, '0 or more'),
    ('age', 40, 'the key is one of'),
])
def test_an_invalid_fact_is_refused_naming_the_rule(key, value, rule):
    with pytest.raises(profile.InvalidProfileFact, match=rule):
        profile.validate(key, value, NOW)


def test_a_proposal_expires_after_seven_days_and_not_before():
    row = {'status': 'ready', 'created_at': NOW}
    edge = NOW + profile.EXPIRY
    assert profile.status(row, edge - timedelta(seconds=1)) == 'ready'
    assert profile.status(row, edge + timedelta(seconds=1)) == 'expired'
    assert profile.status({**row, 'status': 'merged'},
                          edge + timedelta(days=1)) == 'merged'


# ---------------------------------------------------------- the writes --

def test_a_fact_is_written_only_once_confirmed(opened):
    proposal_id = profile.propose(opened, 'marginal_rate', 0.3, NOW)
    assert facts(opened) == []

    confirmed = profile.confirm(opened, proposal_id, NOW)

    assert confirmed['status'] == 'merged'
    assert profile.read(opened)['facts']['marginal_rate']['value'] == 0.3


def test_confirming_twice_writes_once(opened):
    proposal_id = profile.propose(opened, 'risk_tolerance', 'prudent', NOW)
    profile.confirm(opened, proposal_id, NOW)

    with pytest.raises(profile.ProposalNotReady):
        profile.confirm(opened, proposal_id, NOW)
    assert len(facts(opened)) == 1


def test_an_expired_proposal_cannot_be_confirmed(opened):
    proposal_id = profile.propose(opened, 'marginal_rate', 0.3, NOW)

    with pytest.raises(profile.ProposalNotReady) as refused:
        profile.confirm(opened, proposal_id,
                        NOW + profile.EXPIRY + timedelta(seconds=1))
    assert refused.value.status == 'expired'
    assert facts(opened) == []


def test_an_ignored_proposal_writes_nothing_and_stays_ignored(opened):
    proposal_id = profile.propose(opened, 'marginal_rate', 0.3, NOW)
    assert profile.ignore(opened, proposal_id, NOW)['status'] == 'ignored'
    with pytest.raises(profile.ProposalNotReady):
        profile.confirm(opened, proposal_id, NOW)
    assert facts(opened) == []


def test_two_proposals_on_one_key_the_last_confirmed_wins(opened):
    first = profile.propose(opened, 'marginal_rate', 0.3, NOW)
    second = profile.propose(opened, 'marginal_rate', 0.41, NOW)
    profile.confirm(opened, second, NOW)
    profile.confirm(opened, first, NOW)
    assert profile.read(opened)['facts']['marginal_rate']['value'] == 0.3


def test_a_new_project_gets_its_id_when_confirmed(opened):
    proposal_id = profile.propose(opened, 'project', PROJECT, NOW)
    profile.confirm(opened, proposal_id, NOW)

    [project] = profile.read(opened)['projects']
    assert len(project['id']) == 12 and project['label'] == 'Maison'
    assert profile.read_proposals(opened, [proposal_id], NOW)[0]['key'] == 'project'
    with pytest.raises(profile.UnknownFact):
        profile.propose(opened, 'project:0123456789ab', PROJECT, NOW)


def test_an_income_carries_the_reporting_currency_and_needs_one(tmp_path):
    _, opened = build_runtime(tmp_path, currency=None)
    with pytest.raises(profile.InvalidProfileFact, match='currency first'):
        profile.propose(opened, 'income', {'amount': 1}, NOW)
    opened.execute("INSERT INTO setting VALUES ('base_currency', 'EUR')")
    profile.put(opened, 'income', {'amount': 1}, NOW)
    assert profile.read(opened)['facts']['income']['value'] == {
        'amount': 1, 'currency': 'EUR'}


# ------------------------------------------------------------- the MCP --

@pytest.mark.parametrize('key, value', [
    ('marginal_rate', 0.9), ('marginal_rate', True),
    ('risk_tolerance', 'yolo'), ('project', {**PROJECT, 'target_year': 2000}),
])
def test_an_invalid_proposal_is_refused_in_words_and_records_nothing(
        tmp_path, key, value):
    runtime, opened = build_runtime(tmp_path)

    result = call(runtime, 'propose_profile_fact', {'key': key, 'value': value})

    assert result.is_error is True
    assert 'this fact is refused' in _text(result)
    assert opened.query('SELECT * FROM proposal') == []


def test_the_agent_proposes_and_no_tool_decides(tmp_path):
    runtime, opened = build_runtime(tmp_path)

    answer = payload(call(runtime, 'propose_profile_fact',
                          {'key': 'marginal_rate', 'value': 0.3}))

    assert answer['status'] == 'ready' and 'confirmer' in answer['note']
    assert facts(opened) == []
    assert opened.query('SELECT status FROM proposal') == [('ready',)]


def test_get_profile_never_sends_the_income_amount(tmp_path):
    runtime = rich_runtime(tmp_path)

    answer = payload(call(runtime, 'get_profile'))

    assert answer['facts']['income'] == {
        'declared': True, 'confirmed_at': answer['facts']['income']['confirmed_at']}
    assert '54321' not in json.dumps(answer)
    assert answer['projects'][0]['label'] == 'Maison'


# ----------------------------------------------------------- the routes --

def test_a_proposal_is_confirmed_through_the_route_once(client):
    http, runtime = client
    proposal_id = profile.propose(runtime.store, 'marginal_rate', 0.3,
                                  datetime.now(timezone.utc))
    assert http.get('/api/profile').get_json() == {'facts': {}, 'projects': []}

    first = http.post(f'/api/profile/proposals/{proposal_id}/confirm')
    second = http.post(f'/api/profile/proposals/{proposal_id}/confirm')

    assert first.status_code == 200
    assert first.get_json()['profile']['facts']['marginal_rate']['value'] == 0.3
    assert second.status_code == 409
    assert 'déjà notée' in second.get_json()['detail']
    assert len(facts(runtime.store)) == 1


def test_the_routes_answer_404_409_and_422(client):
    http, runtime = client
    unknown = '0' * 32
    assert http.post(f'/api/profile/proposals/{unknown}/ignore').status_code == 404
    ignored = profile.propose(runtime.store, 'marginal_rate', 0.3,
                              datetime.now(timezone.utc))
    assert http.post(f'/api/profile/proposals/{ignored}/ignore').status_code == 200
    assert http.post(f'/api/profile/proposals/{ignored}/confirm').status_code == 409

    refused = http.put('/api/profile/marginal_rate', json={'value': 0.9})
    assert refused.status_code == 422
    assert refused.get_json()['key'] == 'marginal_rate'
    assert http.put('/api/profile/project:0123456789ab',
                    json={'value': PROJECT}).status_code == 404
    assert http.put('/api/profile/age', json={'value': 1}).status_code == 404
    assert http.delete('/api/profile/marginal_rate').status_code == 404


def test_the_owner_reads_edits_and_forgets_their_own_income(client):
    http, _ = client

    answer = http.put('/api/profile/income', json={'value': {'amount': 54321}})

    assert answer.get_json()['facts']['income']['value'] == {
        'amount': 54321, 'currency': 'EUR'}
    assert http.delete('/api/profile/income').status_code == 204
    assert http.get('/api/profile').get_json()['facts'] == {}


def test_proposals_are_read_by_ids_and_unknown_ones_are_left_out(client):
    http, runtime = client
    proposal_id = profile.propose(runtime.store, 'risk_tolerance', 'prudent',
                                  datetime.now(timezone.utc))

    answer = http.get(f'/api/profile/proposals?ids={proposal_id},{"f" * 32},'
                      f'{proposal_id}')

    assert [p['id'] for p in answer.get_json()['proposals']] == [proposal_id]
    assert http.get('/api/profile/proposals?ids=nope').status_code == 400
    assert http.get('/api/profile/proposals').status_code == 400
    many = ','.join(f'{i:032x}' for i in range(51))
    assert http.get(f'/api/profile/proposals?ids={many}').status_code == 400


# ------------------------------------------------- a turn, scripted --

def _proposing(value):
    async def stream(messages, info):
        # Counted in model turns: a refused call comes back as a retry
        # prompt, not as a tool return.
        done = (len(messages) - 1) // 2
        if done == 0:
            yield {0: DeltaToolCall(
                'propose_profile_fact',
                json.dumps({'key': 'marginal_rate', 'value': value}),
                tool_call_id='p1')}
        elif done == 1 and value != 0.9:
            yield {0: DeltaToolCall('get_profile', '{}', tool_call_id='g1')}
        else:
            yield 'Noted, pending your confirmation.'
    return stream


def test_a_turn_proposes_the_owner_confirms_and_the_next_read_sees_it(
        tmp_path, monkeypatch):
    runtime = rich_runtime(tmp_path)
    switched_on(runtime)
    with runtime.config_manager.writing() as opened:
        profile.forget(opened, 'marginal_rate')
    monkeypatch.setattr(agent, 'build_model', scripted(
        FunctionModel(stream_function=_proposing(0.25))))

    outputs = [c for c in chunks(run(runtime, post('t1')).text)
               if c['type'] == 'tool-output-available']

    proposal_id = outputs[0]['output']['proposal_id']
    assert 'marginal_rate' not in outputs[1]['output']['facts']
    http = create_app(runtime).test_client()
    assert http.post(f'/api/profile/proposals/{proposal_id}/confirm').status_code == 200
    seen = payload(call(runtime, 'get_profile'))
    assert seen['facts']['marginal_rate']['value'] == 0.25


def test_a_turn_with_an_invalid_value_is_a_tool_error_and_records_nothing(
        tmp_path, monkeypatch):
    runtime = rich_runtime(tmp_path)
    switched_on(runtime)
    before = runtime.store.query('SELECT count(*) FROM proposal')
    monkeypatch.setattr(agent, 'build_model', scripted(
        FunctionModel(stream_function=_proposing(0.9))))

    streamed = chunks(run(runtime, post('t2')).text)

    [error] = [c for c in streamed if c['type'] == 'tool-output-error']
    assert 'this fact is refused' in error['errorText']
    assert not any(c['type'] == 'error' for c in streamed)
    assert runtime.store.query('SELECT count(*) FROM proposal') == before


# --------------------------------------------------- after the review --

def test_the_instructions_name_the_one_tool_that_proposes(tmp_path):
    from test_mcp_server import instructions
    runtime, _ = build_runtime(tmp_path)

    said = ' '.join(instructions(runtime).split())

    assert 'cannot change it' not in said
    assert '`propose_profile_fact`' in said and 'no tool confirms one' in said


def test_an_expired_proposal_answers_409_and_reads_expired(client):
    http, runtime = client
    stale = datetime.now(timezone.utc) - profile.EXPIRY - timedelta(seconds=1)
    proposal_id = profile.propose(runtime.store, 'marginal_rate', 0.3, stale)

    answer = http.post(f'/api/profile/proposals/{proposal_id}/confirm')

    assert answer.status_code == 409 and 'expirée' in answer.get_json()['detail']
    assert facts(runtime.store) == []
    [read] = http.get(f'/api/profile/proposals?ids={proposal_id}').get_json()['proposals']
    assert read['status'] == 'expired'


def test_confirm_refuses_an_unknown_or_malformed_id_and_a_bodyless_put(client):
    http, _ = client
    assert http.post(f'/api/profile/proposals/{"0" * 32}/confirm').status_code == 404
    assert http.post('/api/profile/proposals/nope/confirm').status_code == 404
    assert http.delete('/api/profile/age').status_code == 404
    assert http.put('/api/profile/marginal_rate', json={}).status_code == 400
    assert http.put('/api/profile/marginal_rate', data='0.3').status_code == 400


def _a_project(opened, now=NOW, year=2028):
    profile.confirm(opened, profile.propose(
        opened, 'project', {'label': 'Maison', 'target_year': year}, now), now)
    return 'project:' + profile.read(opened)['projects'][0]['id']


def test_a_change_to_a_project_is_confirmed_in_place(opened):
    key = _a_project(opened)

    profile.confirm(opened, profile.propose(
        opened, key, {'label': 'Grande maison', 'target_year': 2030}, NOW), NOW)

    [project] = profile.read(opened)['projects']
    assert (project['label'], project['target_year']) == ('Grande maison', 2030)


def test_a_change_to_a_project_forgotten_since_answers_404(client):
    http, runtime = client
    now = datetime.now(timezone.utc)
    key = _a_project(runtime.store, now, now.year + 2)
    proposal_id = profile.propose(runtime.store, key,
                                  {'label': 'Autre', 'target_year': now.year + 3}, now)
    assert http.delete(f'/api/profile/{key}').status_code == 204

    answer = http.post(f'/api/profile/proposals/{proposal_id}/confirm')

    assert answer.status_code == 404
    assert facts(runtime.store) == []


def test_an_income_is_confirmed_in_the_currency_it_was_proposed_in(opened):
    proposal_id = profile.propose(opened, 'income', {'amount': 54321}, NOW)
    opened.execute("UPDATE setting SET value = 'USD' WHERE key = 'base_currency'")

    profile.confirm(opened, proposal_id, NOW)

    assert profile.read(opened)['facts']['income']['value'] == {
        'amount': 54321, 'currency': 'EUR'}


def test_a_project_whose_year_has_passed_can_still_be_renamed(opened):
    key = _a_project(opened, NOW.replace(year=2025), 2025)

    profile.put(opened, key, {'label': 'Maison achetée', 'target_year': 2025}, NOW)

    assert profile.read(opened)['projects'][0]['label'] == 'Maison achetée'
    with pytest.raises(profile.InvalidProfileFact, match='2025 to 2076'):
        profile.put(opened, key, {'label': 'Maison', 'target_year': 2024}, NOW)


def test_a_decision_on_a_proposal_decided_meanwhile_writes_nothing(opened):
    proposal_id = profile.propose(opened, 'marginal_rate', 0.3, NOW)
    # Another writer decided it between the read and the write.
    opened.execute("UPDATE proposal SET status = 'ignored' WHERE id = ?",
                   [proposal_id])

    with pytest.raises(profile.ProposalNotReady) as refused:
        with opened.transaction():
            profile._write(opened, 'marginal_rate', 0.3, NOW)
            profile._decide(opened, proposal_id, 'merged', NOW)
    assert refused.value.status == 'ignored'
    assert facts(opened) == []
