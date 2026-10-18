"""The currency of a file's amounts, asked about before the write (#1261).

A real store under the lookups and a faked Yahoo: ``market.symbol_attributes``
is the one edge patched, and the rates are an ``fx.Rates`` built on fetchers
that answer from a literal.
"""
import threading
import time
from datetime import date, datetime, timedelta, timezone

import pytest

from application import fx
from application import import_currency
from application import market
from application import quotes
from application.events.schemas import Event, EventType


def _buy(symbol, day=date(2024, 1, 15), unit_price=100.0, fee=2.0, amount=None,
         event_type=EventType.BUY):
    return Event(date=day, event_type=event_type, symbol=symbol, quantity=10.0,
                 unit_price=unit_price, fee=fee, amount=amount)


def _quote(store, symbol, currency):
    store.execute('INSERT INTO symbol (symbol) VALUES (?) '
                  'ON CONFLICT (symbol) DO NOTHING', [symbol])
    quotes.record_quote(store, symbol, datetime(2024, 6, 3, tzinfo=timezone.utc),
                        100.0, attributes={'currency': currency})


def _yahoo(monkeypatch, answers):
    """``market.symbol_attributes`` answering from ``answers``; returns its calls."""
    calls = []

    def asked(symbol):
        calls.append(symbol)
        currency = answers.get(symbol)
        return None if currency is None else {'currency': currency}

    monkeypatch.setattr(market, 'symbol_attributes', asked)
    return calls


def _rates(per_day, calls=None):
    """``fx.Rates`` over a literal: ``{currency: rate}`` on every trading day.

    Shaped like Yahoo: weekdays only, ``end`` exclusive, nothing when
    ``start >= end``.
    """
    def series(pair, start, end):
        if calls is not None:
            calls.append(pair)
        rate = per_day.get(pair[:3])
        if rate is None:
            return {}
        days = (start + timedelta(days=i) for i in range((end - start).days))
        return {day: rate for day in days if day.weekday() < 5}
    return fx.Rates(lambda pair: None, series)


def test_a_symbol_quoted_in_the_base_currency_is_not_foreign(store, monkeypatch):
    _yahoo(monkeypatch, {'MC.PA': 'EUR'})

    found = import_currency.survey(store, [_buy('MC.PA')], 'EUR')

    assert found.lines == () and found.unverified == ()


def test_a_stored_quote_currency_is_read_before_any_lookup(store, monkeypatch):
    _quote(store, 'AAPL', 'USD')
    calls = _yahoo(monkeypatch, {})

    found = import_currency.survey(store, [_buy('AAPL')], 'EUR')

    assert found.lines == (import_currency.ForeignLine('AAPL', 'USD', 1),)
    assert calls == []


def test_an_unknown_symbol_is_looked_up_once_and_cached(store, monkeypatch):
    calls = _yahoo(monkeypatch, {'AAPL': 'USD'})

    first = import_currency.survey(store, [_buy('AAPL')], 'EUR')
    second = import_currency.survey(store, [_buy('AAPL')], 'EUR')

    assert first.pairs == second.pairs == {'AAPL': 'USD'}
    assert calls == ['AAPL']
    assert store.query('SELECT count(*) FROM symbol_quote') == [(0,)]


def test_a_failed_lookup_is_unverified_and_not_cached(store, monkeypatch):
    answers = {}
    calls = _yahoo(monkeypatch, answers)

    first = import_currency.survey(store, [_buy('XYZ')], 'EUR')
    answers['XYZ'] = 'USD'
    second = import_currency.survey(store, [_buy('XYZ')], 'EUR')

    assert first.lines == () and first.unverified == ('XYZ',)
    assert second.pairs == {'XYZ': 'USD'} and second.unverified == ()
    assert calls == ['XYZ', 'XYZ']


def test_a_lookup_past_the_timeout_is_unverified_without_blocking(
        store, monkeypatch):
    release = threading.Event()

    def slow(symbol):
        release.wait(10)
        return {'currency': 'USD'}

    monkeypatch.setattr(market, 'symbol_attributes', slow)
    monkeypatch.setattr(import_currency, 'LOOKUP_TIMEOUT_S', 0.2)
    try:
        started = time.monotonic()
        found = import_currency.survey(store, [_buy('AAPL')], 'EUR')
        elapsed = time.monotonic() - started

        assert found.unverified == ('AAPL',) and found.lines == ()
        assert elapsed < 3
    finally:
        release.set()

    # A lookup that lands late fills the cache: the next forecast lists it.
    deadline = time.monotonic() + 5
    while 'AAPL' not in import_currency._LOOKED_UP and time.monotonic() < deadline:
        time.sleep(0.01)
    assert import_currency.survey(store, [_buy('AAPL')], 'EUR').pairs == {
        'AAPL': 'USD'}


def test_pence_fold_into_pounds(store, monkeypatch):
    _quote(store, 'VOD.L', 'GBp')

    in_euro = import_currency.survey(store, [_buy('VOD.L')], 'EUR')
    in_pound = import_currency.survey(store, [_buy('VOD.L')], 'GBP')

    assert in_euro.pairs == {'VOD.L': 'GBP'}
    assert in_pound.lines == ()


def test_a_line_without_money_is_not_foreign(store, monkeypatch):
    _quote(store, 'AAPL', 'USD')
    free = _buy('AAPL', unit_price=None, fee=None, event_type=EventType.GRANT)
    cash = Event(date=date(2024, 1, 2), event_type=EventType.DEPOSIT,
                 amount=500.0)

    found = import_currency.survey(store, [free, cash], 'EUR')

    assert found.lines == () and found.unverified == ()


def test_conversion_scales_price_fee_and_amount_not_quantity():
    event = _buy('AAPL', unit_price=100.0, fee=2.0, amount=1000.0)

    (done,) = import_currency.convert(
        [event], {'AAPL': 'USD'}, _rates({'USD': 0.5}), 'EUR')

    assert (done.unit_price, done.fee, done.amount) == (50.0, 1.0, 500.0)
    assert done.quantity == 10.0


def test_conversion_leaves_other_securities_and_empty_fields_alone():
    foreign = _buy('AAPL', fee=None)
    home = _buy('MC.PA')

    done = import_currency.convert(
        [foreign, home], {'AAPL': 'USD'}, _rates({'USD': 0.5}), 'EUR')

    assert done[0].fee is None and done[0].unit_price == 50.0
    assert done[1] == home


def test_conversion_rounds_to_the_round_trip_precision():
    event = _buy('AAPL', unit_price=0.1, fee=None)

    (done,) = import_currency.convert(
        [event], {'AAPL': 'USD'}, _rates({'USD': 3.0}), 'EUR')

    assert done.unit_price == float('%.16g' % (0.1 * 3.0))
    assert repr(done.unit_price) == '0.3'


def test_conversion_fetches_one_series_per_currency():
    fetched = []
    rows = [_buy('AAPL', date(2024, 1, 15)), _buy('AAPL', date(2024, 3, 4)),
            _buy('TSLA', date(2024, 2, 1)), _buy('VOD.L', date(2024, 2, 9))]

    import_currency.convert(
        rows, {'AAPL': 'USD', 'TSLA': 'USD', 'VOD.L': 'GBP'},
        _rates({'USD': 0.9, 'GBP': 1.2}, fetched), 'EUR')

    assert sorted(fetched) == ['GBPEUR=X', 'USDEUR=X']


def test_a_missing_rate_refuses_naming_symbol_and_day():
    rows = [_buy('TSLA', date(2024, 3, 4)), _buy('AAPL', date(2024, 1, 15))]

    with pytest.raises(import_currency.Unconvertible) as refused:
        import_currency.convert(
            rows, {'AAPL': 'USD', 'TSLA': 'USD'}, _rates({}), 'EUR')

    assert (refused.value.symbol, refused.value.currency, refused.value.base,
            refused.value.day) == ('AAPL', 'USD', 'EUR', date(2024, 1, 15))


def test_a_one_day_file_and_a_weekend_start_find_their_rate():
    saturday = date(2026, 3, 7)
    rows = [_buy('AAPL', saturday), _buy('AAPL', saturday)]

    (first, _) = import_currency.convert(
        rows, {'AAPL': 'USD'}, _rates({'USD': 0.5}), 'EUR')

    assert first.unit_price == 50.0


def test_the_last_day_is_priced_at_its_own_close():
    closes = {date(2026, 3, 12): 1.12, date(2026, 3, 13): 1.13}
    rates = fx.Rates(lambda pair: None, lambda pair, start, end: {
        day: rate for day, rate in closes.items() if start <= day < end})
    rows = [_buy('AAPL', date(2026, 3, 12)), _buy('AAPL', date(2026, 3, 13))]

    done = import_currency.convert(rows, {'AAPL': 'USD'}, rates, 'EUR')

    assert [event.unit_price for event in done] == [112.0, 113.0]


def test_the_whole_preview_waits_for_lookups_no_longer_than_its_budget(
        store, monkeypatch):
    release = threading.Event()
    asked = []

    def slow(symbol):
        asked.append(symbol)
        release.wait(10)
        return {'currency': 'USD'}

    monkeypatch.setattr(market, 'symbol_attributes', slow)
    monkeypatch.setattr(import_currency, 'LOOKUP_TIMEOUT_S', 1.0)
    monkeypatch.setattr(import_currency, 'LOOKUP_BUDGET_S', 0.5)
    symbols = [f'S{i}' for i in range(12)]
    try:
        started = time.monotonic()
        found = import_currency.survey(
            store, [_buy(symbol) for symbol in symbols], 'EUR')

        # Three batches of four would be 3 s here; the budget is what bounds it.
        assert time.monotonic() - started < 2
        assert found.unverified == tuple(sorted(symbols))
    finally:
        release.set()

    # The lookups still queued were cancelled, not started late.
    time.sleep(0.3)
    assert len(asked) <= 4
