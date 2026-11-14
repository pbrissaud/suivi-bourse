"""A stored day ends on the closing auction's print, not before it (issue #1399).

Yahoo's hourly bars stop before the closing auction: the last Paris bar of a day
is the 17:00 one, the continuous price before the fixing (SAN.PA on 20/10/2026:
73.44 by the hour, 73.58 as the day's close). Only the daily bar carries the
print. So the hourly fetch lays the daily close on the day's last bar, and the
backfill puts it once on every day the store already holds.
"""

from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

from application import entries
from application import market
from application import quotes
from application import store_reads
from application.jobs.backfill import BackfillJob

UTC = timezone.utc
PARIS = ZoneInfo('Europe/Paris')

TODAY = datetime.now(PARIS).date()
#: Two past sessions inside the hourly band, the SAN.PA days of the ticket.
FIRST = TODAY - timedelta(days=30)
SECOND = TODAY - timedelta(days=29)

HOURLY = {FIRST: (70.5, 70.98), SECOND: (72.0, 73.44), TODAY: (79.0, 79.5)}
DAILY = {FIRST: 71.01, SECOND: 73.58, TODAY: 80.0}


@pytest.fixture
def store(store):
    entries.declare_symbol(store, 'SAN.PA')
    return store


def _local(day, hour):
    return pd.Timestamp(datetime.combine(day, time(hour), tzinfo=PARIS))


class _Paris:
    """Answers each bar size the way Yahoo does, and remembers what it was asked."""

    def __init__(self, splits=None):
        self.asked = []
        self.info = {'currency': 'EUR'}
        self.splits = splits if splits is not None else pd.Series(dtype=float)

    def history(self, **kwargs):
        self.asked.append(kwargs['interval'])
        if kwargs['interval'] == '1d':
            index = [_local(day, 0) for day in DAILY]
            return pd.DataFrame({'Close': list(DAILY.values())},
                                index=pd.DatetimeIndex(index))
        index, closes = [], []
        for day, (morning, last) in HOURLY.items():
            index += [_local(day, 9), _local(day, 17)]
            closes += [morning, last]
        return pd.DataFrame({'Close': closes}, index=pd.DatetimeIndex(index))


def _fetch(mocker, ticker, end=None):
    mocker.patch.object(market.yf, 'Ticker', lambda symbol: ticker)
    start = datetime.combine(FIRST, time.min, tzinfo=UTC)
    prices, _ = market.price_history('SAN.PA', start,
                                     end or datetime.now(UTC), 0)
    return prices


def _last_of(prices, day):
    return [point for point in prices
            if point['timestamp'].astimezone(PARIS).date() == day][-1]


def test_the_hourly_fetch_ends_each_finished_day_on_its_official_close(mocker):
    ticker = _Paris()
    prices = _fetch(mocker, ticker)

    assert ticker.asked == ['1h', '1d']
    assert _last_of(prices, FIRST)['price'] == 71.01
    assert _last_of(prices, SECOND)['price'] == 73.58
    # At the bar's own instant: nothing is invented after it.
    assert _last_of(prices, SECOND)['timestamp'] == _local(SECOND, 17).to_pydatetime()
    # The morning is untouched, and so is a session still running.
    assert prices[0]['price'] == 70.5
    assert _last_of(prices, TODAY)['price'] == 79.5


def test_a_window_ending_mid_session_lays_no_close_on_a_midday_bar(mocker):
    """Seen on Yahoo: a window ending at noon on 20/10 got 73.58 on its 11:00 bar."""
    prices = _fetch(mocker, _Paris(), end=_local(SECOND, 12).to_pydatetime())

    assert _last_of(prices, FIRST)['price'] == 71.01
    # This fake serves the whole day anyway; the cut is what keeps it hourly.
    assert _last_of(prices, SECOND)['price'] == 73.44


def test_a_split_after_the_day_is_applied_once_to_the_official_close(mocker):
    splits = pd.Series([2.0], index=pd.DatetimeIndex([_local(TODAY, 0)]))
    prices = _fetch(mocker, _Paris(splits))

    assert _last_of(prices, SECOND)['price'] == 147.16


def test_the_stored_days_read_the_official_close(mocker, store):
    prices = _fetch(mocker, _Paris())
    for point in prices:
        point.update(converted=point['price'], rate=1.0)
    quotes.record_history(store, 'SAN.PA', prices)

    closes = {row['day']: row['price']
              for row in store_reads.PortfolioReader(store).daily_closes()}
    assert closes[FIRST] == 71.01
    assert closes[SECOND] == 73.58


# --------------------------------------------------------------------------- #
# The repair of what is already stored
# --------------------------------------------------------------------------- #

def _at(day, hour, minute=0):
    return datetime.combine(day, time(hour, minute), tzinfo=UTC)


def _point(at, price, rate=0.5):
    return {'timestamp': at, 'price': price, 'converted': price * rate,
            'rate': rate}


def _stored(store, at):
    return store.query(
        'SELECT price_native, price_converted, fx_rate FROM price_point '
        ' WHERE symbol = ? AND ts = ?', ['SAN.PA', at])[0]


def test_the_last_point_of_a_stored_day_takes_the_close_at_its_own_rate(store):
    quotes.record_history(store, 'SAN.PA', [
        _point(_at(SECOND, 15), 73.44),
        # A scrape from before #1352, after the last bar: the day's real last point.
        _point(_at(SECOND, 15, 29), 73.40),
    ])

    assert quotes.overlay_closes(store, 'SAN.PA', {SECOND: 73.58}) == 1

    assert _stored(store, _at(SECOND, 15, 29)) == (73.58, 73.58 * 0.5, 0.5)
    assert _stored(store, _at(SECOND, 15))[0] == 73.44
    closes = store_reads.PortfolioReader(store).daily_closes()
    assert [(row['day'], row['price']) for row in closes] == [(SECOND, 36.79)]
    # It was the symbol's newest point, so the quote follows it.
    assert store.query(
        'SELECT last_price_native FROM symbol_quote WHERE symbol = ?',
        ['SAN.PA'])[0][0] == 73.58


def test_a_same_currency_close_is_stored_exactly(store):
    days = [SECOND - timedelta(days=offset) for offset in range(20)]
    quotes.record_history(store, 'SAN.PA', [
        _point(_at(day, 15), 70.0 + index * 0.37, rate=1.0)
        for index, day in enumerate(days)])
    closes = {day: 71.01 + index * 0.13 for index, day in enumerate(days)}

    quotes.overlay_closes(store, 'SAN.PA', closes)

    for day, close in closes.items():
        assert _stored(store, _at(day, 15)) == (close, close, 1.0)


def test_a_day_already_on_its_close_is_not_rewritten(store):
    quotes.record_history(store, 'SAN.PA', [_point(_at(SECOND, 15, 35), 73.58)])

    assert quotes.overlay_closes(store, 'SAN.PA', {SECOND: 73.58}) == 0


def test_a_session_across_utc_midnight_closes_on_its_own_last_bar(store):
    """Sydney's 20/10 runs 23:00Z on the 19th to 05:00Z: its UTC day ends on 21/10's opening bar."""
    sydney = ZoneInfo('Australia/Sydney')
    entries.declare_symbol(store, 'BHP.AX')

    def bar(day, hour):
        return datetime.combine(day, time(hour), tzinfo=sydney).astimezone(UTC)

    day = date(2026, 10, 20)
    quotes.record_history(store, 'BHP.AX', [
        _point(bar(day, 10), 44.0), _point(bar(day, 15), 44.5),
        _point(bar(day + timedelta(days=1), 10), 45.0)])

    assert quotes.overlay_closes(store, 'BHP.AX', {day: 44.62}, sydney) == 1

    def stored(at):
        return store.query('SELECT price_native FROM price_point'
                           ' WHERE symbol = ? AND ts = ?', ['BHP.AX', at])[0][0]
    assert stored(bar(day, 15)) == 44.62
    assert stored(bar(day + timedelta(days=1), 10)) == 45.0


def _job(store, market_client):
    @contextmanager
    def writing():
        yield store

    ctx = SimpleNamespace(
        config_manager=SimpleNamespace(store=store, writing=writing),
        market=market_client, backfill_delay=0)
    return BackfillJob(ctx, {})


class _DailyCloses:
    def __init__(self):
        self.asked = []

    def price_history(self, symbol, start, end, delay=0.0, max_retries=3,
                      interval=None):
        self.asked.append((start, end, interval))
        return [{'timestamp': _at(SECOND, 12), 'price': 73.58}], {}

    def symbol_attributes(self, symbol):
        return {'exchangeTimezoneName': 'Europe/Paris'}


def test_the_backfill_repairs_a_symbol_once_per_process(store):
    quotes.record_history(store, 'SAN.PA', [_point(_at(SECOND, 15), 73.44)])
    client = _DailyCloses()
    job = _job(store, client)
    now = datetime.now(UTC)

    assert job.repair_closes('SAN.PA', now) == 1
    assert job.repair_closes('SAN.PA', now) == 0

    assert len(client.asked) == 1
    start, end, interval = client.asked[0]
    assert interval == '1d'
    assert end == datetime.combine(now.date(), time.min, tzinfo=UTC)
    assert _stored(store, _at(SECOND, 15))[0] == 73.58


def test_a_failed_fetch_is_retried_on_the_next_cycle(store):
    quotes.record_history(store, 'SAN.PA', [_point(_at(SECOND, 15), 73.44)])
    client = _DailyCloses()
    client.price_history = lambda *args, **kwargs: (
        client.asked.append(kwargs) or (None, None))
    job = _job(store, client)

    assert job.repair_closes('SAN.PA', datetime.now(UTC)) == 0
    assert job.repair_closes('SAN.PA', datetime.now(UTC)) == 0
    assert len(client.asked) == 2
