"""
True end-to-end wiring tests for SuiviBourse.

These exercise the *whole* application with every external boundary mocked:
  * yfinance  -> monkeypatched ``main.yf.Ticker`` returning canned frames/info
  * InfluxDB  -> ``MagicMock(spec=InfluxDBWriter)`` (the ``mock_influx`` fixture)
  * time.sleep-> no-op (so rate-limit pauses never actually sleep)

A real ``ConfigurationManager`` reads a real CSV written into ``tmp_path`` and a
real ``SuiviBourseMetrics`` drives the full pipeline
loader -> validator -> aggregator -> scrape / backfill. Assertions compare the
values the writer receives against portfolio state hand-computed from the CSV.

No network is ever touched.
"""

import pytest

import main
from main import ConfigurationManager, SuiviBourseMetrics
from events.aggregator import AggregationError

from datetime import datetime, timezone


# --------------------------------------------------------------------------- #
# Canonical events CSV used by the events-mode tests.
#
# Columns match docker-compose/events/example.csv. Hand-computed end state
# (verified against the real EventAggregator):
#
#   AAPL: purchase.quantity=20, cost_price=143.75, fee=7.50
#         estate.quantity=18, received_dividend=2.40
#   MSFT: purchase.quantity=5,  cost_price=380.0,  fee=2.50
#         estate.quantity=5,  received_dividend=5.00
#
# Intermediate AAPL state on 2024-06-20 (before the 2024-09-15 SELL):
#   purchase.quantity=20, cost_price=143.75, fee=5.50
#   estate.quantity=21, received_dividend=2.40
# --------------------------------------------------------------------------- #
EVENTS_CSV = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2023-06-01,BUY,AAPL,Apple Inc,5,100.00,1.00,,Very early purchase\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
    "2024-02-01,BUY,MSFT,Microsoft,5,380.00,2.50,,Initial purchase\n"
    "2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,2.40,Q1 2024 dividend\n"
    "2024-06-01,GRANT,AAPL,Apple Inc,1,,,,Bonus share\n"
    "2024-06-15,BUY,AAPL,Apple Inc,5,175.00,2.00,,Additional purchase\n"
    "2024-09-15,SELL,AAPL,Apple Inc,3,190.00,2.00,,Partial sale\n"
    "2025-01-30,DIVIDEND,MSFT,Microsoft,,,,5.00,New dividend\n"
)

# Per-symbol last-close prices returned by the fake ticker in scrape tests.
TICKER_CLOSE = {"AAPL": 190.0, "MSFT": 400.0}


# --------------------------------------------------------------------------- #
# Local helpers (kept in this module so parallel agents' conftest is untouched)
# --------------------------------------------------------------------------- #
def _make_fake_ticker(fake_ticker, close):
    """Build a yfinance.Ticker stand-in with a given last-close price."""
    return fake_ticker(close=close)


def _patch_ticker(monkeypatch, fake_ticker):
    """Route ``main.yf.Ticker(symbol)`` to a per-symbol fake ticker."""
    def factory(symbol):
        return _make_fake_ticker(fake_ticker, TICKER_CLOSE.get(symbol, 100.0))
    monkeypatch.setattr(main.yf, "Ticker", factory)


def _no_sleep(monkeypatch):
    """Make every ``time.sleep`` in main a no-op (deterministic + fast)."""
    monkeypatch.setattr(main.time, "sleep", lambda *a, **k: None)


def _events_config_via_settings(tmp_path, monkeypatch):
    """Real ConfigurationManager in events mode, wired through settings.yaml.

    Writes the CSV into ``<config_dir>/events/2024.csv`` and a settings.yaml
    selecting events mode. Ensures SB_CONFIG_MODE is unset so settings.yaml
    actually drives the mode (env var would otherwise win).
    """
    monkeypatch.delenv("SB_CONFIG_MODE", raising=False)
    config_dir = tmp_path / "config"
    events_dir = config_dir / "events"
    events_dir.mkdir(parents=True)
    (events_dir / "2024.csv").write_text(EVENTS_CSV, encoding="utf-8")
    (config_dir / "settings.yaml").write_text(
        "mode: events\n"
        "events:\n"
        f"  source: {events_dir}\n",
        encoding="utf-8",
    )
    return ConfigurationManager(config_dir=str(config_dir))


def _events_config_via_env(tmp_path, monkeypatch, csv_text=EVENTS_CSV):
    """Real ConfigurationManager in events mode, selected via SB_CONFIG_MODE.

    The events source defaults to ``<config_dir>/events`` when settings.yaml is
    absent, so we drop the CSV there.
    """
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    config_dir = tmp_path / "config"
    events_dir = config_dir / "events"
    events_dir.mkdir(parents=True)
    (events_dir / "2024.csv").write_text(csv_text, encoding="utf-8")
    return ConfigurationManager(config_dir=str(config_dir))


# --------------------------------------------------------------------------- #
# 1. Full events-mode chain: loader -> validator -> aggregator -> scrape
# --------------------------------------------------------------------------- #
def test_events_mode_full_chain_drives_write_metrics(
    tmp_path, monkeypatch, fake_ticker, mock_influx, shares_validator
):
    """The whole events pipeline feeds correct portfolio state into write_metrics."""
    _no_sleep(monkeypatch)
    _patch_ticker(monkeypatch, fake_ticker)

    config_manager = _events_config_via_settings(tmp_path, monkeypatch)

    # Sanity: mode really came from settings.yaml, not a stray env var.
    assert config_manager.get_mode() == "events"

    sb = SuiviBourseMetrics(
        config_manager, shares_validator, influxdb_writer=mock_influx
    )

    # __init__ connected to (mocked) InfluxDB and loaded shares through the
    # real loader -> validator -> aggregator chain.
    mock_influx.connect.assert_called_once()

    shares_by_symbol = {s["symbol"]: s for s in sb.shares}
    assert set(shares_by_symbol) == {"AAPL", "MSFT"}

    aapl = shares_by_symbol["AAPL"]
    assert aapl["purchase"]["quantity"] == pytest.approx(20.0)
    assert aapl["purchase"]["cost_price"] == pytest.approx(143.75)
    assert aapl["purchase"]["fee"] == pytest.approx(7.5)
    assert aapl["estate"]["quantity"] == pytest.approx(18.0)
    assert aapl["estate"]["received_dividend"] == pytest.approx(2.4)

    # Aggregated portfolio must satisfy the production cerberus schema.
    assert shares_validator.validate({"shares": sb.shares}), shares_validator.errors

    # Drive the real scrape (fetch prices -> write metrics).
    sb.scrape()

    calls = {
        c.kwargs["share_symbol"]: c.kwargs
        for c in mock_influx.write_metrics.call_args_list
    }
    assert set(calls) == {"AAPL", "MSFT"}

    aapl_call = calls["AAPL"]
    assert aapl_call["share_name"] == "Apple Inc"
    assert aapl_call["share_price"] == pytest.approx(190.0)  # fake ticker close
    assert aapl_call["purchased_quantity"] == pytest.approx(20.0)
    assert aapl_call["purchased_price"] == pytest.approx(143.75)
    assert aapl_call["purchased_fee"] == pytest.approx(7.5)
    assert aapl_call["owned_quantity"] == pytest.approx(18.0)
    assert aapl_call["received_dividend"] == pytest.approx(2.4)
    # Enrichment tags/fields sourced from ticker.info (fake_ticker defaults).
    assert aapl_call["share_currency"] == "USD"
    assert aapl_call["share_exchange"] == "NMS"
    assert aapl_call["quote_type"] == "EQUITY"
    assert aapl_call["dividend_yield"] == pytest.approx(0.52)  # 0.0052 * 100

    msft_call = calls["MSFT"]
    assert msft_call["share_name"] == "Microsoft"
    assert msft_call["share_price"] == pytest.approx(400.0)
    assert msft_call["purchased_quantity"] == pytest.approx(5.0)
    assert msft_call["purchased_price"] == pytest.approx(380.0)
    assert msft_call["purchased_fee"] == pytest.approx(2.5)
    assert msft_call["owned_quantity"] == pytest.approx(5.0)
    assert msft_call["received_dividend"] == pytest.approx(5.0)


# --------------------------------------------------------------------------- #
# 2. Backfill writes historically-correct portfolio state for an intermediate date
# --------------------------------------------------------------------------- #
def test_backfill_writes_historical_state_for_intermediate_date(
    tmp_path, monkeypatch, fake_ticker, mock_influx, shares_validator
):
    """backfill() enriches each price point with aggregate_until_date state."""
    _no_sleep(monkeypatch)
    _patch_ticker(monkeypatch, fake_ticker)

    config_manager = _events_config_via_env(tmp_path, monkeypatch)
    sb = SuiviBourseMetrics(
        config_manager, shares_validator, influxdb_writer=mock_influx
    )

    # No existing data in InfluxDB -> backfill fetches a fresh chunk.
    mock_influx.get_oldest_timestamp.return_value = None

    intermediate = datetime(2024, 6, 20, 15, 0, tzinfo=timezone.utc)

    # Canned historical fetch: one price point for AAPL on the intermediate
    # date, nothing for MSFT. Assigned as an instance attribute so it shadows
    # the bound method and is called as (symbol, start, end) with no self.
    def canned_fetch(symbol, start, end):
        if symbol == "AAPL":
            return [{
                "timestamp": intermediate,
                "price": 180.0,
                "price_open": 179.0,
                "price_high": 181.0,
                "price_low": 178.0,
                "volume": 900_000,
            }]
        return []

    sb._fetch_historical_data = canned_fetch

    sb.backfill()

    # Only AAPL produced rows, so exactly one historical write.
    mock_influx.write_historical_prices.assert_called_once()
    call = mock_influx.write_historical_prices.call_args
    assert call.kwargs["share_symbol"] == "AAPL"
    assert call.kwargs["share_name"] == "Apple Inc"
    # Tags come from the info the (fake) scrape cache resolved.
    assert call.kwargs["share_currency"] == "USD"
    assert call.kwargs["share_exchange"] == "NMS"
    assert call.kwargs["quote_type"] == "EQUITY"

    prices = call.kwargs["prices"]
    assert len(prices) == 1
    point = prices[0]

    # Raw price data preserved.
    assert point["timestamp"] == intermediate
    assert point["price"] == pytest.approx(180.0)

    # Portfolio state enriched from events == aggregate_until_date(2024-06-20).
    assert point["purchased_quantity"] == pytest.approx(20.0)
    assert point["purchased_price"] == pytest.approx(143.75)
    assert point["purchased_fee"] == pytest.approx(5.5)   # SELL not yet applied
    assert point["owned_quantity"] == pytest.approx(21.0)  # GRANT+BUYs, no SELL
    assert point["received_dividend"] == pytest.approx(2.4)

    # Cross-check against the real aggregator to prove the state is not hardcoded.
    from events.aggregator import EventAggregator
    from datetime import date as _date
    expected = EventAggregator().aggregate_until_date(
        config_manager.get_events(), _date(2024, 6, 20), "AAPL"
    )
    assert point["purchased_quantity"] == expected["purchase"]["quantity"]
    assert point["owned_quantity"] == expected["estate"]["quantity"]
    assert point["received_dividend"] == expected["estate"]["received_dividend"]


# --------------------------------------------------------------------------- #
# 3. Manual-mode E2E: config.yaml (via a fake confuse Configuration) -> scrape
# --------------------------------------------------------------------------- #
def test_manual_mode_full_chain_drives_write_metrics(
    tmp_path, monkeypatch, fake_ticker, mock_influx, shares_validator
):
    """Manual mode reads config.yaml shares and scrape writes their metrics."""
    _no_sleep(monkeypatch)
    _patch_ticker(monkeypatch, fake_ticker)
    monkeypatch.delenv("SB_CONFIG_MODE", raising=False)

    manual_shares = [{
        "name": "Apple",
        "symbol": "AAPL",
        "purchase": {"quantity": 2, "fee": 2, "cost_price": 119.98},
        "estate": {"quantity": 2, "received_dividend": 2.85},
    }]

    class _FakeConfuseConfig:
        """Minimal stand-in for confuse.Configuration used by manual mode."""
        def __init__(self, appname, modname):
            self._shares = manual_shares

        def __getitem__(self, key):
            assert key == "shares"
            return self

        def get(self):
            return self._shares

        def reload(self):
            pass

    monkeypatch.setattr(main, "Configuration", _FakeConfuseConfig)

    # No settings.yaml, no env var -> defaults to manual mode.
    config_manager = ConfigurationManager(config_dir=str(tmp_path / "config"))
    assert config_manager.get_mode() == "manual"

    sb = SuiviBourseMetrics(
        config_manager, shares_validator, influxdb_writer=mock_influx
    )
    assert sb.shares == manual_shares

    sb.scrape()

    mock_influx.write_metrics.assert_called_once()
    kwargs = mock_influx.write_metrics.call_args.kwargs
    assert kwargs["share_symbol"] == "AAPL"
    assert kwargs["share_name"] == "Apple"
    assert kwargs["share_price"] == pytest.approx(190.0)
    assert kwargs["purchased_quantity"] == pytest.approx(2)
    assert kwargs["purchased_price"] == pytest.approx(119.98)
    assert kwargs["purchased_fee"] == pytest.approx(2)
    assert kwargs["owned_quantity"] == pytest.approx(2)
    assert kwargs["received_dividend"] == pytest.approx(2.85)


# --------------------------------------------------------------------------- #
# 4. Negative path: an over-selling CSV surfaces as AggregationError
# --------------------------------------------------------------------------- #
def test_oversell_csv_raises_aggregation_error_through_config_manager(
    tmp_path, monkeypatch
):
    """A SELL exceeding holdings must propagate as AggregationError.

    The SELL is otherwise valid (positive quantity/unit_price) so it clears the
    EventValidator and fails only at aggregation time -- proving the error is
    an AggregationError, not an EventValidationError.
    """
    bad_csv = (
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2024-01-15,BUY,AAPL,Apple Inc,5,150.00,2.50,,Buy five\n"
        "2024-02-15,SELL,AAPL,Apple Inc,10,190.00,2.00,,Oversell ten\n"
    )
    config_manager = _events_config_via_env(
        tmp_path, monkeypatch, csv_text=bad_csv
    )

    with pytest.raises(AggregationError):
        config_manager.load_shares()
