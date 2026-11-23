"""The built-in agent's own tools: the System page, read (#1625), and its
journal, secrets masked (#1627).

Over a real store and the process's own recorder, as ``/api/runtime`` and
``/api/advisories`` are tested; no provider is ever called.
"""
import asyncio
import json
import logging
import sys
from datetime import date, datetime, timezone

from application import accounts as accounts_module
from application import advisories
from application import agent
from application import agent_diagnostics
from application import build_info
from application import entries
from application import job_history
from application import journal
from application import log_masking
from application import mcp_server
from application import quotes
from application import runtime_state
from application import settings
from application.events.schemas import Event, EventType
from test_mcp_server import build_runtime

NOW = datetime(2026, 11, 21, 9, 0, tzinfo=timezone.utc)
FUND = 'CW8.PA'
ORIGIN = date(2020, 3, 2)
NO_HISTORY = f'yfinance returned no history for {FUND} over 2020-03-02..2020-06-02'


def followed_and_never_priced(tmp_path):
    """A comparison fund nobody holds, walked to the ledger's first day for
    nothing, whose last backward pass failed."""
    runtime, opened = build_runtime(tmp_path)
    settings.save(opened, {'benchmark_symbols': [FUND]})
    entries.declare_symbol(opened, FUND)
    accounts_module.create_account(opened, 'main')
    entries.create(opened, Event(ORIGIN, EventType.DEPOSIT,
                                 account='main', amount=1000.0))
    quotes.record_window_tried(opened, FUND, ORIGIN)
    runtime.config_manager.reload()
    runtime.recorder.record_backfill(runtime_state.BackfillRecord(
        symbol=FUND, direction=runtime_state.BACKWARD, at=NOW,
        failed=True, error=NO_HISTORY))
    return runtime


def test_a_quiet_installation_reports_no_error_and_every_job(tmp_path):
    runtime, _ = build_runtime(tmp_path)

    status = agent_diagnostics.system_status(runtime, now=NOW)

    assert [job['id'] for job in status['jobs']] == [
        'scrape', 'backfill', 'ingestion', 'performance']
    assert status['errors'] == []
    assert status['store_fault'] is None
    assert status['installation_facts'] == []
    assert {dial['key'] for dial in status['settings']} >= {
        'base_currency', 'benchmark_symbols', 'update_check'}
    assert status['now'] == NOW.isoformat()


def test_a_followed_fund_nobody_holds_has_a_row_and_its_backfill_error(tmp_path):
    """The page's rows stop at the shares; "why is my benchmark empty?" is
    asked about a fund that is in none."""
    runtime = followed_and_never_priced(tmp_path)

    status = agent_diagnostics.system_status(runtime, now=NOW)

    row, = [one for one in status['symbols'] if one['symbol'] == FUND]
    assert row['held'] is False
    assert row['price'] == 'not_held'
    assert row['history']['backward'] == 'failing'
    assert status['errors'] == [{
        'source': 'backfill:backward', 'key': FUND,
        'at': NOW.isoformat(), 'message': NO_HISTORY}]
    never_priced, = [one for one in status['advisories']
                     if one['kind'] == advisories.BENCHMARK_NEVER_PRICED]
    assert never_priced['detail'] == {'symbol': FUND}
    assert FUND in never_priced['message']


def test_a_job_that_failed_says_its_last_error(tmp_path):
    runtime, _ = build_runtime(tmp_path)
    runtime.recorder.history.record(
        job_history.PERFORMANCE, None, job_history.Pass(
            NOW, 0.4, job_history.ERROR,
            'the perf series could not be written'))

    status = agent_diagnostics.system_status(runtime, now=NOW)

    perf, = [job for job in status['jobs'] if job['id'] == 'performance']
    assert perf['last_error'] == 'the perf series could not be written'


def test_a_store_that_cannot_answer_keeps_the_jobs_and_says_why(tmp_path):
    """Unknown is not "none": the store's half is ``None`` under a sentence,
    and the half that explains the fault still goes out."""
    runtime, _ = build_runtime(tmp_path, break_store=True)

    status = agent_diagnostics.system_status(runtime, now=NOW)

    assert status['advisories'] is None
    assert status['installation_facts'] is None
    assert status['settings'] is None
    assert 'unknown here, not empty' in status['store_fault']
    assert len(status['jobs']) == 4
    agent_diagnostics._SHAPE.validate_python(status)


class Learnt:
    """An update check that already knows a release, and is never asked."""

    def known(self, running):
        return {'version': '9.9.9', 'url': 'https://example.test/9.9.9'}


def test_the_update_the_check_already_learnt_is_an_advisory(tmp_path):
    runtime, _ = build_runtime(tmp_path)
    runtime.build = build_info.Build('5.3.0', None, build_info.RELEASE)

    def updates(checker):
        status = agent_diagnostics.system_status(runtime, checker, now=NOW)
        return [one['detail'] for one in status['advisories']
                if one['kind'] == advisories.UPDATE_AVAILABLE]

    assert updates(Learnt()) == [
        {'version': '9.9.9', 'url': 'https://example.test/9.9.9'}]
    assert updates(None) == []


def test_the_agent_calls_the_tool_and_gets_the_published_shape(tmp_path):
    from pydantic_ai.messages import ToolReturnPart
    from pydantic_ai.models.test import TestModel

    runtime = followed_and_never_priced(tmp_path)
    assistant = agent.build_agent(
        TestModel(call_tools=['get_system_status']),
        mcp_server.build_server(runtime),
        agent_diagnostics.build_toolset(runtime), thinking='low')

    result = asyncio.run(assistant.run('Is anything wrong?'))

    answer, = [part.content for message in result.all_messages()
               for part in message.parts if isinstance(part, ToolReturnPart)]
    agent_diagnostics._SHAPE.validate_python(answer)
    assert [error['key'] for error in answer['errors']] == [FUND]


# --- read_logs (#1627) -------------------------------------------------------

#: Built by concatenation: a literal credentialed URL or a provider-shaped key
#: in a test file stops the push.
SECRET = 'hunter2' + 'Zq9' * 6
PROXY = 'https' + f'://paul:{SECRET}' + '@proxy.example:8080'


def _record(message, level=logging.WARNING, module='scrape', exc_info=None):
    record = logging.LogRecord('suivi_bourse', level, f'{module}.py', 1,
                               message, None, exc_info)
    record.module = module
    return record


def _raised(error):
    try:
        raise error
    except Exception:
        return sys.exc_info()


def test_the_log_lines_default_to_warnings_and_narrow_as_the_page_does(
        monkeypatch):
    ring = journal.Ring()
    monkeypatch.setattr(journal, 'RING', ring)
    ring.emit(_record('fetched 6 symbols', logging.INFO))
    ring.emit(_record('HTTP 429 for AI.PA'))
    ring.emit(_record('no closes', logging.ERROR, module='performance'))

    def messages(**asked):
        return [line['message']
                for line in agent_diagnostics.log_lines(**asked)['lines']]

    assert messages() == ['no closes', 'HTTP 429 for AI.PA']
    assert messages(level='error') == ['no closes']
    assert messages(level='debug', job='scrape') == [
        'HTTP 429 for AI.PA', 'fetched 6 symbols']
    assert messages(since=datetime(2999, 1, 1)) == []
    assert agent_diagnostics.log_lines() == {
        'more': False, 'lines': ring.select('warning')[0]}


def test_one_call_is_bounded_and_says_when_it_left_lines_out(monkeypatch):
    ring = journal.Ring()
    monkeypatch.setattr(journal, 'RING', ring)
    lines = agent_diagnostics.LOG_LINES
    for n in range(lines + 3):
        ring.emit(_record(f'line {n}'))

    answer = agent_diagnostics.log_lines()

    assert [line['message'] for line in answer['lines']] == [
        f'line {n}' for n in range(lines + 2, 2, -1)]
    assert answer['more'] is True
    assert agent_diagnostics.log_lines(level='error') == {
        'lines': [], 'more': False}


def test_a_line_is_masked_then_cut_and_a_traceback_keeps_its_end(monkeypatch):
    """A secret straddling the cut is masked whole, never left half shown."""
    ring = journal.Ring()
    monkeypatch.setattr(journal, 'RING', ring)
    cut = agent_diagnostics.LOG_MESSAGE_MAX
    straddling = 'x' * (cut - 20) + f' token={SECRET} ' + 'y' * cut
    ring.emit(_record(straddling, logging.ERROR, exc_info=_raised(
        ConnectionError('z' * 2000 + f' could not reach {PROXY}/v8'))))

    line, = agent_diagnostics.log_lines()['lines']

    assert len(line['message']) == cut
    assert straddling[:cut].endswith(SECRET[:13])
    assert line['message'].endswith(' token=' + log_masking.MASK + ' yyyyyyyyy')
    assert len(line['detail']) == agent_diagnostics.LOG_DETAIL_MAX
    assert line['detail'].endswith(
        'could not reach https://' + log_masking.MASK + '@proxy.example:8080/v8')
    assert 'hunter2' not in json.dumps(line)


def test_the_tool_takes_the_journal_s_own_levels_and_jobs_and_no_other(tmp_path):
    """``Ring.select`` reads an unknown level as *everything*: the schema is
    what refuses a typo, so it must list exactly what the journal knows."""
    runtime, _ = build_runtime(tmp_path)
    toolset = agent_diagnostics.build_toolset(runtime)

    asked = toolset.tools['read_logs'].function_schema.json_schema['properties']

    assert asked['level']['enum'] == list(journal.LEVELS)
    assert asked['level']['default'] == 'warning'
    assert asked['job']['anyOf'][0]['enum'] == list(journal.JOBS)
    assert set(asked) == {'level', 'job', 'since'}


def test_the_agent_reads_the_logs_and_never_an_unmasked_secret(tmp_path):
    """Written through ``logging``, read by the agent's own call: the secret
    is in a message and in a traceback, and in nothing the tool returns."""
    from pydantic_ai.messages import ToolReturnPart
    from pydantic_ai.models.test import TestModel

    runtime, _ = build_runtime(tmp_path)
    journal.install()
    logger = logging.getLogger('suivi_bourse')
    logger.warning('read-logs-marker GET %s/v8?crumb=%s refused', PROXY, SECRET)
    try:
        raise ConnectionError(f'Authorization: Bearer {SECRET} was refused')
    except ConnectionError:
        logger.exception('read-logs-marker the pass failed')
    assistant = agent.build_agent(
        TestModel(call_tools=['read_logs']),
        mcp_server.build_server(runtime),
        agent_diagnostics.build_toolset(runtime), thinking='low')

    result = asyncio.run(assistant.run('What errors are in the logs?'))

    answer, = [part.content for message in result.all_messages()
               for part in message.parts if isinstance(part, ToolReturnPart)]
    failed, refused = [line for line in answer['lines']
                       if 'read-logs-marker' in line['message']]
    masked = log_masking.MASK
    assert refused['message'] == (
        f'read-logs-marker GET https://{masked}@proxy.example:8080/v8'
        f'?crumb={masked} refused')
    assert failed['level'] == 'error'
    assert failed['detail'].endswith(
        f'ConnectionError: Authorization: Bearer {log_masking.MASK} was refused')
    assert SECRET not in json.dumps(answer)
    assert len(answer['lines']) <= agent_diagnostics.LOG_LINES
