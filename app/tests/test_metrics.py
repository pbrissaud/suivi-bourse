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

    Exposes exactly the surface SuiviBourseMetrics relies on: load_shares(),
    get_mode(), get_first_buy_date(), get_events(), load_accounts().
    """

    def __init__(self, shares, mode="manual", first_buy_dates=None, events=None,
                 accounts=None):
        self._shares = shares
        self._mode = mode
        self._first_buy_dates = first_buy_dates or {}
        self._events = events
        self._accounts = accounts
        self.raise_on_load = False

    def load_shares(self, force=False):
        if self.raise_on_load:
            raise RuntimeError("boom loading shares")
        return self._shares

    def get_mode(self):
        return self._mode

    def load_accounts(self):
        return self._accounts

    def get_first_buy_date(self, symbol):
        return self._first_buy_dates.get(symbol)

    def get_events(self):
        return self._events


class _RaisingTicker:
    """Ticker stand-in whose .history() always raises the given exception."""

    def __init__(self, exc):
        self._exc = exc
        self.info = {}

    def history(self, *args, **kwargs):
        raise self._exc


def _build_metrics(shares, mock_influx, shares_validator, mode="manual",
                   first_buy_dates=None, events=None):
    cfg = FakeConfigManager(shares, mode=mode,
                            first_buy_dates=first_buy_dates, events=events)
    metrics = SuiviBourseMetrics(cfg, shares_validator, influxdb_writer=mock_influx)
    return metrics, cfg


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """Make every time.sleep in main a no-op so tests are fast/deterministic."""
    monkeypatch.setattr(main.time, "sleep", lambda *a, **k: None)


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------

def test_constructor_loads_shares_and_connects(mock_influx, shares_validator):
    metrics, cfg = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    assert metrics.shares == [_valid_shares()]
    mock_influx.connect.assert_called_once()


# ---------------------------------------------------------------------------
# _fetch_ticker_data
# ---------------------------------------------------------------------------

def test_fetch_ticker_data_success_and_mapping(mock_influx, shares_validator,
                                               fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
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


def test_fetch_ticker_data_pe_ratio_falls_back_to_forward(mock_influx, shares_validator,
                                                          fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(info={"trailingPE": None}))

    _, info = metrics._fetch_ticker_data("AAPL")
    assert info["peRatio"] == 26.0  # forwardPE


def test_fetch_ticker_data_none_dividend_yield_preserved(
        mock_influx, shares_validator, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(info={"dividendYield": None}))

    _, info = metrics._fetch_ticker_data("AAPL")
    assert info["dividendYield"] is None


def test_fetch_ticker_data_empty_history_returns_none(
        mock_influx, shares_validator, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    empty = fake_ticker(history_df=pd.DataFrame())
    monkeypatch.setattr(main.yf, "Ticker", lambda s: empty)

    assert metrics._fetch_ticker_data("AAPL") == (None, None)


def test_fetch_ticker_data_retries_after_rate_limit(
        mock_influx, shares_validator, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    tickers = iter([_RaisingTicker(YFRateLimitError()), fake_ticker()])
    monkeypatch.setattr(main.yf, "Ticker", lambda s: next(tickers))

    last_quote, info = metrics._fetch_ticker_data("AAPL")
    assert last_quote == 185.0
    assert info is not None


def test_fetch_ticker_data_exhausts_retries_returns_none(
        mock_influx, shares_validator, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: _RaisingTicker(YFRateLimitError()))

    assert metrics._fetch_ticker_data("AAPL", max_retries=3) == (None, None)


def test_fetch_ticker_data_runtime_error_returns_none(
        mock_influx, shares_validator, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: _RaisingTicker(RuntimeError("kaboom")))

    assert metrics._fetch_ticker_data("AAPL") == (None, None)


def test_fetch_ticker_data_connection_error_returns_none(
        mock_influx, shares_validator, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: _RaisingTicker(NewConnectionError(None, "no route")))

    assert metrics._fetch_ticker_data("AAPL") == (None, None)


# ---------------------------------------------------------------------------
# expose_metrics
# ---------------------------------------------------------------------------

def test_expose_metrics_writes_dividend_yield_times_100(
        mock_influx, shares_validator, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
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
        mock_influx, shares_validator, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(info={"dividendYield": None}))

    metrics.expose_metrics()

    kwargs = mock_influx.write_metrics.call_args.kwargs
    assert kwargs["dividend_yield"] is None


def test_expose_metrics_skips_write_when_fetch_fails(
        mock_influx, shares_validator, mocker):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    mocker.patch.object(metrics, "_fetch_ticker_data", return_value=(None, None))

    metrics.expose_metrics()

    mock_influx.write_metrics.assert_not_called()


def test_expose_metrics_write_error_does_not_abort_remaining_shares(
        mock_influx, shares_validator, fake_ticker, monkeypatch):
    shares = [_valid_shares("AAPL", "Apple"), _valid_shares("MSFT", "Microsoft")]
    metrics, _ = _build_metrics(shares, mock_influx, shares_validator)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker())
    # First write raises, second must still be attempted.
    mock_influx.write_metrics.side_effect = [Exception("influx down"), None]

    metrics.expose_metrics()

    assert mock_influx.write_metrics.call_count == 2


# ---------------------------------------------------------------------------
# ingest
# ---------------------------------------------------------------------------

def test_ingest_updates_shares_when_valid_and_different(mock_influx, shares_validator):
    metrics, cfg = _build_metrics([_valid_shares("AAPL", "Apple")], mock_influx,
                                  shares_validator)
    new_shares = [_valid_shares("MSFT", "Microsoft")]
    cfg._shares = new_shares

    metrics.ingest()

    assert metrics.shares == new_shares


def test_ingest_keeps_previous_when_new_config_invalid(mock_influx, shares_validator):
    original = [_valid_shares("AAPL", "Apple")]
    metrics, cfg = _build_metrics(original, mock_influx, shares_validator)
    # Missing required purchase/estate blocks -> invalid per schema.yaml
    cfg._shares = [{"name": "Broken", "symbol": "BAD"}]

    metrics.ingest()

    assert metrics.shares == original


def test_ingest_swallows_exceptions(mock_influx, shares_validator):
    original = [_valid_shares("AAPL", "Apple")]
    metrics, cfg = _build_metrics(original, mock_influx, shares_validator)
    cfg.raise_on_load = True

    # Must not raise
    metrics.ingest()

    assert metrics.shares == original


# ---------------------------------------------------------------------------
# scrape
# ---------------------------------------------------------------------------

def test_scrape_returns_when_no_shares(mock_influx, shares_validator, mocker):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator)
    metrics.shares = []
    spy = mocker.spy(metrics, "expose_metrics")

    metrics.scrape()

    spy.assert_not_called()
    mock_influx.write_metrics.assert_not_called()


# ---------------------------------------------------------------------------
# backfill
# ---------------------------------------------------------------------------

def test_backfill_returns_when_no_shares(mock_influx, shares_validator):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator,
                                mode="events")
    metrics.shares = []

    metrics.backfill()

    mock_influx.get_oldest_timestamp.assert_not_called()
    mock_influx.write_historical_prices.assert_not_called()


def test_backfill_returns_when_mode_not_events(mock_influx, shares_validator):
    metrics, _ = _build_metrics([_valid_shares()], mock_influx, shares_validator,
                                mode="manual")

    metrics.backfill()

    mock_influx.get_oldest_timestamp.assert_not_called()
    mock_influx.write_historical_prices.assert_not_called()


def test_backfill_marks_complete_when_oldest_reaches_first_buy(
        mock_influx, shares_validator):
    first_buy = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], mock_influx, shares_validator,
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


def test_backfill_fetches_chunk_when_gap_exists(mock_influx, shares_validator, mocker):
    first_buy = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], mock_influx, shares_validator,
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
        mock_influx, shares_validator, mocker, sample_events):
    """One replay serves every symbol, regardless of the number of shares."""
    import main
    first_buys = {"AAPL": date(2024, 1, 15), "MSFT": date(2024, 2, 1)}
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple"), _valid_shares("MSFT", "Microsoft")],
        mock_influx, shares_validator, mode="events",
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
        mock_influx, shares_validator, mocker):
    first_buys = {"AAPL": date(2024, 1, 15), "MSFT": date(2024, 1, 15)}
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple"), _valid_shares("MSFT", "Microsoft")],
        mock_influx, shares_validator, mode="events",
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


def test_backfill_empty_window_marks_complete(mock_influx, shares_validator, mocker):
    first_buy = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], mock_influx, shares_validator,
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
