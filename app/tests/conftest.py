"""
Shared pytest fixtures for the SuiviBourse test suite.

`pytest.ini` sets ``pythonpath = src`` so tests (and this conftest) import the
application modules exactly like ``app/src/main.py`` does::

    import main
    import quotes
    from events import EventLoader, EventValidator, EventAggregator
    from events.schemas import Event, EventType, ShareState

All fixtures below are project-wide (auto-discovered by any ``test_*.py`` under
``app/tests/``). Keep them generic; put test-specific data in the test module.
"""

from datetime import date, timezone

import pandas as pd
import pytest

import positions
import store as store_module
from events.schemas import Event, EventType


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
def store(tmp_path):
    """A **real** DuckDB store in ``tmp_path``, DDL applied and seeded (#696).

    The one seam of the v5 suite, and it is deliberately the highest one the
    design allows: the store is embedded, so mocking it would mock half the
    product. A transaction, an ``UPSERT`` and a pruning ``DELETE`` are exactly
    the kind of thing a mock reports as *having happened* and only a database
    reports as *correct* — and "one writer per row" is checkable on the row, not
    on the intention of writing it.

    On a **file**, never ``:memory:``. Three reasons, all of them things the
    suite has to be able to assert: DuckDB refuses a second process, persistence
    and checkpointing are part of what is claimed (the file not drifting over N
    cycles, notably), and a file under ``tmp_path`` is thrown away for free.

    Closed after the test, so the next one opens a store nothing is holding.
    """
    opened = store_module.open_store(tmp_path / "store.duckdb")
    try:
        yield opened
    finally:
        opened.close()


@pytest.fixture
def declare_positions():
    """Lay a share list into the store the way the replay would (issue #700).

    The gesture every test that used to hand ``SuiviBourseMetrics`` a
    ``MagicMock`` now performs on a real store instead: the accounts and symbols
    the positions reference, then :func:`positions.write_state`, which is the
    production writer and not a copy of it.

    The two ``INSERT``s before it are what the foreign keys ask for, and they
    belong to the **configuration** path — the market and replay writers never
    create a declaration (that is the schema rule: one writer per row). A test
    that skips them gets the constraint violation a real ledger cannot produce.
    """
    def _declare(opened, shares, cash=None):
        for share in shares:
            account = share.get('account') or 'default'
            opened.execute(
                'INSERT INTO account (id, type, label) VALUES (?, ?, ?) '
                'ON CONFLICT (id) DO NOTHING', [account, 'CTO', account])
            opened.execute(
                'INSERT INTO symbol (symbol) VALUES (?) '
                'ON CONFLICT (symbol) DO NOTHING', [share['symbol']])
        positions.write_state(opened, shares, cash or {})
    return _declare


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

    Market-aware scheduling fields (issue #616) also ride on ``.info``
    (``marketState``, ``exchangeTimezoneName``, ``regularMarketTime``) — pass
    them via ``info=``. The ``history()`` metadata (``currentTradingPeriod``,
    read by ``main`` as ``ticker.history_metadata``) is supplied separately:

    - ``market_state``: convenience for ``info["marketState"]``.
    - ``history_metadata``: dict exposed as ``ticker.history_metadata`` (defaults
      to ``None`` so, absent an override, the exact next-open is unavailable).
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

    def _make(close=185.0, rows=3, start="2024-01-02", info=None, history_df=None,
              market_state=None, history_metadata=None):
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
        if market_state is not None:
            default_info["marketState"] = market_state
        if info:
            default_info.update(info)

        class _FakeTicker:
            def __init__(self, frame, info_dict, hist_meta):
                self._frame = frame
                self.info = info_dict
                self.history_metadata = hist_meta

            def history(self, *args, **kwargs):
                return self._frame

        return _FakeTicker(df, default_info, history_metadata)

    return _make
