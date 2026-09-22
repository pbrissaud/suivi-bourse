"""A bar belongs to the day the *exchange* traded it (issue #1013).

yfinance stamps a daily bar at midnight in the venue's own timezone. Paris
midnight is 22:00Z the day before, and every reader of ``ts`` buckets in UTC —
``time_bucket`` for the chart, ``CAST(ts AS DATE)`` for the ladder and the
conversion repair — so a Euronext close was served under the day before the one
it printed on. Exact to the cent and invisible: FDJ's 49,27 of 01/07/2021 sat
under 30/06, where the custodian's statement says 49,58.

Mixed by venue, which is why it never read as an offset: a US bar's local
midnight is 04:00–05:00Z and lands on the right UTC day either way.

Sibling of #987/#1008 in shape only — those were the *price*, this is the
*date* it is filed under.
"""

from datetime import datetime, timedelta, timezone

import pandas as pd
import pytest

from application import market
from application import quotes
from application import store as store_module
from application import store_reads

UTC = timezone.utc

#: Deeper than Yahoo's hourly ceiling, which is what makes the fetch ask for
#: **daily** bars — the only ones stamped at the venue's midnight, and the only
#: ones this ticket is about.
DEEP_PAST_DAYS = 1_600


class _Euronext:
    """A ticker answering the way Paris does: one bar a day, at local midnight."""

    def __init__(self, closes):
        self.closes = closes
        self.info = {'currency': 'EUR'}
        self.splits = pd.Series(dtype=float)

    def history(self, **kwargs):
        index = pd.to_datetime(
            [day for day, _ in self.closes]).tz_localize('Europe/Paris')
        return pd.DataFrame({'Close': [price for _, price in self.closes]},
                            index=index)


@pytest.fixture
def paris(mocker):
    """Hand the market edge a Euronext ticker and say what it printed."""
    def _serve(closes):
        mocker.patch.object(market.yf, 'Ticker',
                            lambda symbol: _Euronext(closes))
    return _serve


def _deep_window():
    """A window old enough that the fetch asks Yahoo for daily bars."""
    now = datetime.now(UTC)
    return now - timedelta(days=DEEP_PAST_DAYS), now - timedelta(
        days=DEEP_PAST_DAYS - 30)


# --------------------------------------------------------------------------- #
# The edge
# --------------------------------------------------------------------------- #

def test_a_paris_close_is_stamped_on_the_day_paris_printed_it(paris):
    """The two closes of the report, each under its own date.

    Noon rather than midnight: the instant has to survive being read as a UTC
    date, and noon is twelve hours from either edge, so UTC−11 through UTC+12
    all land on the trading day.
    """
    paris([('2021-06-30', 49.58), ('2021-07-01', 49.27)])
    start, end = _deep_window()

    prices, _ = market.price_history('FDJU.PA', start, end, 0)

    assert [(point['timestamp'], point['price']) for point in prices] == [
        (datetime(2021, 6, 30, 12, tzinfo=UTC), 49.58),
        (datetime(2021, 7, 1, 12, tzinfo=UTC), 49.27)]


def test_an_intraday_bar_keeps_the_instant_it_came_with(paris):
    """Only a *daily* bar is a date. An hourly one is an instant and stays one.

    Anchoring those at noon too would collapse a whole session onto one point —
    and they were never wrong: 15:30 in Paris is 13:30Z, the same UTC day.
    """
    paris([('2026-09-21 15:30', 49.58), ('2026-09-21 16:30', 49.27)])
    now = datetime.now(UTC)

    prices, _ = market.price_history('FDJU.PA', now - timedelta(days=5), now, 0)

    assert [point['timestamp'] for point in prices] == [
        datetime(2026, 9, 21, 13, 30, tzinfo=UTC),
        datetime(2026, 9, 21, 14, 30, tzinfo=UTC)]


def test_a_pair_s_rate_is_filed_under_the_date_the_pair_carries(mocker):
    """The same shift, on the rate every backfilled close is converted at.

    London midnight in summer is 23:00Z the day before, so a rate moved to UTC
    before its date was read landed a day early — and, through
    ``repair_conversions``, so did every price converted at it.
    """
    index = pd.to_datetime(['2021-06-30', '2021-07-01']).tz_localize(
        'Europe/London')
    frame = pd.DataFrame({'Close': [0.8593, 0.8571]}, index=index)
    mocker.patch.object(market.yf, 'Ticker',
                        lambda pair: type('T', (), {
                            'history': lambda self, **kwargs: frame})())

    series = market.pair_series('USDEUR=X', index[0].date(), index[-1].date())

    assert series == {index[0].date(): pytest.approx(0.8593),
                      index[1].date(): pytest.approx(0.8571)}


# --------------------------------------------------------------------------- #
# End to end, through the bucket that did the filing
# --------------------------------------------------------------------------- #

def test_the_series_the_page_reads_gives_each_day_its_own_close(store, paris):
    """The claim itself: a point labelled 30/06 carries the close of 30/06.

    Asserted through ``chart_series`` rather than on the instant, because
    ``time_bucket`` is the other half of the defect — the stamp was only wrong
    in that it was about to be bucketed in UTC.
    """
    paris([('2021-06-30', 49.58), ('2021-07-01', 49.27)])
    start, end = _deep_window()

    prices, _ = market.price_history('FDJU.PA', start, end, 0)
    for point in prices:
        point['converted'] = point['price']
    store.execute("INSERT INTO symbol (symbol) VALUES ('FDJU.PA')")
    quotes.record_history(store, 'FDJU.PA', prices)

    served = store_reads.PortfolioReader(store).chart_series(
        'FDJU.PA', interval='1 day')

    assert [(point['ts'].date(), point['price']) for point in served] == [
        (datetime(2021, 6, 30).date(), pytest.approx(49.58)),
        (datetime(2021, 7, 1).date(), pytest.approx(49.27))]


# --------------------------------------------------------------------------- #
# The series already in the wild
# --------------------------------------------------------------------------- #

def test_a_store_gives_up_the_daily_bars_and_keeps_the_intraday_ones(tmp_path):
    """Unlike #987 and #1008, this one does not cost the whole series.

    A bad point is a daily bar, the fetch only asks for daily bars beyond the
    hourly ceiling, so every bad point is older than 729 days and no good one
    is. The recent two years stand; ``oldest_window_tried`` goes back to
    ``NULL`` so the backward pass really buys the deleted years again, and
    ``newest_window_tried`` stays, because what it covers was never wrong.
    """
    path = tmp_path / 'bucketed.duckdb'
    old = datetime.now(UTC) - timedelta(days=1_000)
    recent = datetime.now(UTC) - timedelta(days=10)
    opened = store_module.open_store(path)
    try:
        opened.execute("INSERT INTO symbol (symbol) VALUES ('FDJU.PA')")
        opened.execute(
            "INSERT INTO symbol_quote (symbol, last_price_native, "
            "oldest_window_tried, newest_window_tried) "
            "VALUES ('FDJU.PA', 34.0, DATE '2019-11-21', DATE '2026-09-17')")
        opened.execute(
            'INSERT INTO price_point (symbol, ts, price_native) '
            "VALUES ('FDJU.PA', ?, 49.27), ('FDJU.PA', ?, 34.0)",
            [old, recent])
        opened.execute(
            "INSERT INTO account_metrics (account, day, total_value) "
            "VALUES ('default', DATE '2021-06-30', 3402.0)")
        opened.execute(
            "INSERT INTO portfolio_totals (day, total_value) "
            "VALUES (DATE '2021-06-30', 3402.0)")
        # The store now reads as one written before the step existed, which is
        # the only shape it ever runs on.
        opened.execute("DELETE FROM schema_step "
                       "WHERE step = 'refetch_prices_bucketed_in_utc'")
    finally:
        opened.close()

    brought = store_module.open_store(path)
    try:
        assert brought.query('SELECT price_native FROM price_point') == [(34.0,)]
        assert brought.query(
            'SELECT (SELECT count(*) FROM account_metrics), '
            '       (SELECT count(*) FROM portfolio_totals)') == [(0, 0)]
        assert brought.query(
            'SELECT oldest_window_tried, newest_window_tried, '
            '       last_price_native FROM symbol_quote') == [
            (None, date_of('2026-09-17'), 34.0)]
    finally:
        brought.close()


def test_the_step_is_recorded_under_its_own_name(tmp_path):
    """A name is an identity forever, and this one is neither #987's nor #1008's."""
    opened = store_module.open_store(tmp_path / 'fresh.duckdb')
    try:
        steps = {row[0] for row in
                 opened.query('SELECT step FROM schema_step')}
    finally:
        opened.close()

    assert 'refetch_prices_bucketed_in_utc' in steps


def date_of(text: str):
    """One ISO day as the ``date`` DuckDB hands back."""
    return datetime.strptime(text, '%Y-%m-%d').date()
