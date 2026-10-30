"""Ledger events the agent proposes, the owner merges (#1119).

The store is real under ``tmp_path``; time is injected. ``propose`` is the
agent's one write and lands in ``proposal``; only the routes merge.
"""
import json
import re
from datetime import date, datetime, timedelta, timezone

import pytest
from pydantic_ai.models.function import DeltaToolCall, FunctionModel

from api import create_app
from application import accounts as accounts_module
from application import agent, entries, event_proposals, ledger, proposals
from application import statements
from application.events.schemas import Event, EventType
from test_agent_routes import chunks, post, run, scripted, switched_on
from test_mcp_server import build_runtime, call, payload

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
BUY = {'date': '2026-03-03', 'event_type': 'BUY', 'symbol': 'CW8.PA',
       'name': 'Amundi MSCI World', 'quantity': 10, 'unit_price': 512,
       'account': 'cto'}


def batch(*bodies):
    return json.dumps(list(bodies or [BUY]))


def count(opened, table):
    return opened.query(f'SELECT count(*) FROM {table}')[0][0]


@pytest.fixture
def runtime(tmp_path):
    runtime, opened = build_runtime(tmp_path)
    accounts_module.create_account(opened, 'cto')
    entries.create_many(opened, [
        Event(date(2026, 1, 5), EventType.BUY, 'AAPL', 'Apple Inc',
              quantity=5, unit_price=150.0, account='cto')])
    runtime.config_manager.reload()
    return runtime


@pytest.fixture
def opened(runtime):
    return runtime.store


@pytest.fixture
def http(runtime):
    return create_app(runtime).test_client()


def the_only_proposal(opened):
    return opened.query('SELECT id FROM proposal')[0][0]


# ------------------------------------------------------------- refusals --

@pytest.mark.parametrize('events_json, where', [
    ('{not json', 'events_json'),
    ('{"date": "2026-03-03"}', 'events_json'),
    (batch(BUY, {**BUY, 'event_type': 'BUYY'}), 'line 2 (event_type)'),
    (batch(BUY, {**BUY, 'account': 'boursorama'}), "line 2 (account)"),
    (batch({**BUY, 'mark': 'statement'}), 'line 1 (mark)'),
    (batch({**BUY, 'marks': ['statement']}), 'line 1 (marks)'),
    (json.dumps([BUY] * (event_proposals.EVENTS_MAX + 1)), 'events_json'),
    (batch({**BUY, 'event_type': 'SELL', 'quantity': 99}), 'line 1 (quantity)'),
])
def test_an_invalid_batch_is_refused_whole_naming_the_line(
        opened, events_json, where):
    before = ledger.stamp(opened)

    with pytest.raises(event_proposals.InvalidProposal, match=re.escape(where)):
        event_proposals.propose(opened, 'Achats', events_json, NOW)

    assert count(opened, 'proposal') == 0
    assert ledger.stamp(opened) == before


def test_an_unknown_account_says_to_ask_the_owner(opened):
    with pytest.raises(event_proposals.InvalidProposal, match=(
            "account 'boursorama' does not exist; ask the owner to create "
            "it in Comptes, then propose again")):
        event_proposals.propose(
            opened, 'x', batch({**BUY, 'account': 'boursorama'}), NOW)


@pytest.mark.parametrize('title', ['', '   ', 'x' * 81, 'a\nb', None])
def test_a_title_is_one_line_of_one_to_eighty_characters(opened, title):
    with pytest.raises(event_proposals.InvalidProposal, match='title'):
        event_proposals.propose(opened, title, batch(), NOW)


def test_the_validator_refusal_names_the_line_not_the_position_among_fresh(
        opened):
    held = {'date': '2026-01-05', 'event_type': 'BUY', 'symbol': 'AAPL',
            'name': 'Apple Inc', 'quantity': 5, 'unit_price': 150,
            'account': 'cto'}

    with pytest.raises(event_proposals.InvalidProposal) as refused:
        event_proposals.propose(
            opened, 'x', batch(held, {**BUY, 'quantity': -1}), NOW)

    assert refused.value.line == 2 and 'line 2 (quantity)' in str(refused.value)


# ------------------------------------------------------------- the write --

def test_propose_writes_one_proposal_and_not_one_event(opened):
    before = ledger.stamp(opened)
    events_before = count(opened, 'event')

    proposal_id = event_proposals.propose(opened, 'Achat CW8', batch(), NOW)

    assert ledger.stamp(opened) == before
    assert count(opened, 'event') == events_before
    assert opened.query('SELECT id, kind, status FROM proposal') == [
        (proposal_id, 'events', 'ready')]


def test_the_stored_payload_is_the_normalised_batch_and_the_stamp(opened):
    event_proposals.propose(opened, ' Achat CW8 ', batch({**BUY, 'event_type': 'buy'}), NOW)

    payload_ = json.loads(opened.query('SELECT payload FROM proposal')[0][0])

    assert payload_['title'] == 'Achat CW8'
    assert payload_['events'][0]['event_type'] == 'BUY'
    assert payload_['stamp'] == ledger.stamp(opened)


# ------------------------------------------------------------ the status --

def test_status_is_stale_only_for_a_stamped_row_and_expired_after_seven_days():
    row = {'status': 'ready', 'created_at': NOW, 'stamp': 'a'}
    assert proposals.status(row, NOW, 'a') == 'ready'
    assert proposals.status(row, NOW, 'b') == 'stale'
    assert proposals.status({'status': 'ready', 'created_at': NOW}, NOW, 'b') == 'ready'
    edge = NOW + proposals.EXPIRY
    assert proposals.status(row, edge, 'a') == 'ready'
    assert proposals.status(row, edge + timedelta(seconds=1), 'b') == 'expired'
    assert proposals.status({**row, 'status': 'merged'}, NOW, 'b') == 'merged'


def test_a_proposal_reads_stale_once_the_ledger_moved(http, opened):
    proposal_id = event_proposals.propose(opened, 'x', batch(), datetime.now(timezone.utc))
    assert http.get(f'/api/agent/proposals?ids={proposal_id}').get_json()[
        'proposals'][0]['status'] == 'ready'

    entries.create(opened, Event(date(2026, 2, 1), EventType.DEPOSIT, amount=10.0,
                                 account='cto'))

    [read] = http.get(f'/api/agent/proposals?ids={proposal_id}').get_json()['proposals']
    assert read['status'] == 'stale' and read['count'] == 1
    assert read['events'] == [{
        'date': '2026-03-03', 'event_type': 'BUY', 'account': 'cto',
        'symbol': 'CW8.PA', 'quantity': 10.0, 'unit_price': 512.0, 'fee': None,
        'amount': None, 'notes': None}]


def test_the_list_route_validates_its_ids(http):
    assert http.get('/api/agent/proposals').status_code == 400
    assert http.get('/api/agent/proposals?ids=nope').status_code == 400
    assert http.get(f'/api/agent/proposals?ids={"f" * 32}').get_json() == {
        'proposals': []}


# --------------------------------------------------- preview and merge --

def propose_now(opened, *bodies):
    return event_proposals.propose(opened, 'Achat CW8', batch(*bodies),
                                   datetime.now(timezone.utc))


def test_a_preview_writes_nothing_and_has_the_receipt_shape(http, opened):
    held = {'date': '2026-01-05', 'event_type': 'BUY', 'symbol': 'AAPL',
            'name': 'Apple Inc', 'quantity': 5, 'unit_price': 150,
            'account': 'cto'}
    proposal_id = propose_now(opened, BUY, held)
    before = ledger.stamp(opened)

    answer = http.post(f'/api/agent/proposals/{proposal_id}/preview')

    assert answer.status_code == 200
    body = answer.get_json()
    assert body['rows'] == 2 and body['written'] == 1 and body['duplicates'] == 1
    assert body['duplicate_rows'][0]['symbol'] == 'AAPL'
    assert body['symbols'] == ['AAPL', 'CW8.PA'] and body['accounts'] == ['cto']
    assert body['proposal'] == {'id': proposal_id, 'title': 'Achat CW8',
                                'status': 'ready'}
    assert ledger.stamp(opened) == before and count(opened, 'event') == 1


def test_a_merge_writes_the_events_and_marks_the_proposal_merged(http, opened):
    proposal_id = propose_now(opened)

    answer = http.post(f'/api/agent/proposals/{proposal_id}/merge')

    assert answer.status_code == 201
    body = answer.get_json()
    assert body['written'] == 1 and len(body['written_ids']) == 1
    assert count(opened, 'event') == 2
    [read] = http.get(f'/api/agent/proposals?ids={proposal_id}').get_json()['proposals']
    assert read['status'] == 'merged' and read['decided_at']
    ids = [str(e['id']) for e in http.get('/api/events').get_json()]
    assert body['written_ids'][0] in ids


def test_a_merge_skips_the_duplicates_unless_asked(http, opened):
    held = {'date': '2026-01-05', 'event_type': 'BUY', 'symbol': 'AAPL',
            'name': 'Apple Inc', 'quantity': 5, 'unit_price': 150,
            'account': 'cto'}
    proposal_id = propose_now(opened, held)

    answer = http.post(f'/api/agent/proposals/{proposal_id}/merge')

    assert answer.get_json()['written'] == 0 and count(opened, 'event') == 1
    assert http.get(f'/api/agent/proposals?ids={proposal_id}').get_json()[
        'proposals'][0]['status'] == 'merged'


def test_a_failure_while_writing_leaves_the_proposal_ready_and_no_event(
        http, opened, monkeypatch):
    proposal_id = propose_now(opened)
    real = entries.record_many

    def broken(store, drafts, **how):
        real(store, drafts, **how)
        raise RuntimeError('disk full')
    monkeypatch.setattr(entries, 'record_many', broken)

    answer = http.post(f'/api/agent/proposals/{proposal_id}/merge')

    assert answer.status_code == 500
    assert count(opened, 'event') == 1
    assert opened.query('SELECT status FROM proposal') == [('ready',)]


def test_a_merge_after_the_ledger_moved_is_409_and_writes_nothing(http, opened):
    proposal_id = propose_now(opened)
    entries.create(opened, Event(date(2026, 2, 1), EventType.DEPOSIT, amount=10.0,
                                 account='cto'))

    for route in ('preview', 'merge'):
        answer = http.post(f'/api/agent/proposals/{proposal_id}/{route}')
        assert answer.status_code == 409
        assert answer.get_json()['type'] == '/problems/proposal-stale'
        assert 'Le grand livre a changé' in answer.get_json()['detail']
    assert count(opened, 'event') == 2
    assert opened.query('SELECT status FROM proposal') == [('ready',)]


def test_repropose_makes_a_new_ready_proposal_and_ignores_the_old(http, opened):
    old = propose_now(opened)
    entries.create(opened, Event(date(2026, 2, 1), EventType.DEPOSIT, amount=10.0,
                                 account='cto'))

    answer = http.post(f'/api/agent/proposals/{old}/repropose')

    assert answer.status_code == 200
    new = answer.get_json()['proposal']
    assert new['id'] != old and new['status'] == 'ready' and new['count'] == 1
    assert dict(opened.query('SELECT id, status FROM proposal')) == {
        old: 'ignored', new['id']: 'ready'}
    assert http.post(f"/api/agent/proposals/{new['id']}/merge").status_code == 201


def test_repropose_says_in_words_when_the_events_no_longer_pass(http, opened):
    sell = {**BUY, 'event_type': 'SELL', 'symbol': 'AAPL', 'name': 'Apple Inc',
            'quantity': 5, 'date': '2026-02-01', 'unit_price': 160}
    old = propose_now(opened, sell)
    entries.create(opened, Event(date(2026, 1, 20), EventType.SELL, 'AAPL',
                                 'Apple Inc', quantity=5, unit_price=155.0,
                                 account='cto'))

    answer = http.post(f'/api/agent/proposals/{old}/repropose')

    assert answer.status_code == 422 and 'line 1' in answer.get_json()['detail']
    assert opened.query('SELECT status FROM proposal') == [('ready',)]


def test_an_expired_proposal_reads_expired_and_merge_is_409(http, opened):
    old = datetime.now(timezone.utc) - proposals.EXPIRY - timedelta(seconds=1)
    proposal_id = event_proposals.propose(opened, 'x', batch(), old)

    answer = http.post(f'/api/agent/proposals/{proposal_id}/merge')

    assert answer.status_code == 409 and 'expirée' in answer.get_json()['detail']
    assert count(opened, 'event') == 1
    assert http.get(f'/api/agent/proposals?ids={proposal_id}').get_json()[
        'proposals'][0]['status'] == 'expired'


def test_ignore_decides_once_and_the_ledger_is_untouched(http, opened):
    proposal_id = propose_now(opened)

    first = http.post(f'/api/agent/proposals/{proposal_id}/ignore')
    again = http.post(f'/api/agent/proposals/{proposal_id}/ignore')

    assert first.get_json()['proposal']['status'] == 'ignored'
    assert again.status_code == 409 and 'déjà ignorée' in again.get_json()['detail']
    assert http.post(f'/api/agent/proposals/{proposal_id}/merge').status_code == 409
    assert count(opened, 'event') == 1


def test_a_stale_proposal_can_still_be_ignored(http, opened):
    proposal_id = propose_now(opened)
    entries.create(opened, Event(date(2026, 2, 1), EventType.DEPOSIT, amount=10.0,
                                 account='cto'))

    answer = http.post(f'/api/agent/proposals/{proposal_id}/ignore')

    assert answer.status_code == 200


@pytest.mark.parametrize('route', ['preview', 'merge', 'ignore', 'repropose'])
def test_the_routes_answer_404_for_an_unknown_or_malformed_id(http, route):
    assert http.post(f'/api/agent/proposals/{"0" * 32}/{route}').status_code == 404
    assert http.post(f'/api/agent/proposals/nope/{route}').status_code == 404


def test_a_profile_proposal_is_not_an_events_proposal(http, runtime):
    from application import profile
    fact = profile.propose(runtime.store, 'marginal_rate', 0.3, datetime.now(timezone.utc))

    assert http.post(f'/api/agent/proposals/{fact}/merge').status_code == 404
    assert http.get(f'/api/agent/proposals?ids={fact}').get_json() == {'proposals': []}


def test_a_foreign_security_asks_its_currency_question_in_the_preview(
        http, opened, monkeypatch):
    from application import import_currency
    monkeypatch.setattr(import_currency, '_look_up', lambda symbol: 'USD')
    # The base is EUR and the proposal states no unit: a USD security is asked about.
    proposal_id = propose_now(opened, {**BUY, 'symbol': 'AAPL', 'name': 'Apple Inc'})

    answer = http.post(f'/api/agent/proposals/{proposal_id}/preview')

    assert answer.status_code == 200
    assert answer.get_json()['foreign_lines'] == [
        {'symbol': 'AAPL', 'currency': 'USD', 'rows': 1}]


# ---------------------------------------------------------- a turn, scripted --

def _proposing(events_json):
    async def stream(messages, info):
        done = (len(messages) - 1) // 2
        if done == 0:
            yield {0: DeltaToolCall(
                'propose_events',
                json.dumps({'title': 'Achat CW8', 'events_json': events_json}),
                tool_call_id='p1')}
        else:
            yield 'Proposed, pending your review.'
    return stream


def test_a_turn_proposes_the_owner_previews_and_merges(runtime, monkeypatch):
    switched_on(runtime)
    accounts_module.create_account(runtime.store, 'pea')
    monkeypatch.setattr(agent, 'build_model', scripted(
        FunctionModel(stream_function=_proposing(batch()))))
    before = ledger.stamp(runtime.store)

    outputs = [c for c in chunks(run(runtime, post('t1')).text)
               if c['type'] == 'tool-output-available']

    proposal = outputs[0]['output']
    assert proposal['count'] == 1 and proposal['status'] == 'ready'
    assert proposal['preview_url'] == f"/ledger?proposal={proposal['proposal_id']}"
    assert ledger.stamp(runtime.store) == before
    http = create_app(runtime).test_client()
    base = f"/api/agent/proposals/{proposal['proposal_id']}"
    assert http.get(f"/api/agent/proposals?ids={proposal['proposal_id']}").get_json()[
        'proposals'][0]['status'] == 'ready'
    assert http.post(f'{base}/preview').status_code == 200
    assert http.post(f'{base}/merge').status_code == 201
    symbols = [e['symbol'] for e in http.get('/api/events').get_json()]
    assert 'CW8.PA' in symbols
    assert http.get(f"/api/agent/proposals?ids={proposal['proposal_id']}").get_json()[
        'proposals'][0]['status'] == 'merged'


def test_a_refused_batch_is_a_tool_error_naming_the_line_and_records_nothing(
        runtime, monkeypatch):
    switched_on(runtime)
    monkeypatch.setattr(agent, 'build_model', scripted(FunctionModel(
        stream_function=_proposing(batch(BUY, {**BUY, 'event_type': 'BUYY'})))))

    streamed = chunks(run(runtime, post('t2')).text)

    [error] = [c for c in streamed if c['type'] == 'tool-output-error']
    assert 'this proposal is refused' in error['errorText']
    assert 'line 2 (event_type)' in error['errorText']
    assert count(runtime.store, 'proposal') == 0


def test_no_tool_merges_ignores_or_reproposes(runtime):
    from test_mcp_server import listed
    names = {tool.name for tool in listed(runtime)}
    assert {n for n in names if any(w in n for w in (
        'merge', 'ignore', 'repropose', 'confirm'))} == set()
    assert {n for n in names if n.startswith('propose')} == {
        'propose_events', 'propose_profile_fact'}


@pytest.mark.parametrize('member', ['mark', 'marks'])
def test_the_tool_refuses_a_mark_the_agent_proposes(runtime, member):
    from test_mcp_server import _text
    answer = call(runtime, 'propose_events', {
        'title': 'Achat CW8', 'events_json': batch({**BUY, member: ['gap']})})

    assert answer.is_error is True
    assert f'line 1 ({member})' in _text(answer)
    assert count(runtime.store, 'proposal') == 0


def test_the_tool_answers_through_mcp_directly(runtime):
    answer = payload(call(runtime, 'propose_events',
                          {'title': 'Achat CW8', 'events_json': batch()}))

    assert answer['count'] == 1 and answer['title'] == 'Achat CW8'
    assert count(runtime.store, 'event') == 1


# ------------------------------------------------- after the adversarial review --

def test_two_identical_lines_are_skipped_unless_the_owner_writes_the_repeat(
        http, opened):
    proposal_id = propose_now(opened, BUY, BUY)

    preview = http.post(f'/api/agent/proposals/{proposal_id}/preview').get_json()
    assert preview['rows'] == 2 and preview['written'] == 1
    [repeat] = preview['duplicate_rows']
    assert repeat['repeat_of'] == 0

    whole = http.post(f'/api/agent/proposals/{proposal_id}/preview?write_repeat=0')
    assert whole.get_json()['written'] == 2
    merged = http.post(f'/api/agent/proposals/{proposal_id}/merge?write_repeat=0')
    assert merged.status_code == 201 and len(merged.get_json()['written_ids']) == 2
    assert count(opened, 'event') == 3


def test_a_repeat_index_that_names_no_group_is_refused(http, opened):
    proposal_id = propose_now(opened)

    answer = http.post(f'/api/agent/proposals/{proposal_id}/merge?write_repeat=0')

    assert answer.status_code == 422 and count(opened, 'event') == 1
    assert opened.query('SELECT status FROM proposal') == [('ready',)]


@pytest.mark.parametrize('body, where', [
    ({'notes': 'x' * 201}, 'line 1 (notes)'),
    ({'symbol': 'X' * 201}, 'line 1 (symbol)'),
])
def test_a_text_member_past_its_cap_is_refused_naming_line_and_field(
        opened, body, where):
    with pytest.raises(event_proposals.InvalidProposal, match=re.escape(where)):
        event_proposals.propose(opened, 'x', batch({**BUY, **body}), NOW)
    assert count(opened, 'proposal') == 0


def test_a_number_too_large_for_a_float_is_refused_in_words(opened):
    huge = '[{"date": "2026-03-03", "event_type": "DEPOSIT", "amount": 1' + '0' * 400 + '}]'

    with pytest.raises(event_proposals.InvalidProposal, match=r'line 1 \(amount\)'):
        event_proposals.propose(opened, 'x', huge, NOW)


# ------------------------------------------------------ a broker statement --

def line(name='AMUNDI MSCI WORLD', **members):
    return statements.ExtractedLine(name=name, **members)


def statement_of(opened, *lines, kind='positions', as_of=date(2026, 6, 30),
                 search=lambda query: [{'symbol': 'CW8.PA'}], **members):
    return statements.resolve(opened, 'cto', statements.Extraction(
        kind=kind, as_of=as_of, lines=list(lines), **members), search)


def propose_statement_now(opened, *lines, **members):
    return event_proposals.propose_statement(
        opened, 'Relevé Boursorama', statement_of(opened, *lines, **members),
        datetime.now(timezone.utc))


def aapl_and(*lines):
    return (line('APPLE', ticker='AAPL', quantity=5), *lines)


def test_a_statement_proposal_stores_the_extraction_and_no_event(opened):
    before = count(opened, 'event')

    proposal_id = propose_statement_now(opened, *aapl_and(
        line(isin='FR0010315770', quantity=12, unit_price=512.4)))

    payload_ = json.loads(opened.query('SELECT payload FROM proposal')[0][0])
    assert 'events' not in payload_ and payload_['stamp'] == ledger.stamp(opened)
    assert payload_['statement']['lines'][1]['symbol'] == 'CW8.PA'
    assert count(opened, 'event') == before
    assert proposal_id


def test_a_statement_proposal_reads_with_marks_and_its_facts(http, opened):
    proposal_id = propose_statement_now(opened, *aapl_and(
        line(isin='FR0010315770', quantity=12, unit_price=512.4)))

    [read] = http.get(f'/api/agent/proposals?ids={proposal_id}').get_json()['proposals']

    assert read['count'] == 1 and read['status'] == 'ready'
    assert read['events'][0]['marks'] == ['statement', 'gap']
    assert read['events'][0]['price_source'] == 'statement'
    assert read['statement'] == {
        'kind': 'positions', 'as_of': '2026-06-30', 'dropped': 0,
        'unresolved': [], 'pending_held': 0, 'total_check': None}


def test_a_statement_previews_its_gap_and_merges_it(http, opened):
    proposal_id = propose_statement_now(opened, *aapl_and(
        line(isin='FR0010315770', quantity=12, unit_price=512.4)))

    preview = http.post(f'/api/agent/proposals/{proposal_id}/preview')

    assert preview.status_code == 200
    body = preview.get_json()
    assert body['rows'] == 1 and body['written'] == 1
    assert body['statement']['lines'][0]['marks'] == ['statement', 'gap']
    assert count(opened, 'event') == 1
    merged = http.post(f'/api/agent/proposals/{proposal_id}/merge')
    assert merged.status_code == 201 and count(opened, 'event') == 2
    [written] = [e for e in http.get('/api/events').get_json()
                 if e['symbol'] == 'CW8.PA']
    assert written['quantity'] == 12 and written['date'] == '2026-06-30'
    assert written['unit_price'] == 512.4 and written['amount'] is None


def test_an_unresolved_line_previews_but_blocks_the_merge_until_chosen(http, opened):
    proposal_id = propose_statement_now(
        opened, *aapl_and(line(isin='FR0010315770', quantity=12,
                               unit_price=512.4)), search=lambda query: [])
    base = f'/api/agent/proposals/{proposal_id}'

    preview = http.post(f'{base}/preview').get_json()
    refused = http.post(f'{base}/merge')

    assert preview['statement']['unresolved'] == [
        {'n': 2, 'name': 'AMUNDI MSCI WORLD', 'isin': 'FR0010315770'}]
    assert preview['rows'] == 0
    assert refused.status_code == 422
    assert refused.get_json()['detail'] == (
        'line 2 (symbol): choose the title for "AMUNDI MSCI WORLD" '
        '(FR0010315770)')
    chosen = {'symbols': {'2': 'CW8.PA'}}
    assert http.post(f'{base}/preview', json=chosen).get_json()['rows'] == 1
    assert http.post(f'{base}/merge', json=chosen).status_code == 201
    assert 'CW8.PA' in [e['symbol'] for e in http.get('/api/events').get_json()]


def test_a_gap_without_a_price_is_refused_until_one_is_typed(http, opened):
    proposal_id = propose_statement_now(
        opened, *aapl_and(line(isin='FR0010315770', quantity=12)))
    base = f'/api/agent/proposals/{proposal_id}'

    preview = http.post(f'{base}/preview').get_json()
    refused = http.post(f'{base}/merge')

    assert preview['statement']['lines'][0]['price_source'] is None
    assert preview['statement']['lines'][0]['unit_price'] is None
    assert refused.status_code == 422 and 'type a price' in refused.get_json()['detail']
    typed = {'prices': {'CW8.PA': 530.5}}
    assert http.post(f'{base}/merge', json=typed).status_code == 201
    [written] = [e for e in http.get('/api/events').get_json()
                 if e['symbol'] == 'CW8.PA']
    assert written['unit_price'] == 530.5


@pytest.mark.parametrize('edits, key', [
    ({'prices': {'AAPL': 5}}, 'prices'),
    ({'symbols': {'1': 'AAPL'}}, 'symbols'),
    ({'tickers': {}}, 'tickers'),
    ({'prices': [5]}, 'prices'),
])
def test_an_edit_that_changes_nothing_it_may_is_a_422_naming_the_key(
        http, opened, edits, key):
    proposal_id = propose_statement_now(opened, *aapl_and(
        line(isin='FR0010315770', quantity=12, unit_price=1.0)))

    answer = http.post(f'/api/agent/proposals/{proposal_id}/preview', json=edits)

    assert answer.status_code == 422 and answer.get_json()['key'] == key


def test_a_body_that_is_not_an_object_is_refused(http, opened):
    proposal_id = propose_statement_now(opened, *aapl_and(
        line(isin='FR0010315770', quantity=12, unit_price=1.0)))

    answer = http.post(f'/api/agent/proposals/{proposal_id}/preview',
                       data='[1]', content_type='application/json')

    assert answer.status_code == 422


def test_operations_that_differ_only_by_the_fee_are_duplicates(http, opened):
    entries.create(opened, Event(
        date(2026, 3, 3), EventType.BUY, 'CW8.PA', 'Amundi MSCI World',
        quantity=2, unit_price=510.0, amount=1020.0, fee=0.0, account='cto'))
    proposal_id = propose_statement_now(opened, line(
        ticker='CW8.PA', date=date(2026, 3, 3), event_type='BUY', quantity=2,
        unit_price=510.0, amount=1020.0, fee=1.5), kind='operations', as_of=None)

    preview = http.post(f'/api/agent/proposals/{proposal_id}/preview').get_json()
    merged = http.post(f'/api/agent/proposals/{proposal_id}/merge')

    assert preview['duplicates'] == 1 and preview['written'] == 0
    assert merged.get_json()['written'] == 0 and count(opened, 'event') == 2


def test_rekind_makes_a_new_proposal_of_the_other_kind_and_ignores_the_old(
        http, opened):
    old = propose_statement_now(opened, *aapl_and(
        line(isin='FR0010315770', quantity=12, unit_price=512.4)))

    answer = http.post(f'/api/agent/proposals/{old}/rekind')

    assert answer.status_code == 200
    new = answer.get_json()['proposal']
    assert new['id'] != old and new['status'] == 'ready'
    assert new['statement']['kind'] == 'operations'
    assert dict(opened.query('SELECT id, status FROM proposal')) == {
        old: 'ignored', new['id']: 'ready'}


def test_rekind_to_positions_needs_a_day(http, opened):
    old = propose_statement_now(opened, line(
        ticker='CW8.PA', date=date(2026, 3, 3), event_type='BUY', quantity=2,
        unit_price=510.0), kind='operations', as_of=None)

    answer = http.post(f'/api/agent/proposals/{old}/rekind')

    assert answer.status_code == 422 and 'gives no date' in answer.get_json()['detail']
    assert opened.query('SELECT status FROM proposal') == [('ready',)]


def test_an_agents_proposal_cannot_be_reread_as_a_statement(http, opened):
    proposal_id = propose_now(opened)

    assert http.post(f'/api/agent/proposals/{proposal_id}/rekind').status_code == 422


def test_repropose_keeps_a_statement_and_stamps_it_afresh(http, opened):
    old = propose_statement_now(opened, *aapl_and(
        line(isin='FR0010315770', quantity=12, unit_price=512.4)))
    entries.create(opened, Event(date(2026, 2, 1), EventType.DEPOSIT, amount=10.0,
                                 account='cto'))

    new = http.post(f'/api/agent/proposals/{old}/repropose').get_json()['proposal']

    assert new['status'] == 'ready' and new['statement']['kind'] == 'positions'
    assert http.post(f"/api/agent/proposals/{new['id']}/merge").status_code == 201
