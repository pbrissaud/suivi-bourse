"""
Tests for main.SuiviBourseMetrics.

Everything here is network-free, and since #700 there is **one** faked edge:
yfinance. The store is real — a DuckDB file in ``tmp_path`` with the DDL
applied — so every assertion below is on what the store *contains* rather than
on what a mock was asked to write. That is the seam spec #695 chose, and the
``MagicMock(spec=InfluxDBWriter)`` it replaces is named in the spec as the
counter-example: it reported what the job *meant* to write, which is not
connected to what ends up in the database.

The ConfigurationManager is still a lightweight in-memory fake, because what is
under test here is the job and not the ledger — but it carries the real store
and hands it out exactly as the production one does, mutex included.

Imports work top-level because pytest.ini sets ``pythonpath = src`` (same as
how app/src/main.py imports its own modules).
"""

from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

import pandas as pd
import pytest

import main
import quotes
import runtime_view
from main import SuiviBourseMetrics
from events.schemas import Event, EventType
from events.validator import EventValidationError
from yfinance.exceptions import YFRateLimitError
from urllib3.exceptions import NewConnectionError


# ---------------------------------------------------------------------------
# Local helpers / fakes
# ---------------------------------------------------------------------------

def _valid_shares(symbol="AAPL", name="Apple", quantity=10):
    """A single position dict in the v5 shape (#699)."""
    return {
        "name": name,
        "symbol": symbol,
        "quantity": quantity,
        "cost_basis": 150.0 * quantity + 2.5,
        "realized_gain": 0.0,
        "received_dividend": 2.4,
    }


class FakeConfigManager:
    """In-memory stand-in for main.ConfigurationManager.

    Exposes the surface SuiviBourseMetrics relies on since #658: ``current()``
    (the published snapshot — the read path), ``reload()`` (the publisher), plus
    ``get_mode()``. ``_acquisitions`` / ``_exits`` override what the snapshot
    would derive from ``events``, so tests can name a holding window without
    writing an event list (issue #703).

    ``raise_on_load`` fails the *publisher* only, never ``current()``: that is
    the production contract — a failed reload leaves the previously published
    snapshot readable.
    """

    def __init__(self, shares, opened_store=None, mode="manual",
                 acquisitions=None, exits=None, events=None, accounts=None):
        self._shares = shares
        self._store = opened_store
        self._mode = mode
        self._acquisitions = acquisitions or {}
        self._exits = exits or {}
        self._events = events
        self._accounts = accounts
        self.raise_on_load = False

    @property
    def store(self):
        """The read accessor the jobs use — no mutex, one statement at a time."""
        return self._store

    @contextmanager
    def writing(self):
        """The writers' mutex, which in production keeps a transaction whole."""
        yield self._store

    def current(self):
        return _FakeSnapshot(
            shares=self._shares, events=self._events, accounts=self._accounts,
            cache_key=None, acquisitions=self._acquisitions, exits=self._exits)

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

    def get_first_acquisition_date(self, symbol):
        return self._acquisitions.get(symbol)

    def get_events(self):
        return self._events


class _FakeSnapshot(main.ConfigSnapshot):
    """A ConfigSnapshot whose holding windows come from dicts, not events.

    ``exits`` names the last sale of a symbol nothing holds any more; a symbol
    absent from it is still held and its window ends today — the same rule
    :meth:`main.ConfigSnapshot.backfill_windows` applies, expressed on data a
    test can write in one line.
    """

    def __init__(self, acquisitions=None, exits=None, **kwargs):
        super().__init__(**kwargs)
        object.__setattr__(self, "_acquisitions", acquisitions or {})
        object.__setattr__(self, "_exits", exits or {})

    def backfill_windows(self):
        # No override: the production rule, over this snapshot's real events.
        # That is what the #703 tests below run on — the windows *are* what is
        # under test there, so naming them in the fake would test the fake.
        if not self._acquisitions:
            # ``events=None`` is this fake's own shorthand for "the ledger is
            # beside the point here"; the real snapshot always carries a list.
            return super().backfill_windows() if self.events else {}
        held = {share["symbol"] for share in self.shares
                if share.get("symbol") and share.get("quantity")}
        return {symbol: (acquired,
                         None if symbol in held else self._exits.get(symbol))
                for symbol, acquired in self._acquisitions.items()}


class _RaisingTicker:
    """Ticker stand-in whose .history() always raises the given exception."""

    def __init__(self, exc):
        self._exc = exc
        self.info = {}

    def history(self, *args, **kwargs):
        raise self._exc


def _build_metrics(shares, store, mode="manual",
                   acquisitions=None, exits=None, events=None):
    """A metrics object over a **real** store, with the positions laid down.

    The two ``INSERT``s are the configuration path's rows the foreign keys ask
    for — the market writer never invents a declaration, which is the schema
    rule (one writer per row) seen from the test's side.
    """
    for share in shares:
        store.execute(
            "INSERT INTO symbol (symbol) VALUES (?) "
            "ON CONFLICT (symbol) DO NOTHING", [share["symbol"]])
        store.execute(
            "INSERT INTO position (account, symbol, name, quantity, cost_basis,"
            "                      realized_gain, received_dividend) "
            "VALUES ('default', ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (account, symbol) DO NOTHING",
            [share["symbol"], share["name"], share["quantity"],
             share["cost_basis"], share["realized_gain"],
             share["received_dividend"]])
    cfg = FakeConfigManager(shares, opened_store=store, mode=mode,
                            acquisitions=acquisitions, exits=exits,
                            events=events)
    metrics = SuiviBourseMetrics(cfg)
    return metrics, cfg


def _points(store, symbol="AAPL"):
    """Every stored price of a symbol, oldest first — the assertion surface."""
    return store.query(
        "SELECT ts, price_native FROM price_point WHERE symbol = ? ORDER BY ts",
        [symbol])


def _seed_prices(store, symbol, *instants, price=100.0):
    """Put a symbol's series where a test needs it to start from."""
    quotes.record_history(
        store, symbol, [{"timestamp": at, "price": price} for at in instants])


def _seed_up_to_now(store, symbol, oldest, price=100.0):
    """Seed a series from ``oldest`` **and** a point a minute old.

    The recent point is what makes the *forward* pass a no-op: its guard is "the
    newest point is under a day old", which is exactly the steady state a live
    writer keeps. Without it every backward-pass test would also exercise the
    forward one and count two fetches where it means to count one.
    """
    _seed_prices(store, symbol, oldest,
                 datetime.now(timezone.utc) - timedelta(minutes=1),
                 price=price)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """Make every time.sleep in main a no-op so tests are fast/deterministic."""
    monkeypatch.setattr(main.time, "sleep", lambda *a, **k: None)


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------

def test_constructor_reads_the_published_shares_and_opens_nothing(store):
    """No connection to establish since #700: the manager owns the store.

    The ``InfluxDBWriter`` argument is gone rather than swapped for a store
    one — there is a single store in a process, the manager already holds it
    *and* the mutex that keeps a write whole, and a second handle here would be
    a second answer to "which generation of the ledger is this job on".
    """
    metrics, cfg = _build_metrics([_valid_shares()], store)

    assert metrics.shares == [_valid_shares()]
    assert metrics.config_manager.store is store


# ---------------------------------------------------------------------------
# _fetch_ticker_data
# ---------------------------------------------------------------------------

def test_fetch_ticker_data_success_and_mapping(store,
                                               fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], store)
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


def test_fetch_ticker_data_pe_ratio_falls_back_to_forward(store,
                                                          fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], store)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(info={"trailingPE": None}))

    _, info = metrics._fetch_ticker_data("AAPL")
    assert info["peRatio"] == 26.0  # forwardPE


def test_fetch_ticker_data_none_dividend_yield_preserved(
        store, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], store)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(info={"dividendYield": None}))

    _, info = metrics._fetch_ticker_data("AAPL")
    assert info["dividendYield"] is None


def test_fetch_ticker_data_empty_history_returns_none(
        store, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], store)
    empty = fake_ticker(history_df=pd.DataFrame())
    monkeypatch.setattr(main.yf, "Ticker", lambda s: empty)

    assert metrics._fetch_ticker_data("AAPL") == (None, None)


def test_fetch_ticker_data_uses_last_non_nan_close(
        store, fake_ticker, monkeypatch):
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
    metrics, _ = _build_metrics([_valid_shares()], store)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(history_df=df))

    last_quote, info = metrics._fetch_ticker_data("AAPL")

    # Last non-NaN close, not the NaN tail row.
    assert last_quote == pytest.approx(176.52)
    # .info is still resolved and cached so backfill can proceed while closed.
    assert info is not None
    assert metrics._share_info_cache["AAPL"] == info


def test_fetch_ticker_data_all_nan_close_returns_none(
        store, fake_ticker, monkeypatch):
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
    metrics, _ = _build_metrics([_valid_shares()], store)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(history_df=df))

    assert metrics._fetch_ticker_data("AAPL") == (None, None)
    assert "AAPL" not in metrics._share_info_cache


def test_fetch_ticker_data_retries_after_rate_limit(
        store, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], store)
    tickers = iter([_RaisingTicker(YFRateLimitError()), fake_ticker()])
    monkeypatch.setattr(main.yf, "Ticker", lambda s: next(tickers))

    last_quote, info = metrics._fetch_ticker_data("AAPL")
    assert last_quote == 185.0
    assert info is not None


def test_fetch_ticker_data_exhausts_retries_returns_none(
        store, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], store)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: _RaisingTicker(YFRateLimitError()))

    assert metrics._fetch_ticker_data("AAPL", max_retries=3) == (None, None)


def test_fetch_ticker_data_runtime_error_returns_none(
        store, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], store)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: _RaisingTicker(RuntimeError("kaboom")))

    assert metrics._fetch_ticker_data("AAPL") == (None, None)


def test_fetch_ticker_data_connection_error_returns_none(
        store, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], store)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: _RaisingTicker(NewConnectionError(None, "no route")))

    assert metrics._fetch_ticker_data("AAPL") == (None, None)


# ---------------------------------------------------------------------------
# expose_metrics
# ---------------------------------------------------------------------------

def test_a_scrape_writes_one_price_point_and_refreshes_the_quote_row(
        store, fake_ticker, monkeypatch):
    """The whole of the scrape's write, asserted on the two tables it owns."""
    metrics, _ = _build_metrics([_valid_shares()], store)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker())

    metrics.expose_metrics()

    assert [price for _, price in _points(store)] == [185.0]
    quote = quotes.read_quote(store, "AAPL")
    assert quote["currency"] == "USD"
    assert quote["exchange"] == "NMS"
    assert quote["quote_type"] == "EQUITY"
    # dividendYield 0.0052 -> dividend_yield 0.52
    assert quote["dividend_yield"] == pytest.approx(0.52)
    assert quote["pe_ratio"] == 28.5
    assert quote["market_cap"] == 3_000_000_000_000
    # The ``latest`` maintenance rule ran in the same transaction.
    assert quote["last_price_native"] == 185.0
    assert quote["last_price_ts"] is not None


def test_a_symbol_held_in_two_accounts_is_written_once(
        store, fake_ticker, monkeypatch):
    """#700's structural decision, on the row.

    A market price belongs to no account, so two holdings of the same share are
    one observation. Writing it twice would inflate the series by the number of
    accounts and make every read of it pick between duplicates.
    """
    shares = [_valid_shares(), dict(_valid_shares(), account="pea")]
    metrics, _ = _build_metrics([_valid_shares()], store)
    metrics.config_manager._shares = shares
    store.execute("INSERT INTO account (id, type, label) VALUES "
                  "('pea', 'PEA', 'PEA')")
    store.execute(
        "INSERT INTO position (account, symbol, name, quantity, cost_basis,"
        "                      realized_gain, received_dividend) "
        "VALUES ('pea', 'AAPL', 'Apple', 4, 600.0, 0, 0)")
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker())

    metrics.expose_metrics()

    assert len(_points(store)) == 1


def test_a_missing_dividend_yield_is_stored_as_null_not_as_zero(
        store, fake_ticker, monkeypatch):
    metrics, _ = _build_metrics([_valid_shares()], store)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(info={"dividendYield": None}))

    metrics.expose_metrics()

    assert quotes.read_quote(store, "AAPL")["dividend_yield"] is None


def test_expose_metrics_skips_write_when_fetch_fails(store, mocker):
    metrics, _ = _build_metrics([_valid_shares()], store)
    mocker.patch.object(metrics, "_fetch_ticker_data", return_value=(None, None))

    metrics.expose_metrics()

    assert _points(store) == []


def test_a_write_error_on_one_symbol_does_not_abort_the_rest(
        store, fake_ticker, monkeypatch, mocker):
    shares = [_valid_shares("AAPL", "Apple"), _valid_shares("MSFT", "Microsoft")]
    metrics, _ = _build_metrics(shares, store)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker())
    # The first symbol's write raises; the second must still be attempted.
    real = quotes.record_quote
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("the store refused the write")
        return real(*args, **kwargs)

    mocker.patch.object(main.quotes, "record_quote", side_effect=flaky)

    metrics.expose_metrics()

    assert calls["n"] == 2
    assert [price for _, price in _points(store, "MSFT")] == [185.0]


# ---------------------------------------------------------------------------
# ingest
# ---------------------------------------------------------------------------

def test_ingest_updates_shares_when_valid_and_different(store):
    metrics, cfg = _build_metrics([_valid_shares("AAPL", "Apple")], store)
    new_shares = [_valid_shares("MSFT", "Microsoft")]
    cfg._shares = new_shares

    metrics.ingest()

    assert metrics.shares == new_shares


def test_ingest_keeps_previous_when_publication_fails(store):
    """A refused configuration never reaches this class.

    Since #658 the rejection happens in the manager, before publication, so
    ``ingest`` sees an exception rather than a bad share list — and the snapshot
    every reader holds is still the last valid one. The rejection itself is
    tested against the real manager in ``test_configuration_manager.py``.
    """
    original = [_valid_shares("AAPL", "Apple")]
    metrics, cfg = _build_metrics(original, store)
    cfg.raise_on_load = EventValidationError("row 4: SELL of 40 with 18 owned")

    metrics.ingest()

    assert metrics.shares == original


def test_ingest_swallows_exceptions(store):
    original = [_valid_shares("AAPL", "Apple")]
    metrics, cfg = _build_metrics(original, store)
    cfg.raise_on_load = True

    # Must not raise
    metrics.ingest()

    assert metrics.shares == original


# ---------------------------------------------------------------------------
# One snapshot per cycle (issue #658)
# ---------------------------------------------------------------------------

def test_shares_is_a_read_of_the_published_snapshot(store):
    """Not a copy: a republication is visible without anyone assigning it here.

    The second copy is what let scraping and backfill run on two different
    configurations for a cycle.
    """
    metrics, cfg = _build_metrics([_valid_shares("AAPL")], store)
    cfg._shares = [_valid_shares("MSFT", "Microsoft")]

    assert [s["symbol"] for s in metrics.shares] == ["MSFT"]


def test_backfill_takes_exactly_one_snapshot_for_the_whole_cycle(
        store, mocker):
    """Shares, events and accounts must come from the same generation.

    They used to be fetched one call at a time (``self.shares``, then
    ``load_accounts()``, then ``get_events()``, then ``get_first_acquisition_date()``
    per share), so a reload landing mid-cycle could pair this cycle's shares
    with the next cycle's events.
    """
    metrics, cfg = _build_metrics(
        [_valid_shares("AAPL"), _valid_shares("MSFT")], store,
        mode="events")
    spy = mocker.spy(cfg, "current")

    metrics.backfill()

    assert spy.call_count == 1


def test_recompute_perf_reads_no_snapshot_at_all(
        store, mocker, sample_events):
    """The job takes no configuration argument any more (issue #707).

    Its inputs are the store and the clock: the snapshot it used to be handed
    existed so the *gate* and the recompute could not straddle a reload, and the
    gate is gone. Passing one now would tie the cache's freshness to the
    configuration's publication rhythm rather than to what the store holds.
    """
    metrics, cfg = _build_metrics([_valid_shares("AAPL")], store,
                                  mode="events",
                                  events=sample_events)
    recompute = mocker.patch.object(metrics, "update_account_metrics")
    published = mocker.spy(cfg, "current")

    metrics.recompute_perf()

    recompute.assert_called_once_with()
    assert published.call_count == 0


# ---------------------------------------------------------------------------
# scrape
# ---------------------------------------------------------------------------

def test_scrape_returns_when_no_shares(store, mocker):
    metrics, cfg = _build_metrics([_valid_shares()], store)
    cfg._shares = []
    spy = mocker.spy(metrics, "expose_metrics")

    metrics.scrape()

    spy.assert_not_called()
    assert _points(store) == []


# ---------------------------------------------------------------------------
# backfill
#
# Since #700 the unit is the **symbol**, not the (account, symbol) pair: the
# series it fills has no account dimension, so a share held in three accounts
# would otherwise fetch the same window from Yahoo three times a cycle.
# ---------------------------------------------------------------------------

def test_backfill_returns_when_no_shares(store, mocker):
    metrics, cfg = _build_metrics([_valid_shares()], store, mode="events")
    cfg._shares = []
    fetch = mocker.patch.object(metrics, "_fetch_historical_data")

    metrics.backfill()

    fetch.assert_not_called()
    assert _points(store) == []


def test_backfill_marks_complete_when_the_anchor_reaches_the_acquisition(store, mocker):
    acquired = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], store,
        mode="events", acquisitions={"AAPL": acquired})
    metrics.backfill_chunk_days = 365
    # Stored history already predates the first BUY date.
    _seed_up_to_now(store, "AAPL", datetime(2024, 1, 10, tzinfo=timezone.utc))
    fetch = mocker.patch.object(metrics, "_fetch_historical_data")

    metrics.backfill()

    fetch.assert_not_called()
    expected = datetime(2024, 1, 15, 0, 0, 0, tzinfo=timezone.utc)
    # The watermark is per symbol since #700 — one series, one answer.
    assert metrics._backfill_complete["AAPL"] == expected


def test_backfill_fetches_a_chunk_and_the_prices_land(store, mocker):
    acquired = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], store,
        mode="events", acquisitions={"AAPL": acquired}, events=None)
    metrics.backfill_chunk_days = 365
    # Oldest stored point well after the first BUY -> a gap to fill.
    _seed_up_to_now(store, "AAPL", datetime(2024, 6, 1, tzinfo=timezone.utc))
    latest_before = quotes.read_quote(store, "AAPL")["last_price_ts"]
    canned = [{"timestamp": datetime(2024, 3, 1, tzinfo=timezone.utc),
               "price": 170.0}]
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=canned)

    metrics.backfill()

    assert [price for _, price in _points(store)] == [170.0, 100.0, 100.0]
    # An older chunk leaves the ``latest`` row alone: the maintenance rule only
    # fires on a point at or after the one it already names.
    assert quotes.read_quote(store, "AAPL")["last_price_ts"] == latest_before


def test_a_symbol_held_in_two_accounts_is_backfilled_once(store, mocker):
    """The other half of #700's decision, on the job that costs the most.

    The backfill is the moment the app emits more requests than at any other
    time of its life. Fetching one window per *holding* would multiply that by
    the number of accounts, on a series that would then hold each point twice.
    """
    metrics, cfg = _build_metrics(
        [_valid_shares("AAPL", "Apple")], store,
        mode="events", acquisitions={"AAPL": date(2024, 1, 15)})
    cfg._shares = [_valid_shares("AAPL", "Apple"),
                   dict(_valid_shares("AAPL", "Apple"), account="pea")]
    metrics.backfill_chunk_days = 365
    _seed_up_to_now(store, "AAPL", datetime(2024, 6, 1, tzinfo=timezone.utc))
    fetch = mocker.patch.object(
        metrics, "_fetch_historical_data",
        return_value=[{"timestamp": datetime(2024, 3, 1, tzinfo=timezone.utc),
                       "price": 170.0}])

    metrics.backfill()

    assert fetch.call_count == 1


def test_backfill_does_not_replay_the_ledger_at_all(store, mocker, sample_events):
    """The enrichment left with the shape it fed (issue #700).

    Every chunk used to be walked date by date so each point could be stamped
    with the position held that day, because a price point carried position
    fields. A market observation says nothing about who held what, so the replay
    the backfill used to run every cycle has no subject left.
    """
    import main as main_module
    acquired_on = {"AAPL": date(2024, 1, 15), "MSFT": date(2024, 2, 1)}
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple"), _valid_shares("MSFT", "Microsoft")],
        store, mode="events",
        acquisitions=acquired_on, events=sample_events)
    metrics.backfill_chunk_days = 365
    for symbol in ("AAPL", "MSFT"):
        _seed_up_to_now(store, symbol, datetime(2024, 6, 1, tzinfo=timezone.utc))
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=[
        {"timestamp": datetime(2024, 3, 1, tzinfo=timezone.utc), "price": 170.0}])

    spy = mocker.spy(main_module.EventAggregator, "replay")
    metrics.backfill()

    assert spy.call_count == 0


def test_backfill_write_failure_does_not_abort_remaining_symbols(store, mocker):
    acquired_on = {"AAPL": date(2024, 1, 15), "MSFT": date(2024, 1, 15)}
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple"), _valid_shares("MSFT", "Microsoft")],
        store, mode="events", acquisitions=acquired_on, events=None)
    metrics.backfill_chunk_days = 365
    for symbol in ("AAPL", "MSFT"):
        _seed_up_to_now(store, symbol, datetime(2024, 6, 1, tzinfo=timezone.utc))
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=[
        {"timestamp": datetime(2024, 3, 1, tzinfo=timezone.utc), "price": 170.0}])

    real = quotes.record_history
    calls = {"n": 0}

    def flaky(opened, symbol, points):
        calls["n"] += 1
        if symbol == "AAPL":
            raise RuntimeError("the store refused the write")
        return real(opened, symbol, points)

    mocker.patch.object(main.quotes, "record_history", side_effect=flaky)

    # Must not propagate the exception out of the per-symbol loop.
    metrics.backfill()

    assert calls["n"] == 2
    assert [price for _, price in _points(store, "MSFT")] == [
        170.0, 100.0, 100.0]


# ---------------------------------------------------------------------------
# backfill — forward gap-fill pass (issue #627)
# ---------------------------------------------------------------------------

def test_backfill_forward_fills_recent_gap(store, mocker):
    """A session missed while down (old newest) is recovered by the forward pass,
    even when the backward pass is already complete — the two directions are
    independent."""
    acquired = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], store,
        mode="events", acquisitions={"AAPL": acquired}, events=None)
    metrics.backfill_chunk_days = 365
    # Backward already complete -> only the forward pass should act.
    metrics._backfill_complete["AAPL"] = datetime(2024, 1, 15, tzinfo=timezone.utc)
    anchor = datetime.now(timezone.utc) - timedelta(days=30)
    _seed_prices(store, "AAPL", anchor)
    recovered = anchor + timedelta(days=2)
    mocker.patch.object(
        metrics, "_fetch_historical_data",
        return_value=[{"timestamp": recovered, "price": 175.0}])

    metrics.backfill()

    assert [price for _, price in _points(store)] == [100.0, 175.0]
    # The forward chunk is newer than the anchor, so the maintenance rule moves
    # the ``latest`` row with it — the one case the backward chunk does not.
    assert quotes.read_quote(store, "AAPL")["last_price_native"] == 175.0


def test_a_sold_position_keeps_its_history_but_stops_chasing_the_present(
        store, mocker):
    """The two directions part company at the sale (#699, #672 D5).

    The backward pass still runs — the chart wants the history of a line the
    user held, and the watermark bounds it. The forward pass stops: it exists
    to catch a live writer up, that writer has just been removed, and its own
    no-op guard ("the newest point is under a day old") is the very thing the
    writer was keeping true — so left running it would refetch
    ``[newest → now]`` from Yahoo every day, forever.
    """
    metrics, _ = _build_metrics(
        [_valid_shares("ALO", "Alstom", quantity=0)], store,
        mode="events", acquisitions={"ALO": date(2021, 10, 5)}, events=None)
    _seed_prices(store, "ALO", datetime(2022, 1, 1, tzinfo=timezone.utc))
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=[])

    metrics.backfill()

    assert metrics.recorder.backfill_of(
        "ALO", main.runtime_state.BACKWARD) is not None
    assert metrics.recorder.backfill_of(
        "ALO", main.runtime_state.FORWARD) is None


def test_backfill_forward_empty_window_writes_nothing(store, mocker):
    """A weekend/holiday gap: yfinance returns no rows for the forward window, so
    nothing is written (self-classifying, no calendar logic)."""
    acquired = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], store,
        mode="events", acquisitions={"AAPL": acquired}, events=None)
    metrics.backfill_chunk_days = 365
    metrics._backfill_complete["AAPL"] = datetime(2024, 1, 15, tzinfo=timezone.utc)
    _seed_prices(store, "AAPL", datetime.now(timezone.utc) - timedelta(days=30))
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=[])

    metrics.backfill()

    assert len(_points(store)) == 1


def test_backfill_forward_noop_when_series_empty(store, mocker):
    """No stored point yet: the forward pass has no anchor and the backward pass
    owns seeding the series, so no forward fetch happens."""
    acquired = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], store,
        mode="events", acquisitions={"AAPL": acquired}, events=None)
    metrics.backfill_chunk_days = 365
    metrics._backfill_complete["AAPL"] = datetime(2024, 1, 15, tzinfo=timezone.utc)
    fetch = mocker.patch.object(metrics, "_fetch_historical_data",
                                return_value=[])

    metrics.backfill()

    fetch.assert_not_called()
    assert _points(store) == []
    assert metrics.recorder.backfill_of(
        "AAPL", main.runtime_state.FORWARD).skipped == \
        main.runtime_state.SKIP_NO_SERIES


def test_backfill_runs_both_directions_in_one_cycle(store, mocker):
    """When both an older gap (backward) and a recent gap (forward) exist, a
    single cycle fills both for the same symbol."""
    acquired = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], store,
        mode="events", acquisitions={"AAPL": acquired}, events=None)
    metrics.backfill_chunk_days = 365
    anchor = datetime.now(timezone.utc) - timedelta(days=30)
    _seed_prices(store, "AAPL", anchor)
    fetch = mocker.patch.object(
        metrics, "_fetch_historical_data",
        return_value=[{"timestamp": anchor - timedelta(days=1),
                       "price": 170.0}])

    metrics.backfill()

    # One fetch for the backward chunk, one for the forward chunk.
    assert fetch.call_count == 2
    # Backward pass never marked complete (the older gap remains open).
    assert "AAPL" not in metrics._backfill_complete


def test_backfill_empty_window_marks_complete(store, mocker):
    acquired = date(2024, 1, 15)
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], store,
        mode="events", acquisitions={"AAPL": acquired})
    metrics.backfill_chunk_days = 365
    # end_date=2024-03-01, chunk clamps start_date to the acquisition (2024-01-15).
    _seed_up_to_now(store, "AAPL", datetime(2024, 3, 1, tzinfo=timezone.utc))
    # Empty (but non-None) window: the fetch succeeded with no rows.
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=[])

    metrics.backfill()

    assert len(_points(store)) == 2
    expected = datetime(2024, 1, 15, 0, 0, 0, tzinfo=timezone.utc)
    assert metrics._backfill_complete["AAPL"] == expected


# ---------------------------------------------------------------------------
# backfill — driven by the replay, over holding windows (issue #703, ADR-0009)
# ---------------------------------------------------------------------------

def _window_recorder(metrics, mocker, prices=None):
    """Patch the fetch and remember every ``(start, end)`` it was asked for."""
    windows = []

    def fetch(symbol, start, end, **kwargs):
        windows.append((start, end))
        return [] if prices is None else prices(symbol, start, end)

    mocker.patch.object(metrics, "_fetch_historical_data", side_effect=fetch)
    return windows


def test_a_share_bought_in_2020_and_sold_in_2022_is_reconstructed(store, mocker):
    """The permanent wrong figure #703 exists to fix (ADR-0009).

    The backfill used to iterate over *current* positions, so a line bought in
    2020 and sold in 2022 had no reconstructed price at all and the account's
    ``xirr`` / ``twr_index`` were wrong **for ever** — not for the duration of
    the reconstruction. It is driven by the replay now: the set is the union
    over the whole timeline, and this symbol's window is its own holding period,
    ending at the sale rather than at today.
    """
    events = [
        Event(date(2020, 3, 2), EventType.BUY, "ALO", "Alstom",
              quantity=10, unit_price=30.0),
        Event(date(2022, 5, 4), EventType.SELL, "ALO", "Alstom",
              quantity=10, unit_price=25.0),
    ]
    metrics, _ = _build_metrics(
        [_valid_shares("ALO", "Alstom", quantity=0)], store,
        mode="events", events=events)
    metrics.backfill_chunk_days = 365
    windows = _window_recorder(
        metrics, mocker,
        prices=lambda s, start, end: [
            {"timestamp": start + timedelta(days=1), "price": 42.0}])

    for _ in range(4):
        metrics.backfill()

    # The window is the holding period: it opens at the sale (the day after,
    # yfinance reading the end of a range as exclusive) and not at today, and it
    # closes on the first acquisition.
    assert windows[0][1].date() == date(2022, 5, 5)
    assert windows[-1][0].date() == date(2020, 3, 2)
    # Prices landed *inside* the period the owner held the line.
    stored = [ts.date() for ts, _ in _points(store, "ALO")]
    assert stored and all(date(2020, 3, 2) <= day <= date(2022, 5, 5)
                          for day in stored)
    assert metrics._backfill_complete["ALO"] == datetime(
        2020, 3, 2, tzinfo=timezone.utc)


def test_the_published_progress_measures_the_holding_window_not_today(
        store, mocker):
    """The bar of a sold line is drawn against ``[acquisition, exit]``.

    #703 gave every symbol a window bounded above by its last exit, and the
    progress ``/api/runtime`` publishes has to divide by *that* span. Measured
    against *now*, the same ALO — bought 2020-03-02, sold 2022-05-04, one chunk
    of its three walked down — reports **0,82** where it has covered **0,46**,
    and the older the sale the wider the gap. The ceiling therefore rides on the
    record: it is what the reader would otherwise have to invent.
    """
    events = [
        Event(date(2020, 3, 2), EventType.BUY, "ALO", "Alstom",
              quantity=10, unit_price=30.0),
        Event(date(2022, 5, 4), EventType.SELL, "ALO", "Alstom",
              quantity=10, unit_price=25.0),
    ]
    metrics, _ = _build_metrics(
        [_valid_shares("ALO", "Alstom", quantity=0)], store,
        mode="events", events=events)
    metrics.backfill_chunk_days = 365
    _window_recorder(
        metrics, mocker,
        prices=lambda s, start, end: [
            {"timestamp": start + timedelta(days=1), "price": 42.0}])

    # Two cycles: the first seeds the series, the second observes an ``oldest``.
    metrics.backfill()
    metrics.backfill()

    record = metrics.recorder.backfill_of("ALO", main.runtime_state.BACKWARD)
    assert record.ceiling.date() == date(2022, 5, 5)

    now = datetime(2026, 8, 10, tzinfo=timezone.utc)
    progress = runtime_view.backfill_progress(
        record, main.runtime_state.BACKWARD, now)
    assert progress.ratio == pytest.approx(0.458, abs=0.01)
    # What the pass would have reported measured against today.
    assert (now - record.oldest) / (now - record.target) == pytest.approx(
        0.817, abs=0.01)


def test_the_backfill_takes_the_whole_timeline_and_the_scrape_only_holdings(
        store, mocker):
    """The first place the two sets part company (spec #695 § 7).

    *What do we poll live* and *whose history do we need* stop being the same
    question the moment a position can close.
    """
    events = [
        Event(date(2021, 2, 1), EventType.BUY, "ALO", "Alstom",
              quantity=10, unit_price=30.0),
        Event(date(2022, 2, 1), EventType.SELL, "ALO", "Alstom",
              quantity=10, unit_price=35.0),
        Event(date(2023, 2, 1), EventType.BUY, "AAPL", "Apple",
              quantity=4, unit_price=150.0),
    ]
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple", quantity=4),
         _valid_shares("ALO", "Alstom", quantity=0)],
        store, mode="events", events=events)
    metrics.backfill_chunk_days = 365
    windows = _window_recorder(metrics, mocker)

    metrics.backfill()

    backward = {
        symbol for symbol in ("AAPL", "ALO")
        if metrics.recorder.backfill_of(
            symbol, main.runtime_state.BACKWARD) is not None
    }
    assert backward == {"AAPL", "ALO"}
    assert len(windows) == 2
    # And the scrape keeps its own set, filtered on ``quantity``.
    assert metrics._held_symbols() == {"AAPL"}


def test_a_mute_symbol_walks_back_to_its_acquisition_and_stops_asking(
        store, mocker):
    """The silent infinite loop, closed (issue #703, ADR-0009).

    A delisted symbol stores no point, so an anchor read off the *series* never
    moves: the stop condition is never reached and the same window is asked of
    Yahoo every 60 s, for ever. Neither guard catches it — an empty return is
    classified as a gap and not a failure, deliberately (#606), so the
    consecutive-failure counter stays at zero too.

    With the anchor being the oldest window **tried**, it walks back one chunk
    per cycle, reaches ``complete`` with **zero point**, and stops asking.
    """
    acquired = (datetime.now(timezone.utc) - timedelta(days=1125)).date()
    events = [Event(acquired, EventType.BUY, "DEAD", "Delisted Co",
                    quantity=5, unit_price=10.0)]
    metrics, _ = _build_metrics(
        [_valid_shares("DEAD", "Delisted Co", quantity=5)], store,
        mode="events", events=events)
    metrics.backfill_chunk_days = 365
    fetch = mocker.patch.object(
        metrics, "_fetch_historical_data", return_value=[])

    for _ in range(10):
        metrics.backfill()

    # 1125 days over 365-day chunks: four windows, then nothing, for ever.
    assert fetch.call_count == 4
    assert _points(store, "DEAD") == []
    record = metrics.recorder.backfill_of("DEAD", main.runtime_state.BACKWARD)
    assert record.terminal == main.runtime_state.TERMINAL_COMPLETE
    assert record.written == 0


def test_the_anchor_is_persisted_so_a_restart_does_not_start_asking_again(
        store, mocker):
    """The one named exception to *watermarks stay derived* (spec #695 § 4).

    The argument for deriving a watermark is that it recomputes itself from the
    rows — which is exactly what a symbol with no rows cannot do. So this one is
    written on ``symbol_quote``, by the module that owns the row, and a process
    that restarts mid-reconstruction resumes where it left off.
    """
    acquired = (datetime.now(timezone.utc) - timedelta(days=1125)).date()
    events = [Event(acquired, EventType.BUY, "DEAD", "Delisted Co",
                    quantity=5, unit_price=10.0)]
    metrics, _ = _build_metrics(
        [_valid_shares("DEAD", "Delisted Co", quantity=5)], store,
        mode="events", events=events)
    metrics.backfill_chunk_days = 365
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=[])

    for _ in range(4):
        metrics.backfill()

    assert quotes.oldest_window_tried(store, "DEAD") == acquired

    # A fresh process over the same store: no in-memory watermark at all.
    revived, _ = _build_metrics(
        [_valid_shares("DEAD", "Delisted Co", quantity=5)], store,
        mode="events", events=events)
    revived.backfill_chunk_days = 365
    again = mocker.patch.object(
        revived, "_fetch_historical_data", return_value=[])

    revived.backfill()

    again.assert_not_called()
    assert revived.recorder.backfill_of(
        "DEAD", main.runtime_state.BACKWARD).terminal == \
        main.runtime_state.TERMINAL_COMPLETE


def test_a_failed_fetch_leaves_the_anchor_where_it_was(store, mocker):
    """*Tried* means the fetch completed, empty or not.

    A failure has attempted nothing the app is entitled to skip: persisting it
    would let one Yahoo hiccup erase a year of history the pass never comes back
    to, and the backward pass has no second chance at a window it walked past.
    """
    events = [Event(date(2022, 1, 3), EventType.BUY, "AAPL", "Apple",
                    quantity=10, unit_price=150.0)]
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], store, mode="events", events=events)
    metrics.backfill_chunk_days = 365
    mocker.patch.object(metrics, "_fetch_historical_data", return_value=None)

    metrics.backfill()

    assert quotes.oldest_window_tried(store, "AAPL") is None


def test_the_backward_pass_never_reaches_into_the_stored_series(store, mocker):
    """The geometry ``price_point`` has instead of a uniqueness key (ADR-0007).

    The backward pass works strictly before the oldest stored point and the
    forward one only starts past a day of anchor, so a range writer that deletes
    its own span then inserts cannot lose a point another pass owns.
    """
    events = [Event(date(2020, 1, 6), EventType.BUY, "AAPL", "Apple",
                    quantity=10, unit_price=150.0)]
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple")], store, mode="events", events=events)
    metrics.backfill_chunk_days = 365
    _seed_up_to_now(store, "AAPL", datetime(2023, 6, 1, tzinfo=timezone.utc))
    windows = _window_recorder(metrics, mocker)

    for _ in range(3):
        metrics.backfill()

    oldest = quotes.oldest_ts(store, "AAPL")
    assert windows
    assert all(end <= oldest for _, end in windows)


def test_the_forward_pass_fills_the_gap_of_a_position_bought_back(
        store, mocker):
    """Free, and it only needed the symbol to be in the backfill's set (#695 § 7).

    Sold, then bought back nine months later: nothing was written in between
    because there was no live writer, so the forward pass's anchor is nine
    months old, the window is sized, and one chunk lands per cycle. It stays a
    no-op while the anchor is under a day old — the live writer's own steady
    state.
    """
    events = [
        Event(date(2022, 1, 10), EventType.BUY, "AAPL", "Apple",
              quantity=10, unit_price=150.0),
        Event(date(2023, 1, 10), EventType.SELL, "AAPL", "Apple",
              quantity=10, unit_price=160.0),
        Event(date(2023, 10, 10), EventType.BUY, "AAPL", "Apple",
              quantity=5, unit_price=170.0),
    ]
    metrics, _ = _build_metrics(
        [_valid_shares("AAPL", "Apple", quantity=5)], store,
        mode="events", events=events)
    metrics.backfill_chunk_days = 365
    # Backward already done, so only the forward pass can act.
    metrics._backfill_complete["AAPL"] = datetime(
        2022, 1, 10, tzinfo=timezone.utc)
    anchor = datetime.now(timezone.utc) - timedelta(days=270)
    _seed_prices(store, "AAPL", anchor)
    recovered = anchor + timedelta(days=2)
    mocker.patch.object(
        metrics, "_fetch_historical_data",
        return_value=[{"timestamp": recovered, "price": 175.0}])

    metrics.backfill()

    assert [price for _, price in _points(store)] == [100.0, 175.0]
    record = metrics.recorder.backfill_of("AAPL", main.runtime_state.FORWARD)
    assert record.written == 1

    # And the no-op guard is intact: a point a minute old sizes no window.
    _seed_prices(store, "AAPL", datetime.now(timezone.utc) - timedelta(minutes=1))
    metrics.backfill()

    assert metrics.recorder.backfill_of(
        "AAPL", main.runtime_state.FORWARD).skipped == \
        main.runtime_state.SKIP_TOO_RECENT
