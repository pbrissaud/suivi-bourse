"""The replay that follows the write carries the performance with it (#812).

``main.replay_after_write`` already republished the snapshot, replayed the
positions and reconciled the scrape jobs. It did **not** rewrite the performance
series, which waited for the ``PERF_TICK`` — up to two minutes during which
correcting a mistake made in 2019 left every curve exactly as it was, with
*taken*, *taken wrong* and *not taken yet* rendering the same screen.

The seam is the suite's usual one: a **real** DuckDB store in ``tmp_path``, a
real :class:`main.ConfigurationManager` and a real
:class:`main.SuiviBourseMetrics` behind a real Flask client. Nothing here
asserts that a method was called — every assertion is on ``account_metrics`` and
``portfolio_totals``, read back after a write and **before any tick has run**:
there is no scheduler in this module at all, so a row that is up to date can
only have been written by the replay.

Prior art: ``tests/test_performance.py``, ``tests/test_positions.py``,
``tests/test_metrics.py``.
"""
import io
import threading
import time
from datetime import date, datetime

import pytest

import main
import store as store_module
import web as web_module
from web import create_app


#: One deposit, imported from the drop folder. Cash alone on purpose: the
#: rules under test are about *when* the series is rewritten, and a ledger with
#: no security needs no price to produce a full set of daily points.
_LEDGER = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-10,DEPOSIT,,,,,,1000.00,Opening transfer\n"
)

#: The day the clock is pinned to. The series runs to *today*, so a floating one
#: would change the shape of every assertion below on the next calendar day.
_TODAY = date(2024, 3, 5)

#: The old mistake this ticket is named after.
_OLD_DAY = '2022-06-03'


def _fixed_today(mocker):
    """``main``'s clock, pinned — and UTC-qualified, like every read of it."""
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(_TODAY.year, _TODAY.month, _TODAY.day, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)


def _deposit(**overrides) -> dict:
    body = {
        'date': _OLD_DAY,
        'event_type': 'DEPOSIT',
        'account': '',
        'symbol': None,
        'name': None,
        'notes': 'Typed in the app',
        'quantity': None,
        'unit_price': None,
        'fee': None,
        'amount': 500.0,
    }
    body.update(overrides)
    return body


def _build(tmp_path, mocker):
    """A client over a real store, a real manager and a **real** metrics object.

    ``runtime.metrics`` is the production class rather than a stand-in: the
    whole point is that the perf tables are written by the replay, and a fake
    would be the one thing incapable of showing it. No scheduler is wired —
    ``_reconcile_jobs`` no-ops without one — which is also what makes *"no tick
    has run"* structural here rather than a matter of timing.

    The pass at the end is the **boot's**, not a tick: ``start_runtime`` arms the
    perf job with an immediate first fire, so a process that has just come up
    holds a complete series. Every test below asserts on what a *write* does to
    it afterwards.
    """
    _fixed_today(mocker)
    events_dir = tmp_path / 'events'
    events_dir.mkdir(exist_ok=True)
    (events_dir / '2024.csv').write_text(_LEDGER, encoding='utf-8')

    opened = store_module.open_store(tmp_path / 'store.duckdb')
    manager = main.ConfigurationManager(config_dir=str(tmp_path),
                                        opened_store=opened)
    runtime = main.Runtime(manager, None)
    runtime.store = opened
    manager.reload()
    opened.execute("INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR') "
                   "ON CONFLICT (key) DO UPDATE SET value = excluded.value")

    metrics = main.SuiviBourseMetrics(manager)
    metrics.base_currency = 'EUR'
    runtime.metrics = metrics
    runtime.metrics.recompute_perf()

    return create_app(runtime).test_client(), opened


def _days(opened, table='account_metrics'):
    return [row[0] for row in
            opened.query(f'SELECT day FROM {table} ORDER BY day')]


def _cash_on(opened, day):
    (row,) = opened.query(
        'SELECT cash_balance FROM account_metrics WHERE day = ?', [day])
    return row[0]


# --------------------------------------------------------------------------- #
# The three writes
# --------------------------------------------------------------------------- #

def test_an_event_dated_years_back_rewrites_the_series_down_to_that_day(
        tmp_path, mocker):
    """``POST`` — and the curves move before the answer comes back."""
    client, opened = _build(tmp_path, mocker)
    assert _days(opened)[0] == date(2024, 1, 10)

    created = client.post('/api/events', json=_deposit())
    assert created.status_code == 201

    assert _days(opened)[0] == date(2022, 6, 3)
    assert _days(opened, 'portfolio_totals')[0] == date(2022, 6, 3)
    # And the deposit is in the figures, not only in the span.
    assert _cash_on(opened, date(2022, 6, 3)) == pytest.approx(500.0)
    assert _cash_on(opened, _TODAY) == pytest.approx(1500.0)


def test_correcting_an_old_amount_moves_the_points_it_touches(tmp_path, mocker):
    """``PATCH`` — the gesture the ticket is named after."""
    client, opened = _build(tmp_path, mocker)
    key = client.post('/api/events', json=_deposit()).get_json()['id']
    assert _cash_on(opened, date(2022, 6, 3)) == pytest.approx(500.0)

    corrected = client.patch(f'/api/events/{key}',
                             json=_deposit(amount=800.0))
    assert corrected.status_code == 200

    assert _cash_on(opened, date(2022, 6, 3)) == pytest.approx(800.0)
    assert _cash_on(opened, _TODAY) == pytest.approx(1800.0)


def test_removing_an_event_erases_the_points_it_made(tmp_path, mocker):
    """``DELETE`` — the days the event alone produced leave with it."""
    client, opened = _build(tmp_path, mocker)
    key = client.post('/api/events', json=_deposit()).get_json()['id']
    assert _days(opened)[0] == date(2022, 6, 3)

    removed = client.delete(f'/api/events/{key}')
    assert removed.status_code == 200

    assert _days(opened)[0] == date(2024, 1, 10)
    assert _days(opened, 'portfolio_totals')[0] == date(2024, 1, 10)
    assert _cash_on(opened, _TODAY) == pytest.approx(1000.0)


def test_a_bulk_removal_carries_the_series_and_the_positions_with_it(
        tmp_path, mocker):
    """``DELETE /api/events?…`` — the fourth write, and the same seam (#814).

    Undoing a whole import is the gesture that moves the most history at once,
    so it is the one where a series left to the next ``PERF_TICK`` would be most
    visibly wrong. Nothing here asserts a call: the rows are read back off
    ``account_metrics`` and ``account_state``, and no scheduler exists in this
    module to have written them.
    """
    client, opened = _build(tmp_path, mocker)
    client.post('/api/events', json=_deposit())
    client.post('/api/events', json=_deposit(date='2022-07-04', amount=250.0))
    assert _days(opened)[0] == date(2022, 6, 3)
    assert _cash_on(opened, _TODAY) == pytest.approx(1750.0)

    # The reduction the reader is looking at: everything typed on that account
    # before the drop folder's own deposit. Both rows leave in one gesture.
    removed = client.delete('/api/events?until=2023-12-31')
    assert removed.status_code == 200
    assert removed.get_json() == {'events_removed': 2}

    # The series is back to the ledger that is left — its span, its figures —
    # and the replay's own tables with it.
    assert _days(opened)[0] == date(2024, 1, 10)
    assert _days(opened, 'portfolio_totals')[0] == date(2024, 1, 10)
    assert _cash_on(opened, _TODAY) == pytest.approx(1000.0)
    assert opened.query(
        'SELECT cash_balance FROM account_state') == [(1000.0,)]


# --------------------------------------------------------------------------- #
# Integral, and that is the decision (ADR-0011)
# --------------------------------------------------------------------------- #

def test_the_whole_series_is_rewritten_and_not_only_its_tail(tmp_path, mocker):
    """A point **older** than the event just written is up to date too.

    The assertion an incremental window — *from the event's date to today* —
    would fail, and it is written this way round on purpose: a false day left
    behind a frontier is invisible by construction, so the test has to put one
    there first. The row below is what such a stale day looks like, and the
    replay must have swept it away without being told which days to look at.
    """
    client, opened = _build(tmp_path, mocker)
    client.post('/api/events', json=_deposit())

    # A wrong figure on a day the next write cannot reach through any window
    # opened at its own date: it is a year and a half older than it.
    stale = date(2022, 8, 1)
    opened.execute(
        'UPDATE account_metrics SET cash_balance = 42.0, total_value = 42.0 '
        'WHERE day = ?', [stale])
    assert _cash_on(opened, stale) == pytest.approx(42.0)

    written = client.post('/api/events',
                          json=_deposit(date='2024-02-01', amount=100.0))
    assert written.status_code == 201

    # The stale day is back to what the ledger says it was, and the span it
    # belongs to has not moved — this is a rewrite, not a prune.
    assert _cash_on(opened, stale) == pytest.approx(500.0)
    assert _days(opened)[0] == date(2022, 6, 3)
    assert _cash_on(opened, _TODAY) == pytest.approx(1600.0)


# --------------------------------------------------------------------------- #
# Without a scheduler-side runtime there is nothing to recompute
# --------------------------------------------------------------------------- #

def test_a_runtime_with_no_metrics_still_replays_and_writes_no_series(
        tmp_path, mocker):
    """Before the ``fork``, and in a test holding only a manager (#697).

    The branch that republishes the snapshot stays what it is: it has no perf
    machinery to reach for, and inventing one here would be a second writer of
    the two tables ADR-0006 gives exactly one.
    """
    _fixed_today(mocker)
    events_dir = tmp_path / 'events'
    events_dir.mkdir(exist_ok=True)
    (events_dir / '2024.csv').write_text(_LEDGER, encoding='utf-8')
    opened = store_module.open_store(tmp_path / 'store.duckdb')
    manager = main.ConfigurationManager(config_dir=str(tmp_path),
                                        opened_store=opened)
    runtime = main.Runtime(manager, None)
    runtime.store = opened
    manager.reload()

    main.replay_after_write(runtime)

    # The snapshot was republished — the replay's own tables are written — and
    # the perf tables are untouched, there being nothing here to recompute with.
    assert opened.query('SELECT count(*) FROM account_state') == [(1,)]
    assert opened.query('SELECT count(*) FROM account_metrics') == [(0,)]
    assert opened.query('SELECT count(*) FROM portfolio_totals') == [(0,)]
    opened.close()


# --------------------------------------------------------------------------- #
# The currency an uploaded file declares reaches the running process
# --------------------------------------------------------------------------- #

_DECLARING_CSV = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes,"
    "base_currency\n"
    "2024-01-10,DEPOSIT,,,,,,1000.00,Opening,EUR\n"
)


def test_a_file_that_declares_the_currency_gets_a_series_from_that_write(
        tmp_path, mocker):
    """The onboarding road, end to end (issue #812).

    ``POST /api/events/import`` writes ``base_currency`` into ``setting``, and
    the perf gate reads the **attribute**. It was refreshed only on a drop-folder
    scan, and the replay that follows the write scans nothing — so the row landed
    and the process went on holding ``None``, which made this recompute *and
    every later tick* write no series at all. An install whose first gesture is
    an import had an empty dashboard until a restart.
    """
    _fixed_today(mocker)
    (tmp_path / 'events').mkdir(exist_ok=True)
    opened = store_module.open_store(tmp_path / 'store.duckdb')
    manager = main.ConfigurationManager(config_dir=str(tmp_path),
                                        opened_store=opened)
    runtime = main.Runtime(manager, None)
    runtime.store = opened
    manager.reload()
    metrics = main.SuiviBourseMetrics(manager)
    runtime.metrics = metrics
    # Unanswered, as it is on a fresh install: the file is what answers it.
    assert metrics.base_currency is None
    client = create_app(runtime).test_client()

    written = client.post(
        '/api/events/import',
        data={'file': (io.BytesIO(_DECLARING_CSV.encode()), 'broker.csv')},
        content_type='multipart/form-data')
    assert written.status_code == 201

    assert opened.setting('base_currency') == 'EUR'
    assert metrics.base_currency == 'EUR'
    assert _days(opened)[0] == date(2024, 1, 10)
    assert _cash_on(opened, _TODAY) == pytest.approx(1000.0)
    opened.close()


# --------------------------------------------------------------------------- #
# One pass at a time
# --------------------------------------------------------------------------- #

def test_two_recomputes_never_overlap(tmp_path, mocker):
    """The tick and the write are two callers now, and the prune is not safe.

    A pass reads and computes outside any mutex and takes ``writing()`` only for
    its final upsert-and-prune, and ``prune_account_metrics`` is bounded by
    **that pass's own spans**. So a tick that began before a back-dated event was
    recorded would commit second, with the old ledger's spans, and delete the
    history the request had just written — the exact screen #812 exists to
    remove, arrived at from the other side.

    Asserted on the call because there is no row that says *two passes did not
    run at once*: it is the app declining to do something, which is the one case
    the suite reaches for an internal double (see ``app/CLAUDE.md``).
    """
    client, opened = _build(tmp_path, mocker)
    metrics = main.SuiviBourseMetrics
    live, overlapped = [], []
    guard = threading.Lock()
    real = metrics._rebuild_series

    def watched(self):
        with guard:
            overlapped.append(bool(live))
            live.append(1)
        try:
            return real(self)
        finally:
            with guard:
                live.pop()

    mocker.patch.object(metrics, '_rebuild_series', watched)

    threads = [threading.Thread(
        target=lambda i=i: client.post(
            '/api/events', json=_deposit(date=f'2022-06-0{i + 1}')))
        for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert overlapped and not any(overlapped)
    # And the ledger they wrote between them is whole, with its oldest day
    # standing rather than pruned away by a pass that read before it.
    assert _days(opened)[0] == date(2022, 6, 1)
    assert _cash_on(opened, _TODAY) == pytest.approx(1000.0 + 4 * 500.0)


def test_the_record_of_a_pass_is_published_under_the_pass_lock(
        tmp_path, mocker):
    """``record_perf`` is inside the lock, with the rebuild it is about (#812).

    ``_perf_lock`` orders the passes; the record used to be published after it
    was released, so the two orderings were free to disagree. A tick descheduled
    between its own release and its ``record_perf`` would stamp older horizons
    and an older ``at`` over the record of the request that overtook it, and
    ``/api/runtime`` would then name a cache that no longer exists.

    Asserted on the lock rather than on a race, and from **another thread**
    because the lock is reentrant: at the instant the record is built, nobody
    else may take the pass. There is no row that says this — it is the app
    declining to leave a window open — which is the one case the suite reaches
    for an internal double (see ``app/CLAUDE.md``).
    """
    client, opened = _build(tmp_path, mocker)
    metrics = web_module.current_runtime().metrics
    seen, record = [], main.runtime_state.PerfRecord

    def watched(**kwargs):
        seen.append(_free_from_another_thread(metrics._perf_lock))
        return record(**kwargs)

    mocker.patch.object(main.runtime_state, 'PerfRecord', watched)

    assert client.post('/api/events', json=_deposit()).status_code == 201

    # One pass, and nobody could have started another while it was recording.
    assert seen == [False]


def _free_from_another_thread(lock) -> bool:
    """Could a *different* thread take this lock right now?

    Another thread on purpose: ``RLock`` lets the holder re-acquire, so asking
    from the recording thread would answer ``True`` on a lock that is very much
    held.
    """
    answer = []

    def ask():
        taken = lock.acquire(blocking=False)
        answer.append(taken)
        if taken:
            lock.release()

    asker = threading.Thread(target=ask)
    asker.start()
    asker.join()
    return answer[0]
