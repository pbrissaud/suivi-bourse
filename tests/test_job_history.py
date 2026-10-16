"""The jobs' recent passes, in process memory (issue #1236)."""
import logging
import threading
from datetime import datetime, timedelta, timezone

import pytest

from application import job_history, runtime_state, runtime_view
from application.job_history import JobHistory, Pass

T0 = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)


def _pass(at, outcome=job_history.OK, error=None):
    return Pass(at=at, duration=0.5, outcome=outcome, error=error)


def test_a_day_at_a_ten_second_cadence_keeps_24_slots_and_20_passes():
    history = JobHistory(now=T0)
    end = T0 + timedelta(hours=24)
    at = T0
    while at < end:
        history.record(job_history.PERFORMANCE, None, _pass(at))
        at += timedelta(seconds=10)

    track = history._tracks[(job_history.PERFORMANCE, None)]
    assert len(track.slots) == 24
    assert len(track.recent) == 20

    body = history.read(end - timedelta(seconds=1))['jobs'][job_history.PERFORMANCE]
    assert len(body['slots']) == 24
    assert len(body['passes']) == 20
    assert body['slots'][-1]['passes'] == 360


def test_a_pass_25_hours_old_is_gone():
    history = JobHistory(now=T0)
    history.record(job_history.INGESTION, None, _pass(T0, job_history.ERROR, 'boom'))

    body = history.read(T0 + timedelta(hours=25))['jobs'][job_history.INGESTION]

    assert body['passes'] == []
    assert all(slot['passes'] == 0 for slot in body['slots'])
    # The row still dates it: a quiet day is not *never ran*.
    assert body['last']['error'] == 'boom'


def test_a_read_30_hours_later_shows_24_empty_slots_and_writes_nothing():
    history = JobHistory(now=T0)
    history.record(job_history.BACKFILL, None, _pass(T0))

    body = history.read(T0 + timedelta(hours=30))['jobs'][job_history.BACKFILL]

    assert len(body['slots']) == 24
    assert all(slot['passes'] == 0 for slot in body['slots'])
    # Aged on read only: the slot is still stored until the next write.
    assert len(history._tracks[(job_history.BACKFILL, None)].slots) == 1


def test_a_slot_counts_its_outcomes_and_keeps_its_last_error():
    history = JobHistory(now=T0)
    history.record(job_history.SCRAPE, 'AAPL', _pass(T0, job_history.ERROR, 'one'))
    history.record(job_history.SCRAPE, 'AAPL',
                   _pass(T0 + timedelta(minutes=5), job_history.ATTENTION))
    history.record(job_history.SCRAPE, 'AAPL',
                   _pass(T0 + timedelta(minutes=9), job_history.ERROR, 'two'))

    slot = history.read(T0)['scrape']['AAPL']['slots'][-1]

    assert (slot['passes'], slot['errors'], slot['attentions']) == (3, 2, 1)
    assert slot['last_error'] == 'two'
    assert slot['duration'] == pytest.approx(1.5)


def test_a_departed_symbol_takes_its_scrape_history_with_it():
    recorder = runtime_state.RuntimeRecorder()
    for symbol in ('AAPL', 'MSFT', 'TSLA'):
        recorder.history.record(job_history.SCRAPE, symbol, _pass(T0))

    recorder.retain({'AAPL', 'TSLA'})
    recorder.forget_scrape('TSLA')

    assert list(recorder.history.read(T0)['scrape']) == ['AAPL']


def test_eight_concurrent_threads_never_share_a_log_line():
    log = logging.getLogger('suivi_bourse')
    captured = {}
    barrier = threading.Barrier(8)

    def work(n):
        with job_history.capturing() as lines:
            barrier.wait()
            for i in range(3):
                log.warning('thread %d line %d', n, i)
            barrier.wait()
        captured[n] = [line['message'] for line in lines.lines]

    threads = [threading.Thread(target=work, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    for n in range(8):
        assert captured[n] == [f'thread {n} line {i}' for i in range(3)]


def test_a_yfinance_warning_inside_a_pass_is_captured():
    with job_history.capturing() as lines:
        logging.getLogger('yfinance').warning('AAPL: possibly delisted')
        logging.getLogger('suivi_bourse').info('not a warning')

    assert lines.lines == [{'level': 'WARNING', 'logger': 'yfinance',
                            'message': 'AAPL: possibly delisted'}]


def test_a_line_outside_any_pass_is_dropped():
    logging.getLogger('suivi_bourse').warning('before')
    with job_history.capturing() as lines:
        pass
    logging.getLogger('suivi_bourse').warning('after')

    assert lines.lines == []
    assert job_history._capture.open == {}


def test_an_eleventh_line_raises_the_overflow_count_and_lines_are_cut():
    with job_history.capturing() as lines:
        for i in range(12):
            logging.getLogger('suivi_bourse').error('x' * 400)

    assert len(lines.lines) == job_history.MAX_LINES
    assert lines.overflow == 2
    assert len(lines.lines[0]['message']) == job_history.LINE_CHARS


def test_a_logger_with_no_handler_still_reaches_stderr(capsys, monkeypatch):
    """The root capture must not switch ``logging.lastResort`` off.

    pytest puts its own handlers on the root; production has none but ours.
    """
    monkeypatch.setattr(logging.root, 'handlers', [job_history._capture])

    logging.getLogger('test_job_history.unhandled').error('still printed')

    assert 'still printed' in capsys.readouterr().err


def test_a_logger_with_its_own_handler_is_not_printed_twice(
        capsys, monkeypatch):
    monkeypatch.setattr(logging.root, 'handlers', [job_history._capture])
    logger = logging.getLogger('test_job_history.handled')
    monkeypatch.setattr(logger, 'handlers', [logging.StreamHandler()])

    logger.error('once')

    assert capsys.readouterr().err.count('once') == 1


def test_timed_records_a_raising_pass_before_it_re_raises():
    history = JobHistory(now=T0)

    with pytest.raises(ValueError):
        with job_history.timed(history, job_history.BACKFILL):
            logging.getLogger('suivi_bourse').warning('about to fail')
            raise ValueError('nope')

    one = history._tracks[(job_history.BACKFILL, None)].recent[0]
    assert one.outcome == job_history.ERROR
    assert one.error == 'ValueError: nope'
    assert [line['message'] for line in one.lines] == ['about to fail']
    assert one.duration >= 0


def test_an_interrupted_pass_is_an_error_not_a_success():
    history = JobHistory(now=T0)

    with pytest.raises(KeyboardInterrupt):
        with job_history.timed(history, job_history.PERFORMANCE):
            raise KeyboardInterrupt()

    assert history._tracks[(job_history.PERFORMANCE, None)].recent[0].outcome == (
        job_history.ERROR)


def _scrape(**fields):
    base = dict(symbol='AAPL', at=T0, market_state='REGULAR', closed=False,
                price_present=True, verdict=runtime_state.SCRAPE_WROTE,
                failure_count=0, next_delay=60.0)
    return runtime_state.ScrapeRecord(**{**base, **fields})


def test_a_raising_scrape_with_failures_is_an_error_not_attention():
    record = _scrape(failure_count=3, error='RuntimeError: down',
                     verdict=runtime_state.SCRAPE_NO_PRICE)

    assert runtime_view.scrape_outcome(record) == (
        job_history.ERROR, 'RuntimeError: down')


def test_the_scrape_outcomes_follow_the_bell():
    assert runtime_view.scrape_outcome(_scrape())[0] == job_history.OK
    assert runtime_view.scrape_outcome(_scrape(failure_count=1))[0] == (
        job_history.ATTENTION)
    assert runtime_view.scrape_outcome(_scrape(stale=True))[0] == (
        job_history.ATTENTION)


def test_a_backfill_cycle_is_failed_by_any_direction_and_idle_with_none():
    ok = runtime_state.BackfillRecord(
        symbol='AAPL', direction=runtime_state.BACKWARD, at=T0)
    failed = runtime_state.BackfillRecord(
        symbol='MSFT', direction=runtime_state.FORWARD, at=T0, failed=True,
        error='timeout')
    unconvertible = runtime_state.BackfillRecord(
        symbol='AAPL', direction=runtime_state.LATERAL, at=T0,
        terminal=runtime_state.TERMINAL_UNCONVERTIBLE)

    assert runtime_view.backfill_outcome([]) == (job_history.IDLE, None)
    assert runtime_view.backfill_outcome([ok]) == (job_history.OK, None)
    assert runtime_view.backfill_outcome([ok, unconvertible])[0] == (
        job_history.ATTENTION)
    assert runtime_view.backfill_outcome([ok, unconvertible, failed]) == (
        job_history.ERROR, 'timeout')


def test_the_scrape_lines_ride_on_its_20_newest_passes_only():
    history = JobHistory(now=T0)
    for i in range(15):
        for symbol in ('AAPL', 'MSFT'):
            history.record(job_history.SCRAPE, symbol, Pass(
                at=T0 + timedelta(minutes=i), duration=0.1,
                outcome=job_history.ERROR, error=f'{symbol} {i}',
                lines=({'level': 'WARNING', 'logger': 'yfinance',
                        'message': 'down'},)))

    body = history.read(T0 + timedelta(minutes=30))

    assert body['scrape']['AAPL']['passes'][0]['lines'] == []
    recent = body['scrape_recent']
    assert len(recent) == job_history.RECENT
    assert (recent[0]['symbol'], recent[0]['error']) in {
        ('AAPL', 'AAPL 14'), ('MSFT', 'MSFT 14')}
    assert all(one['lines'] for one in recent)
