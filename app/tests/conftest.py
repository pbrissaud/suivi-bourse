"""
Shared pytest fixtures for the SuiviBourse test suite.

`pytest.ini` sets ``pythonpath = src`` so tests (and this conftest) import the
application modules exactly like ``app/src/main.py`` does::

    import main
    import influxdb_writer
    from events import EventLoader, EventValidator, EventAggregator
    from events.schemas import Event, EventType, ShareState

All fixtures below are project-wide (auto-discovered by any ``test_*.py`` under
``app/tests/``). Keep them generic; put test-specific data in the test module.
"""

from pathlib import Path
from datetime import date, timezone

import pandas as pd
import pytest
import yaml
from cerberus import Validator

from events.schemas import Event, EventType
from influxdb_writer import InfluxDBWriter


# Path to app/src/schema.yaml, resolved relative to this conftest (app/tests/).
_SRC_DIR = Path(__file__).resolve().parent.parent / "src"
_SCHEMA_PATH = _SRC_DIR / "schema.yaml"

# Canonical valid events CSV. Same columns as docker-compose/events/example.csv:
#   date,event_type,symbol,name,quantity,unit_price,fee,amount,notes
# Covers BUY/GRANT/DIVIDEND/SELL across two symbols (AAPL, MSFT). Rows are in
# date order and load/validate/aggregate cleanly through the events pipeline.
_EXAMPLE_CSV = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
    "2024-02-01,BUY,MSFT,Microsoft,5,380.00,2.50,,Initial purchase\n"
    "2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,2.40,Q1 2024 dividend\n"
    "2024-06-01,GRANT,AAPL,Apple Inc,1,,,,Bonus share\n"
    "2024-06-15,BUY,AAPL,Apple Inc,5,175.00,2.00,,Additional purchase\n"
    "2024-09-15,SELL,AAPL,Apple Inc,3,190.00,2.00,,Partial sale\n"
    "2025-01-30,DIVIDEND,MSFT,Microsoft,,,,5.00,New dividend\n"
)


@pytest.fixture
def sample_events():
    """A list[events.schemas.Event] pre-sorted by date.

    Covers every EventType (BUY, GRANT, DIVIDEND, SELL) across two symbols
    (AAPL and MSFT). Mirrors ``_EXAMPLE_CSV`` so aggregation results line up
    with the ``events_csv`` / ``events_dir`` fixtures. Safe to pass straight to
    EventValidator.validate / EventAggregator.aggregate.
    """
    return [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.00, fee=2.50, notes="Initial purchase"),
        Event(date(2024, 2, 1), EventType.BUY, "MSFT", "Microsoft",
              quantity=5, unit_price=380.00, fee=2.50, notes="Initial purchase"),
        Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple Inc",
              amount=2.40, notes="Q1 2024 dividend"),
        Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
              quantity=1, notes="Bonus share"),
        Event(date(2024, 6, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=5, unit_price=175.00, fee=2.00, notes="Additional purchase"),
        Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
              quantity=3, unit_price=190.00, fee=2.00, notes="Partial sale"),
        Event(date(2025, 1, 30), EventType.DIVIDEND, "MSFT", "Microsoft",
              amount=5.00, notes="New dividend"),
    ]


@pytest.fixture
def events_csv(tmp_path):
    """Write a valid events CSV into tmp_path and return its Path.

    Columns match docker-compose/events/example.csv. Point an EventLoader or
    ConfigurationManager at the returned file path to exercise CSV loading.
    """
    csv_path = tmp_path / "events.csv"
    csv_path.write_text(_EXAMPLE_CSV, encoding="utf-8")
    return csv_path


@pytest.fixture
def events_dir(tmp_path):
    """Create a directory holding the valid events CSV and return the dir Path.

    Use as the ``source`` for EventLoader(dir) or ConfigurationManager in events
    mode (which scans the directory for ``*.csv`` / ``*.xlsx``). The CSV lives at
    ``<dir>/2024.csv``.
    """
    d = tmp_path / "events"
    d.mkdir()
    (d / "2024.csv").write_text(_EXAMPLE_CSV, encoding="utf-8")
    return d


@pytest.fixture
def mock_influx(mocker):
    """A MagicMock standing in for InfluxDBWriter (spec-checked).

    Wired with sensible return values so it can be passed as
    ``SuiviBourseMetrics(config_manager, validator, influxdb_writer=mock_influx)``
    without real I/O:
      - connect() / close() / write_metrics(): no-op (return None)
      - get_oldest_timestamp(): None (no existing data)
      - has_data_for_date(): False
      - write_historical_prices(): 0 (points written; keeps ``+=`` arithmetic sane)

    Override any return_value in the test, e.g.
    ``mock_influx.get_oldest_timestamp.return_value = some_datetime``.
    """
    m = mocker.MagicMock(spec=InfluxDBWriter)
    m.connect.return_value = None
    m.close.return_value = None
    m.write_metrics.return_value = None
    m.get_oldest_timestamp.return_value = None
    m.has_data_for_date.return_value = False
    m.write_historical_prices.return_value = 0
    return m


@pytest.fixture
def shares_validator():
    """A real cerberus.Validator built from app/src/schema.yaml.

    Validate an aggregated portfolio with ``shares_validator.validate({"shares": shares})``
    (True/False); read ``shares_validator.errors`` on failure.
    """
    with open(_SCHEMA_PATH, encoding="utf-8") as f:
        schema = yaml.safe_load(f)
    return Validator(schema)


@pytest.fixture
def fake_ticker():
    """Factory returning a stand-in for ``yfinance.Ticker``.

    Call it to build a ticker-like object, then monkeypatch it in, e.g.::

        import main
        monkeypatch.setattr(main.yf, "Ticker", lambda symbol: fake_ticker())

    The returned object exposes:
      - ``.history(*args, **kwargs)`` -> pandas.DataFrame with a tz-aware
        (UTC) DatetimeIndex and Open/High/Low/Close/Volume columns. Ignores all
        arguments (period/interval/start/end) and returns the same frame, which
        satisfies every call site in main.py (last-close, hourly-volume, and the
        backfill ``history(start=, end=, interval=)`` row iteration).
      - ``.info`` -> dict with currency/exchange/quoteType/dividendYield/
        trailingPE/forwardPE/marketCap/volume.

    Factory signature (all optional keywords)::

        fake_ticker(close=185.0, rows=3, start="2024-01-02",
                    info=None, history_df=None)

    - ``close``: last close price; earlier rows step down by 1.0 each.
    - ``rows``: number of daily rows in the default frame.
    - ``start``: first date of the default DatetimeIndex (daily frequency).
    - ``info``: dict to merge over the default ``.info`` (override any key).
    - ``history_df``: supply a fully custom DataFrame, bypassing default generation.
    """
    def _build_df(close, rows, start):
        idx = pd.date_range(start=start, periods=rows, freq="D", tz=timezone.utc)
        closes = [close - (rows - 1 - i) for i in range(rows)]
        data = {
            "Open": [c - 0.5 for c in closes],
            "High": [c + 1.0 for c in closes],
            "Low": [c - 1.0 for c in closes],
            "Close": closes,
            "Volume": [1_000_000 + 1000 * i for i in range(rows)],
        }
        return pd.DataFrame(data, index=idx)

    def _make(close=185.0, rows=3, start="2024-01-02", info=None, history_df=None):
        df = history_df if history_df is not None else _build_df(close, rows, start)
        default_info = {
            "currency": "USD",
            "exchange": "NMS",
            "quoteType": "EQUITY",
            "dividendYield": 0.0052,
            "trailingPE": 28.5,
            "forwardPE": 26.0,
            "marketCap": 3_000_000_000_000,
            "volume": 50_000_000,
        }
        if info:
            default_info.update(info)

        class _FakeTicker:
            def __init__(self, frame, info_dict):
                self._frame = frame
                self.info = info_dict

            def history(self, *args, **kwargs):
                return self._frame

        return _FakeTicker(df, default_info)

    return _make
