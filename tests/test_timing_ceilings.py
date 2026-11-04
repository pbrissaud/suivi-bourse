"""The timing lane: three whole operations, three ceilings (issue #995).

5.1's two best fixes were found by timing the stack floor by floor, and the
suite could not tell they had been undone:

- **#972 / #980** — ``perf_series._upsert`` wrote one statement per row at
  0.741 ms a row. ``tests/test_perf_series.py`` asserts the rows it writes, not
  the seconds it takes, so a ``executemany`` put back passes it.
- **#967 / #977** — the API read through the writers' connection and waited
  behind their transaction. ``tests/test_store.py`` asserts that one read lands
  while a write is held; it does not assert how many, or how fast.
- **#760** — the counterfactual is replayed on every read, and the review that
  deleted the ticket's "past a threshold, switch to a stored curve" clause did
  it on one out-of-band measurement that left nothing behind.

So: whole operations, not microbenchmarks, and a ceiling set from a measured
run with headroom rather than from a wish. Each one is an **order of
magnitude** below the pathology it guards and an order of magnitude above what
the operation costs today — a shared runner is a noisy clock, and a lane that
cries wolf is a lane that gets deselected.

**Out of the pull request gate.** Every test here carries ``timing``, which
``.github/workflows/pr-checks.yml`` deselects beside ``network`` and which
``.github/workflows/nightly-benchmarks.yml`` runs on the schedule it already
had. A number measured on a machine that is also building three other branches
is not a review comment worth writing.

Measured 2026-09-22, Python 3.14 on an M-series laptop; the CI figures of the
first nightly runs are what the ceilings are really sized for.
"""
import statistics
import threading
import time
from datetime import date, datetime, timedelta, timezone

import pytest

from api import create_app
from application import accounts
from application import counterfactual
from application import entries
from application import main
from application import store as store_module
from application import workloads
from application.events.loader import EventLoader

pytestmark = pytest.mark.timing


# --------------------------------------------------------------------------- #
# The ceilings
# --------------------------------------------------------------------------- #

#: ``replay_after_write`` over ~13 k series rows. Measured 0.085 s; row by row
#: the same rewrite is ~9.7 s (13 158 × 0.741 ms), so this sits 23× above the
#: fixed cost and 5× below the regression.
REPLAY_CEILING_S = 2.0

#: The median ``GET /api/positions`` while a write transaction is held.
#: Measured 0.94 ms, worst 1.71 ms. On the writers' connection a read does not
#: get slower, it does not return at all until the ``COMMIT``.
READ_P50_CEILING_MS = 25.0

#: And enough of them to have a median worth reading. 1 044 landed inside the
#: held second; on the shared connection the answer is 0.
READS_EXPECTED = 100

#: One counterfactual replay over a window longer than the closed list's
#: longest. Measured 2.7 ms — the figure `counterfactual`'s own docstring
#: spends to argue the series need not be persisted.
COUNTERFACTUAL_CEILING_MS = 25.0

#: How long the held write lasts. Long enough for a median, short enough that
#: the lane stays a lane.
HELD_WRITE_S = 1.0


def _median_of(runs: int, operation):
    """The median of ``runs`` timings, in seconds. The median on purpose: one
    descheduled run on a shared runner is not a regression."""
    timings = []
    for _ in range(runs):
        started = time.perf_counter()
        operation()
        timings.append(time.perf_counter() - started)
    return statistics.median(timings)


# --------------------------------------------------------------------------- #
# A store with a real series in it
# --------------------------------------------------------------------------- #

#: The clock, pinned: the series runs to *today*, so a floating one would make
#: the row count — and the cost that follows it — drift a day at a time.
_TODAY = date(2024, 3, 5)

#: Six years back, which is what makes six accounts ≈ 13 k daily points: the
#: shape #972 was measured on.
_FIRST = date(2018, 3, 5)

_ACCOUNTS = tuple(f'acct-{index}' for index in range(6))


def _ledger() -> str:
    """One deposit per account, and nothing else.

    Cash alone on purpose: what is being timed is the **rewrite** of the daily
    series, and a ledger with no security needs no price to produce a full set
    of points. Adding holdings would add a market to stub and time.
    """
    head = ('date,event_type,symbol,name,quantity,unit_price,fee,amount,'
            'notes,account\n')
    return head + ''.join(
        f'{_FIRST.isoformat()},DEPOSIT,,,,,,1000.00,Opening,{account}\n'
        for account in _ACCOUNTS)


@pytest.fixture
def loaded(tmp_path, mocker):
    """A real store, a real manager, real workloads, and the series written.

    Returns ``(runtime, store)`` with the first pass already done, so every
    measurement below is of a **rewrite** — which is what a write costs, the
    replay being inside the request that wrote the event.
    """
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(_TODAY.year, _TODAY.month, _TODAY.day,
                            12, 0, tzinfo=tz)
    mocker.patch('application.perf_job.datetime', _FixedDatetime)

    events_dir = tmp_path / 'events'
    events_dir.mkdir(exist_ok=True)
    path = events_dir / 'ledger.csv'
    path.write_text(_ledger(), encoding='utf-8')

    opened = store_module.open_store(tmp_path / 'store.duckdb')
    for account in _ACCOUNTS:
        accounts.create_account(opened, account, account)
    entries.create_many(opened, EventLoader(str(path)).load())

    manager = main.ConfigurationManager(config_dir=str(tmp_path),
                                        opened_store=opened)
    runtime = main.Runtime(manager, None)
    runtime.store = opened
    manager.reload()
    opened.execute(
        "INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR') "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value")

    metrics = workloads.Workloads(manager)
    metrics.base_currency = 'EUR'
    runtime.workloads = metrics
    metrics.recompute_perf()

    yield runtime, opened
    opened.close()


# --------------------------------------------------------------------------- #
# 1. The rewrite inside the write (#972 / #980)
# --------------------------------------------------------------------------- #

def test_the_series_rewrite_that_rides_a_write_stays_under_its_ceiling(loaded):
    """``main.replay_after_write`` over ~13 k points.

    This is the operation and not ``_upsert``, because the ceiling has to keep
    meaning something if the cost moves to the caller: what a reader waits for
    is the whole replay behind their ``201``, not one statement inside it.
    """
    runtime, opened = loaded
    (rows,) = opened.query('SELECT count(*) FROM account_metrics')[0]
    assert rows > 12_000, f'the fixture stopped being heavy: {rows} rows'

    median = _median_of(5, lambda: main.replay_after_write(runtime))

    assert median < REPLAY_CEILING_S, (
        f'rewriting {rows} series rows took {median:.3f} s, '
        f'ceiling {REPLAY_CEILING_S} s — is the upsert back to one '
        f'statement per row? (#972)')


# --------------------------------------------------------------------------- #
# 2. The reads that must not wait for it (#967 / #977)
# --------------------------------------------------------------------------- #

def test_the_api_keeps_answering_while_a_write_holds_the_store(loaded):
    """``GET /api/positions``, polled flat out for a second of held write.

    The write is a transaction held open rather than a real long one: it holds
    the writers' mutex for exactly as long as this asks it to, which makes the
    failure unambiguous — on the writers' connection the reads do not land
    slowly, they land after the ``COMMIT``.

    The client is warmed first, because the **first** read on a thread creates
    its cursor and that takes the store's lock. Once per thread, against every
    read: measuring it here would measure the lock rather than the read.
    """
    runtime, opened = loaded
    client = create_app(runtime).test_client()
    for _ in range(5):
        assert client.get('/api/positions').status_code == 200

    holding, release = threading.Event(), threading.Event()

    def hold_a_write():
        with opened.transaction():
            opened.execute(
                "INSERT INTO setting (key, value) VALUES ('timing', '1') "
                "ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            holding.set()
            # Bounded so the regression this guards fails in seconds rather
            # than hanging: a read on the writers' connection waits for this
            # `COMMIT`, and a lane nobody can wait out is a lane nobody runs.
            release.wait(timeout=10)

    writer = threading.Thread(target=hold_a_write)
    writer.start()
    try:
        assert holding.wait(timeout=5), 'the write never took the store'
        latencies = []
        until = time.perf_counter() + HELD_WRITE_S
        while time.perf_counter() < until:
            started = time.perf_counter()
            assert client.get('/api/positions').status_code == 200
            latencies.append((time.perf_counter() - started) * 1000)
    finally:
        release.set()
        writer.join(timeout=15)

    assert len(latencies) >= READS_EXPECTED, (
        f'{len(latencies)} read(s) landed in {HELD_WRITE_S} s of held write, '
        f'expected {READS_EXPECTED} — are the reads back on the writers\' '
        f'connection? (#967)')
    median = statistics.median(latencies)
    assert median < READ_P50_CEILING_MS, (
        f'p50 {median:.2f} ms under a held write, '
        f'ceiling {READ_P50_CEILING_MS} ms (#967)')


# --------------------------------------------------------------------------- #
# 3. The replay #760 chose not to persist
# --------------------------------------------------------------------------- #

_CF_FIRST, _CF_LAST = date(2009, 1, 1), date(2026, 4, 1)


def _counterfactual_inputs():
    """Heavier than any real portfolio, and than the closed list's longest run.

    6 300 calendar days, 4 500 of them quoted, seventeen splits and 207 flows —
    the shape ``counterfactual``'s docstring measured, with every branch of the
    day's order exercised: splits, buys and sells that do not exhaust the
    position.
    """
    days = [_CF_FIRST + timedelta(days=offset)
            for offset in range((_CF_LAST - _CF_FIRST).days + 1)]
    prices = {day: 20.0 + (index % 50) * 0.1
              for index, day in enumerate(days) if day.weekday() < 5}
    splits = {days[index * 370]: 2.0 for index in range(17)}
    flows = {days[index * 30 + 15]: (250.0 if index % 7 else -300.0)
             for index in range(207)}
    return days, prices, splits, flows


def test_one_counterfactual_replay_stays_cheap_enough_not_to_be_stored():
    """The argument against a stored curve, kept honest.

    #760's review deleted "past a threshold, switch to persistence" because one
    replay costs less than the JSON encoding of its own output. The route runs
    two per account, so a replay that crossed this ceiling would put the
    threshold — and the second code path, and the staleness question — back on
    the table. That is the thing this is here to say out loud.
    """
    days, prices, splits, flows = _counterfactual_inputs()
    replayed = counterfactual.replay(
        (_CF_FIRST, _CF_LAST), prices, splits, flows, 10_000.0)
    # It ran the whole window: a replay that ended early is a cheaper loop, and
    # the ceiling below would be measuring the wrong thing.
    assert replayed.ended is None
    assert len(replayed.series) == len(days)

    median = _median_of(20, lambda: counterfactual.replay(
        (_CF_FIRST, _CF_LAST), prices, splits, flows, 10_000.0))

    assert median * 1000 < COUNTERFACTUAL_CEILING_MS, (
        f'one replay over {len(days)} days took {median * 1000:.2f} ms, '
        f'ceiling {COUNTERFACTUAL_CEILING_MS} ms — the route runs two per '
        f'account (#760, #983)')


# --------------------------------------------------------------------------- #
# 4. The tick that only today's quotes moved (#1257)
# --------------------------------------------------------------------------- #

#: The pass that follows a scrape, at the 500-symbol shape: today's point alone,
#: for each account and the total. Measured 0.053 s against 5.8 s for the full
#: rebuild it replaces on the same store (2026-11-03, a Linux CI container): 19×
#: above the cost, 6× below the full pass, so a tick quietly falling back to it
#: every time is a red nightly.
TODAY_ONLY_CEILING_S = 1.0

_WIDE_TODAY = date(2024, 3, 5)
_WIDE_FIRST = date(2019, 3, 5)
_WIDE_SYMBOLS = tuple(f'S{index:03d}' for index in range(500))
_WIDE_ACCOUNTS = ('wide-a', 'wide-b', 'wide-c')


@pytest.fixture
def wide(tmp_path, mocker):
    """3 accounts, 500 symbols, five years of daily closes, the series written."""
    from application import quotes
    from application.events.schemas import Event, EventType

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(_WIDE_TODAY.year, _WIDE_TODAY.month,
                            _WIDE_TODAY.day, 12, 0, tzinfo=tz)
    mocker.patch('application.perf_job.datetime', _FixedDatetime)

    opened = store_module.open_store(tmp_path / 'store.duckdb')
    for account in _WIDE_ACCOUNTS:
        accounts.create_account(opened, account, account)
    events = [Event(_WIDE_FIRST, EventType.DEPOSIT, amount=1_000_000.0,
                    account=account) for account in _WIDE_ACCOUNTS]
    events += [Event(_WIDE_FIRST + timedelta(days=1), EventType.BUY, symbol,
                     symbol, quantity=10, unit_price=100.0,
                     account=_WIDE_ACCOUNTS[index % len(_WIDE_ACCOUNTS)])
               for index, symbol in enumerate(_WIDE_SYMBOLS)]
    entries.create_many(opened, events)
    opened.execute(
        "INSERT INTO symbol_quote (symbol, currency) "
        "SELECT symbol, 'EUR' FROM symbol ON CONFLICT (symbol) DO NOTHING")
    days = (_WIDE_TODAY - _WIDE_FIRST).days
    opened.execute(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted,'
        '                         fx_rate) '
        "SELECT s.symbol, CAST(? AS TIMESTAMPTZ) + d.range * INTERVAL '1 day',"
        '       100 + d.range * 0.01, 100 + d.range * 0.01, 1.0'
        '  FROM symbol s, range(?) d', [datetime.combine(
            _WIDE_FIRST, datetime.min.time()).replace(hour=17).isoformat()
            + '+00:00', days])
    quotes.forget_oldest_stored()

    manager = main.ConfigurationManager(config_dir=str(tmp_path),
                                        opened_store=opened)
    manager.reload()
    metrics = workloads.Workloads(manager)
    metrics.base_currency = 'EUR'
    metrics.recompute_perf()
    yield metrics, opened
    opened.close()


def test_the_tick_after_a_scrape_rewrites_only_today(wide):
    """One symbol quoted today, then the pass — 500 symbols, five years."""
    from application import quotes
    from application import runtime_state

    metrics, opened = wide
    (points,) = opened.query('SELECT count(*) FROM price_point')[0]
    assert points > 900_000, f'the fixture stopped being wide: {points} points'
    minute = iter(range(60))

    def tick():
        quotes.record_quote(
            opened, 'S000', datetime(_WIDE_TODAY.year, _WIDE_TODAY.month,
                                     _WIDE_TODAY.day, 9, next(minute),
                                     tzinfo=timezone.utc),
            150.0, attributes={'currency': 'EUR'}, price_converted=150.0,
            fx_rate=1.0)
        metrics.recompute_perf()
        assert metrics.recorder.perf().mode == runtime_state.PERF_PASS_TODAY

    median = _median_of(5, tick)
    full = _median_of(3, lambda: metrics.recompute_perf(full=True))

    assert median < TODAY_ONLY_CEILING_S, (
        f'the today-only pass took {median:.3f} s (full: {full:.3f} s), '
        f'ceiling {TODAY_ONLY_CEILING_S} s — is it reading the whole '
        f'history again? (#1257)')


# --------------------------------------------------------------------------- #
# 5. The full pass after a write reads only the recent closes (#1256)
# --------------------------------------------------------------------------- #

#: The full pass that follows a write, with the closes behind today kept, as a
#: share of the same pass reading the whole history again, on the same store
#: and the same machine. Measured 3.1 s against 5.8 s (2026-11-04, a Linux CI
#: container): 0.54. A ratio and not seconds, because the saving is a factor
#: of two, not ten: no absolute figure sits clear of both a noisy runner and
#: the regression. The rows read are the structural half of the guard.
FULL_AFTER_WRITE_SHARE = 0.8


def test_the_full_pass_after_a_write_reads_only_recent_closes(wide, mocker):
    """500 symbols, five years: the second full pass reads today alone."""
    from application import store_reads

    metrics, opened = wide
    job = metrics._recompute
    reads = []
    original = store_reads.PortfolioReader.daily_closes

    def spy(self, start=None, stop=None):
        rows = original(self, start, stop)
        reads.append((start, len(rows)))
        return rows
    mocker.patch.object(store_reads.PortfolioReader, 'daily_closes', spy)

    cached = _median_of(3, lambda: metrics.recompute_perf(full=True))
    assert reads and all(start is not None for start, _ in reads), reads
    assert max(rows for _, rows in reads) < len(_WIDE_SYMBOLS), reads

    def whole():
        job._closes_cache = None
        metrics.recompute_perf(full=True)
    uncached = _median_of(3, whole)

    assert cached < FULL_AFTER_WRITE_SHARE * uncached, (
        f'the full pass with the closes kept took {cached:.3f} s against '
        f'{uncached:.3f} s reading them whole, ceiling '
        f'{FULL_AFTER_WRITE_SHARE:.0%} — is it reading the whole history '
        f'again? (#1256)')
