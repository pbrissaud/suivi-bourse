"""The perf pass rewrites the least that keeps the series exact (issue #1257).

Three passes, told apart by what the store holds and nothing else (#707):

- **skipped**, when nothing the pass reads has moved;
- **today**, when only today's points have: today's row alone, for each account
  and the total, chained from the row before it;
- **full**, on anything else.

The seam is the suite's usual one: a real DuckDB store in ``tmp_path``, a real
:class:`workloads.Workloads`, and what is asserted is the rows written. The
claim the whole issue rests on — *a series continued one day at a time equals
the series rebuilt whole* — is asserted row for row and exactly, by a property
test over random sequences of today's quotes.
"""
from datetime import date, datetime, timedelta, timezone

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from conftest import PerfConfigManager

from application import perf_series
from application import quotes
from application import runtime_state
from application import store as store_module
from application import workloads
from application.events.schemas import Account, Event, EventType

UTC = timezone.utc

_TODAY = date(2024, 6, 20)
_OPENED = date(2024, 5, 1)
_ACQUIRED = date(2024, 5, 2)

_LEDGER = [
    Event(_OPENED, EventType.DEPOSIT, amount=10000.0, account='pea'),
    Event(_ACQUIRED, EventType.BUY, 'AAPL', 'Apple', quantity=10,
          unit_price=100.0, account='pea'),
    Event(_OPENED, EventType.DEPOSIT, amount=5000.0, account='cto'),
    Event(_ACQUIRED, EventType.BUY, 'BTC-EUR', 'Bitcoin', quantity=0.05,
          unit_price=60000.0, account='cto'),
    Event(_ACQUIRED, EventType.BUY, 'AAPL', 'Apple', quantity=2,
          unit_price=100.0, account='cto'),
    # An account with no cash ledger, so the fields it may not write stay NULL.
    Event(_ACQUIRED, EventType.GRANT, 'MSFT', 'Microsoft', quantity=4,
          unit_price=300.0, account='rsu'),
]
_ACCOUNTS = [Account('pea', 'PEA'), Account('cto', 'CTO'), Account('rsu', 'RSU')]
_SYMBOLS = ('AAPL', 'BTC-EUR', 'MSFT')
_BASE = {'AAPL': 100.0, 'BTC-EUR': 60000.0, 'MSFT': 300.0}


class _Clock:
    """The perf pass's clock, pinned — and movable, for the day turn."""

    day = _TODAY


def _pin(mocker):
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            d = _Clock.day
            return datetime(d.year, d.month, d.day, 12, 0, tzinfo=tz)
    _Clock.day = _TODAY
    mocker.patch("application.perf_job.datetime", _FixedDatetime)


def _seed(opened, declare_ledger, ledger=_LEDGER):
    declare_ledger(opened, ledger, _ACCOUNTS)
    held = [symbol for symbol in _SYMBOLS
            if any(e.symbol == symbol for e in ledger)]
    for symbol in held:
        opened.execute(
            'INSERT INTO symbol_quote (symbol, currency) VALUES (?, ?) '
            'ON CONFLICT (symbol) DO NOTHING', [symbol, 'EUR'])
    day = _ACQUIRED
    rows = []
    while day < _TODAY:
        drift = 1.0 + 0.001 * (day - _ACQUIRED).days
        for symbol in held:
            price = _BASE[symbol] * drift
            rows.append([symbol, datetime(day.year, day.month, day.day, 17,
                                          tzinfo=UTC), price, price, 1.0])
        day += timedelta(days=1)
    opened.executemany(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted,'
        '                         fx_rate) VALUES (?, ?, ?, ?, ?)', rows)
    quotes.forget_oldest_stored()


def _metrics(opened):
    metrics = workloads.Workloads(PerfConfigManager(opened))
    metrics.base_currency = 'EUR'
    return metrics


def _quote_today(opened, symbol, price, minute=0):
    """A live observation, written by the market writer itself."""
    quotes.record_quote(
        opened, symbol,
        datetime(_TODAY.year, _TODAY.month, _TODAY.day, 9, minute, tzinfo=UTC),
        price, attributes={'currency': 'EUR'}, price_converted=price,
        fx_rate=1.0)


def _pass(metrics) -> str:
    metrics.recompute_perf()
    record = metrics.recorder.perf()
    assert record.verdict == runtime_state.PERF_RAN, record.error
    return record.mode


def _series(opened):
    return (
        opened.query('SELECT * FROM account_metrics ORDER BY account, day'),
        opened.query('SELECT * FROM portfolio_totals ORDER BY day'),
    )


@pytest.fixture
def seeded(store, mocker, declare_ledger):
    _pin(mocker)
    _seed(store, declare_ledger)
    metrics = _metrics(store)
    _quote_today(store, 'BTC-EUR', 61000.0)
    assert _pass(metrics) == runtime_state.PERF_PASS_FULL
    return store, metrics


# ---------------------------------------------------------------------------
# Which pass runs
# ---------------------------------------------------------------------------

def test_a_quiet_tick_writes_nothing(seeded, mocker):
    opened, metrics = seeded
    write = mocker.spy(perf_series, 'write_account_metrics')

    assert _pass(metrics) == runtime_state.PERF_PASS_UNCHANGED
    assert write.call_count == 0


def test_a_quote_today_writes_only_todays_rows(seeded, mocker):
    """The rows written are today's, one per account reaching today, and the total's."""
    opened, metrics = seeded
    accounts = mocker.spy(perf_series, 'write_account_metrics')
    totals = mocker.spy(perf_series, 'write_portfolio_totals')
    prune = mocker.spy(perf_series, 'prune_account_metrics')

    _quote_today(opened, 'BTC-EUR', 62000.0, minute=2)

    assert _pass(metrics) == runtime_state.PERF_PASS_TODAY
    (_, written), = [c.args for c in accounts.call_args_list]
    assert sorted(p.account for p in written) == ['cto', 'pea', 'rsu']
    assert {p.day for p in written} == {_TODAY}
    (_, total), = [c.args for c in totals.call_args_list]
    assert [p.day for p in total] == [_TODAY]
    assert prune.call_count == 0


def test_todays_point_moves_with_todays_quote(seeded):
    opened, metrics = seeded
    before = opened.query(
        "SELECT holdings_value FROM account_metrics WHERE account = 'cto' "
        ' AND day = ?', [_TODAY])[0][0]

    _quote_today(opened, 'BTC-EUR', 62000.0, minute=2)
    _pass(metrics)

    after = opened.query(
        "SELECT holdings_value FROM account_metrics WHERE account = 'cto' "
        ' AND day = ?', [_TODAY])[0][0]
    assert after - before == pytest.approx(0.05 * 1000.0)


def test_the_replay_after_a_write_rebuilds_whole(seeded):
    opened, metrics = seeded
    _quote_today(opened, 'BTC-EUR', 62000.0, minute=2)

    metrics.recompute_perf(full=True)

    assert metrics.recorder.perf().mode == runtime_state.PERF_PASS_FULL


# ---------------------------------------------------------------------------
# Every other change rebuilds whole — one per writer
# ---------------------------------------------------------------------------

def _ledger_write(opened, metrics, declare_ledger):
    declare_ledger(opened, [Event(date(2024, 5, 3), EventType.DEPOSIT,
                                  amount=100.0, account='pea')], _ACCOUNTS)


def _account_write(opened, metrics, declare_ledger):
    opened.execute("UPDATE account SET label = 'Renamed' WHERE id = 'pea'")


def _history(opened, metrics, declare_ledger):
    quotes.record_history(opened, 'AAPL', [
        {'timestamp': datetime(2024, 6, 3, 17, tzinfo=UTC), 'price': 90.0,
         'converted': 90.0, 'rate': 1.0}])


def _repair(opened, metrics, declare_ledger):
    opened.execute(
        'UPDATE price_point SET price_converted = NULL, fx_rate = NULL '
        " WHERE symbol = 'MSFT' AND ts = ?",
        [datetime(2024, 6, 3, 17, tzinfo=UTC)])
    # At a rate other than the one the row first carried, so the repaired
    # point is a different point: a repair back to the same value moves nothing.
    quotes.repair_conversions(opened, 'MSFT', {date(2024, 6, 3): 1.1})


def _ladder(opened, metrics, declare_ledger):
    opened.execute(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted,'
        "                         fx_rate) VALUES ('AAPL', ?, 1, 1, 1)",
        [datetime(2020, 1, 1, 10, tzinfo=UTC)])
    quotes.collapse_to_ladder(opened, datetime(2024, 6, 20, 12, tzinfo=UTC))


def _forget(opened, metrics, declare_ledger):
    quotes.forget_symbol(opened, 'MSFT')


def _splits(opened, metrics, declare_ledger):
    quotes.record_splits(opened, 'AAPL', {date(2024, 6, 1): 2.0})


def _anchor(opened, metrics, declare_ledger):
    quotes.record_window_tried(opened, 'AAPL', date(2024, 1, 1))


def _currency(opened, metrics, declare_ledger):
    metrics.base_currency = 'USD'


def _day_turn(opened, metrics, declare_ledger):
    _Clock.day = _TODAY + timedelta(days=1)


def _restart(opened, metrics, declare_ledger):
    metrics._recompute.forget()


@pytest.mark.parametrize('change', [
    _ledger_write, _account_write, _history, _repair, _ladder, _forget,
    _splits, _anchor, _currency, _day_turn, _restart,
], ids=lambda change: change.__name__.lstrip('_'))
def test_every_other_change_rebuilds_whole(seeded, declare_ledger, change):
    opened, metrics = seeded
    # Today's quote moves too: the change must win over it.
    _quote_today(opened, 'BTC-EUR', 62000.0, minute=2)

    change(opened, metrics, declare_ledger)

    assert _pass(metrics) == runtime_state.PERF_PASS_FULL


def test_a_symbol_first_quoted_today_rebuilds_whole(
        store, mocker, declare_ledger):
    """The one day its horizon can move without the history behind today moving."""
    _pin(mocker)
    ledger = _LEDGER + [Event(_ACQUIRED, EventType.BUY, 'NEW', 'New', quantity=1,
                              unit_price=10.0, account='pea')]
    _seed(store, declare_ledger, ledger)
    metrics = _metrics(store)
    assert _pass(metrics) == runtime_state.PERF_PASS_FULL

    _quote_today(store, 'NEW', 11.0)
    assert _pass(metrics) == runtime_state.PERF_PASS_FULL
    _quote_today(store, 'NEW', 12.0, minute=2)
    assert _pass(metrics) == runtime_state.PERF_PASS_FULL


def test_a_base_currency_answered_again_rebuilds_whole(seeded):
    """No base currency writes nothing and forgets the pass; its return rebuilds."""
    opened, metrics = seeded
    metrics.base_currency = None
    metrics.recompute_perf()
    metrics.base_currency = 'EUR'
    assert _pass(metrics) == runtime_state.PERF_PASS_FULL


# ---------------------------------------------------------------------------
# Continued one day at a time == rebuilt whole, row for row
# ---------------------------------------------------------------------------

_quote_steps = st.lists(
    st.tuples(st.sampled_from(('AAPL', 'BTC-EUR')),
              st.floats(min_value=0.5, max_value=2.0, allow_nan=False)),
    min_size=1, max_size=8)


@settings(max_examples=25, deadline=None,
          suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(steps=_quote_steps, flow_today=st.booleans(),
       quoted_at_full=st.booleans(), with_grants=st.booleans())
def test_todays_point_continued_equals_a_full_rebuild(
        tmp_path_factory, mocker, declare_ledger, steps, flow_today,
        quoted_at_full, with_grants):
    _pin(mocker)
    opened = store_module.open_store(
        tmp_path_factory.mktemp('perf') / 'store.duckdb')
    try:
        # Without the grant-only account, every account keeps a cash ledger and
        # the total writes its own index: the chain the seed carries is read.
        ledger = [e for e in _LEDGER if with_grants or e.account != 'rsu']
        if flow_today:
            # A flow landing today: the index's own term for today, read from
            # the ledger rather than from the row before.
            ledger.append(Event(_TODAY, EventType.DEPOSIT, amount=250.0,
                                account='cto'))
        _seed(opened, declare_ledger, ledger)
        metrics = _metrics(opened)
        if quoted_at_full:
            _quote_today(opened, 'AAPL', 101.0)
        assert _pass(metrics) == runtime_state.PERF_PASS_FULL

        # A second pass over the same store, rebuilding whole every time: it
        # holds its own memory, so the first one keeps continuing its own.
        whole = _metrics(opened)

        modes = []
        for minute, (symbol, factor) in enumerate(steps, start=1):
            _quote_today(opened, symbol, _BASE[symbol] * factor, minute=minute)
            modes.append(_pass(metrics))
            continued = _series(opened)

            whole.recompute_perf(full=True)
            assert _series(opened) == continued
        assert set(modes) == {runtime_state.PERF_PASS_TODAY}
    finally:
        opened.close()
