"""The close a dividend was already paid out of, and paid into cash too (#1008).

yfinance defaults ``auto_adjust`` to ``True``, which serves ``Adj Close`` under
the name ``Close`` — the close **net of every dividend paid since**. The store
already holds each of those dividends as a ``DIVIDEND`` event crediting cash, so
carrying it in the price as well counts it twice: the whole past is valued short
by the compounded stream, the portfolio appears to have grown from lower than it
did, and every return read off that curve is overstated.

Silent, and ordered by yield — a custodian's statement of four French lines put
a PEA at 3 402 € against its own 4 205 €, on a day with no event of any kind.

Sibling of #987/#988, which is the *other* adjustment: that one is applied by
Yahoo's chart endpoint and undone in :func:`market_info.as_printed`, this one is
applied by yfinance itself and is turned off at the call.
"""

from datetime import date, datetime, timedelta, timezone

import pandas as pd
import pytest

from application import market
from application import store as store_module

UTC = timezone.utc


class _Ticker:
    """A ticker that adjusts its closes the way yfinance does.

    ``auto_adjust=True`` — the default, and the defect — replaces ``Close`` with
    ``Adj Close``. The factor stands in for a dividend stream: a line yielding
    its way to a 24 % gap over the window is served at 0,756 of what it printed.
    """

    def __init__(self, closes, adjustment, splits=()):
        self.closes = closes
        self.adjustment = adjustment
        self._splits = dict(splits)
        self.info = {'currency': 'EUR'}

    def history(self, auto_adjust=True, **kwargs):
        factor = self.adjustment if auto_adjust else 1.0
        index = pd.to_datetime([day for day, _ in self.closes], utc=True)
        return pd.DataFrame({'Close': [price * factor
                                       for _, price in self.closes]},
                            index=index)

    @property
    def splits(self):
        if not self._splits:
            return pd.Series(dtype=float)
        return pd.Series(list(self._splits.values()),
                         index=pd.to_datetime(list(self._splits), utc=True))


@pytest.fixture
def served(mocker):
    """Hand the market edge a ticker that adjusts, and say by how much."""
    def _serve(closes, adjustment, splits=()):
        mocker.patch.object(
            market.yf, 'Ticker',
            lambda symbol: _Ticker(closes, adjustment, splits))
    return _serve


# --------------------------------------------------------------------------- #
# The edge
# --------------------------------------------------------------------------- #

def test_the_backfill_stores_the_close_the_market_printed(served):
    """The defect end to end, on the window the backward pass buys.

    49,58 is what FDJ printed on 2021-06-30 and what the custodian's statement
    states to the cent; 37,49 is the same day net of four years of dividends the
    ledger is *also* crediting to cash. The ledger's quantity belongs beside the
    first one.
    """
    served([('2021-06-30', 49.58)], 0.756)
    now = datetime.now(UTC)

    prices, _ = market.price_history('FDJU.PA', now - timedelta(days=30), now, 0)

    assert prices[0]['price'] == pytest.approx(49.58)


def test_the_live_quote_is_the_close_the_market_printed(served):
    """Same keyword on the live fetch, and here it is a guard, not a repair.

    The adjustment factor is anchored on the newest bar, so the one this reads
    comes back the same either way and the stored live price was never short.
    Pinned all the same: the two edges have to read the same column, or the
    stored history and the price drawn at the end of it drift apart the day
    that invariant stops holding — and nothing would say so.
    """
    served([('2026-09-18', 100.0), ('2026-09-21', 101.0)], 0.9)

    price, _ = market.latest_quote('FDJU.PA')

    assert price == pytest.approx(101.0)


# --------------------------------------------------------------------------- #
# The series already in the wild
# --------------------------------------------------------------------------- #

def test_a_store_carrying_an_adjusted_series_gives_it_up_and_asks_again(
        tmp_path):
    """Mixed the way #987's was: a point written on the day was never adjusted.

    One backfilled after an ex-date was, and the row says nothing about which it
    is. There is no factor to apply, so the series goes — and the anchors go with
    it, or the backward pass resumes from the oldest point it can still see and
    never buys back what it already has.
    """
    path = tmp_path / 'adjusted.duckdb'
    opened = store_module.open_store(path)
    try:
        opened.execute("INSERT INTO symbol (symbol) VALUES ('FDJU.PA')")
        opened.execute(
            "INSERT INTO symbol_quote (symbol, last_price_native, "
            "oldest_window_tried, newest_window_tried) "
            "VALUES ('FDJU.PA', 34.0, DATE '2019-11-21', DATE '2026-09-17')")
        opened.execute(
            "INSERT INTO price_point (symbol, ts, price_native) "
            "VALUES ('FDJU.PA', TIMESTAMPTZ '2021-06-30 00:00:00+00', 37.49)")
        opened.execute(
            "INSERT INTO account_metrics (account, day, total_value) "
            "VALUES ('default', DATE '2021-06-30', 3402.0)")
        opened.execute(
            "INSERT INTO portfolio_totals (day, total_value) "
            "VALUES (DATE '2021-06-30', 3402.0)")
        # The ratios stay: a share count is not something a dividend moves.
        opened.execute(
            "INSERT INTO symbol_split (symbol, day, ratio) "
            "VALUES ('FDJU.PA', DATE '2024-03-22', 0.001)")
        # The mark this release adds, lifted: the store now reads as one written
        # before the step existed, which is the only shape it ever runs on.
        opened.execute("DELETE FROM schema_step "
                       "WHERE step = 'drop_dividend_adjusted_prices'")
    finally:
        opened.close()

    brought = store_module.open_store(path)
    try:
        assert brought.query(
            'SELECT (SELECT count(*) FROM price_point), '
            '       (SELECT count(*) FROM account_metrics), '
            '       (SELECT count(*) FROM portfolio_totals), '
            '       (SELECT count(*) FROM symbol_split)') == [(0, 0, 0, 1)]
        assert brought.query(
            'SELECT oldest_window_tried, newest_window_tried, '
            '       last_price_native FROM symbol_quote') == [
            (None, None, 34.0)]
    finally:
        brought.close()


def test_a_store_already_brought_forward_keeps_the_series_it_bought_back(
        tmp_path):
    """The step runs once. A second boot must not throw the rebuild away.

    Written because the step is destructive and its mark is the only thing
    standing between it and every cycle: it deletes on a store that needs it and
    it is never invited back.
    """
    path = tmp_path / 'brought.duckdb'
    opened = store_module.open_store(path)
    try:
        opened.execute("INSERT INTO symbol (symbol) VALUES ('FDJU.PA')")
        opened.execute("INSERT INTO symbol_quote (symbol) VALUES ('FDJU.PA')")
        opened.execute(
            "INSERT INTO price_point (symbol, ts, price_native) "
            "VALUES ('FDJU.PA', TIMESTAMPTZ '2021-06-30 00:00:00+00', 49.58)")
    finally:
        opened.close()

    again = store_module.open_store(path)
    try:
        assert again.query('SELECT price_native FROM price_point') == [(49.58,)]
    finally:
        again.close()


def test_the_step_is_recorded_under_its_own_name(tmp_path):
    """A name is an identity forever, and this one is not #987's.

    The two steps do the same thing for two different adjustments, so a store
    that ran the first must still run the second — which only holds while they
    are two rows and not one.
    """
    opened = store_module.open_store(tmp_path / 'fresh.duckdb')
    try:
        steps = {row[0] for row in
                 opened.query('SELECT step FROM schema_step')}
    finally:
        opened.close()

    assert {'drop_split_adjusted_prices',
            'drop_dividend_adjusted_prices'} <= steps


def test_the_two_adjustments_are_undone_in_two_different_places(served):
    """Both corrections apply to the same close, and neither covers the other.

    The dividend half is turned off at the call; the split half is applied by
    Yahoo's chart endpoint, which no flag reaches, and is undone afterwards by
    :func:`market_info.as_printed`. A fix that took one for the other would
    leave the close wrong by the factor it dropped.
    """
    served([('2021-06-30', 2000.0)], 0.9, {date(2024, 3, 22): 0.001})
    now = datetime.now(UTC)

    prices, splits = market.price_history(
        'FDJU.PA', now - timedelta(days=30), now, 0)

    assert prices[0]['price'] == pytest.approx(2.0)
    assert splits == {date(2024, 3, 22): 0.001}
