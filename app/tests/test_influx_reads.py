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

from influx_reads import PortfolioReader, bucket_for_window


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


def test_a_real_query_error_propagates():
    """The whole reason this module is a sibling of the writer.

    ``influxdb_writer`` swallows every read exception into ``None`` — correct
    for a scheduler, and for a UI it makes "the database is dead" and "no data
    yet" the same screen (#655 decision 5/8).
    """
    executor = FakeExecutor(error=Exception("connection refused"))

    with pytest.raises(Exception, match="connection refused"):
        PortfolioReader(executor).latest_per_account()
