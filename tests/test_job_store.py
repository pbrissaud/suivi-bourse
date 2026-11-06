"""The job history and the scrape's arming survive a restart (issue #1254)."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pytest
from apscheduler.schedulers.background import BackgroundScheduler

from application import job_history
from application import job_store
from application import main
from application import scheduling
from application import store as store_module
from application.job_history import ERROR, OK, JobHistory, Pass
from application.jobs import registry

UTC = timezone.utc
NOW = datetime(2026, 11, 6, 12, 30, tzinfo=UTC)


class _Manager:
    """A configuration manager over a real store, counting its writes."""

    def __init__(self, opened, symbols=()):
        self.store = opened
        self.writes = 0
        self._shares = [{'symbol': s, 'account': 'default', 'quantity': 10}
                        for s in symbols]

    def current(self):
        return main.ConfigSnapshot(shares=self._shares, events=[],
                                   accounts=None, cache_key=None)

    @contextmanager
    def writing(self):
        self.writes += 1
        yield self.store


def _pass(at, outcome=OK, error=None):
    return Pass(at=at, duration=0.5, outcome=outcome, error=error,
                lines=({'level': 'WARNING', 'logger': 'x', 'message': 'm'},),
                overflow=1)


def _count(opened, table):
    return opened.query(f'SELECT count(*) FROM {table}')[0][0]


def test_the_passes_recorded_before_a_restart_are_read_after_it(tmp_path):
    path = tmp_path / 'store.duckdb'
    opened = store_module.open_store(path)
    before = JobHistory(now=NOW)
    before.record('scrape', 'AAPL', _pass(NOW - timedelta(hours=3), ERROR, 'boom'))
    before.record('scrape', 'AAPL', _pass(NOW - timedelta(minutes=5)))
    before.record('backfill', None, _pass(NOW - timedelta(minutes=1)))
    job_store.flush(_Manager(opened), before, now=NOW)
    expected = before.read(NOW, ['backfill'])
    opened.close()

    reopened = store_module.open_store(path)
    after = JobHistory(now=NOW + timedelta(minutes=1))
    job_store.restore(reopened, after, now=NOW)
    read = after.read(NOW, ['backfill'])

    assert read['scrape'] == expected['scrape']
    assert read['jobs'] == expected['jobs']
    assert read['scrape_recent'] == expected['scrape_recent']
    # The history reaches back past this start: the page reads that.
    assert after.started == (NOW - timedelta(hours=3)).replace(minute=0)
    reopened.close()


def test_retention_drops_old_slots_and_caps_the_passes(store):
    history = JobHistory(now=NOW)
    for i in range(job_history.RECENT + 5):
        history.record('scrape', 'AAPL', _pass(NOW - timedelta(minutes=i)))
    history.record('scrape', 'AAPL', _pass(NOW - timedelta(hours=30)))
    job_store.flush(_Manager(store), history, now=NOW)

    assert _count(store, 'job_pass') == job_history.RECENT
    oldest = store.query('SELECT min(hour) FROM job_slot')[0][0]
    assert oldest >= NOW.replace(minute=0) - timedelta(hours=job_history.SLOTS - 1)


def test_a_departed_symbol_leaves_the_three_tables(store):
    history = JobHistory(now=NOW)
    history.record('scrape', 'AAPL', _pass(NOW))
    history.schedule('scrape', 'AAPL', NOW + timedelta(minutes=2), 3)
    history.record('scrape', 'MSFT', _pass(NOW))
    job_store.flush(_Manager(store), history, now=NOW)

    history.forget('AAPL')
    job_store.flush(_Manager(store), history, now=NOW)

    for table in ('job_slot', 'job_pass', 'job_schedule'):
        assert [r[0] for r in store.query(f'SELECT DISTINCT member FROM {table}')] \
            in ([], ['MSFT'])
    assert _count(store, 'job_pass') == 1


def test_a_failed_flush_keeps_the_batch_for_the_next(store):
    history = JobHistory(now=NOW)
    history.record('scrape', 'AAPL', _pass(NOW))

    class _Closed(_Manager):
        @contextmanager
        def writing(self):
            raise store_module.StoreUnavailable('closed')
            yield

    job_store.flush(_Closed(store), history, now=NOW)
    job_store.flush(_Manager(store), history, now=NOW)

    assert _count(store, 'job_pass') == 1
    assert _count(store, 'job_slot') == 1


def _scrape(store, mocker, symbols):
    manager = _Manager(store, symbols)
    jobs = registry.build(manager)
    jobs.ctx.scheduler = mocker.MagicMock(spec=BackgroundScheduler)
    jobs.ctx.scheduler.get_jobs.return_value = []
    jobs.ctx.regular_interval = 120
    mocker.patch('application.jobs.scrape.random.uniform', return_value=0.0)
    return manager, jobs


def _armed(jobs):
    return {c.kwargs['args'][0]: c.kwargs['run_date']
            for c in jobs.ctx.scheduler.add_job.call_args_list}


def test_a_stored_back_off_is_resumed_at_boot(store, mocker):
    now = datetime.now(UTC)
    backoff = scheduling.backoff_delay(120, 5)
    history = JobHistory()
    history.schedule('scrape', 'AAPL', now + timedelta(seconds=backoff), 5)
    history.schedule('scrape', 'MSFT', now - timedelta(hours=1), 0)
    job_store.flush(_Manager(store), history)
    store.execute("INSERT INTO job_schedule (job, member, paused) "
                  "VALUES ('scrape', 'ALO', TRUE)")

    _, jobs = _scrape(store, mocker, ['AAPL', 'MSFT', 'ALO'])
    scrape = jobs['scrape']
    scrape.restore(job_store.restore(store, jobs.ctx.recorder.history))
    scrape.reconcile_jobs()
    armed = _armed(jobs)

    assert scrape.failure_counts['AAPL'] == 5
    assert armed['AAPL'] == pytest.approx(
        now + timedelta(seconds=backoff), abs=timedelta(seconds=2))
    assert armed['MSFT'] <= datetime.now(UTC)      # past: fires now
    assert 'ALO' not in armed                       # paused (#1255)
    scrape.reconcile_jobs()
    assert 'ALO' not in _armed(jobs)                # and stays so


def test_no_write_happens_on_a_pass_own_path(store, mocker):
    manager, jobs = _scrape(store, mocker, ['AAPL'])
    mocker.patch.object(jobs.ctx.market, 'latest_quote',
                        return_value=(None, None))

    jobs['scrape']('AAPL')
    jobs['scrape']('AAPL')
    assert manager.writes == 0

    job_store.flush(manager, jobs.ctx.recorder.history)
    assert manager.writes == 1
    assert _count(store, 'job_pass') == 2
    assert store.query('SELECT failure_count FROM job_schedule')[0][0] == 2


def test_a_symbol_sold_while_down_is_forgotten_at_boot(store, mocker):
    history = JobHistory()
    history.record('scrape', 'SOLD', _pass(datetime.now(UTC)))
    history.schedule('scrape', 'SOLD', datetime.now(UTC), 7)
    job_store.flush(_Manager(store), history)

    manager, jobs = _scrape(store, mocker, ['AAPL'])
    scrape = jobs['scrape']
    scrape.restore(job_store.restore(store, jobs.ctx.recorder.history))
    job_store.flush(manager, jobs.ctx.recorder.history)

    assert 'SOLD' not in scrape.failure_counts
    for table in ('job_slot', 'job_pass', 'job_schedule'):
        assert _count(store, table) == 0


def test_a_failed_flush_does_not_bring_back_a_symbol_dropped_since(store):
    history = JobHistory(now=NOW)
    history.record('scrape', 'AAPL', _pass(NOW))
    history.schedule('scrape', 'AAPL', NOW, 1)
    drained = history.drain()
    history.forget('AAPL')
    history.undrain(drained)
    job_store.flush(_Manager(store), history, now=NOW)

    for table in ('job_slot', 'job_pass', 'job_schedule'):
        assert _count(store, table) == 0


def test_a_symbol_recorded_again_after_a_failed_flush_keeps_only_its_new_passes(store):
    history = JobHistory(now=NOW)
    history.record('scrape', 'AAPL', _pass(NOW - timedelta(minutes=5)))
    drained = history.drain()
    history.forget('AAPL')
    history.record('scrape', 'AAPL', _pass(NOW))
    history.undrain(drained)
    job_store.flush(_Manager(store), history, now=NOW)

    assert [r[0] for r in store.query('SELECT ran_at FROM job_pass')] == [NOW]


def test_a_paused_symbol_sold_then_bought_again_is_armed(store, mocker):
    store.execute("INSERT INTO job_schedule (job, member, paused) "
                  "VALUES ('scrape', 'ALO', TRUE)")
    manager, jobs = _scrape(store, mocker, [])
    scrape = jobs['scrape']
    scrape.restored = job_store.restore(store, jobs.ctx.recorder.history)
    scrape.reconcile_jobs()                       # ALO is not held: dropped

    manager._shares = [{'symbol': 'ALO', 'account': 'default', 'quantity': 10}]
    scrape.reconcile_jobs()
    assert 'ALO' in _armed(jobs)
    job_store.flush(manager, jobs.ctx.recorder.history)
    assert store.query("SELECT paused FROM job_schedule WHERE member = 'ALO'") \
        == [(False,)]
