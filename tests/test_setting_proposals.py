"""A setting the agent proposes (#1628): it proposes, only the app applies.

The store is real under ``tmp_path``; time is injected. The log level is the
process's own, so every test starts at ``INFO`` and puts it back.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from pydantic_ai.models.function import DeltaToolCall, FunctionModel

from api import create_app
from application import agent, main, profile, proposals, setting_proposals
from test_agent_routes import chunks, post, run, scripted, switched_on
from test_mcp_server import build_runtime, listed, rich_runtime

NOW = datetime(2026, 11, 22, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def at_info():
    main.set_log_level('INFO')
    yield
    main.set_log_level('INFO')


@pytest.fixture
def opened(tmp_path):
    return build_runtime(tmp_path)[1]


@pytest.fixture
def client(tmp_path):
    runtime, _ = build_runtime(tmp_path)
    return create_app(runtime).test_client(), runtime


def proposed(store, value='DEBUG', now=None):
    return setting_proposals.propose(
        store, 'log_level', value, 'INFO', now or datetime.now(timezone.utc))


def rows(store):
    """The setting proposals; a seeded store holds a profile fact's too."""
    return store.query(
        "SELECT payload, status FROM proposal WHERE kind = 'setting'")


# --------------------------------------------------------------- the kind --

@pytest.mark.parametrize('value', ['DEBUG', 'debug', ' Debug '])
def test_a_level_is_taken_as_set_log_level_takes_it(value):
    assert setting_proposals.validate('log_level', value) == 'DEBUG'


@pytest.mark.parametrize('key, value, reason', [
    ('base_currency', 'USD', "'base_currency' is not a setting that can be "
                             "proposed; the only one is log_level"),
    ('log_level', 'chatty', 'the log level is one of'),
    ('log_level', 10, 'the log level is one of'),
    ('log_level', None, 'the log level is one of'),
])
def test_another_key_or_an_unknown_level_is_refused_naming_the_rule(
        key, value, reason):
    with pytest.raises(setting_proposals.InvalidSettingProposal, match=reason):
        setting_proposals.validate(key, value)
    assert main.current_log_level() == 'INFO'


def test_a_proposal_is_a_setting_row_and_changes_no_setting(opened):
    proposal_id = setting_proposals.propose(
        opened, 'log_level', 'debug', 'INFO', NOW)

    assert rows(opened) == [(json.dumps(
        {'key': 'log_level', 'value': 'DEBUG', 'previous': 'INFO'}), 'ready')]
    assert main.current_log_level() == 'INFO'
    read, = setting_proposals.read(opened, [proposal_id], NOW)
    assert read == {
        'id': proposal_id, 'key': 'log_level', 'value': 'DEBUG',
        'previous': 'INFO', 'status': 'ready',
        'created_at': NOW.isoformat(), 'decided_at': None}
    # A kind reads its own rows only.
    assert profile.read_proposals(opened, [proposal_id], NOW) == []


def test_the_level_the_app_is_already_at_is_refused(opened):
    with pytest.raises(setting_proposals.InvalidSettingProposal,
                       match='already INFO'):
        setting_proposals.propose(opened, 'log_level', 'info', 'INFO', NOW)
    assert rows(opened) == []


def test_a_proposal_is_decided_once(opened):
    confirmed, ignored = proposed(opened, now=NOW), proposed(opened, now=NOW)

    assert setting_proposals.confirm(opened, confirmed, NOW)['status'] == 'merged'
    assert setting_proposals.ignore(opened, ignored, NOW)['status'] == 'ignored'

    for proposal_id, status in ((confirmed, 'merged'), (ignored, 'ignored')):
        with pytest.raises(proposals.ProposalNotReady) as refused:
            setting_proposals.confirm(opened, proposal_id, NOW)
        assert refused.value.status == status


def test_an_expired_or_unknown_proposal_cannot_be_decided(opened):
    proposal_id = proposed(opened, now=NOW)
    later = NOW + proposals.EXPIRY + timedelta(seconds=1)

    with pytest.raises(proposals.ProposalNotReady) as refused:
        setting_proposals.confirm(opened, proposal_id, later)
    assert refused.value.status == 'expired'
    with pytest.raises(proposals.UnknownProposal):
        setting_proposals.ignore(opened, '0' * 32, NOW)
    # Seven days to the second is still ready.
    assert setting_proposals.confirm(
        opened, proposal_id, NOW + proposals.EXPIRY)['status'] == 'merged'


# ------------------------------------------------------------- the routes --

def test_confirming_applies_the_level_once(client):
    http, runtime = client
    proposal_id = proposed(runtime.store)

    first = http.post(f'/api/config/proposals/{proposal_id}/confirm')
    assert first.status_code == 200
    assert first.get_json()['proposal']['status'] == 'merged'
    assert http.get('/api/config').get_json()['log_level'] == 'DEBUG'

    # Decided: a second press answers 409 and moves nothing.
    main.set_log_level('INFO')
    second = http.post(f'/api/config/proposals/{proposal_id}/confirm')
    assert second.status_code == 409
    assert 'déjà appliquée' in second.get_json()['detail']
    assert http.get('/api/config').get_json()['log_level'] == 'INFO'
    read, = http.get(
        f'/api/config/proposals?ids={proposal_id}').get_json()['proposals']
    assert (read['status'], read['previous'], read['value']) == (
        'merged', 'INFO', 'DEBUG')


def test_ignoring_leaves_the_level_and_reads_ignored(client):
    http, runtime = client
    proposal_id = proposed(runtime.store)

    answer = http.post(f'/api/config/proposals/{proposal_id}/ignore')

    assert answer.status_code == 200
    assert answer.get_json()['proposal']['status'] == 'ignored'
    assert http.get('/api/config').get_json()['log_level'] == 'INFO'
    confirm = http.post(f'/api/config/proposals/{proposal_id}/confirm')
    assert confirm.status_code == 409
    assert 'déjà ignorée' in confirm.get_json()['detail']
    assert http.get('/api/config').get_json()['log_level'] == 'INFO'


def test_an_expired_proposal_answers_409_and_reads_expired(client):
    http, runtime = client
    stale = datetime.now(timezone.utc) - proposals.EXPIRY - timedelta(seconds=1)
    proposal_id = proposed(runtime.store, now=stale)

    answer = http.post(f'/api/config/proposals/{proposal_id}/confirm')

    assert answer.status_code == 409 and 'expirée' in answer.get_json()['detail']
    assert http.get('/api/config').get_json()['log_level'] == 'INFO'
    read, = http.get(
        f'/api/config/proposals?ids={proposal_id}').get_json()['proposals']
    assert read['status'] == 'expired'


def test_the_routes_refuse_an_unknown_id_and_another_kind_s(client):
    http, runtime = client
    fact = profile.propose(runtime.store, 'marginal_rate', 0.3,
                           datetime.now(timezone.utc))

    for proposal_id in ('0' * 32, 'nope', fact):
        for decision in ('confirm', 'ignore'):
            assert http.post(
                f'/api/config/proposals/{proposal_id}/{decision}'
            ).status_code == 404
    assert http.get('/api/config').get_json()['log_level'] == 'INFO'


def test_proposals_are_read_by_ids_and_unknown_ones_are_left_out(client):
    http, runtime = client
    proposal_id = proposed(runtime.store)

    answer = http.get(f'/api/config/proposals?ids={proposal_id},{"f" * 32},'
                      f'{proposal_id}')

    assert [p['id'] for p in answer.get_json()['proposals']] == [proposal_id]
    assert http.get('/api/config/proposals?ids=nope').status_code == 400
    assert http.get('/api/config/proposals').status_code == 400
    many = ','.join(f'{i:032x}' for i in range(51))
    assert http.get(f'/api/config/proposals?ids={many}').status_code == 400


# ------------------------------------------------------- a turn, scripted --

def _proposing(*calls):
    """One ``propose_setting`` call per model turn, then an answer."""
    async def stream(messages, info):
        done = (len(messages) - 1) // 2
        if done < len(calls):
            key, value = calls[done]
            yield {0: DeltaToolCall(
                'propose_setting', json.dumps({'key': key, 'value': value}),
                tool_call_id=f's{done}')}
        else:
            yield 'It is proposed; nothing changes until you confirm.'
    return stream


def turn(tmp_path, monkeypatch, *calls):
    runtime = rich_runtime(tmp_path)
    switched_on(runtime)
    monkeypatch.setattr(agent, 'build_model', scripted(
        FunctionModel(stream_function=_proposing(*calls))))
    return runtime, chunks(run(runtime, post('t1')).text)


def test_a_turn_proposes_and_only_the_owner_s_confirmation_applies(
        tmp_path, monkeypatch):
    runtime, streamed = turn(tmp_path, monkeypatch, ('log_level', 'debug'))

    output, = [c['output'] for c in streamed
               if c['type'] == 'tool-output-available']
    assert (output['key'], output['previous'], output['value'],
            output['status']) == ('log_level', 'INFO', 'DEBUG', 'ready')
    assert [status for _, status in rows(runtime.store)] == ['ready']
    assert main.current_log_level() == 'INFO'

    http = create_app(runtime).test_client()
    confirmed = http.post(
        f"/api/config/proposals/{output['proposal_id']}/confirm")
    assert confirmed.status_code == 200
    assert main.current_log_level() == 'DEBUG'


def test_a_refused_setting_reaches_the_model_in_words_and_records_nothing(
        tmp_path, monkeypatch):
    """Twice in a row, so a refusal is seen to cost no retry: the turn ends
    on the model's own words, not on an error."""
    runtime, streamed = turn(
        tmp_path, monkeypatch,
        ('base_currency', 'USD'), ('log_level', 'chatty'))

    first, second = [c['errorText'] for c in streamed
                     if c['type'] == 'tool-output-error']
    assert "this setting is refused: 'base_currency' is not a setting" in first
    assert 'the log level is one of' in second
    assert not any(c['type'] == 'error' for c in streamed)
    assert any(c['type'] == 'text-delta' for c in streamed)
    assert rows(runtime.store) == []
    assert main.current_log_level() == 'INFO'


def test_mcp_never_lists_the_tool(tmp_path):
    runtime, _ = build_runtime(tmp_path)

    assert 'propose_setting' not in [tool.name for tool in listed(runtime)]


def test_a_store_that_cannot_record_says_so_to_the_model(tmp_path, monkeypatch):
    runtime = rich_runtime(tmp_path)
    switched_on(runtime)
    runtime.store.execute('DROP TABLE proposal')
    monkeypatch.setattr(agent, 'build_model', scripted(FunctionModel(
        stream_function=_proposing(('log_level', 'debug')))))

    streamed = chunks(run(runtime, post('t1')).text)

    error, = [c['errorText'] for c in streamed
              if c['type'] == 'tool-output-error']
    assert 'the store could not record this proposal' in error
    assert not any(c['type'] == 'error' for c in streamed)
    assert main.current_log_level() == 'INFO'
