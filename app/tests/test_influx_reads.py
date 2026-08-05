"""Tests for the UI read primitives (issue #659).

#655 named the testing criterion for this slice, and it is narrow on purpose:
**P1's SQL** is the thing with real logic in it — the
``ROW_NUMBER() … PARTITION BY COALESCE(account,'default')`` window — so it is
tested against a fake executor that records the SQL string. The rest of the
module is a pandas-to-dict conversion, tested for the one thing that conversion
must get right: NaN is not a value.

The fake also proves the injection point does what #655 decision 5 claimed: a
``query(sql) -> table`` callable is enough to exercise every primitive, with no
InfluxDB anywhere.
"""
import math
from datetime import datetime, timezone

import pandas as pd
import pytest

from influx_reads import (
    MEASUREMENT,
    TOTALS_MEASUREMENT,
    PortfolioReader,
    bucket_for_window,
)


class FakeTable:
    """The little of an Arrow table the reader touches: ``len`` and ``to_pandas``."""

    def __init__(self, frame: pd.DataFrame):
        self._frame = frame

    def __len__(self):
        return len(self._frame)

    def to_pandas(self):
        return self._frame


class FakeExecutor:
    """Records every SQL string it is handed, and replays canned frames."""

    def __init__(self, frame=None, error=None):
        self.queries = []
        self._frame = frame if frame is not None else pd.DataFrame()
        self._error = error

    def __call__(self, sql: str):
        self.queries.append(sql)
        if self._error is not None:
            raise self._error
        return FakeTable(self._frame)

    @property
    def sql(self) -> str:
        assert self.queries, "no query was executed"
        return " ".join(self.queries[-1].split())


# --------------------------------------------------------------------- #
# P1 — the query the whole page rests on
# --------------------------------------------------------------------- #

def test_latest_per_account_partitions_on_coalesced_account():
    """Trap 1: pre-v4.1 points carry no account tag and must count as 'default'.

    Partitioning on the bare tag would give them their own NULL bucket, and the
    symptom is history that quietly stops at a version boundary.
    """
    executor = FakeExecutor()
    PortfolioReader(executor).latest_per_account()

    assert "ROW_NUMBER() OVER ( PARTITION BY share_symbol, "\
        "COALESCE(account, 'default') ORDER BY time DESC) AS rn" in executor.sql
    assert "WHERE rn = 1" in executor.sql
    # The account column must be the coalesced one, not the raw tag.
    assert "COALESCE(account, 'default') AS account" in executor.sql


def test_latest_per_account_is_one_query_for_the_whole_portfolio():
    """#652 déc. 8 generalised P1 to all symbols at once — one query, two callers."""
    executor = FakeExecutor()
    PortfolioReader(executor).latest_per_account()

    assert len(executor.queries) == 1
    assert "share_symbol = " not in executor.sql


def test_latest_per_account_has_no_time_window():
    """Trap 6 / déc. 1: 'current' is absolute. A window here would blank the page
    whenever the market had been closed longer than it."""
    executor = FakeExecutor()
    PortfolioReader(executor).latest_per_account()

    assert "time >=" not in executor.sql
    assert "time <=" not in executor.sql
    assert "INTERVAL" not in executor.sql


def test_latest_per_account_narrows_to_one_symbol():
    executor = FakeExecutor()
    PortfolioReader(executor).latest_per_account(share_symbol='AAPL')

    assert "share_symbol = 'AAPL'" in executor.sql


def test_symbol_is_escaped_through_the_shared_helper():
    """The tag values come from a user-authored events file."""
    executor = FakeExecutor()
    PortfolioReader(executor).latest_per_account(share_symbol="O'NEIL")

    assert "share_symbol = 'O''NEIL'" in executor.sql


def test_latest_per_account_selects_the_fundamentals_alongside_the_price():
    """They ride the same point, which is what makes P1 a single window function."""
    executor = FakeExecutor()
    PortfolioReader(executor).latest_per_account()

    for field in ('share_price', 'owned_quantity', 'purchased_price',
                  'dividend_yield', 'pe_ratio', 'market_cap'):
        assert field in executor.sql


# --------------------------------------------------------------------- #
# The series behind the chart
# --------------------------------------------------------------------- #

def test_raw_series_never_filters_by_account():
    """🔒 A market price belongs to no account (the get_price_series rule)."""
    executor = FakeExecutor()
    PortfolioReader(executor).raw_series('AAPL')

    assert "account" not in executor.sql


def test_raw_series_applies_the_window_as_utc_z_literals():
    executor = FakeExecutor()
    start = datetime(2024, 1, 15, 9, 30, tzinfo=timezone.utc)
    stop = datetime(2024, 2, 15, 17, 0, tzinfo=timezone.utc)
    PortfolioReader(executor).raw_series('AAPL', start, stop)

    # Bare-UTC 'Z', never '+00:00Z' — InfluxDB rejects the latter.
    assert "time >= '2024-01-15T09:30:00Z'" in executor.sql
    assert "time <= '2024-02-15T17:00:00Z'" in executor.sql
    assert "+00:00" not in executor.sql


def test_bucketed_series_refuses_an_interval_it_did_not_choose():
    """The interval reaches SQL as a literal, so it may never come from a request."""
    reader = PortfolioReader(FakeExecutor())

    with pytest.raises(ValueError):
        reader.bucketed_series('AAPL', "1 day'; DROP TABLE portfolio_metrics; --")


def test_bucketed_series_takes_the_last_price_of_each_bucket():
    """Matches get_price_series's daily-close rule, so the two agree on overlap."""
    executor = FakeExecutor()
    PortfolioReader(executor).bucketed_series('AAPL', '1 day')

    assert "DATE_BIN(INTERVAL '1 day', time)" in executor.sql
    assert "ORDER BY time DESC" in executor.sql
    assert "WHERE rn = 1" in executor.sql


@pytest.mark.parametrize("span_days,expected", [
    (1, None),
    (7, None),
    (30, '30 minutes'),
    (90, '1 hour'),
    (365, '6 hours'),
    (1826, '1 day'),
])
def test_bucket_for_window(span_days, expected):
    """Pure, so the downsampling choice is testable without a database."""
    assert bucket_for_window(span_days) == expected


# --------------------------------------------------------------------- #
# The boundary: pandas in, plain rows out
# --------------------------------------------------------------------- #

def test_nan_becomes_none_at_the_boundary():
    """NaN is a float that passes ``is not None``, and JSON has no NaN at all.

    Letting one out would put a literal NaN in the payload and, worse, would
    make the pure module's tests build DataFrames instead of lists.
    """
    frame = pd.DataFrame([{
        'share_symbol': 'AAPL',
        'account': 'pea',
        'share_price': 150.0,
        'pe_ratio': math.nan,
    }])
    rows = PortfolioReader(FakeExecutor(frame)).latest_per_account()

    assert rows[0]['pe_ratio'] is None
    assert rows[0]['share_price'] == 150.0


def test_timestamps_come_back_utc_aware():
    frame = pd.DataFrame([{
        'share_symbol': 'AAPL',
        'time': pd.Timestamp('2024-06-01 12:00:00'),
    }])
    rows = PortfolioReader(FakeExecutor(frame)).latest_per_account()

    assert rows[0]['time'] == datetime(2024, 6, 1, 12, 0, tzinfo=timezone.utc)


def test_a_missing_measurement_is_an_empty_install_not_a_failure():
    """A fresh database has no ``portfolio_metrics`` until the first write.

    #655's three states: this is the *empty collection*, so it must be ``[]``.
    Answering 503 here would make every brand-new install look broken.
    """
    executor = FakeExecutor(error=Exception("table 'portfolio_metrics' not found"))
    assert PortfolioReader(executor).latest_per_account() == []


# --------------------------------------------------------------------- #
# P6 — value_at, the 6th primitive (issue #660)
#
# #660's testing criterion names this one: "the 'last point ≤ t' rule is the
# logic". Everything else about the primitive is plumbing.
# --------------------------------------------------------------------- #

AN_INSTANT = datetime(2026, 8, 5, tzinfo=timezone.utc)


def test_value_at_reads_the_last_point_at_or_before_the_instant():
    """The rule, and the reason it is `<=` rather than `=`: the exact point
    never exists. `portfolio_totals` is stamped at midnight, prices land every
    120 s during a session and not at all outside one, and a weekend is a
    legitimate hole (#606). A query *at* an instant answers nothing, almost
    always.
    """
    executor = FakeExecutor()
    PortfolioReader(executor).value_at(TOTALS_MEASUREMENT, 'total_value', AN_INSTANT)

    assert "time <= '2026-08-05T00:00:00Z'" in executor.sql
    assert "ORDER BY time DESC" in executor.sql
    assert "LIMIT 1" in executor.sql
    # Bare UTC 'Z' — `isoformat()` alone would emit '+00:00Z', which InfluxDB
    # rejects outright.
    assert '+00:00' not in executor.sql


def test_value_at_ignores_points_where_the_field_is_null():
    """Otherwise the "last point" can be a point that carries no value at all —
    `write_metrics` persists a row without a price when the quote fetch fails."""
    executor = FakeExecutor()
    PortfolioReader(executor).value_at(MEASUREMENT, 'share_price', AN_INSTANT)

    assert 'share_price IS NOT NULL' in executor.sql


def test_value_at_returns_none_when_nothing_was_stored_that_early():
    """Absence, not zero. A portfolio that did not exist yet has no value, and
    calling that a gain of everything is trap 3 at its most flattering."""
    reader = PortfolioReader(FakeExecutor())

    assert reader.value_at(TOTALS_MEASUREMENT, 'total_value', AN_INSTANT) is None


def test_value_at_refuses_a_target_it_does_not_know():
    """The measurement and the field land in SQL as **identifiers**, where
    quote-doubling buys nothing. So they are whitelisted rather than escaped —
    and a primitive that can read any field of any measurement is the generic
    query API #655 decision 6 rejected."""
    reader = PortfolioReader(FakeExecutor())

    with pytest.raises(ValueError):
        reader.value_at('portfolio_metrics', 'volume; DROP TABLE x', AN_INSTANT)
    with pytest.raises(ValueError):
        reader.value_at('some_other_measurement', 'share_price', AN_INSTANT)


def test_value_at_scopes_an_account_through_coalesce():
    """Trap 1 again, and it is invisible when wrong: a bare `account = 'x'`
    succeeds and silently omits the pre-v4.1 half of the history."""
    executor = FakeExecutor()
    PortfolioReader(executor).value_at(
        MEASUREMENT, 'share_price', AN_INSTANT, {'account': 'pea'})

    assert "COALESCE(account, 'default') = 'pea'" in executor.sql


def test_value_at_escapes_a_filter_value():
    executor = FakeExecutor()
    PortfolioReader(executor).value_at(
        MEASUREMENT, 'share_price', AN_INSTANT, {'share_symbol': "O'NEIL"})

    assert "share_symbol = 'O''NEIL'" in executor.sql


def test_values_at_answers_every_symbol_in_one_query():
    """The movers block needs the previous close for the whole portfolio, and
    one `value_at` per symbol would be N round-trips for one screen — the same
    arithmetic that made #652 déc. 8 generalise P1."""
    executor = FakeExecutor()
    PortfolioReader(executor).values_at(
        MEASUREMENT, 'share_price', AN_INSTANT, partition_by='share_symbol')

    assert len(executor.queries) == 1
    assert 'ROW_NUMBER() OVER ( PARTITION BY share_symbol ORDER BY time DESC) AS rn' \
        in executor.sql
    assert 'WHERE rn = 1' in executor.sql
    assert "time <= '2026-08-05T00:00:00Z'" in executor.sql


def test_values_at_refuses_a_partition_it_does_not_know():
    reader = PortfolioReader(FakeExecutor())

    with pytest.raises(ValueError):
        reader.values_at(MEASUREMENT, 'share_price', AN_INSTANT,
                         partition_by='time DESC) AS rn FROM x; --')


# --------------------------------------------------------------------- #
# The global perf series
# --------------------------------------------------------------------- #

def test_latest_totals_selects_every_column_rather_than_naming_the_fields():
    """Three of the seven fields are written only when computable, and in
    InfluxDB 3 a field never written is a column that does not exist. Naming
    `xirr` in the SELECT would turn "this portfolio has no deposits" into a
    query error — which `_ABSENT_SCHEMA` then reports as an empty install, so
    the whole head would vanish because one rate was undefined.
    """
    executor = FakeExecutor()
    PortfolioReader(executor).latest_totals()

    assert 'SELECT * FROM "portfolio_totals"' in executor.sql
    assert 'xirr' not in executor.sql


def test_latest_totals_has_no_time_window():
    """Déc. 1 again, and it bites harder here: the perf job is gated (#618) and
    a fully-closed market wave writes nothing, so any window narrow enough to be
    useful is narrow enough to blank the dashboard."""
    executor = FakeExecutor()
    PortfolioReader(executor).latest_totals()

    assert 'time >=' not in executor.sql
    assert 'time <=' not in executor.sql


def test_totals_series_is_not_bucketed():
    """One point per calendar day is already the grain; there is nothing to
    downsample, and five years is ~1800 rows."""
    executor = FakeExecutor()
    PortfolioReader(executor).totals_series(
        datetime(2024, 1, 1, tzinfo=timezone.utc), AN_INSTANT)

    assert 'DATE_BIN' not in executor.sql
    assert "time >= '2024-01-01T00:00:00Z'" in executor.sql
    assert 'ORDER BY time' in executor.sql


# --------------------------------------------------------------------- #
# The per-account perf series (issue #661)
# --------------------------------------------------------------------- #

def test_latest_account_metrics_ranks_the_newest_point_of_each_account():
    """P1's shape on a second measurement: one window answering N accounts.

    One `value_at` per declared account would be N round trips to fill one
    screen — the arithmetic that made #652 déc. 8 generalise P1 in the first
    place.
    """
    executor = FakeExecutor()
    PortfolioReader(executor).latest_account_metrics()

    assert 'FROM "account_metrics"' in executor.sql
    assert 'ROW_NUMBER() OVER ( PARTITION BY account ORDER BY time DESC) AS rn' \
        in executor.sql
    assert 'WHERE rn = 1' in executor.sql
    # Same reason as `latest_totals`: xirr/gain_absolu/twr_index are written
    # only when computable, and naming a column that was never written is a
    # query error that reads as an empty install.
    assert 'xirr' not in executor.sql


def test_latest_account_metrics_drops_the_ranking_column():
    """`rn` is an artefact of the window, not a field of the series — and with
    `SELECT *` it would otherwise ride all the way into the payload."""
    frame = pd.DataFrame([
        {'account': 'pea', 'time': pd.Timestamp('2026-08-05'),
         'total_value': 12500.0, 'rn': 1},
    ])
    rows = PortfolioReader(FakeExecutor(frame)).latest_account_metrics()

    assert rows[0]['total_value'] == 12500.0
    assert 'rn' not in rows[0]


def test_account_series_filters_through_the_shared_tag_rule():
    """The account clause has one home (`influx_sql`), even here where the tag
    is never null — two implementations of trap 1 is how one of them decays."""
    executor = FakeExecutor()
    PortfolioReader(executor).account_series(
        "pea", datetime(2024, 1, 1, tzinfo=timezone.utc), AN_INSTANT)

    assert "COALESCE(account, 'default') = 'pea'" in executor.sql
    assert "time >= '2024-01-01T00:00:00Z'" in executor.sql
    assert 'ORDER BY time' in executor.sql
    # Daily grain already: nothing to downsample, same as `totals_series`.
    assert 'DATE_BIN' not in executor.sql


def test_account_series_escapes_the_account_id():
    """Ids come from a user-written settings.yaml, so they are literals, not
    trusted identifiers."""
    executor = FakeExecutor()
    PortfolioReader(executor).account_series("o'brien")

    assert "'o''brien'" in executor.sql


def test_daily_position_series_ranks_per_day_and_series_before_anything_is_summed():
    """The trap is the shape, not the fields. During a session a symbol is
    written every 120 s, so a `SUM(...) GROUP BY day` over the raw points
    multiplies the portfolio by its polling rate — a valuation curve that really
    tracks market opening hours.
    """
    executor = FakeExecutor()
    PortfolioReader(executor).daily_position_series()

    assert "DATE_BIN(INTERVAL '1 day', time)" in executor.sql
    assert 'PARTITION BY DATE_BIN(INTERVAL \'1 day\', time), share_symbol, ' \
        "COALESCE(account, 'default') ORDER BY time DESC" in executor.sql
    assert 'WHERE rn = 1' in executor.sql
    # Summing is the pure module's job — a missing day has to stay a missing row
    # so it can be forward-filled rather than silently dropped from the total.
    assert 'SUM(' not in executor.sql


def test_a_real_query_error_propagates():
    """The whole reason this module is a sibling of the writer.

    ``influxdb_writer`` swallows every read exception into ``None`` — correct
    for a scheduler, and for a UI it makes "the database is dead" and "no data
    yet" the same screen (#655 decision 5/8).
    """
    executor = FakeExecutor(error=Exception("connection refused"))

    with pytest.raises(Exception, match="connection refused"):
        PortfolioReader(executor).latest_per_account()
