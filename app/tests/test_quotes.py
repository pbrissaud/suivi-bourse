"""The market's two tables, and the read that joins them (issue #700).

The store is real here — a DuckDB file in ``tmp_path`` — because everything
below is a claim about a *row*: what a writer leaves behind, what a second pass
over the same window leaves behind, and which of two writers moved the ``latest``
line. A mock reports that a call happened; only a database reports that the
result is right.
"""
from datetime import date, datetime, timedelta, timezone

import pytest

import perf_series
import quotes
import store_reads
from events.schemas import AccountMetricPoint, PortfolioTotalPoint

UTC = timezone.utc
NOW = datetime(2024, 6, 3, 15, 30, tzinfo=UTC)

ATTRIBUTES = {
    'currency': 'USD', 'exchange': 'NMS', 'quote_type': 'EQUITY',
    'dividend_yield': 0.52, 'pe_ratio': 28.5, 'market_cap': 3.0e12,
}


@pytest.fixture
def declared(store):
    """The configuration path's rows the market writer's keys point at.

    The market writer never creates them, and that is the schema rule rather
    than an omission: ``symbol`` belongs to the configuration path, and a writer
    inventing a declaration is exactly the two-writers-one-row the DDL exists to
    forbid.
    """
    store.execute("INSERT INTO symbol (symbol) VALUES ('AAPL'), ('MSFT')")
    store.execute("INSERT INTO position (account, symbol, name, quantity, "
                  "  cost_basis, realized_gain, received_dividend) "
                  "VALUES ('default', 'AAPL', 'Apple Inc', 10, 1500.0, 0, 2.4)")
    return store


def _points(store, symbol='AAPL'):
    return store.query(
        'SELECT ts, price_native FROM price_point WHERE symbol = ? ORDER BY ts',
        [symbol])


# --------------------------------------------------------------------------- #
# What a price point is, and what it is not
# --------------------------------------------------------------------------- #

def test_a_price_point_has_no_account_and_no_ohlc(store):
    """The two columns families #700 removes, asserted on the schema itself.

    The account went because a market price belongs to none — the shim that
    rescued it (``COALESCE(account, 'default')``) dies with it, and the row
    count falls by a quarter. OHLC went for a sharper reason: the live writer
    set ``open = high = low = close`` on every point it wrote, so those were not
    dead columns but **columns that lied**, and a candlestick drawn from them
    showed a flat doji through every session the app was up for.
    """
    columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'price_point'")}

    assert columns == {'symbol', 'ts', 'price_native', 'price_converted',
                       'fx_rate'}


def test_a_share_s_name_lives_on_the_position_and_not_on_the_symbol(store):
    """It comes from the owner's file, not from Yahoo (spec #695 § 3).

    Two accounts may legitimately call the same line differently, and — the
    reason that matters — renaming a share can no longer cut its history in two,
    because the history is keyed on a symbol the rename does not touch.
    """
    symbol_columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'symbol'")}
    quote_columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'symbol_quote'")}

    assert symbol_columns == {'symbol'}
    assert 'name' not in quote_columns


# --------------------------------------------------------------------------- #
# The live writer
# --------------------------------------------------------------------------- #

def test_a_live_write_truncates_to_the_second(declared):
    """Kept from v4's ``WritePrecision.S``, and for the reason it was chosen.

    A range writer deletes what it is about to insert; without the truncation it
    would land a microsecond away from the row it means to replace, leaving a
    shadow copy no ``DELETE`` bounded by the batch could ever find.
    """
    quotes.record_quote(declared, 'AAPL', NOW.replace(microsecond=123456),
                        185.0, ATTRIBUTES)

    assert _points(declared) == [(NOW, 185.0)]


def test_a_live_write_appends_and_refreshes_the_quote_in_one_gesture(declared):
    quotes.record_quote(declared, 'AAPL', NOW, 185.0, ATTRIBUTES)
    quotes.record_quote(declared, 'AAPL', NOW + timedelta(seconds=120), 186.0,
                        ATTRIBUTES)

    assert [price for _, price in _points(declared)] == [185.0, 186.0]
    row = quotes.read_quote(declared, 'AAPL')
    assert row['currency'] == 'USD'
    assert row['last_price_native'] == 186.0
    assert row['last_price_ts'] == NOW + timedelta(seconds=120)


def test_the_market_writer_never_invents_a_declaration(store):
    """One writer per row, seen from the wrong side of the foreign key.

    A symbol nobody declared has no ``symbol`` row, and the market writer will
    not create one — the configuration path owns that table. In production the
    case cannot arise (every symbol these writers see came from the ledger); the
    refusal is what keeps it that way.
    """
    with pytest.raises(Exception):
        quotes.record_quote(store, 'NOPE', NOW, 1.0, ATTRIBUTES)


# --------------------------------------------------------------------------- #
# The maintenance rule — one sentence, three cases
# --------------------------------------------------------------------------- #

def test_an_older_chunk_does_not_move_the_latest_line(declared):
    """*A writer inserting a point whose ``ts >= last_price_ts`` updates
    ``last_*``.* A backward chunk is entirely older, so it updates nothing —
    and the rule is in the ``WHERE`` rather than in the caller, which is what
    makes it one sentence for three writers."""
    quotes.record_quote(declared, 'AAPL', NOW, 185.0, ATTRIBUTES)

    quotes.record_history(declared, 'AAPL', [
        {'timestamp': NOW - timedelta(days=30), 'price': 100.0},
        {'timestamp': NOW - timedelta(days=29), 'price': 101.0},
    ])

    row = quotes.read_quote(declared, 'AAPL')
    assert (row['last_price_native'], row['last_price_ts']) == (185.0, NOW)


def test_a_newer_chunk_moves_it(declared):
    """The forward pass's case, and #704's lateral one will fall under the same
    sentence without a clause of its own."""
    quotes.record_quote(declared, 'AAPL', NOW, 185.0, ATTRIBUTES)

    quotes.record_history(declared, 'AAPL', [
        {'timestamp': NOW + timedelta(days=1), 'price': 190.0}])

    row = quotes.read_quote(declared, 'AAPL')
    assert row['last_price_native'] == 190.0
    assert row['last_price_ts'] == NOW + timedelta(days=1)


def test_the_invariant_is_the_newest_point_whatever_its_completeness(declared):
    """Not "the newest **complete** point" — that spelling is the per-field
    last-non-null pass the store exists to avoid, reintroduced under a new
    name. A point with no conversion still moves the line."""
    quotes.record_quote(declared, 'AAPL', NOW, 185.0, ATTRIBUTES)
    declared.execute("UPDATE symbol_quote SET last_price_converted = 170.0")

    quotes.record_history(declared, 'AAPL', [
        {'timestamp': NOW + timedelta(days=1), 'price': 190.0}])

    row = quotes.read_quote(declared, 'AAPL')
    assert row['last_price_ts'] == NOW + timedelta(days=1)


def test_a_backfill_reaches_a_symbol_the_scrape_never_fetched(declared):
    """A position sold before this install existed has no quote row yet, and
    the ``latest`` rule needs one to update. The attributes stay ``NULL`` until
    a live fetch supplies them — absent, never invented."""
    quotes.record_history(declared, 'MSFT', [
        {'timestamp': NOW - timedelta(days=400), 'price': 300.0}])

    row = quotes.read_quote(declared, 'MSFT')
    assert row['currency'] is None
    assert row['last_price_native'] == 300.0


# --------------------------------------------------------------------------- #
# The range writer — deleting its own span, and only its own
# --------------------------------------------------------------------------- #

def test_re_running_the_same_window_leaves_the_same_rows(declared):
    """Idempotence, which is where ``price_point``'s uniqueness lives now that
    the table carries no key at all (ADR-0007). The backfill re-runs a window
    whenever a cycle is interrupted, and a second pass must not double it."""
    chunk = [{'timestamp': NOW - timedelta(days=n), 'price': 100.0 + n}
             for n in range(5)]

    quotes.record_history(declared, 'AAPL', chunk)
    first = _points(declared)
    quotes.record_history(declared, 'AAPL', chunk)

    assert _points(declared) == first
    assert len(first) == 5


def test_a_chunk_that_comes_back_short_never_erases_what_it_did_not_resupply(
        declared):
    """Why the deleted span is the **batch's** and not the window's.

    A ``DELETE`` bounded by the range that was asked for removes points a
    hiccuping fetch failed to bring back — history lost to a transient Yahoo
    error, silently. Bounded by the batch, the operation can only ever replace
    rows it is about to write.
    """
    quotes.record_history(declared, 'AAPL', [
        {'timestamp': NOW - timedelta(days=n), 'price': 100.0 + n}
        for n in range(5)])

    # The same window, and the fetch came back with one row of it.
    quotes.record_history(declared, 'AAPL', [
        {'timestamp': NOW - timedelta(days=2), 'price': 999.0}])

    stored = dict(_points(declared))
    assert len(stored) == 5
    assert stored[NOW - timedelta(days=2)] == 999.0


def test_a_refused_write_leaves_the_previous_series_whole(declared, mocker):
    """The transaction, asserted where it matters: the delete and the insert are
    one gesture, so a failure between them cannot leave a hole where history
    used to be. Both statements plus the ``latest`` rule are inside it, which is
    also why a reader never sees a point whose ``latest`` row has not caught up.
    """
    quotes.record_history(declared, 'AAPL', [
        {'timestamp': NOW - timedelta(days=n), 'price': 100.0 + n}
        for n in range(5)])
    before = _points(declared)
    mocker.patch.object(declared, 'executemany',
                        side_effect=RuntimeError('disk full'))

    with pytest.raises(RuntimeError):
        quotes.record_history(declared, 'AAPL', [
            {'timestamp': NOW - timedelta(days=2), 'price': 999.0}])

    assert _points(declared) == before


def test_an_unknown_symbol_has_no_quote_row_and_says_so(declared):
    assert quotes.read_quote(declared, 'NOPE') is None
    assert quotes.oldest_ts(declared, 'NOPE') is None
    assert quotes.newest_ts(declared, 'NOPE') is None
    assert quotes.last_price(declared, 'NOPE') is None
    assert quotes.price_series(declared, 'NOPE') == {}


def test_a_row_with_no_usable_price_is_dropped_rather_than_written(declared):
    written = quotes.record_history(declared, 'AAPL', [
        {'timestamp': NOW, 'price': None},
        {'timestamp': NOW - timedelta(days=1), 'price': 100.0},
    ])

    assert written == 1
    assert len(_points(declared)) == 1


def test_an_empty_chunk_writes_nothing_and_touches_nothing(declared):
    quotes.record_quote(declared, 'AAPL', NOW, 185.0, ATTRIBUTES)

    assert quotes.record_history(declared, 'AAPL', []) == 0
    assert len(_points(declared)) == 1


# --------------------------------------------------------------------------- #
# The anchors the scheduler reads
# --------------------------------------------------------------------------- #

def test_the_forward_anchor_ignores_a_point_with_no_price(declared):
    """The pass exists to fill *price* gaps, so a newer point without one must
    not make it believe coverage reaches ``now`` and skip an older range. #702
    makes such a point an ordinary state."""
    quotes.record_history(declared, 'AAPL', [
        {'timestamp': NOW - timedelta(days=2), 'price': 100.0}])
    declared.execute(
        'INSERT INTO price_point (symbol, ts, price_native) VALUES (?, ?, NULL)',
        ['AAPL', NOW])

    assert quotes.oldest_ts(declared, 'AAPL') == NOW - timedelta(days=2)
    assert quotes.newest_ts(declared, 'AAPL') == NOW - timedelta(days=2)


def test_the_day_s_survivor_is_its_last_point(declared):
    """The rule every daily read in the product follows, and the one #705's
    ladder inherits: a survivor chosen otherwise makes the value jump when a day
    is collapsed."""
    quotes.record_history(declared, 'AAPL', [
        {'timestamp': datetime(2024, 6, 3, 9, 0, tzinfo=UTC), 'price': 100.0},
        {'timestamp': datetime(2024, 6, 3, 17, 30, tzinfo=UTC), 'price': 104.0},
    ])

    assert quotes.price_series(declared, 'AAPL') == {date(2024, 6, 3): 104.0}


# --------------------------------------------------------------------------- #
# P1 — the join that replaced the window
# --------------------------------------------------------------------------- #

def test_p1_joins_the_position_to_its_symbol_s_newest_observation(declared):
    quotes.record_quote(declared, 'AAPL', NOW, 185.0, ATTRIBUTES)

    (row,) = store_reads.PortfolioReader(declared).positions()

    assert row['symbol'] == 'AAPL'
    assert row['name'] == 'Apple Inc'
    assert row['quantity'] == 10.0
    assert row['cost_basis'] == 1500.0
    assert row['price'] == 185.0
    assert row['price_time'] == NOW
    assert row['currency'] == 'USD'


def test_p1_has_no_time_window_so_a_long_closure_never_blanks_the_page(declared):
    """"Current" is absolute (#652 déc. 1). The join reads the ``latest`` row,
    so a symbol last observed four years ago is still a row with a price — which
    is what a market shut over a long weekend, or a delisting, produces."""
    quotes.record_quote(declared, 'AAPL', NOW - timedelta(days=1500), 185.0,
                        ATTRIBUTES)

    (row,) = store_reads.PortfolioReader(declared).positions()

    assert row['price'] == 185.0


def test_a_position_whose_symbol_was_never_fetched_is_still_a_row(declared):
    """The LEFT join, and the reason it is one: an inner join answers *"you own
    nothing"* to someone who has just declared everything they own — a fresh
    install between its first import and its first scrape."""
    (row,) = store_reads.PortfolioReader(declared).positions()

    assert row['quantity'] == 10.0
    assert row['price'] is None
    assert row['currency'] is None


def test_an_empty_store_answers_an_empty_collection_and_never_raises(store):
    """The window #696 left open, closed here.

    Removing ``_ABSENT_SCHEMA`` was right — in a store a declared column that
    was never written reads as ``NULL`` — but while the InfluxDB reader lived, a
    fresh install whose measurement did not exist yet answered ``503`` where it
    owed ``200`` + ``[]``. The tables are declared at creation, so absence is a
    shape of the data and nothing has to recognise an error message.
    """
    reader = store_reads.PortfolioReader(store)

    assert reader.positions() == []
    assert reader.raw_series('AAPL') == []
    assert reader.bucketed_series('AAPL', '1 day') == []
    assert reader.daily_closes() == []
    assert reader.prices_at(NOW) == []
    assert reader.latest_totals() is None
    assert reader.totals_series() == []
    assert reader.latest_account_metrics() == []
    assert reader.account_series('default') == []
    assert reader.total_value_at(NOW) is None


def test_a_wide_read_crosses_arrow_and_a_narrow_one_does_not(declared, mocker):
    """A constraint on the read primitives, not a preference (spec #695 § 1).

    Materialising a ``TIMESTAMPTZ`` column into Python objects costs **8×** what
    Arrow costs — 382 ms against 47 for a quarter of a million points — because
    every instant becomes an individual object on the way out. The series
    primitives therefore fetch columns; the narrow reads, where the frontier is
    not the cost, stay tuples.
    """
    quotes.record_quote(declared, 'AAPL', NOW, 185.0, ATTRIBUTES)
    reader = store_reads.PortfolioReader(declared)
    arrow = mocker.spy(declared, 'arrow')
    rows = mocker.spy(declared, 'query')

    reader.raw_series('AAPL')
    reader.daily_closes()

    assert arrow.call_count == 2
    assert rows.call_count == 0

    reader.positions()
    assert rows.call_count == 1


def test_a_bucket_width_is_whitelisted_never_interpolated(declared):
    """It reaches SQL as a literal, so it must never come from a request."""
    reader = store_reads.PortfolioReader(declared)

    with pytest.raises(ValueError):
        reader.bucketed_series('AAPL', "1 day'); DROP TABLE price_point; --")


# --------------------------------------------------------------------------- #
# The perf series' own writer
# --------------------------------------------------------------------------- #

def test_the_perf_write_rewrites_its_own_key_rather_than_appending(store, mocker):
    """The mechanism ADR-0011 measured, asserted as the property it establishes.

    The measurement itself — 44,8 MB for a 1,6 MB table over a thousand cycles
    of a ``DELETE``+``INSERT``, against 1,1 MB for the upsert — comes from a
    throwaway harness and stays there (spec #695 Testing Decisions: *a bench is
    not a test*). What it established is this: a cycle that recomputes the same
    days leaves the same **rows**, because the write lands on the primary key it
    already occupies. The file-size claim belongs to #707, which is where the
    incremental window it interacts with is removed.

    And it is **one block statement**, not a loop: the same 5 478-row upsert is
    3 ms in one call and does not finish in two minutes row by row.
    """
    store.execute("INSERT INTO account (id, type, label) "
                  "VALUES ('pea', 'PEA', 'PEA')")
    days = [date(2024, 1, 1) + timedelta(days=n) for n in range(60)]
    block = mocker.spy(store, 'executemany')

    for cycle in range(3):
        perf_series.write_account_metrics(store, [AccountMetricPoint(
            account='pea', account_type='PEA', account_currency='EUR',
            day=day, cash_balance=float(cycle), holdings_value=1.0,
            total_value=1.0, net_contributed=1.0) for day in days])
        perf_series.write_portfolio_totals(store, [PortfolioTotalPoint(
            day=day, cash_balance=float(cycle), holdings_value=1.0,
            total_value=1.0, net_contributed=1.0) for day in days])

    assert store.query('SELECT count(*) FROM account_metrics') == [(60,)]
    assert store.query('SELECT count(*) FROM portfolio_totals') == [(60,)]
    # The last cycle's values, not the first's: an upsert, not an insert-ignore.
    assert store.query('SELECT DISTINCT cash_balance FROM account_metrics') \
        == [(2.0,)]
    # Two statements per cycle for 120 rows, never one per row.
    assert block.call_count == 6
