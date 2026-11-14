"""The journal (``GET /api/logs``) and the System page's data (B5)."""
import logging
from datetime import datetime, timezone

from api import current_runtime
from application import journal, runtime_state
from test_web_api import ACCOUNTS_EVENTS, ACCOUNTS_FILE, build_client_and_store


def _record(message, level=logging.INFO, module='main', name='suivi_bourse',
            exc_info=None):
    record = logging.LogRecord(name, level, f'{module}.py', 1, message, None,
                               exc_info)
    record.module = module
    return record


def test_the_ring_keeps_only_its_capacity_and_reads_newest_first():
    ring = journal.Ring(capacity=3)
    for n in range(5):
        ring.emit(_record(f'line {n}'))

    rows, cursor = ring.select()

    assert [row['message'] for row in rows] == ['line 4', 'line 3', 'line 2']
    assert cursor == 5
    assert ring.select(cursor=4)[0][0]['message'] == 'line 4'
    assert ring.select(cursor=cursor)[0] == []


def test_a_row_names_its_job_its_level_and_its_traceback():
    ring = journal.Ring()
    try:
        raise ValueError('boom')
    except ValueError:
        import sys
        ring.emit(_record('pass failed', logging.ERROR, module='scrape',
                          exc_info=sys.exc_info()))
    ring.emit(_record('ledger reread', logging.CRITICAL))
    ring.emit(_record('slow', logging.WARNING, module='x', name='perf_series'))

    rows, _ = ring.select()

    assert [(r['job'], r['level']) for r in rows] == [
        ('performance', 'warning'), ('system', 'error'), ('scrape', 'error')]
    assert 'ValueError: boom' in rows[2]['detail']
    assert rows[1]['detail'] is None


def test_the_filters_narrow_by_level_job_text_and_instant():
    ring = journal.Ring()
    ring.emit(_record('fetched 6 symbols', module='scrape'))
    ring.emit(_record('HTTP 429 for AI.PA', logging.WARNING, module='scrape'))
    ring.emit(_record('backfill complete', module='backfill'))

    assert len(ring.select(level='warning')[0]) == 1
    assert len(ring.select(job='backfill')[0]) == 1
    assert len(ring.select(q='ai.pa')[0]) == 1
    future = datetime(2999, 1, 1, tzinfo=timezone.utc)
    assert ring.select(since=future)[0] == []


def test_the_logs_route_answers_rows_and_a_cursor(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    journal.install()
    logging.getLogger('suivi_bourse').warning('journal-route-marker')

    body = client.get('/api/logs?q=journal-route-marker').get_json()

    assert [r['message'] for r in body['rows']] == ['journal-route-marker']
    assert body['rows'][0]['level'] == 'warning'
    assert client.get('/api/logs?cursor=oops').status_code == 400
    assert client.get(
        f"/api/logs?q=journal-route-marker&cursor={body['cursor']}"
    ).get_json()['rows'] == []


def test_the_file_log_is_downloadable(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    runtime = current_runtime()
    runtime.store_path = tmp_path / 'store.duckdb'
    assert client.get('/api/logs/download').status_code == 404

    journal.install(tmp_path / 'logs')
    try:
        logging.getLogger('suivi_bourse').warning('written-to-the-file')
        response = client.get('/api/logs/download')
    finally:
        journal.install()

    assert response.status_code == 200
    assert b'written-to-the-file' in response.data


def test_a_frozen_price_counts_its_passes_and_since_when():
    recorder = runtime_state.RuntimeRecorder()
    first = datetime(2026, 11, 6, 17, 25, tzinfo=timezone.utc)

    def scrape(at, stale):
        return runtime_state.ScrapeRecord(
            symbol='PUST.PA', at=at, market_state='REGULAR', closed=False,
            price_present=True, verdict=runtime_state.SCRAPE_WROTE,
            failure_count=0, next_delay=300, stale=stale)

    recorder.record_scrape(scrape(first, True))
    second = recorder.record_scrape(scrape(first.replace(minute=30), True))
    assert (second.stale_since, second.stale_passes) == (first, 2)

    healed = recorder.record_scrape(scrape(first.replace(minute=35), False))
    assert (healed.stale_since, healed.stale_passes) == (None, 0)


def test_the_runtime_lists_the_followed_securities_and_the_source(tmp_path):
    client, _ = build_client_and_store(
        tmp_path,
        accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)

    body = client.get('/api/runtime').get_json()

    assert body['quote_source']['name'] == 'yfinance'
    assert 'size_bytes' in body['store']
    assert body['followed'][0]['symbol'] == 'AAPL'
    assert body['followed'][0]['state'] == 'ok'


def test_running_an_unknown_job_is_a_404(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    current_runtime().jobs = None

    assert client.post('/api/jobs/nope/run').status_code == 404
