"""
Tests for main.SuiviBourseMetrics.

Everything here is network-free: yfinance and InfluxDB are the only external
boundaries and both are mocked/monkeypatched. The ConfigurationManager is
replaced by a lightweight in-memory fake so no real ~/.config/SuiviBourse or
event files are ever touched.

Imports work top-level because pytest.ini sets ``pythonpath = src`` (same as
how app/src/main.py imports its own modules).
"""

from datetime import date, datetime, timezone

import pandas as pd
import pytest

import main
from main import SuiviBourseMetrics
from events.validator import EventValidationError
from yfinance.exceptions import YFRateLimitError
from urllib3.exceptions import NewConnectionError


# ---------------------------------------------------------------------------
# Local helpers / fakes
# ---------------------------------------------------------------------------

def _valid_shares(symbol="AAPL", name="Apple"):
    """A single valid share dict matching schema.yaml requirements."""
    return {
        "name": name,
        "symbol": symbol,
        "purchase": {"quantity": 10, "fee": 2.5, "cost_price": 150.0},
        "estate": {"quantity": 10, "received_dividend": 2.4},
    }


class FakeConfigManager:
    """In-memory stand-in for main.ConfigurationManager.

    Exposes the surface SuiviBourseMetrics relies on since #658: ``current()``
    (the published snapshot — the read path), ``reload()`` (the publisher), plus
    ``get_mode()``. ``_first_buy_dates`` overrides what the snapshot would
    derive from ``events``, so tests can name a first-BUY date without writing
    an event list.

    ``raise_on_load`` fails the *publisher* only, never ``current()``: that is
    the production contract — a failed reload leaves the previously published
    snapshot readable.
    """

    def __init__(self, shares, mode="manual", first_buy_dates=None, events=None,
                 accounts=None):
        self._shares = shares
        self._mode = mode
        self._first_buy_dates = first_buy_dates or {}
        self._events = events
        self._accounts = accounts
        self.raise_on_load = False

    def current(self):
        return _FakeSnapshot(
            shares=self._shares, events=self._events, accounts=self._accounts,
            cache_key=None, first_buy_dates=self._first_buy_dates)

    def reload(self, force=False):
        if isinstance(self.raise_on_load, BaseException):
            raise self.raise_on_load
        if self.raise_on_load:
            raise RuntimeError("boom loading shares")
        return self.current()

    def load_shares(self, force=False):
        return self.reload(force=force).shares

    def get_mode(self):
        return self._mode

    def load_accounts(self):
        return self._accounts

    def get_first_buy_date(self, symbol):
        return self._first_buy_dates.get(symbol)

    def get_events(self):
        return self._events


class _FakeSnapshot(main.ConfigSnapshot):
    """A ConfigSnapshot whose first_buy_date comes from a dict, not events."""

    def __init__(self, first_buy_dates=None, **kwargs):
        super().__init__(**kwargs)
        object.__setattr__(self, "_first_buy_dates", first_buy_dates or {})

    def first_buy_date(self, symbol):
        return self._first_buy_dates.get(symbol)


class _RaisingTicker:
    """Ticker stand-in whose .history() always raises the given exception."""

    def __init__(self, exc):
        self._exc = exc
        self.info = {}

    def history(self, *args, **kwargs):
        raise self._exc


def _build_metrics(shares, mock_influx, mode="manual",
                   first_buy_dates=None, events=None):
    cfg = FakeConfigManager(shares, mode=mode,
                            first_buy_dates=first_buy_dates, events=events)
    metrics = SuiviBourseMetrics(cfg, influxdb_writer=mock_influx)
    return metrics, cfg


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """Make every time.sleep in main a no-op so tests are fast/deterministic."""
    monkeypatch.setattr(main.time, "sleep", lambda *a, **k: None)


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------

def test_constructor_loads_shares_and_connects(mock_influx):
    metrics, cfg = _build_metrics([_valid_shares()], mock_influx)
    assert metrics.shares == [_valid_shares()]
    mock_influx.connect.assert_called_once()


# ---------------------------------------------------------------------------
# _fetch_ticker_data
# ---------------------------------------------------------------------------

def test_fetch_ticker_data_success_and_mapping(mock_influx,
                                               fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker())

    last_quote, info = metrics._fetch_ticker_data("AAPL")

    assert last_quote == 185.0
    assert info["currency"] == "USD"
    assert info["exchange"] == "NMS"
    assert info["quoteType"] == "EQUITY"
    assert info["dividendYield"] == pytest.approx(0.0052)
    # peRatio maps to trailingPE when present
    assert info["peRatio"] == 28.5
    assert info["marketCap"] == 3_000_000_000_000
    # hourly volume = last Volume row (rows=3 default -> 1_000_000 + 1000*2)
    assert info["volume"] == 1_002_000
    # info is cached for backfill reuse
    assert metrics._share_info_cache["AAPL"] == info


def test_fetch_ticker_data_pe_ratio_falls_back_to_forward(mock_influx,
                                                          fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(info={"trailingPE": None}))

    _, info = metrics._fetch_ticker_data("AAPL")
    assert info["peRatio"] == 26.0  # forwardPE


def test_fetch_ticker_data_none_dividend_yield_preserved(
        mock_influx, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(info={"dividendYield": None}))

    _, info = metrics._fetch_ticker_data("AAPL")
    assert info["dividendYield"] is None


def test_fetch_ticker_data_empty_history_returns_none(
        mock_influx, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    empty = fake_ticker(history_df=pd.DataFrame())
    monkeypatch.setattr(main.yf, "Ticker", lambda s: empty)

    assert metrics._fetch_ticker_data("AAPL") == (None, None)


def test_fetch_ticker_data_uses_last_non_nan_close(
        mock_influx, fake_ticker, monkeypatch):
    """Yahoo returns the most recent daily bar with a NaN close for a while
    after a session ends (the daily aggregate lags the intraday data). The fetch
    must fall back to the last row that actually has a close — and still cache
    ``.info`` — instead of bailing on ``(None, None)``; otherwise
    ``_ensure_share_info`` defers ALL backfill whenever the market is closed,
    defeating the missed-session gap-fill (#627)."""
    idx = pd.date_range("2024-01-02", periods=3, freq="D", tz=timezone.utc)
    df = pd.DataFrame(
        {
            "Open": [150.0, 151.0, 152.0],
            "High": [151.0, 152.0, 153.0],
            "Low": [149.0, 150.0, 151.0],
            "Close": [175.0, 176.52, float("nan")],  # last daily bar NaN
            "Volume": [1_000_000, 1_010_000, 1_020_000],
        },
        index=idx,
    )
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(history_df=df))

    last_quote, info = metrics._fetch_ticker_data("AAPL")

    # Last non-NaN close, not the NaN tail row.
    assert last_quote == pytest.approx(176.52)
    # .info is still resolved and cached so backfill can proceed while closed.
    assert info is not None
    assert metrics._share_info_cache["AAPL"] == info


def test_fetch_ticker_data_all_nan_close_returns_none(
        mock_influx, fake_ticker, monkeypatch):
    """A frame with no usable close at all is still rejected as no-data, so a
    NaN price never reaches InfluxDB."""
    idx = pd.date_range("2024-01-02", periods=2, freq="D", tz=timezone.utc)
    df = pd.DataFrame(
        {
            "Open": [150.0, 151.0],
            "High": [151.0, 152.0],
            "Low": [149.0, 150.0],
            "Close": [float("nan"), float("nan")],
            "Volume": [1_000_000, 1_010_000],
        },
        index=idx,
    )
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(history_df=df))

    assert metrics._fetch_ticker_data("AAPL") == (None, None)
    assert "AAPL" not in metrics._share_info_cache


def test_fetch_ticker_data_retries_after_rate_limit(
        mock_influx, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    tickers = iter([_RaisingTicker(YFRateLimitError()), fake_ticker()])
    monkeypatch.setattr(main.yf, "Ticker", lambda s: next(tickers))

    last_quote, info = metrics._fetch_ticker_data("AAPL")
    assert last_quote == 185.0
    assert info is not None


def test_fetch_ticker_data_exhausts_retries_returns_none(
        mock_influx, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: _RaisingTicker(YFRateLimitError()))

    assert metrics._fetch_ticker_data("AAPL", max_retries=3) == (None, None)


def test_fetch_ticker_data_runtime_error_returns_none(
        mock_influx, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: _RaisingTicker(RuntimeError("kaboom")))

    assert metrics._fetch_ticker_data("AAPL") == (None, None)


def test_fetch_ticker_data_connection_error_returns_none(
        mock_influx, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: _RaisingTicker(NewConnectionError(None, "no route")))

    assert metrics._fetch_ticker_data("AAPL") == (None, None)


# ---------------------------------------------------------------------------
# expose_metrics
# ---------------------------------------------------------------------------

def test_expose_metrics_writes_dividend_yield_times_100(
        mock_influx, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker())

    metrics.expose_metrics()

    mock_influx.write_metrics.assert_called_once()
    kwargs = mock_influx.write_metrics.call_args.kwargs
    assert kwargs["share_symbol"] == "AAPL"
    assert kwargs["share_price"] == 185.0
    # dividendYield 0.0052 -> dividend_yield 0.52
    assert kwargs["dividend_yield"] == pytest.approx(0.52)
    assert kwargs["pe_ratio"] == 28.5
    assert kwargs["market_cap"] == 3_000_000_000_000
    assert kwargs["volume"] == 1_002_000
    assert kwargs["share_currency"] == "USD"


def test_expose_metrics_none_dividend_yield_is_none(
        mock_influx, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(info={"dividendYield": None}))

    metrics.expose_metrics()

    kwargs = mock_influx.write_metrics.call_args.kwargs
    assert kwargs["dividend_yield"] is None


def test_expose_metrics_skips_write_when_fetch_fails(
        mock_influx, mocker):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx)
    mocker.patch.object(metrics, "_fetch_ticker_data", return_value=(None, None))

    metrics.expose_metrics()

    mock_influx.write_metrics.assert_not_called()


def test_expose_metrics_write_error_does_not_abort_remaining_shares(
        mock_influx, fake_ticker, monkeypatch):
    shares = [_valid_shares("AAPL", "Apple"), _valid_shares("MSFT", "Microsoft")]
    metrics, _ = _build_metrics(shares, mock_influx)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker())
    # First write raises, second must still be attempted.
    mock_influx.write_metrics.side_effect = [Exception("influx down"), None]

    metrics.expose_metrics()

    assert mock_influx.write_metrics.call_count == 2


# ---------------------------------------------------------------------------
# ingest
# ---------------------------------------------------------------------------

def test_ingest_updates_shares_when_valid_and_different(mock_influx):
    metrics, cfg = _build_metrics([_valid_shares("AAPL", "Apple")], mock_influx)
    new_shares = [_valid_shares("MSFT", "Microsoft")]
    cfg._shares = new_shares

    metrics.ingest()

    assert metrics.shares == new_shares


def test_ingest_keeps_previous_when_publication_fails(mock_influx):
    """A refused configuration never reaches this class.

    Since #658 the rejection happens in the manager, before publication, so
    ``ingest`` sees an exception rather than a bad share list — and the snapshot
    every reader holds is still the last valid one. The rejection itself is
    tested against the real manager in ``test_configuration_manager.py``.
    """
    original = [_valid_shares("AAPL", "Apple")]
    metrics, cfg = _build_metrics(original, mock_influx)
    cfg.raise_on_load = EventValidationError("row 4: SELL of 40 with 18 owned")

    metrics.ingest()

    assert metrics.shares == original


def test_ingest_swallows_exceptions(mock_influx):
    original = [_valid_shares("AAPL", "Apple")]
    metrics, cfg = _build_metrics(original, mock_influx)
    cfg.raise_on_load = True

    # Must not raise
    metrics.ingest()

    assert metrics.shares == original


# ---------------------------------------------------------------------------
# One snapshot per cycle (issue #658)
# ---------------------------------------------------------------------------

def test_shares_is_a_read_of_the_published_snapshot(mock_influx):
    """Not a copy: a republication is visible without anyone assigning it here.

    The second copy is what let scraping and backfill run on two different
    configurations for a cycle.
    """
    metrics, cfg = _build_metrics([_valid_shares("AAPL")], mock_influx)
    cfg._shares = [_valid_shares("MSFT", "Microsoft")]

    assert [s["symbol"] for s in metrics.shares] == ["MSFT"]


def test_backfill_takes_exactly_one_snapshot_for_the_whole_cycle(
        mock_influx, mocker):
    """Shares, events and accounts must come from the same generation.

    They used to be fetched one call at a time (``self.shares``, then
    ``load_accounts()``, then ``get_events()``, then ``get_first_buy_date()``
    per share), so a reload landing mid-cycle could pair this cycle's shares
    with the next cycle's events.
    """
    metrics, cfg = _build_metrics(
        [_valid_shares("AAPL"), _valid_shares("MSFT")], mock_influx,
        mode="events")
    spy = mocker.spy(cfg, "current")

    metrics.backfill()

    assert spy.call_count == 1


def test_recompute_perf_hands_its_snapshot_to_the_recompute(
        mock_influx, mocker, sample_events):
    """The gate and the recompute must judge the same configuration."""
    metrics, cfg = _build_metrics([_valid_shares("AAPL")], mock_influx,
                                  mode="events",
                                  events=sample_events)
    recompute = mocker.patch.object(metrics, "update_account_metrics")

    metrics.recompute_perf()

    recompute.assert_called_once()
    assert recompute.call_args.args[0].events is sample_events


# ---------------------------------------------------------------------------
# scrape
# ---------------------------------------------------------------------------

def test_scrape_returns_when_no_shares(mock_influx, mocker):
    metrics, cfg = _build_metrics([_valid_shares()], mock_influx)
    cfg._shares = []
    spy = mocker.spy(metrics, "expose_metrics")

    metrics.scrape()

    spy.assert_not_called()
    mock_influx.write_metrics.assert_not_called()


# ---------------------------------------------------------------------------
# backfill
# ---------------------------------------------------------------------------

def test_backfill_returns_when_no_shares(mock_influx):
    metrics, cfg = _build_metrics([_valid_shares()], mock_influx,
                                  mode="events")
    cfg._shares = []

    metrics.backfill()

    mock_influx.get_oldest_timestamp.assert_not_called()
    mock_influx.write_historical_prices.assert_not_called()


def test_backfill_returns_when_mode_not_events(mock_influx):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx,
                                mode="manual")

    metrics.backfill()

    mock_influx.get_oldest_timestamp.assert_not_called()
    mock_influx.write_historical_prices.assert_not_called()


def test_backfill_marks_complete_when_oldest_reaches_first_buy(
        mock_influx):
    first_buy = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], mock_influx,
        mode="events", first_buy_dates={"AAPL": first_buy})
    # Pre-populate info cache so no yfinance call happens.
    metrics._share_info_cache["AAPL"] = {
        "currency": "USD", "exchange": "NMS", "quoteType": "EQUITY"}
    metrics.backfill_chunk_days = 365
    # Oldest data already predates the first BUY date.
    mock_influx.get_oldest_timestamp.return_value = datetime(2024, 1, 10,
                                                             tzinfo=timezone.utc)

    metrics.backfill()

    mock_influx.write_historical_prices.assert_not_called()
    expected = datetime(2024, 1, 15, 0, 0, 0, tzinfo=timezone.utc)
    # Completion is tracked per (symbol, account); default account here.
    assert metrics._backfill_complete[("AAPL", "default")] == expected


def test_backfill_fetches_chunk_when_gap_exists(mock_influx, mocker):
    first_buy = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], mock_influx,
        mode="events", first_buy_dates={"AAPL": first_buy}, events=None)
    metrics._share_info_cache["AAPL"] = {
        "currency": "USD", "exchange": "NMS", "quoteType": "EQUITY"}
    metrics.backfill_chunk_days = 365
    # Oldest data well after first BUY -> a gap to fill.
    mock_influx.get_oldest_timestamp.return_value = datetime(
        2024, 6, 1, tzinfo=timezone.utc)
    canned = [{"timestamp": datetime(2024, 3, 1, tzinfo=timezone.utc), "price": 170.0}]
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=canned)
    mock_influx.write_historical_prices.return_value = 1

    metrics.backfill()

    mock_influx.write_historical_prices.assert_called_once()
    kwargs = mock_influx.write_historical_prices.call_args.kwargs
    assert kwargs["share_symbol"] == "AAPL"
    assert kwargs["share_name"] == "Apple"
    assert kwargs["prices"] == canned
    assert kwargs["share_currency"] == "USD"


def test_backfill_does_single_replay_per_cycle(
        mock_influx, mocker, sample_events):
    """One replay serves every symbol, regardless of the number of shares."""
    import main
    first_buys = {"AAPL": date(2024, 1, 15), "MSFT": date(2024, 2, 1)}
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple"), _valid_shares("MSFT", "Microsoft")],
        mock_influx, mode="events",
        first_buy_dates=first_buys, events=sample_events)
    for sym in ("AAPL", "MSFT"):
        metrics._share_info_cache[sym] = {
            "currency": "USD", "exchange": "NMS", "quoteType": "EQUITY"}
    metrics.backfill_chunk_days = 365
    mock_influx.get_oldest_timestamp.return_value = datetime(
        2024, 6, 1, tzinfo=timezone.utc)
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=[
        {"timestamp": datetime(2024, 3, 1, tzinfo=timezone.utc), "price": 170.0}])
    mock_influx.write_historical_prices.return_value = 1

    spy = mocker.spy(main.EventAggregator, "replay")
    metrics.backfill()

    # Exactly one replay for the whole cycle (two shares), not one per share.
    assert spy.call_count == 1


def test_backfill_write_failure_does_not_abort_remaining_shares(
        mock_influx, mocker):
    first_buys = {"AAPL": date(2024, 1, 15), "MSFT": date(2024, 1, 15)}
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple"), _valid_shares("MSFT", "Microsoft")],
        mock_influx, mode="events",
        first_buy_dates=first_buys, events=None)
    metrics._share_info_cache["AAPL"] = {
        "currency": "USD", "exchange": "NMS", "quoteType": "EQUITY"}
    metrics._share_info_cache["MSFT"] = {
        "currency": "USD", "exchange": "NMS", "quoteType": "EQUITY"}
    metrics.backfill_chunk_days = 365
    mock_influx.get_oldest_timestamp.return_value = datetime(
        2024, 6, 1, tzinfo=timezone.utc)
    canned = [{"timestamp": datetime(2024, 3, 1, tzinfo=timezone.utc), "price": 170.0}]
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=canned)
    # First share's write raises; the loop must still attempt the second one.
    mock_influx.write_historical_prices.side_effect = [Exception("influx down"), 1]

    # Must not propagate the exception out of the per-share loop.
    metrics.backfill()

    assert mock_influx.write_historical_prices.call_count == 2
    symbols_written = [
        c.kwargs["share_symbol"]
        for c in mock_influx.write_historical_prices.call_args_list]
    assert symbols_written == ["AAPL", "MSFT"]


# ---------------------------------------------------------------------------
# backfill — forward gap-fill pass (issue #627)
# ---------------------------------------------------------------------------

def test_backfill_forward_fills_recent_gap(mock_influx, mocker):
    """A session missed while down (old newest) is recovered by the forward pass,
    carrying the same tags/account as live points, even when the backward pass is
    already complete (the two directions are independent)."""
    first_buy = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], mock_influx,
        mode="events", first_buy_dates={"AAPL": first_buy}, events=None)
    metrics._share_info_cache["AAPL"] = {
        "currency": "USD", "exchange": "NMS", "quoteType": "EQUITY"}
    metrics.backfill_chunk_days = 365
    # Backward already complete -> only the forward pass should act.
    metrics._backfill_complete[("AAPL", "default")] = datetime(
        2024, 1, 15, tzinfo=timezone.utc)
    # Newest stored point is old enough to leave a gap to fill up to now.
    mock_influx.get_newest_timestamp.return_value = datetime(
        2024, 6, 1, tzinfo=timezone.utc)
    canned = [{"timestamp": datetime(2024, 6, 3, tzinfo=timezone.utc), "price": 175.0}]
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=canned)
    mock_influx.write_historical_prices.return_value = 1

    metrics.backfill()

    # Backward complete -> its oldest lookup is never issued; forward drives it.
    mock_influx.get_oldest_timestamp.assert_not_called()
    mock_influx.get_newest_timestamp.assert_called_once_with("AAPL", account="default")
    mock_influx.write_historical_prices.assert_called_once()
    kwargs = mock_influx.write_historical_prices.call_args.kwargs
    assert kwargs["share_symbol"] == "AAPL"
    assert kwargs["account"] == "default"
    assert kwargs["share_currency"] == "USD"
    assert kwargs["share_exchange"] == "NMS"
    assert kwargs["prices"] == canned


def test_backfill_forward_empty_window_writes_nothing(
        mock_influx, mocker):
    """A weekend/holiday gap: yfinance returns no rows for the forward window, so
    nothing is written (self-classifying, no calendar logic)."""
    first_buy = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], mock_influx,
        mode="events", first_buy_dates={"AAPL": first_buy}, events=None)
    metrics._share_info_cache["AAPL"] = {
        "currency": "USD", "exchange": "NMS", "quoteType": "EQUITY"}
    metrics.backfill_chunk_days = 365
    metrics._backfill_complete[("AAPL", "default")] = datetime(
        2024, 1, 15, tzinfo=timezone.utc)
    mock_influx.get_newest_timestamp.return_value = datetime(
        2024, 6, 1, tzinfo=timezone.utc)
    # yfinance returns no rows for the window -> empty, a no-op.
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=[])
    mocker.patch("main.time.sleep")

    metrics.backfill()

    mock_influx.write_historical_prices.assert_not_called()


def test_backfill_forward_noop_when_series_empty(
        mock_influx, mocker):
    """No stored point yet (newest None): the forward pass has no anchor and the
    backward pass owns seeding the series, so no forward fetch happens."""
    first_buy = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], mock_influx,
        mode="events", first_buy_dates={"AAPL": first_buy}, events=None)
    metrics._share_info_cache["AAPL"] = {
        "currency": "USD", "exchange": "NMS", "quoteType": "EQUITY"}
    metrics.backfill_chunk_days = 365
    metrics._backfill_complete[("AAPL", "default")] = datetime(
        2024, 1, 15, tzinfo=timezone.utc)
    mock_influx.get_newest_timestamp.return_value = None
    fetch = mocker.patch.object(metrics, "_fetch_historical_data", return_value=[])

    metrics.backfill()

    fetch.assert_not_called()
    mock_influx.write_historical_prices.assert_not_called()


def test_backfill_runs_both_directions_in_one_cycle(
        mock_influx, mocker):
    """When both an older gap (backward) and a recent gap (forward) exist, a
    single cycle fills both for the same symbol."""
    first_buy = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], mock_influx,
        mode="events", first_buy_dates={"AAPL": first_buy}, events=None)
    metrics._share_info_cache["AAPL"] = {
        "currency": "USD", "exchange": "NMS", "quoteType": "EQUITY"}
    metrics.backfill_chunk_days = 365
    # Oldest after first BUY -> a backward gap; newest old -> a forward gap.
    mock_influx.get_oldest_timestamp.return_value = datetime(
        2024, 6, 1, tzinfo=timezone.utc)
    mock_influx.get_newest_timestamp.return_value = datetime(
        2024, 6, 10, tzinfo=timezone.utc)
    canned = [{"timestamp": datetime(2024, 6, 3, tzinfo=timezone.utc), "price": 170.0}]
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=canned)
    mocker.patch("main.time.sleep")
    mock_influx.write_historical_prices.return_value = 1

    metrics.backfill()

    # One write for the backward chunk, one for the forward chunk.
    assert mock_influx.write_historical_prices.call_count == 2
    # Backward pass never marked complete (the older gap remains open).
    assert ("AAPL", "default") not in metrics._backfill_complete


def test_backfill_empty_window_marks_complete(mock_influx, mocker):
    first_buy = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], mock_influx,
        mode="events", first_buy_dates={"AAPL": first_buy})
    metrics._share_info_cache["AAPL"] = {
        "currency": "USD", "exchange": "NMS", "quoteType": "EQUITY"}
    metrics.backfill_chunk_days = 365
    # end_date=2024-03-01, chunk clamps start_date to first_buy (2024-01-15).
    mock_influx.get_oldest_timestamp.return_value = datetime(
        2024, 3, 1, tzinfo=timezone.utc)
    # Empty (but non-None) window: fetch succeeded with no rows.
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=[])

    metrics.backfill()

    mock_influx.write_historical_prices.assert_not_called()
    expected = datetime(2024, 1, 15, 0, 0, 0, tzinfo=timezone.utc)
    assert metrics._backfill_complete[("AAPL", "default")] == expected
