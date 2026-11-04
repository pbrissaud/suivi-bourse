"""The full perf pass reads only the recent closes (issue #1256).

The closes behind today are kept between full passes and reused while the
history they were read from is the one in the store, told by the pass reading
the store again (#707), never by a writer raising a flag. What is asserted:

- **what is read** — the window ``daily_closes`` is called with, and the rows
  it hands back;
- **what is written** — row for row, the series a pass with no memory at all
  writes over the same store, after each kind of history rewrite.
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from application import quotes
from application import runtime_state
from application import store as store_module
from application import store_reads

from perf_seed import (
    UTC,
    _TODAY,
    _Clock,
    _day_turn,
    _forget,
    _history,
    _ladder,
    _ledger_write,
    _metrics,
    _pass,
    _pin,
    _quote_today,
    _repair,
    _seed,
    _series,
)


def _midnight(day):
    return datetime.combine(day, time.min, tzinfo=UTC)


@pytest.fixture
def seeded(store, mocker, declare_ledger):
    _pin(mocker)
    _seed(store, declare_ledger)
    metrics = _metrics(store)
    _quote_today(store, 'BTC-EUR', 61000.0)
    assert _pass(metrics) == runtime_state.PERF_PASS_FULL
    return store, metrics


@pytest.fixture
def reads(mocker):
    """Every ``daily_closes`` call: ``(start, rows returned)``."""
    calls = []
    original = store_reads.PortfolioReader.daily_closes

    def spy(self, start=None, stop=None):
        rows = original(self, start, stop)
        calls.append((start, len(rows)))
        return rows
    mocker.patch.object(store_reads.PortfolioReader, 'daily_closes', spy)
    return calls


def _rebuilt_whole(opened):
    """The series a pass with no memory writes over the same store."""
    _metrics(opened)['performance'](full=True)
    return _series(opened)


# ---------------------------------------------------------------------------
# What a full pass reads
# ---------------------------------------------------------------------------


def test_the_first_full_pass_reads_the_whole_history(store, mocker,
                                                     declare_ledger, reads):
    _pin(mocker)
    _seed(store, declare_ledger)
    _pass(_metrics(store))

    assert [start for start, _ in reads] == [None]


def test_the_full_pass_after_a_write_reads_today_alone(seeded, declare_ledger,
                                                       reads):
    opened, metrics = seeded
    _quote_today(opened, 'AAPL', 101.0)
    _ledger_write(opened, metrics, declare_ledger)

    metrics['performance'](full=True)

    assert metrics.ctx.recorder.perf().mode == runtime_state.PERF_PASS_FULL
    # One close per symbol quoted today: BTC-EUR and AAPL.
    assert reads == [(_midnight(_TODAY), 2)]
    written = _series(opened)
    assert _rebuilt_whole(opened) == written


def test_the_day_after_reads_from_yesterday(seeded, reads):
    opened, metrics = seeded

    _Clock.day = _TODAY + timedelta(days=1)
    assert _pass(metrics) == runtime_state.PERF_PASS_FULL

    assert reads == [(_midnight(_TODAY), 1)]
    written = _series(opened)
    assert _rebuilt_whole(opened) == written

    # And the day after that, from the new cut: yesterday's close is kept.
    reads.clear()
    _Clock.day = _TODAY + timedelta(days=2)
    _pass(metrics)
    assert reads == [(_midnight(_TODAY + timedelta(days=1)), 0)]


def test_a_failed_pass_forgets_the_closes(seeded, mocker, reads):
    opened, metrics = seeded
    failing = mocker.patch(
        'application.performance.compute_portfolio_total',
        side_effect=RuntimeError('boom'))
    metrics['performance'](full=True)
    assert metrics.ctx.recorder.perf().verdict == runtime_state.PERF_FAILED
    mocker.stop(failing)
    reads.clear()

    metrics['performance'](full=True)

    assert [start for start, _ in reads] == [None]


# ---------------------------------------------------------------------------
# Every rewrite of the history behind today reads it whole again
# ---------------------------------------------------------------------------


def _backward(opened, metrics, declare_ledger):
    """A backfill reaching further back than the oldest stored point."""
    quotes.record_history(opened, 'AAPL', [
        {'timestamp': datetime(2024, 4, 30, 17, tzinfo=UTC), 'price': 95.0,
         'converted': 95.0, 'rate': 1.0}])


def _split_reread(opened, metrics, declare_ledger):
    """A split recorded, and the history before it read again, adjusted."""
    quotes.record_splits(opened, 'AAPL', {date(2024, 6, 1): 2.0})
    day, points = date(2024, 5, 2), []
    while day < date(2024, 6, 1):
        price = 50.0 * (1.0 + 0.001 * (day - date(2024, 5, 2)).days)
        points.append({'timestamp': datetime(day.year, day.month, day.day, 17,
                                             tzinfo=UTC),
                       'price': price, 'converted': price, 'rate': 1.0})
        day += timedelta(days=1)
    quotes.record_history(opened, 'AAPL', points)


@pytest.mark.parametrize('change', [
    _backward, _history, _repair, _ladder, _forget, _split_reread,
], ids=lambda change: change.__name__.lstrip('_'))
def test_a_rewritten_history_is_read_whole_again(seeded, declare_ledger,
                                                 reads, change):
    opened, metrics = seeded
    # Warm: the cache now holds the history the change is about to rewrite.
    metrics['performance'](full=True)
    assert reads[-1][0] == _midnight(_TODAY)
    reads.clear()

    change(opened, metrics, declare_ledger)
    metrics['performance'](full=True)

    assert [start for start, _ in reads] == [None]
    written = _series(opened)
    assert _rebuilt_whole(opened) == written


def test_a_rewrite_found_the_day_after_is_read_whole_again(seeded,
                                                           declare_ledger,
                                                           reads):
    """The day turned *and* the history behind the old cut moved."""
    opened, metrics = seeded
    _history(opened, metrics, declare_ledger)
    _day_turn(opened, metrics, declare_ledger)

    _pass(metrics)

    assert [start for start, _ in reads] == [None]
    written = _series(opened)
    assert _rebuilt_whole(opened) == written


# ---------------------------------------------------------------------------
# The closes kept equal the closes read whole
# ---------------------------------------------------------------------------


def _whole(opened):
    pairs = defaultdict(list)
    for close in store_reads.PortfolioReader(opened).daily_closes():
        pairs[close['symbol']].append((close['day'], float(close['price'])))
    return dict(pairs)


_steps = st.lists(st.sampled_from(('quote', 'backfill', 'day', 'write')),
                  min_size=1, max_size=8)


@settings(max_examples=25, deadline=None,
          suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(steps=_steps)
def test_the_kept_closes_equal_a_whole_read(tmp_path_factory, mocker,
                                            declare_ledger, steps):
    _pin(mocker)
    opened = store_module.open_store(
        tmp_path_factory.mktemp('closes') / 'store.duckdb')
    try:
        _seed(opened, declare_ledger)
        job = _metrics(opened)['performance']
        for minute, step in enumerate(steps):
            day = _Clock.day
            if step == 'quote':
                quotes.record_quote(
                    opened, 'AAPL',
                    datetime(day.year, day.month, day.day, 9, minute,
                             tzinfo=UTC),
                    100.0 + minute, attributes={'currency': 'EUR'},
                    price_converted=100.0 + minute, fx_rate=1.0)
            elif step == 'backfill':
                back = day - timedelta(days=3 + minute)
                quotes.record_history(opened, 'MSFT', [
                    {'timestamp': datetime(back.year, back.month, back.day, 17,
                                           tzinfo=UTC),
                     'price': 250.0 + minute, 'converted': 250.0 + minute,
                     'rate': 1.0}])
            elif step == 'day':
                _Clock.day = day + timedelta(days=1)

            fingerprint = store_reads.PortfolioReader(opened).perf_inputs(
                _midnight(_Clock.day))
            kept = job._closes(opened, _Clock.day, fingerprint)
            assert kept == _whole(opened)
    finally:
        opened.close()


def test_history_fingerprint_is_perf_inputs_first_half(seeded):
    opened, _ = seeded
    reader = store_reads.PortfolioReader(opened)
    cut = _midnight(_TODAY)

    assert reader.history_fingerprint(cut) == reader.perf_inputs(cut)[0]


@pytest.mark.parametrize('order', [(101.0, 202.0), (202.0, 101.0)])
def test_two_quotes_in_one_second_close_the_day_on_the_same_price(store, order):
    """No key on ``(symbol, ts)``: the pick may not hang on row order."""
    at = datetime(2024, 6, 3, 17, tzinfo=UTC)
    store.executemany(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted,'
        "                         fx_rate) VALUES ('AAPL', ?, 100, ?, 1)",
        [[at, price] for price in order])
    reader = store_reads.PortfolioReader(store)

    assert [c['price'] for c in reader.daily_closes()] == [202.0]
    assert reader.closes_of_day(_midnight(at.date()),
                                _midnight(at.date() + timedelta(days=1))) == {
        'AAPL': 202.0}
