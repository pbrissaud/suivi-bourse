"""The built-in agent's own tool: the System page, read (#1625).

Over a real store and the process's own recorder, as ``/api/runtime`` and
``/api/advisories`` are tested; no provider is ever called.
"""
import asyncio
from datetime import date, datetime, timezone

from application import accounts as accounts_module
from application import advisories
from application import agent
from application import agent_diagnostics
from application import build_info
from application import entries
from application import job_history
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
