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
from application import quotes
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
    prices, splits = _fetch(mocker, [('2022-01-31', 2000.0)],
                            {'2024-03-22': 0.001})

    assert prices[0]['price'] == pytest.approx(2.0)
    # And the ratio that correction consumed is handed over rather than lost
    # (#760): the close is now in the day's share, so anything counting units
    # across the split has nothing left to read in the price.
    assert splits == {date(2024, 3, 22): 0.001}


def test_a_window_whose_splits_cannot_be_read_is_not_written(mocker):
    """The absence is not an empty answer.

    A chunk written without the splits is written in the wrong share, and the
    backward pass never asks twice for a window it has filled — so the mistake
    would be permanent and invisible. Failing the fetch costs one cycle.
    """
    assert _fetch(mocker, [('2022-01-31', 2000.0)],
                  RuntimeError('Yahoo said no')) == (None, None)


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


# --------------------------------------------------------------------------- #
# Keeping the ratios the correction consumes (#760)
# --------------------------------------------------------------------------- #

@pytest.fixture
def opened(tmp_path):
    """A store, open and at its schema, with the two symbols declared.

    Declared because that is the order production runs in: `backfill.run`
    calls `entries.declare_symbol` on the reference before any fetch, and
    `symbol_quote` holds a foreign key on `symbol`.
    """
    handle = store_module.open_store(tmp_path / 'splits.duckdb')
    for symbol in ('AAPL', 'TSLA'):
        handle.execute('INSERT INTO symbol (symbol) VALUES (?)', [symbol])
    try:
        yield handle
    finally:
        handle.close()


def test_a_symbol_that_never_split_reads_as_empty_and_not_as_unknown(opened):
    """``{}`` is an answer; the caller must not have to tell it from ``None``.

    Most symbols never split, and a replay over one of them is as correct as a
    replay over one that did. Handing back ``None`` here would make the common
    case indistinguishable from a history nobody has fetched yet.
    """
    assert quotes.read_splits(opened, 'AAPL') == {}

    assert quotes.record_splits(opened, 'AAPL', {}) == 0
    assert quotes.read_splits(opened, 'AAPL') == {}


def test_the_history_is_rewritten_whole_and_a_retracted_split_goes(opened):
    """The critical gap of the replay: half a split history, written silently.

    Yahoo hands back every split it knows on every fetch, so a row missing from
    the new answer is a row it has taken back. Merging instead of rewriting
    would leave it standing, and a replay counting units would divide a holding
    by a split that never happened — for ever, since the backward pass does not
    revisit a window it has filled.
    """
    quotes.record_splits(opened, 'AAPL', {date(2020, 8, 31): 4.0,
                                          date(2024, 3, 22): 0.001})
    assert quotes.read_splits(opened, 'AAPL') == {date(2020, 8, 31): 4.0,
                                                 date(2024, 3, 22): 0.001}

    quotes.record_splits(opened, 'AAPL', {date(2020, 8, 31): 4.0})

    assert quotes.read_splits(opened, 'AAPL') == {date(2020, 8, 31): 4.0}


def test_rewriting_the_same_history_changes_nothing_and_takes_no_lock(opened):
    """Idempotence, and the reason it is worth asserting rather than assuming.

    A fetch happens every cycle and a symbol splits a handful of times in its
    life, so this is the answer nearly every write path gets. It must leave the
    rows exactly as they were — and say it did nothing, which is what keeps the
    write mutex out of the ordinary cycle.
    """
    quotes.record_splits(opened, 'AAPL', {date(2020, 8, 31): 4.0})

    assert quotes.record_splits(opened, 'AAPL', {date(2020, 8, 31): 4.0}) == 0
    assert quotes.read_splits(opened, 'AAPL') == {date(2020, 8, 31): 4.0}


def test_one_symbol_s_splits_are_its_own(opened):
    """The rewrite is total **per symbol**, and stops at that symbol."""
    quotes.record_splits(opened, 'AAPL', {date(2020, 8, 31): 4.0})
    quotes.record_splits(opened, 'TSLA', {date(2022, 8, 25): 3.0})

    quotes.record_splits(opened, 'AAPL', {})

    assert quotes.read_splits(opened, 'AAPL') == {}
    assert quotes.read_splits(opened, 'TSLA') == {date(2022, 8, 25): 3.0}


def test_forgetting_a_symbol_takes_its_splits_with_it(opened):
    """A symbol dropped from the store leaves no ratio behind to mislead a replay."""
    quotes.record_splits(opened, 'AAPL', {date(2020, 8, 31): 4.0})

    quotes.forget_symbol(opened, 'AAPL')

    assert quotes.read_splits(opened, 'AAPL') == {}


def test_an_empty_history_is_told_apart_from_one_nobody_ever_asked_for(opened):
    """The mark, and the whole reason it exists.

    Zero rows is the ordinary correct answer for the majority of symbols, and
    it is also what a store written before this release holds for every symbol
    it had already fetched. Nothing in the rows tells the two apart, so the
    *reading* is recorded rather than inferred — and anything counting units
    across time reads the mark, never the count.
    """
    assert quotes.splits_were_read(opened, 'AAPL') is False

    quotes.record_splits(opened, 'AAPL', {})

    assert quotes.splits_were_read(opened, 'AAPL') is True
    assert quotes.read_splits(opened, 'AAPL') == {}


def test_the_mark_moves_even_when_no_row_does(opened):
    """A symbol that has never split answers the same empty history for ever.

    Written only alongside a change, the mark would never land on exactly the
    symbols it matters least to be wrong about — and those are the majority.
    """
    quotes.record_splits(opened, 'AAPL', {})
    opened.execute("UPDATE symbol_quote SET splits_read_at = NULL "
                   "WHERE symbol = 'AAPL'")

    assert quotes.record_splits(opened, 'AAPL', {}) == 0
    assert quotes.splits_were_read(opened, 'AAPL') is True


def test_forgetting_a_symbol_takes_the_mark_with_the_rows(opened):
    """What this install knew about its corporate actions is no longer true of it."""
    quotes.record_splits(opened, 'AAPL', {date(2020, 8, 31): 4.0})

    quotes.forget_symbol(opened, 'AAPL')

    assert quotes.splits_were_read(opened, 'AAPL') is False


def test_a_store_that_predates_the_table_is_brought_forward_unmarked(tmp_path):
    """The step adds the column and marks nothing, which is the point.

    A store in circulation has fetched its symbols already and holds no ratios
    for any of them. Marking them on migration would assert a reading that
    never happened; leaving them unmarked is what makes the next fetch the
    thing that establishes the history.
    """
    path = tmp_path / 'older.duckdb'
    opened = store_module.open_store(path)
    try:
        opened.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")
        opened.execute("INSERT INTO symbol_quote (symbol) VALUES ('AAPL')")
        opened.execute("DELETE FROM schema_step WHERE step = 'add_splits_read_at'")
        opened.execute('ALTER TABLE symbol_quote DROP COLUMN splits_read_at')
    finally:
        opened.close()

    brought = store_module.open_store(path)
    try:
        assert quotes.splits_were_read(brought, 'AAPL') is False
        assert quotes.record_splits(brought, 'AAPL', {}) == 0
        assert quotes.splits_were_read(brought, 'AAPL') is True
    finally:
        brought.close()


def test_a_ratio_that_is_not_a_positive_finite_number_is_not_a_ratio(opened):
    """Yahoo serves these out of a pandas frame, where an empty cell is `NaN`.

    And `NaN` is **truthy**: a replay multiplying units by it turns the holding
    into `NaN` and every figure downstream with it, silently. A zero would be
    skipped and a negative would flip the position. Rejected where they are
    written, so nothing further down has to ask.
    """
    quotes.record_splits(opened, 'AAPL', {
        date(2020, 8, 31): 4.0,
        date(2021, 1, 4): float('nan'),
        date(2022, 3, 1): 0.0,
        date(2023, 6, 5): -2.0,
        date(2024, 2, 2): float('inf'),
    })

    assert quotes.read_splits(opened, 'AAPL') == {date(2020, 8, 31): 4.0}


def test_the_market_edge_drops_them_before_they_are_ever_written(mocker):
    """The same rule one floor up, where the frame is read."""
    prices, splits = _fetch(
        mocker, [('2022-01-31', 100.0)],
        {'2024-03-22': 0.001, '2024-06-01': float('nan')})

    assert splits == {date(2024, 3, 22): 0.001}
    assert prices[0]['price'] == pytest.approx(0.1)
