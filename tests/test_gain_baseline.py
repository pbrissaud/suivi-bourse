"""The four gain terms at the day a window opens (#1156).

The identity is the point: the four terms at B sum to ``gain_absolu(B)``, which
only a **real** perf pass can say, so the fixtures run it over a real store
(``tests/test_perf_job.py``'s seam) and read the row it wrote.
"""
from datetime import date, datetime, timezone

import pytest

from conftest import PerfConfigManager

from application import gain_baseline
from application import perf_series
from application import quotes
from application import workloads
from application.events.aggregator import EventAggregator
from application.events.schemas import Event, EventType, PortfolioTotalPoint

UTC = timezone.utc

_TODAY = date(2024, 6, 20)
_B = date(2023, 12, 31)


def _run_perf(opened, mocker):
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(_TODAY.year, _TODAY.month, _TODAY.day, 12, 0,
                            tzinfo=tz)
    mocker.patch('application.perf_job.datetime', _FixedDatetime)
    metrics = workloads.Workloads(PerfConfigManager(opened))
    metrics.base_currency = 'EUR'
    metrics.update_account_metrics()


def _price(opened, symbol, day, price):
    opened.execute(
        'INSERT INTO symbol_quote (symbol, currency) VALUES (?, ?) '
        'ON CONFLICT (symbol) DO NOTHING', [symbol, 'EUR'])
    opened.execute(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted,'
        '                         fx_rate) VALUES (?, ?, ?, ?, ?)',
        [symbol, datetime(day.year, day.month, day.day, 17, 0, tzinfo=UTC),
         price, price, 1.0])
    quotes.forget_oldest_stored()


def _gain(opened, day):
    rows = opened.query(
        'SELECT gain_absolu FROM portfolio_totals WHERE day = ?', [day])
    return rows[0][0]


def _sum(terms):
    return (terms['unrealised'] + terms['realised'] + terms['dividends']
            + terms['transfer_fees'])


#: Deposits with fees, buys, a partial sell, a dividend, a priced GRANT, and
#: events on both sides of B.
_LEDGER = [
    Event(date(2023, 3, 1), EventType.DEPOSIT, amount=10000.0, fee=5.0),
    Event(date(2023, 3, 2), EventType.BUY, 'AAPL', 'Apple', quantity=10,
          unit_price=100.0, fee=2.0),
    Event(date(2023, 3, 2), EventType.GRANT, 'MSFT', 'Microsoft', quantity=5,
          unit_price=50.0),
    Event(date(2023, 6, 1), EventType.SELL, 'AAPL', 'Apple', quantity=4,
          unit_price=120.0, fee=1.0),
    Event(date(2023, 9, 1), EventType.DIVIDEND, 'AAPL', 'Apple', amount=12.0),
    Event(date(2024, 2, 1), EventType.DEPOSIT, amount=1000.0, fee=3.0),
    Event(date(2024, 3, 1), EventType.BUY, 'AAPL', 'Apple', quantity=2,
          unit_price=130.0),
    Event(date(2024, 4, 1), EventType.SELL, 'MSFT', 'Microsoft', quantity=5,
          unit_price=60.0),
]

_CLOSES = {'AAPL': {date(2023, 3, 2): 100.0, date(2023, 12, 29): 110.0,
                    _TODAY: 140.0},
           'MSFT': {date(2023, 3, 2): 50.0, date(2023, 12, 29): 55.0,
                    _TODAY: 65.0}}


def _priced_ledger(opened, declare_ledger, mocker, events=_LEDGER):
    declare_ledger(opened, events)
    for symbol in {e.symbol for e in events if e.symbol}:
        for day, price in _CLOSES[symbol].items():
            _price(opened, symbol, day, price)
    _run_perf(opened, mocker)


def test_the_baseline_day_of_each_period():
    assert gain_baseline.baseline_day('ytd', date(2026, 10, 12)) \
        == date(2025, 12, 31)
    assert gain_baseline.baseline_day('12m', date(2026, 10, 12)) \
        == date(2025, 10, 11)
    # 29 February a year back is the 28th, and the day before that.
    assert gain_baseline.baseline_day('12m', date(2028, 2, 29)) \
        == date(2027, 2, 27)


def test_the_baseline_terms_sum_to_the_gain_at_b(store, declare_ledger, mocker):
    _priced_ledger(store, declare_ledger, mocker)

    measured = gain_baseline.measure(store, _LEDGER, 'ytd')

    assert measured['day'] == '2023-12-31'
    assert measured['since'] == '2024-01-01'
    assert measured['clamped'] is False
    terms = measured['terms']
    assert terms['holds_position'] is True
    assert terms['transfer_fees'] == pytest.approx(-5.0)
    assert _sum(terms) == pytest.approx(_gain(store, _B), abs=1e-6)


def test_the_window_terms_sum_to_the_gain_over_the_window(
        store, declare_ledger, mocker):
    """``now − base`` per term, with ``now`` the front's own four terms."""
    _priced_ledger(store, declare_ledger, mocker)
    base = gain_baseline.measure(store, _LEDGER, 'ytd')['terms']

    now = EventAggregator().replay(_LEDGER).current()
    unrealised = sum(p['quantity'] * _CLOSES[p['symbol']][_TODAY]
                     - p['cost_basis'] for p in now)
    window = ((unrealised - base['unrealised'])
              + sum(p['realized_gain'] for p in now) - base['realised']
              + sum(p['received_dividend'] for p in now) - base['dividends']
              + (-8.0 - base['transfer_fees']))

    assert window == pytest.approx(
        _gain(store, _TODAY) - _gain(store, _B), abs=1e-6)


def test_a_position_sold_out_in_the_window_still_holds_at_b(
        store, declare_ledger, mocker):
    sold = [e for e in _LEDGER if e.symbol != 'AAPL'
            and e.event_type != EventType.DIVIDEND]
    _priced_ledger(store, declare_ledger, mocker, sold)

    terms = gain_baseline.measure(store, sold, 'ytd')['terms']

    # MSFT is gone by today and was held at B: its latent gain at B is real.
    assert terms['holds_position'] is True
    assert terms['unrealised'] == pytest.approx(5 * 55.0 - 5 * 50.0)


def test_a_ledger_younger_than_the_window_is_clamped_to_inception(
        store, declare_ledger, mocker):
    young = [Event(date(2024, 3, 1), EventType.DEPOSIT, amount=1000.0),
             Event(date(2024, 3, 2), EventType.BUY, 'AAPL', 'Apple',
                   quantity=2, unit_price=100.0)]
    declare_ledger(store, young)
    _price(store, 'AAPL', date(2024, 3, 2), 100.0)
    _run_perf(store, mocker)

    measured = gain_baseline.measure(store, young, '12m')

    assert (measured['day'], measured['since'], measured['clamped']) \
        == (None, '2024-03-01', True)
    assert _sum(measured['terms']) == 0.0
    assert measured['terms']['holds_position'] is False


def _rows(opened, *days):
    perf_series.write_portfolio_totals(opened, [
        PortfolioTotalPoint(day=day, cash_balance=0.0, holdings_value=1500.0,
                            total_value=1500.0, net_contributed=1000.0,
                            gain_absolu=500.0)
        for day in days])


_SHORT = [Event(date(2023, 6, 1), EventType.BUY, 'AAPL', 'Apple', quantity=10,
                unit_price=100.0)]


def test_a_series_younger_than_the_ledger_is_clamped_to_its_first_day(
        store, declare_ledger):
    declare_ledger(store, _SHORT)
    _rows(store, date(2024, 2, 1), _TODAY)

    measured = gain_baseline.measure(store, _SHORT, 'ytd')

    assert (measured['day'], measured['since'], measured['clamped']) \
        == ('2024-02-01', '2024-02-02', True)
    assert measured['terms']['unrealised'] == pytest.approx(500.0)


def test_a_missing_row_at_b_reads_as_rebuilding(store, declare_ledger):
    declare_ledger(store, _SHORT)
    _rows(store, date(2023, 6, 1), _TODAY)

    terms = gain_baseline.measure(store, _SHORT, 'ytd')['terms']

    assert terms['unrealised'] is None
    assert terms['unrealised_unknown'] == 'rebuilding'


def test_no_series_at_all_reads_as_rebuilding(store, declare_ledger):
    declare_ledger(store, _SHORT)

    measured = gain_baseline.measure(store, _SHORT, 'ytd')

    assert (measured['day'], measured['since'], measured['clamped']) \
        == (None, None, False)
    assert measured['terms']['unrealised_unknown'] == 'rebuilding'


def test_a_carried_symbol_and_an_undeclared_account(
        store, declare_ledger, mocker):
    """The carried symbol is valued at cost at B, and an account the perf job
    never values is left out of the cost basis too."""
    ledger = [
        Event(date(2023, 3, 1), EventType.DEPOSIT, amount=5000.0, fee=2.0),
        Event(date(2023, 3, 2), EventType.BUY, 'AAPL', 'Apple', quantity=10,
              unit_price=100.0),
        Event(date(2023, 3, 2), EventType.BUY, 'OLD', 'Delisted', quantity=4,
              unit_price=25.0),
    ]
    declare_ledger(store, ledger)
    _price(store, 'AAPL', date(2023, 3, 2), 100.0)
    _price(store, 'AAPL', date(2023, 12, 29), 120.0)
    # Tried back to its acquisition and first quoted in 2024: terminal, so
    # carried at its unit cost on B.
    quotes.record_window_tried(store, 'OLD', date(2023, 3, 2))
    _price(store, 'OLD', date(2024, 5, 1), 30.0)
    _run_perf(store, mocker)
    ghost = Event(date(2023, 4, 1), EventType.BUY, 'AAPL', 'Apple',
                  quantity=3, unit_price=90.0, account='ghost')

    terms = gain_baseline.measure(store, ledger + [ghost], 'ytd')['terms']

    assert _sum(terms) == pytest.approx(_gain(store, _B), abs=1e-6)
    assert terms['unrealised'] == pytest.approx(10 * 20.0)
