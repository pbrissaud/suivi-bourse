"""The perf pass's seeded store and the writers that move it (#1257, #1256).

Shared by ``test_perf_today_only`` (which pass runs) and ``test_perf_closes_cache``
(what the full pass reads): one small ledger over three accounts, a daily close
per symbol up to the pinned day, and one helper per kind of change a pass can
meet — each writer of the price history among them.
"""
from datetime import date, datetime, timedelta, timezone

from conftest import PerfConfigManager

from application import quotes
from application import runtime_state
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
