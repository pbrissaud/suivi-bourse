"""The jobs registry: a job is its class, its line in ``JOBS`` and its label (#1253).

The criterion of #1253 is pinned here: a job added to ``JOBS`` and nowhere else
shows in ``GET /api/jobs`` and ``GET /api/jobs/history`` and gets its scheduler
entry, while ``GET /health`` keeps its keys and its shape.
"""
from datetime import datetime, timezone

import pytest

import api as api_module
from application import job_history
from application.jobs import base
from application.jobs import registry
from test_web_api import _arm_the_scheduler, build_client_and_store


class FakeJob(base.Job):
    """A job nothing else in the code base names."""

    id = 'fake'
    label_key = 'settings.jobs.fake'
    triggers = (base.Interval(scheduler_id='fake', name='Fake job', seconds=60),)

    def __init__(self, ctx, jobs):
        super().__init__(ctx, jobs)
        self.runs = 0

    def run(self):
        self.runs += 1


@pytest.fixture
def with_a_fake_job(monkeypatch):
    monkeypatch.setattr(registry, 'JOBS', (*registry.JOBS, FakeJob))


def test_the_registry_lists_the_four_jobs_in_their_order():
    assert [job['id'] for job in registry.describe()] == [
        'scrape', 'backfill', 'ingestion', 'performance']
    assert {job['id']: job['in_health'] for job in registry.describe()} == {
        'scrape': True, 'backfill': True, 'ingestion': False,
        'performance': True}
    assert {job['id']: job['kind'] for job in registry.describe()}['scrape'] \
        == 'family'


def test_a_job_added_to_the_registry_alone_is_listed_and_has_a_history(
        tmp_path, with_a_fake_job):
    client, _ = build_client_and_store(tmp_path)

    listed = client.get('/api/jobs').get_json()
    history = client.get('/api/jobs/history').get_json()

    assert listed[-1]['id'] == 'fake'
    assert listed[-1]['label_key'] == 'settings.jobs.fake'
    assert listed[-1]['state'] == 'Jamais lancé'
    assert listed[-1]['last_run_at'] is None
    assert set(history['jobs']) == {'backfill', 'performance', 'ingestion',
                                    'fake'}
    assert history['jobs']['fake']['last'] is None
    assert len(history['jobs']['fake']['slots']) == job_history.SLOTS


def test_a_job_added_to_the_registry_alone_gets_its_entry_and_records(
        mocker, with_a_fake_job):
    jobs = registry.build(mocker.MagicMock())
    scheduler = mocker.MagicMock()

    registry.register(scheduler, jobs, {'backfill_interval': 60})
    jobs['fake']()

    entries = {c.kwargs['id']: c for c in scheduler.add_job.call_args_list}
    assert entries['fake'].args == (jobs['fake'], 'interval')
    assert entries['fake'].kwargs['seconds'] == 60
    assert jobs['fake'].runs == 1
    passes = jobs.ctx.recorder.history.read(
        datetime.now(timezone.utc), registry.history_jobs())['jobs']['fake']
    assert passes['last']['outcome'] == job_history.OK


def test_health_keeps_its_keys_with_a_job_that_has_no_line(
        tmp_path, with_a_fake_job):
    client, _ = build_client_and_store(tmp_path)
    _arm_the_scheduler(api_module.current_runtime())

    body = client.get('/health').get_json()

    assert set(body) == {'status', 'now', 'scheduler_running', 'jobs'}
    assert body['scheduler_running'] is True
    assert set(body['jobs']) == {'scrape', 'backfill', 'performance'}


def test_a_write_replays_the_ledger_before_the_perf_series(mocker):
    jobs = registry.build(mocker.MagicMock())
    order = []
    mocker.patch.object(jobs['ingestion'], 'run',
                        side_effect=lambda **kw: order.append(('ingestion', kw)))
    mocker.patch.object(jobs['performance'], 'run',
                        side_effect=lambda **kw: order.append(('performance', kw)))

    jobs.after_write()

    assert order == [('ingestion', {'force': True}),
                     ('performance', {'full': True})]


def test_a_dial_re_arms_the_job_whose_cadence_it_is(mocker):
    jobs = registry.build(mocker.MagicMock())
    jobs.ctx.scheduler = mocker.MagicMock()

    reached = jobs.rearm('backfill_interval', 300)
    untouched = jobs.rearm('backfill_delay', 20)

    jobs.ctx.scheduler.reschedule_job.assert_called_once_with(
        'backfill', trigger='interval', seconds=300)
    assert reached.jobs == ('backfill',)
    assert untouched == base.Rearmed()
