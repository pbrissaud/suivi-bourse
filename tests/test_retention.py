"""The resolution ladder: what age does to a stored point (issue #705, ADR-0010).

Two halves, and the seam between them is the one the rest of the suite uses.
:mod:`retention` is pure — the rungs, the two walls, and the arithmetic that
reads a window against them — so it is asserted with nothing but a ``now``
somebody wrote down. :func:`quotes.collapse_to_ladder` writes, so it is asserted
against a **real** DuckDB store in ``tmp_path``: every claim below is about the
rows that are left, and a mock reports that a ``DELETE`` was issued, never that
it designated the right ones.

The clock is the product's and it is UTC, stated here as a literal so the walls
fall where the test says they do rather than where the machine running it
happens to stand (#781).
"""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pandas as pd
import pytest

from application import backfill
from application import main
from application import market
from application import quotes
from application import retention
from application import settings_registry
from application import store_reads
from application import workloads
from application.events.schemas import Event, EventType

UTC = timezone.utc

#: An instant with no significance beyond being written down. The walls are
#: relative to it, so every seed below is expressed as an **age**.
NOW = datetime(2026, 8, 20, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """The backfill's courtesy to Yahoo is not a unit under test here."""
    monkeypatch.setattr(backfill.time, 'sleep', lambda *a, **k: None)


def _at(days, hour=10, minute=0):
    """An instant ``days`` old, at a stated hour of that day."""
    return (NOW - timedelta(days=days)).replace(
        hour=hour, minute=minute, second=0, microsecond=0)


def _seed(store, symbol, instants, price=100.0):
    """Lay a series down through the production writer, never by hand.

    ``record_history`` is what a backfilled chunk goes through, so what the
    ladder is asked to age is what the app really stores — the truncation to
    the second included, which is what makes the survivor of a bucket a
    well-defined row.
    """
    store.execute('INSERT INTO symbol (symbol) VALUES (?) '
                  'ON CONFLICT (symbol) DO NOTHING', [symbol])
    quotes.record_history(store, symbol, [
        {'timestamp': at, 'price': price + index}
        for index, at in enumerate(sorted(instants))])


def _series(store, symbol='AAPL'):
    return [row[0] for row in store.query(
        'SELECT ts FROM price_point WHERE symbol = ? ORDER BY ts', [symbol])]


# --------------------------------------------------------------------------- #
# The three rungs and the two walls — pure
# --------------------------------------------------------------------------- #

def test_the_ladder_has_three_rungs_and_they_are_read_off_an_age():
    """*As written* under a year, *hourly* to two, *daily* beyond.

    The second wall is inclusive on the hourly side deliberately: at exactly two
    years a point is still hourly, and it is the day after that it goes daily.
    Written the other way the two bands would overlap by a day, and a point
    would be designated by both.
    """
    assert retention.rung_at(timedelta(0)) == retention.RAW
    assert retention.rung_at(timedelta(days=364, hours=23)) == retention.RAW
    assert retention.rung_at(timedelta(days=365)) == retention.HOUR
    assert retention.rung_at(timedelta(days=730)) == retention.HOUR
    assert retention.rung_at(timedelta(days=730, seconds=1)) == retention.DAY


def test_a_point_stamped_in_the_future_sits_on_the_finest_rung():
    """The only answer that keeps the ladder a ceiling.

    Nothing forbids an event — or a badly stamped chunk — dated ahead of the
    clock, and a total function has to answer for it. Answering *daily* there
    would have the collapse designate a row nothing has aged yet, which is the
    one thing a ceiling may never do.
    """
    assert retention.rung_at(timedelta(days=-3)) == retention.RAW


def test_the_two_walls_cut_exactly_the_bands_the_rungs_name():
    """The pure reading of a point and the ``WHERE`` that collapses it are one rule.

    :func:`retention.walls` is what reaches SQL and :func:`retention.rung_at` is
    what a reader means; they are two spellings, so the boundaries have to agree
    at both edges or a point would fall between the bands and be aged by nobody.
    """
    hourly, daily = retention.walls(NOW)

    for age in (0, 1, 364, 365, 366, 500, 729, 730, 731, 5000):
        moment = NOW - timedelta(days=age)
        band = (retention.RAW if moment > hourly
                else retention.HOUR if moment >= daily
                else retention.DAY)
        assert band == retention.rung_at(timedelta(days=age)), age


def test_the_walls_are_an_age_bound_and_never_a_counter():
    """Six months of arrears is one bound, not a hundred and eighty of them.

    The bound's left-hand side is open: everything older than a wall is that
    wall's business however long ago it was written. It is what
    :func:`quotes.collapse_to_ladder` inherits, and the property is stated here
    because it is the one a *counter* — the tempting spelling, *one day per
    cycle* — would silently lose.
    """
    hourly, _ = retention.walls(NOW)
    stale = NOW - timedelta(days=365 + 180)

    assert stale <= hourly


# --------------------------------------------------------------------------- #
# What the API announces — derived, never written down twice
# --------------------------------------------------------------------------- #

def test_the_announced_resolution_is_the_coarsest_of_the_bucket_and_the_rung():
    """The four windows, and what each one is honestly served as (#719, #763)."""
    served = {window: store_reads.chart_window(window)[2]
              for window in store_reads.CHART_WINDOWS}

    assert served == {'1M': 'raw', '1Y': 'hour', '2Y': 'hour', 'MAX': 'day'}


def test_the_resolution_follows_the_ladder_rather_than_a_literal(monkeypatch):
    """Move a wall and the announcement moves with it (issue #705).

    The field said *what was served*, and what is served is decided by the
    retention policy — so a third literal beside the span and the bucket would
    be a copy of the ladder kept in step by hand, going on describing the
    version before the wall moved. That is worse than a wrong number: it reads
    as an answer.
    """
    monkeypatch.setattr(retention, 'HOUR_WALL_DAYS', 14)

    assert store_reads.chart_window('1M')[2] == 'hour'


def test_a_bucket_between_two_rungs_has_no_honest_name_to_be_announced_under():
    """A resolution has three names, and rounding to the nearer is invisible.

    ``ALLOWED_INTERVALS`` still admits ``6 hours``, which sits between the
    hour and the day. Answering ``hour`` or ``day`` for it here would be a claim
    about the series nobody could check.
    """
    with pytest.raises(ValueError):
        retention.rung_of_bucket('6 hours')


def test_nothing_about_the_ladder_is_a_dial():
    """Neither the walls nor the rungs enter the registry (ADR-0014, #705).

    An install whose retention differs is an install whose pages do not mean the
    same thing — and the resolution the API announces would describe a policy no
    reader of that page can see. ``settings_registry`` is the whole of what a
    dial is, so the assertion is on its keys.
    """
    keys = set(settings_registry.defaults())

    assert not {key for key in keys
                if 'retention' in key or 'wall' in key or 'resolution' in key}
    assert 'backfill_chunk_days' in keys  # the coverage half: the list is read


# --------------------------------------------------------------------------- #
# The collapse — in place, on a real store
# --------------------------------------------------------------------------- #

def test_under_a_year_a_point_is_kept_exactly_as_it_was_written(store):
    """The finest rung is the live cadence, and the ladder does not touch it."""
    written = [_at(100, 10, 0), _at(100, 10, 2), _at(100, 10, 4),
               _at(30, 15, 30), _at(30, 15, 32)]
    _seed(store, 'AAPL', written)

    removed = quotes.collapse_to_ladder(store, NOW)

    assert removed == 0
    assert _series(store) == written


def test_from_one_year_to_two_only_the_last_point_of_each_hour_survives(store):
    """The middle rung, and the survivor rule that makes nothing jump.

    The last point of the bucket is what :func:`quotes.price_series` and the
    chart's own reader already mean by *the price then*, so crossing the wall
    removes points and never changes a figure.
    """
    _seed(store, 'AAPL', [
        _at(500, 10, 0), _at(500, 10, 2), _at(500, 10, 58),
        _at(500, 11, 5), _at(500, 11, 45),
    ])

    quotes.collapse_to_ladder(store, NOW)

    assert _series(store) == [_at(500, 10, 58), _at(500, 11, 45)]


def test_beyond_two_years_only_the_last_point_of_each_day_survives(store):
    """The coarsest rung. The bucket is the **UTC calendar day**.

    ``CAST(ts AS DATE)`` and not a one-day ``time_bucket``: the two name the
    same day, and the first is the spelling every daily read of this store
    already uses, so the survivor the collapse leaves is by construction the
    point those reads were already taking.
    """
    _seed(store, 'AAPL', [
        _at(1000, 9, 0), _at(1000, 12, 0), _at(1000, 16, 30),
        _at(999, 11, 0), _at(999, 17, 0),
    ])

    quotes.collapse_to_ladder(store, NOW)

    assert _series(store) == [_at(1000, 16, 30), _at(999, 17, 0)]


def test_the_three_bands_are_aged_in_one_pass_and_never_confused(store):
    """One call, one series, three ages — and each band gets its own rung."""
    _seed(store, 'AAPL', [
        _at(90, 10, 0), _at(90, 10, 2),          # raw: both stay
        _at(500, 10, 0), _at(500, 10, 30),       # hourly: the later one
        _at(1200, 9, 0), _at(1200, 15, 0),       # daily: the later one
    ])

    quotes.collapse_to_ladder(store, NOW)

    assert _series(store) == [_at(1200, 15, 0), _at(500, 10, 30),
                              _at(90, 10, 0), _at(90, 10, 2)]


def test_running_it_twice_designates_nothing_the_second_time(store):
    """Idempotent **by construction**, which is what lets it ride a 60 s job.

    On an already-collapsed bucket exactly one row stands, so it is that
    bucket's last one and ``rn > 1`` names nobody. There is no watermark to
    keep, and therefore nothing to get wrong when the process restarts.
    """
    _seed(store, 'AAPL', [
        _at(500, 10, 0), _at(500, 10, 30), _at(500, 10, 59),
        _at(1200, 9, 0), _at(1200, 15, 0),
    ])

    first = quotes.collapse_to_ladder(store, NOW)
    after_first = _series(store)
    second = quotes.collapse_to_ladder(store, NOW)

    assert first == 3
    assert second == 0
    assert _series(store) == after_first


def test_a_gap_filled_at_nine_months_arrives_hourly_and_stays_hourly(store):
    """The ladder is a **ceiling, never a floor** (ADR-0010).

    The reconstruction can only buy hourly bars past sixty days, so a hole
    filled at nine months of age lands hourly while its band still allows the
    live cadence. Nothing interpolates it up — and when it later crosses the
    wall it is already at the rung the wall asks for, so it crosses without
    losing a point.
    """
    filled = [_at(270, hour, 0) for hour in range(9, 16)]
    _seed(store, 'AAPL', filled)

    quotes.collapse_to_ladder(store, NOW)
    assert _series(store) == filled

    # Six months on, the same rows are in the hourly band. They are already at
    # the rung it asks for, so the wall goes by and takes nothing.
    removed = quotes.collapse_to_ladder(store, NOW + timedelta(days=180))

    assert removed == 0
    assert _series(store) == filled


def test_six_months_of_arrears_are_caught_up_in_one_pass(store):
    """An install switched back on after six months down (#705's own example).

    The wall moved a hundred and eighty days while nothing was running. Because
    it is an age bound and not a counter, one call reaches every one of those
    days — where *one day per cycle* would have needed a hundred and eighty
    cycles, and a watermark to remember where it had got to.
    """
    arrears = []
    for age in range(365, 545):
        arrears += [_at(age, 10, 0), _at(age, 10, 20), _at(age, 10, 40)]
    _seed(store, 'AAPL', arrears)

    quotes.collapse_to_ladder(store, NOW)

    assert _series(store) == [_at(age, 10, 40) for age in range(544, 364, -1)]


def test_the_latest_row_is_left_exactly_as_it_was_found(store):
    """The collapse never touches ``symbol_quote``, and owes it nothing.

    Where the bucket is uniform the newest point *is* its survivor, so the
    ``latest`` line goes on naming a row that exists. Where it is mixed the
    ladder may remove the row it names — and that is not a dangling reference:
    the ``last_*`` columns are a **copy of an observation**, nothing joins them
    to the series, and what they say (*the newest observation ever made*) stays
    true. The figures a reader sees off ``symbol_quote`` are unchanged either
    way, which is what this asserts.
    """
    _seed(store, 'AAPL', [_at(1200, 9, 0), _at(1200, 12, 0), _at(1200, 17, 0)])
    before = quotes.read_quote(store, 'AAPL')

    quotes.collapse_to_ladder(store, NOW)

    assert quotes.read_quote(store, 'AAPL') == before
    assert before['last_price_ts'] in _series(store)


def test_two_symbols_are_aged_apart_by_one_statement(store):
    """The partition carries the symbol, so one scan does the whole table.

    ``price_point`` has no index of any kind (ADR-0007), so ``WHERE symbol = ?``
    is a full scan and N symbols would be N of them. The property that has to
    hold for one statement to be allowed is this one: a bucket belongs to a
    symbol, and the last point of MSFT's hour never stands in for AAPL's.
    """
    _seed(store, 'AAPL', [_at(500, 10, 0), _at(500, 10, 30)])
    _seed(store, 'MSFT', [_at(500, 10, 10), _at(500, 10, 50)])

    quotes.collapse_to_ladder(store, NOW)

    assert _series(store, 'AAPL') == [_at(500, 10, 30)]
    assert _series(store, 'MSFT') == [_at(500, 10, 50)]


def test_a_collapsed_point_keeps_its_own_price_and_its_own_conversion(store):
    """It is a ``DELETE`` and nothing else — no average, no re-stamping.

    The survivor is a row that was written by an observation, carried out whole.
    Anything else would be a figure the app manufactured, which is the one thing
    the ladder is defined not to do.
    """
    store.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")
    quotes.record_history(store, 'AAPL', [
        {'timestamp': _at(500, 10, 0), 'price': 10.0,
         'converted': 9.0, 'rate': 0.9},
        {'timestamp': _at(500, 10, 30), 'price': 20.0,
         'converted': 18.0, 'rate': 0.9},
    ])

    quotes.collapse_to_ladder(store, NOW)

    assert store.query(
        'SELECT ts, price_native, price_converted, fx_rate FROM price_point '
        'WHERE symbol = ?', ['AAPL']) == [
            (_at(500, 10, 30), 20.0, 18.0, 0.9)]


def test_a_mixed_bucket_keeps_the_usable_point_and_the_days_close_is_preserved(store):
    """The survivor rule's qualifier, and the defect it exists against.

    ``price_series`` and ``daily_closes`` rank the day's **converted** rows —
    an unconverted point is not money, and they filter it out before ranking —
    so keeping the last point flat would delete the only usable value in the
    bucket and take the whole day out of the perf job's price input. From there
    the day is carried forward from the previous one, ``oldest_priced`` moves,
    the account's horizon moves and the prune drops days: the #708/#765 crater,
    from a ``DELETE`` nothing can undo.

    Ranked converted-first the day's close is preserved **to the value**, which
    is the criterion — *a survivor chosen otherwise would make the value jump as
    the wall goes by* — read on the figures that are money.
    """
    store.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")
    quotes.record_history(store, 'AAPL', [
        {'timestamp': _at(800, 10, 0), 'price': 10.0,
         'converted': 9.0, 'rate': 0.9},
        {'timestamp': _at(800, 17, 0), 'price': 11.0},
    ])
    before = quotes.price_series(store, 'AAPL')

    quotes.collapse_to_ladder(store, NOW)

    assert quotes.price_series(store, 'AAPL') == before
    assert store.query(
        'SELECT ts, price_converted FROM price_point WHERE symbol = ?',
        ['AAPL']) == [(_at(800, 10, 0), 9.0)]


def test_a_bucket_with_nothing_converted_keeps_its_last_point_all_the_same(store):
    """The other half: an unconverted survivor is a row #704 repairs in place.

    Throwing it away would be the ladder deciding a conversion will never land
    — which is a statement about a rate, and the ladder has nothing to say about
    rates.
    """
    store.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")
    quotes.record_history(store, 'AAPL', [
        {'timestamp': _at(800, 10, 0), 'price': 10.0},
        {'timestamp': _at(800, 17, 0), 'price': 11.0},
    ])

    quotes.collapse_to_ladder(store, NOW)

    assert store.query(
        'SELECT ts, price_native, price_converted FROM price_point '
        'WHERE symbol = ?', ['AAPL']) == [(_at(800, 17, 0), 11.0, None)]


def test_the_days_close_survives_the_hourly_band_too(store):
    """The bands bucket by hour, the money readers bucket by day.

    The day's last converted point lies in some hour, and inside that hour it is
    the last converted one — so it survives, whatever a later hour holds. The
    property is not obvious from the hourly rule alone, which is why it is
    asserted rather than reasoned about.
    """
    store.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")
    quotes.record_history(store, 'AAPL', [
        {'timestamp': _at(500, 10, 0), 'price': 10.0,
         'converted': 9.0, 'rate': 0.9},
        {'timestamp': _at(500, 14, 0), 'price': 12.0,
         'converted': 11.0, 'rate': 0.9},
        {'timestamp': _at(500, 14, 30), 'price': 13.0},
        {'timestamp': _at(500, 17, 0), 'price': 14.0},
    ])
    before = quotes.price_series(store, 'AAPL')

    quotes.collapse_to_ladder(store, NOW)

    assert quotes.price_series(store, 'AAPL') == before == {_at(500).date(): 11.0}


def test_an_empty_store_is_aged_without_raising(store):
    """A fresh install runs this every sixty seconds before it holds anything."""
    assert quotes.collapse_to_ladder(store, NOW) == 0


# --------------------------------------------------------------------------- #
# Where it runs — a step of the backfill, and never a job of its own
# --------------------------------------------------------------------------- #

class _Manager:
    """The manager surface the backfill uses, over a real store."""

    config_dir = None

    def __init__(self, opened, shares=(), events=None):
        self._store = opened
        self._shares = list(shares)
        self._events = events

    @property
    def store(self):
        return self._store

    @contextmanager
    def writing(self):
        yield self._store

    def current(self):
        return main.ConfigSnapshot(
            shares=self._shares, events=self._events or [],
            accounts=None, cache_key=None)


#: A held line and the event that acquired it. The fetching passes need a
#: holding window to walk, and ``backfill_windows()`` derives one from the
#: **events** rather than from the shares — so a fixture that names only a share
#: gets a cycle that returns before any pass runs.
_A_BUY = Event(_at(900).date(), EventType.BUY, 'AAPL', 'Apple Inc',
               quantity=10, unit_price=100.0)

_HELD = {'symbol': 'AAPL', 'name': 'Apple Inc', 'quantity': 10,
         'cost_basis': 1000.0, 'realized_gain': 0.0, 'received_dividend': 0.0}


def _metrics(opened, **kwargs):
    return workloads.Workloads(_Manager(opened, **kwargs))


def test_the_ladder_runs_as_a_step_of_the_backfill(store):
    """It writes ``price_point``, so it belongs to the job that owns that past.

    Never a fifth job: the scrape, the backfill and the perf recompute are what
    the scheduler carries, and a maintenance pass over rows the backfill already
    writes would be a fourth cadence with nothing of its own to decide.
    """
    _seed(store, 'AAPL', [_at(1200, 9, 0), _at(1200, 17, 0)])
    metrics = _metrics(store)

    metrics.backfill(now=NOW)

    assert _series(store) == [_at(1200, 17, 0)]


def test_the_scheduler_gains_no_job_for_it(store, mocker):
    """Two interval jobs, and the ladder is in neither's name."""
    scheduler = mocker.MagicMock()
    main.register_interval_jobs(scheduler, mocker.MagicMock(), 60)

    ids = {call.kwargs['id'] for call in scheduler.add_job.call_args_list}

    assert ids == {'backfill', 'perf'}


def test_the_ladder_runs_though_the_backward_pass_has_nothing_left_to_do(store):
    """A mature install is the one that needs it, and it is the one that fetches least.

    The backward watermark is what stops the reconstruction refetching a window
    it has already reached; gating the collapse on it would leave the ladder
    unapplied on exactly the installs whose series is oldest.
    """
    _seed(store, 'AAPL', [_at(1200, 9, 0), _at(1200, 17, 0)])
    metrics = _metrics(store)
    metrics._backfill_complete['AAPL'] = NOW

    metrics.backfill(now=NOW)

    assert _series(store) == [_at(1200, 17, 0)]


def test_the_ladder_reaches_a_symbol_no_event_names_any_more(store):
    """The rows spec #695 § 10 most insists on keeping are the ones a loop misses.

    An orphan's series is kept — forgetting an import is reversible, a
    reconstructed series is not — and the backfill's own loop walks the holding
    windows the ledger produces, which by definition no longer name it. Aged
    per symbol from inside that loop, the finest series in the store would be
    the one nobody can see.
    """
    _seed(store, 'ORPH', [_at(1200, 9, 0), _at(1200, 17, 0)])
    metrics = _metrics(store)

    metrics.backfill(now=NOW)

    assert _series(store, 'ORPH') == [_at(1200, 17, 0)]


def test_a_store_that_refuses_to_age_does_not_abort_the_cycle(store, mocker):
    """Nothing depends on it: the next cycle designates exactly the same rows.

    The pass carries no watermark, so a failure costs a series that stays finer
    than it should for sixty seconds — where a raise would cost the backfill's
    three **fetching** passes, which do not repeat for free. So the install here
    holds something: on an empty ledger the cycle returns before any pass runs,
    and the test would pass with the guard deleted.
    """
    _seed(store, 'AAPL', [_at(1200, 9, 0), _at(1200, 17, 0)])
    metrics = _metrics(store, shares=[_HELD], events=[_A_BUY])
    mocker.patch.object(quotes, 'collapse_to_ladder',
                        side_effect=RuntimeError('boom'))
    fetch = mocker.patch.object(metrics, '_fetch_historical_data',
                                return_value=[])

    metrics.backfill(now=NOW)

    # The three passes ran, and the series is exactly as the refusal left it.
    assert fetch.call_count > 0
    assert _series(store) == [_at(1200, 9, 0), _at(1200, 17, 0)]


def test_the_ladder_runs_beside_the_three_passes_on_a_populated_install(store,
                                                                        mocker):
    """The ordinary shape: something is held, and the ladder still ages the rest.

    The three fetching passes and the collapse are independent — the first three
    ask Yahoo for what is missing, the fourth removes what age has made too
    fine — and this is the one test where all four run in one cycle.
    """
    _seed(store, 'AAPL', [_at(1200, 9, 0), _at(1200, 17, 0)])
    metrics = _metrics(store, shares=[_HELD], events=[_A_BUY])
    fetch = mocker.patch.object(metrics, '_fetch_historical_data',
                                return_value=[])

    metrics.backfill(now=NOW)

    assert fetch.call_count > 0
    assert _series(store) == [_at(1200, 17, 0)]


# --------------------------------------------------------------------------- #
# The other side of the present: what the rebuild is allowed to buy
# --------------------------------------------------------------------------- #

def test_the_rebuild_asks_for_the_finest_bars_the_api_still_sells(store, mocker):
    """``1h`` under the ceiling, ``1d`` beyond — and it is a ceiling, not a rung.

    Yahoo sells nothing below the hour past 729 days. That is why the number is
    neither a dial nor derived from :mod:`retention`'s walls: the ladder was
    drawn *from* it, so the reconstructed past and the ageing present implement
    one function of age rather than two policies meeting at the present. It is
    also the sentence behind *fine resolution is only ever obtained by having
    been there* — past this line there is nowhere left to buy it back, which is
    what makes sampling at write time the one irreversible decision, and
    therefore the one that was refused.
    """
    asked = []

    class _Ticker:
        def history(self, **kwargs):
            asked.append(kwargs['interval'])
            return pd.DataFrame()

    mocker.patch.object(market.yf, 'Ticker', lambda symbol: _Ticker())
    metrics = _metrics(store)
    # The one instant in this file that is not the literal ``NOW``: the ceiling
    # is measured against Yahoo's *today*, so the call site reads the product's
    # clock and the test has to read the same one — UTC, stated, like every
    # other read in the tree (#781).
    today = datetime.now(timezone.utc)

    metrics._fetch_historical_data('AAPL', today - timedelta(days=700), today)
    metrics._fetch_historical_data('AAPL', today - timedelta(days=800),
                                   today - timedelta(days=700))

    assert asked == ['1h', '1d']


def _the_api_ceiling_is_respected(asked, now):
    """What Yahoo sells, asserted on the requests themselves (#705, #783).

    Two halves and they are the ticket's own: **nothing under the ceiling is
    asked in daily bars** — a daily request may not reach into the band Yahoo
    would still have sold by the hour, since past the ceiling that band can never
    be bought again — and **nothing beyond it is asked in hourly ones**, which is
    a request Yahoo answers with nothing at all.

    The second half is stated in days rather than against the instant: the fetch
    truncates the age to whole days, so a window starting 729 days and a few
    hours ago is still inside Yahoo's own 730-day limit and is legitimately
    bought by the hour.
    """
    ceiling = now - timedelta(days=729)
    for start, end, interval in asked:
        if interval == '1d':
            assert end <= ceiling, (start, end, interval)
        else:
            assert (now - start).days <= 729, (start, end, interval)


def test_a_rebuild_started_today_buys_the_one_to_two_year_band_by_the_hour(
        store, mocker):
    """The chunk is cut on the ceiling, so no window straddles it (issue #783).

    The interval is chosen once for the whole chunk, from its **oldest** day, and
    the backward pass walks a year at a time from its anchor — so a rebuild
    anchored on today asks ``[today − 730 j, today − 365 j]`` on its second
    cycle, which misses the ceiling by a single day and buys ADR-0010's whole
    hourly band in daily bars. Cutting the chunk on the ceiling costs no extra
    request and one more cycle for the symbol, on a pass that already does one
    chunk per cycle.

    The assertion is on the **window actually asked of yfinance**, not on the
    number of points a fake returned: what is wrong here is the request, and a
    fake that answers hourly rows to a daily request would hide it.
    """
    asked = []

    class _Ticker:
        def history(self, **kwargs):
            asked.append((kwargs['start'], kwargs['end'], kwargs['interval']))
            return pd.DataFrame()

    mocker.patch.object(market.yf, 'Ticker', lambda symbol: _Ticker())
    # The ceiling is measured against Yahoo's *today*, so the whole fixture is
    # dated from the same clock the call site reads — UTC, stated, like every
    # other read in the tree (#781). The literal ``NOW`` would put the ledger a
    # day either side of the ceiling on any day but the one this was written.
    today = datetime.now(UTC)
    acquired = Event((today - timedelta(days=900)).date(), EventType.BUY,
                     'AAPL', 'Apple Inc', quantity=10, unit_price=100.0)
    # The declaration the anchor's foreign key asks for — the configuration
    # path's own row, which the market writers never create.
    store.execute('INSERT INTO symbol (symbol) VALUES (?)', ['AAPL'])
    metrics = _metrics(store, shares=[_HELD], events=[acquired])

    for _ in range(3):
        metrics.backfill(now=today)

    # Three cycles, three requests — the repair is not paid for in requests.
    assert [((today - start).days, (today - end).days, interval)
            for start, end, interval in asked] == [
        (365, 0, '1h'),      # the raw year
        (729, 365, '1h'),    # the hourly band, cut on the ceiling
        (900, 729, '1d'),    # beyond it, where the hour is not sold
    ]


def test_the_ceiling_does_not_move_and_the_pass_still_concludes(store, mocker):
    """The cut buys the hourly band; it does not buy a finer bar past the ceiling.

    The whole rebuild of a five-year line, one window at a time: every request
    that reaches under the ceiling is hourly, every request beyond it is daily,
    and **no window straddles** — which is the property the interval-per-chunk
    choice needs in order to be honest at all. What Yahoo sells is unchanged by
    #783 and is not what that ticket discusses.

    And the pass still ends where it ended: an install that has reconstructed
    stays reconstructed, and the cut does not set the cycle asking again for a
    window it had concluded (issue #703).
    """
    asked = []

    class _Ticker:
        def history(self, **kwargs):
            asked.append((kwargs['start'], kwargs['end'], kwargs['interval']))
            return pd.DataFrame()

    mocker.patch.object(market.yf, 'Ticker', lambda symbol: _Ticker())
    today = datetime.now(UTC)
    acquired = Event((today - timedelta(days=1800)).date(), EventType.BUY,
                     'AAPL', 'Apple Inc', quantity=10, unit_price=100.0)
    store.execute('INSERT INTO symbol (symbol) VALUES (?)', ['AAPL'])
    metrics = _metrics(store, shares=[_HELD], events=[acquired])

    for _ in range(5):
        metrics.backfill(now=today)

    _the_api_ceiling_is_respected(asked, today)

    # The windows **tile**: each one resumes exactly where the previous stopped,
    # so the cut moved the anchor onto ground it had really asked for and no day
    # of the history went mute (#703). A cut that advanced the anchor past its
    # own request would show up here as a hole, and nowhere else — Yahoo is
    # never asked twice for a window the pass has concluded.
    # Compared as **days**, because the anchor is a calendar day and not an
    # instant (spec #695 § 3): what resumes the next cycle is the date of the
    # window this one asked for.
    for (_, end, _), (previous_start, _, _) in zip(asked[1:], asked):
        assert end.date() == previous_start.date()

    # Terminal, and it stays terminal: two more cycles ask Yahoo nothing.
    assert metrics._backfill_complete['AAPL'].date() == acquired.date
    concluded = len(asked)
    metrics.backfill(now=today)
    metrics.backfill(now=today)
    assert len(asked) == concluded


def test_a_gap_wider_than_two_years_is_closed_on_both_sides_of_the_ceiling(
        store, mocker):
    """The forward pass is cut on the ceiling too (issue #783).

    A line sold three years ago and bought back today: the backward pass is
    terminal — the store already reaches the first acquisition — so the forward
    pass is the **only** filler of the gap, and its second chunk straddles the
    ceiling by a day exactly as the backward pass's did. An install rallied after
    a stop longer than two years lands in the same place.

    Asserted on the requests, and the property is the ticket's: nothing under the
    ceiling is asked in daily bars, nothing beyond it in hourly ones.
    """
    asked = []

    class _Ticker:
        def history(self, **kwargs):
            asked.append((kwargs['start'], kwargs['end'], kwargs['interval']))
            # The last bar of the window asked for — the forward pass carries no
            # anchor, so a fake that answered nothing would have it re-ask the
            # same window for ever and the test would never reach the band.
            last = kwargs['end'] - timedelta(minutes=1)
            return pd.DataFrame({'Close': [100.0]},
                                index=pd.DatetimeIndex([last]))

    mocker.patch.object(market.yf, 'Ticker', lambda symbol: _Ticker())
    today = datetime.now(UTC)
    events = [
        Event((today - timedelta(days=1100)).date(), EventType.BUY, 'AAPL',
              'Apple Inc', quantity=10, unit_price=100.0),
        Event((today - timedelta(days=1095)).date(), EventType.SELL, 'AAPL',
              'Apple Inc', quantity=10, unit_price=110.0),
        Event(today.date(), EventType.BUY, 'AAPL', 'Apple Inc',
              quantity=10, unit_price=120.0),
    ]
    # The series the install already holds: it reaches the first acquisition, so
    # the backward pass concludes on its first cycle and the gap is the forward
    # pass's alone.
    _seed(store, 'AAPL', [_at(1100, 15, 0), _at(1095, 15, 0)])
    metrics = _metrics(store, shares=[_HELD], events=events)

    for _ in range(3):
        metrics.backfill(now=today)

    assert asked, "the forward pass never ran"
    _the_api_ceiling_is_respected(asked, today)
    # And the band it exists for was really asked by the hour.
    assert any(interval == '1h' for _, _, interval in asked)
