"""The share a price is quoted in, and the quantity it is multiplied by (#987).

Yahoo serves closes adjusted to **today's** share; the ledger holds the quantity
**as traded on the day**. Nothing in either number says so, which is why the
defect is silent: the valuation multiplies the two and produces a phantom, the
TWR index walks the phantom, and the XIRR — computed from cash flows and the
terminal value — goes on saying the opposite on the same card.

Two shapes, and both are ordinary. A free-share attribution of one share per ten
is recorded by Yahoo as a `1.1` split, so a line merely held accumulates the
error every couple of years; a reverse split moves it by three orders of
magnitude in a day.
"""

from datetime import date, datetime, timedelta, timezone

import pandas as pd
import pytest

from application import instants
from application import market
from application import market_info
from application import store as store_module

UTC = timezone.utc


def _point(day: str, price: float) -> dict:
    """One fetched close, in the shape :func:`market.price_history` builds."""
    return {'timestamp': instants.utc(datetime.fromisoformat(day)),
            'price': price}


# --------------------------------------------------------------------------- #
# The arithmetic, on its own
# --------------------------------------------------------------------------- #

def test_a_close_is_multiplied_back_by_every_split_that_came_after_it():
    """Three attributions between that close and today, and they compound.

    Yahoo divides each one out of every earlier close, so what it serves for the
    day is the price in **today's** share: 100 € where the market printed
    133,10 €. Ten shares are worth 1 331 € and not 1 000 €, and the gap widens
    with every attribution the line lives through.
    """
    prices = [_point('2020-09-28', 100.0)]

    market_info.as_printed(prices, {date(2022, 6, 6): 1.1,
                                    date(2024, 6, 10): 1.1,
                                    date(2026, 6, 8): 1.1})

    assert prices[0]['price'] == pytest.approx(133.1)


def test_the_close_of_the_split_day_itself_is_already_in_the_new_share():
    """The comparison is strict, and a reverse split is where it shows.

    A 1-for-1000 takes the printed close from about a cent to about ten euros.
    Yahoo serves the eve adjusted and the day itself untouched — multiplying the
    day back would put the position at a thousand times its value on the one day
    the app has no excuse to get wrong.
    """
    prices = [_point('2024-03-21', 10.0), _point('2024-03-22', 12.0)]

    market_info.as_printed(prices, {date(2024, 3, 22): 0.001})

    assert prices[0]['price'] == pytest.approx(0.01)
    assert prices[1]['price'] == 12.0


# --------------------------------------------------------------------------- #
# The edge that reads them
# --------------------------------------------------------------------------- #

class _Ticker:
    """A ticker that answers a window of closes, and says what it split by."""

    def __init__(self, closes, splits):
        self.closes = closes
        self._splits = splits

    def history(self, **kwargs):
        index = pd.to_datetime([day for day, _ in self.closes], utc=True)
        return pd.DataFrame({'Close': [price for _, price in self.closes]},
                            index=index)

    @property
    def splits(self):
        if isinstance(self._splits, Exception):
            raise self._splits
        return pd.Series(
            list(self._splits.values()),
            index=pd.to_datetime(list(self._splits), utc=True))


def _fetch(mocker, closes, splits):
    """One backward-pass chunk, fetched through the real market edge."""
    mocker.patch.object(market.yf, 'Ticker',
                        lambda symbol: _Ticker(closes, splits))
    now = datetime.now(UTC)
    return market.price_history('AAPL', now - timedelta(days=30), now, 0)


def test_the_fetch_returns_what_the_market_printed(mocker):
    """The defect end to end: the price a stored quantity belongs beside.

    A line held across a 1-for-1000 reverse split was valued at a thousand times
    its worth for the whole of its pre-split history, and the account index
    walked that as a day of several hundred per cent with no contribution behind
    it.
    """
    prices = _fetch(mocker, [('2022-01-31', 2000.0)], {'2024-03-22': 0.001})

    assert prices[0]['price'] == pytest.approx(2.0)


def test_a_window_whose_splits_cannot_be_read_is_not_written(mocker):
    """The absence is not an empty answer.

    A chunk written without the splits is written in the wrong share, and the
    backward pass never asks twice for a window it has filled — so the mistake
    would be permanent and invisible. Failing the fetch costs one cycle.
    """
    assert _fetch(mocker, [('2022-01-31', 2000.0)],
                  RuntimeError('Yahoo said no')) is None


# --------------------------------------------------------------------------- #
# The series already in the wild
# --------------------------------------------------------------------------- #

def test_a_store_carrying_an_adjusted_series_gives_it_up_and_asks_again(
        tmp_path):
    """What the step is for: a series that cannot be corrected, only re-bought.

    A point written on the day it happened stands in that day's share; one
    backfilled after a split does not. The row says nothing about which it is, so
    there is no factor to apply — the series goes, and the anchors go with it so
    the three passes really do buy it back rather than resume past it.
    """
    path = tmp_path / 'adjusted.duckdb'
    opened = store_module.open_store(path)
    try:
        opened.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")
        opened.execute(
            "INSERT INTO symbol_quote (symbol, last_price_native, "
            "oldest_window_tried, newest_window_tried) "
            "VALUES ('AAPL', 187.0, DATE '2020-09-28', DATE '2026-09-17')")
        opened.execute(
            "INSERT INTO price_point (symbol, ts, price_native) "
            "VALUES ('AAPL', TIMESTAMPTZ '2020-09-28 00:00:00+00', 100.0)")
        # The two series computed from it, which are exactly as wrong and are
        # read straight from the store by every page until a perf cycle lands.
        opened.execute(
            "INSERT INTO account_metrics (account, day, total_value) "
            "VALUES ('default', DATE '2020-09-28', 1000.0)")
        opened.execute(
            "INSERT INTO portfolio_totals (day, total_value) "
            "VALUES (DATE '2020-09-28', 1000.0)")
        # The mark this release adds, lifted: the store now reads as one written
        # before the step existed, which is the only shape it ever runs on.
        opened.execute("DELETE FROM schema_step "
                       "WHERE step = 'drop_split_adjusted_prices'")
    finally:
        opened.close()

    brought = store_module.open_store(path)
    try:
        assert brought.query(
            'SELECT (SELECT count(*) FROM price_point), '
            '       (SELECT count(*) FROM account_metrics), '
            '       (SELECT count(*) FROM portfolio_totals)') == [(0, 0, 0)]
        assert brought.query(
            'SELECT oldest_window_tried, newest_window_tried, '
            '       last_price_native FROM symbol_quote') == [
            (None, None, 187.0)]
    finally:
        brought.close()
