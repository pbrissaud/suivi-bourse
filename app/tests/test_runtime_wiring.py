"""Tests for the runtime-state *writers* — one line per job (issue #668, #656).

The pure half is covered in ``test_runtime_view.py``. What is left, and what
this file is for, is that each of the four jobs actually publishes at the end of
its pass, with the values it — and only it — held at that instant.

That "only it" is the whole design. #656 decision 4: a reader composing
``_failure_counts`` at *t* with ``next_run_time`` at *t+ε* gets a verdict that is
wrong twice over, because the job just succeeded and re-armed in between.
``scheduling.decide`` handed the scrape verdict, the delay and the counter back
in **one call**, so the record is coherent with itself by construction — and
these tests are what keep it that way as the call sites move.
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from apscheduler.schedulers.background import BackgroundScheduler

from contextlib import contextmanager

import main
import quotes
import runtime_state
import scheduling
from events.schemas import Event, EventType


UTC = timezone.utc
NOW = datetime(2026, 8, 5, 15, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _no_jitter(mocker):
    mocker.patch("main.random.uniform", return_value=0.0)


@pytest.fixture(autouse=True)
def _no_sleep(mocker):
    """The backfill's rate limit is a courtesy to Yahoo, not a unit under test."""
    mocker.patch.object(main.time, "sleep", lambda *a, **k: None)


def _share(symbol="AAPL", name="Apple", account="default", quantity=10):
    return {
        "name": name,
        "symbol": symbol,
        "account": account,
        "quantity": quantity,
        "cost_basis": 150.0 * quantity + 2.5,
        "realized_gain": 0.0,
        "received_dividend": 2.4,
    }


class _FakeConfigManager:
    """Enough of ``ConfigurationManager`` for the four jobs."""

    def __init__(self, shares, opened_store=None, events=None, raises=None):
        self._shares = shares
        self._store = opened_store
        self._events = events if events is not None else []
        self._raises = raises

    @property
    def store(self):
        return self._store

    @contextmanager
    def writing(self):
        yield self._store

    def current(self):
        return main.ConfigSnapshot(shares=self._shares, events=self._events,
                                   accounts=None, cache_key=None)

    def reload(self, force=False):
        if self._raises is not None:
            raise self._raises
        return self.current()

    def load_shares(self, force=False):
        return self._shares

    def load_accounts(self):
        return None

    def get_events(self):
        return self._events


def _metrics(shares, store, mocker, **manager):
    for share in shares:
        store.execute(
            "INSERT INTO symbol (symbol) VALUES (?) "
            "ON CONFLICT (symbol) DO NOTHING", [share["symbol"]])
    cfg = _FakeConfigManager(shares, opened_store=store, **manager)
    m = main.SuiviBourseMetrics(cfg)
    m.scheduler = mocker.MagicMock(spec=BackgroundScheduler)
    m.regular_interval = 120
    return m


# ===================================================================== #
# The scrape record
# ===================================================================== #

def test_a_regular_pass_records_the_state_it_acted_on_and_its_counter(
        store, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share(account="pea")], store, mocker)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)
    record = m.recorder.scrape_of("AAPL")

    assert record.verdict == runtime_state.SCRAPE_WROTE
    assert record.market_state == "REGULAR"
    assert record.closed is False
    assert record.failure_count == 0
    # The delay `decide` returned, in the same record as the counter it returned
    # it with — which is the pair a reader could never have taken coherently.
    assert record.next_delay == 120
    assert record.wrote is True


def test_a_failed_fetch_records_no_market_state_rather_than_a_stale_one(
        store, mocker):
    """#656 trap 3, at the call site.

    ``_share_info_cache`` is written **only on a successful fetch**, so a symbol
    whose fetch keeps failing has a cache entry describing the market *before*
    its failure. Reading the pill from there would report REGULAR on a symbol the
    app has not reached in hours — the exact case the pill exists to show. The
    record carries what this cycle read, which on a failure is nothing.
    """
    m = _metrics([_share()], store, mocker)
    m._share_info_cache["AAPL"] = {"marketState": "REGULAR"}
    mocker.patch.object(m, "_fetch_ticker_data", return_value=(None, None))

    m._scrape_symbol("AAPL", now=NOW)
    record = m.recorder.scrape_of("AAPL")

    assert record.market_state is None
    assert record.verdict == runtime_state.SCRAPE_NO_PRICE
    assert record.failure_count == 1


def test_an_unrecognised_state_records_the_coercion_beside_the_raw_value(
        store, fake_ticker, mocker, monkeypatch):
    """#656 trap 2. ``decide`` fail-opens to REGULAR while yfinance's raw string
    stays whatever it was, so the record carries both and the pill reads the
    coercion — otherwise the row would claim a state the scheduler ignored."""
    m = _metrics([_share()], store, mocker)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(market_state="SOMETHING_NEW"))

    m._scrape_symbol("AAPL", now=NOW)
    record = m.recorder.scrape_of("AAPL")

    assert record.market_state == "SOMETHING_NEW"
    assert record.closed is False
    assert record.verdict == runtime_state.SCRAPE_WROTE


def test_a_refused_write_is_recorded_although_617s_counter_stays_zero(
        store, fake_ticker, mocker, monkeypatch):
    """The finding this record makes visible.

    ``scheduling.decide`` resets the failure counter whenever a price was
    present, so a store refusing the write leaves the symbol polling at
    ``base_interval`` with a counter of zero — perfectly healthy by every measure
    the scheduler keeps, and persisting nothing. The dead-ticker guard watches
    yfinance by design; without ``SCRAPE_WRITE_FAILED`` nothing in the app would
    say this.
    """
    m = _metrics([_share()], store, mocker)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(market_state="REGULAR"))
    mocker.patch.object(main.quotes, "record_quote",
                        side_effect=RuntimeError("connection refused"))

    m._scrape_symbol("AAPL", now=NOW)
    record = m.recorder.scrape_of("AAPL")

    assert record.verdict == runtime_state.SCRAPE_WRITE_FAILED
    assert record.wrote is False
    assert record.failure_count == 0
    assert "the store refused the write" in record.error
    # And the cadence is untouched — the record is a diagnostic, not a gate.
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == \
        NOW + timedelta(seconds=120)


def test_a_closed_pass_is_recorded_without_touching_the_counter(
        store, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share()], store, mocker)
    m._failure_counts["AAPL"] = 2
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(market_state="CLOSED"))

    m._scrape_symbol("AAPL", now=NOW)
    record = m.recorder.scrape_of("AAPL")

    assert record.verdict == runtime_state.SCRAPE_CLOSED
    assert record.closed is True
    # A shut market is not a ticker fault: the counter is passed through.
    assert record.failure_count == 2


def test_the_628_sonde_rides_the_record_rather_than_being_recomputed(
        store, fake_ticker, mocker, monkeypatch):
    """The sonde's memory belongs to the scrape thread, so its verdict must too.

    Recomputing "is this series frozen" from a request thread would need
    ``_sonde_state`` *and* a fresh live price, read at a second instant — the
    composed read #656 déc. 4 exists to forbid, and it would disagree with the
    warning already in the log.
    """
    m = _metrics([_share(account="pea")], store, mocker)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(close=185.0, market_state="REGULAR"))
    # The stored price is frozen while the live quote moved, and the sonde's
    # memory says it has been frozen for longer than the horizon. The writer is
    # stopped so the frozen value stays frozen — the sonde's exact subject is a
    # symbol that fetches fine and persists nothing.
    quotes.record_quote(store, "AAPL", NOW - timedelta(seconds=120), 100.0)
    mocker.patch.object(main.quotes, "record_quote")
    m.staleness_horizon = 900
    m._sonde_state["AAPL"] = scheduling.SondeState(
        stored_price=100.0,
        frozen_since=NOW - timedelta(seconds=1000),
        last_seen=NOW - timedelta(seconds=120))

    m._scrape_symbol("AAPL", now=NOW)
    record = m.recorder.scrape_of("AAPL")

    assert record.stale is True


def test_a_departed_symbol_loses_its_records_with_its_counter(
        store, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share("AAPL")], store, mocker)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(market_state="REGULAR"))
    m._scrape_symbol("AAPL", now=NOW)
    assert m.recorder.scrape_of("AAPL") is not None

    # The symbol leaves the portfolio; reconcile removes its job.
    m.config_manager._shares = []
    m.scheduler.get_jobs.return_value = [
        SimpleNamespace(id=main._scrape_job_id("AAPL"))]
    m._reconcile_jobs()

    assert m.recorder.scrape_of("AAPL") is None


# ===================================================================== #
# The ingestion record
# ===================================================================== #

def test_a_rejected_configuration_is_recorded_as_kept_previous(
        store, mocker):
    """The silent failure #656 singled out.

    Since #658 an invalid configuration is never published, so the app keeps
    running on its previous snapshot — correctly, and with no trace anywhere but
    a log line. This record is that trace.
    """
    m = _metrics([_share()], store, mocker,
                 raises=ValueError("Invalid 'accounts' block"))

    m.ingest()
    record = m.recorder.ingest()

    assert record.outcome == runtime_state.INGEST_FAILED
    assert "Invalid 'accounts' block" in record.error


def test_an_unchanged_ingestion_is_told_apart_from_an_updated_one(
        store, mocker):
    events = [Event(datetime(2024, 1, 15).date(), EventType.BUY, "AAPL",
                    "Apple", quantity=10, unit_price=150.0)]
    m = _metrics([_share()], store, mocker, events=events)

    m.ingest()
    record = m.recorder.ingest()

    assert record.outcome == runtime_state.INGEST_UNCHANGED
    assert record.shares == 1
    assert record.events == 1
    assert record.error is None


# ===================================================================== #
# The backfill records — the terminal and the counter at their call sites
# ===================================================================== #

def test_a_grant_only_position_is_reconstructed_like_any_other(
        store, mocker):
    """``no_buy`` is gone, and the position it named is backfilled (issue #703).

    A granted share is held from the day it lands, so it has a history to
    reconstruct. Reading only ``BUY`` left a portfolio held entirely by grant
    publishing a terminal that meant *there was never anything to fetch*, while
    its chart stayed empty for ever. The target is the first **acquisition**.
    """
    events = [Event(datetime(2024, 6, 1).date(), EventType.GRANT, "AAPL",
                    "Apple", quantity=1)]
    m = _metrics([_share()], store, mocker, events=events)
    mocker.patch.object(m, "_fetch_historical_data", return_value=[
        {"timestamp": datetime(2024, 7, 1, tzinfo=UTC), "price": 170.0}])

    m.backfill()
    record = m.recorder.backfill_of("AAPL", runtime_state.BACKWARD)

    assert record.target == datetime(2024, 6, 1, tzinfo=UTC)
    assert record.terminal is None
    assert record.written == 1


def test_a_completed_backward_pass_records_both_dates_of_the_bar(
        store, mocker):
    events = [Event(datetime(2024, 1, 15).date(), EventType.BUY, "AAPL",
                    "Apple", quantity=10, unit_price=150.0)]
    m = _metrics([_share()], store, mocker, events=events)
    quotes.record_history(store, "AAPL", [
        {"timestamp": datetime(2024, 1, 10, tzinfo=UTC), "price": 100.0}])

    m.backfill()
    record = m.recorder.backfill_of("AAPL", runtime_state.BACKWARD)

    assert record.terminal == runtime_state.TERMINAL_COMPLETE
    assert record.oldest == datetime(2024, 1, 10, tzinfo=UTC)
    assert record.target == datetime(2024, 1, 15, tzinfo=UTC)


def test_a_failed_history_fetch_raises_the_consecutive_counter(
        store, mocker):
    """#656's driving question, answered at last.

    ``_backfill_backward`` logs a warning and returns ``0`` here — the same value
    a healthy weekend returns — so nothing in the app distinguished "pacing" from
    "wedged on yfinance". The counter does.
    """
    events = [Event(datetime(2020, 1, 15).date(), EventType.BUY, "AAPL",
                    "Apple", quantity=10, unit_price=150.0)]
    m = _metrics([_share()], store, mocker, events=events)
    quotes.record_history(store, "AAPL", [
        {"timestamp": datetime(2024, 1, 10, tzinfo=UTC), "price": 100.0}])
    mocker.patch.object(m, "_fetch_historical_data", return_value=None)

    m.backfill()
    m.backfill()
    record = m.recorder.backfill_of("AAPL", runtime_state.BACKWARD)

    assert record.failures == 2
    assert record.window is not None
    assert record.error is not None


def test_an_empty_window_is_recorded_without_raising_the_counter(
        store, mocker):
    """A weekend classifies itself by coming back empty (#606). Counting it
    would have every Monday morning read as wedged."""
    events = [Event(datetime(2020, 1, 15).date(), EventType.BUY, "AAPL",
                    "Apple", quantity=10, unit_price=150.0)]
    m = _metrics([_share()], store, mocker, events=events)
    quotes.record_history(store, "AAPL", [
        {"timestamp": datetime(2024, 1, 10, tzinfo=UTC), "price": 100.0}])
    mocker.patch.object(m, "_fetch_historical_data", return_value=[])
    mocker.patch("main.time.sleep")

    m.backfill()
    record = m.recorder.backfill_of("AAPL", runtime_state.BACKWARD)

    assert record.failures == 0
    assert record.terminal is None


def test_the_forward_pass_tells_an_unseeded_series_from_the_live_no_op(
        store, mocker):
    """Two no-ops meaning opposite things.

    ``no_series`` is waiting on the backward pass to seed it; ``too_recent`` is
    what a healthy portfolio looks like all day, the forward pass standing aside
    so the REGULAR writer stays the sole writer of the present.
    """
    events = [Event(datetime(2024, 1, 15).date(), EventType.BUY, "AAPL",
                    "Apple", quantity=10, unit_price=150.0)]
    m = _metrics([_share()], store, mocker, events=events)
    # Nothing stored at all: the backward pass owns seeding the series, and the
    # forward one has no anchor to measure from.
    mocker.patch.object(m, "_fetch_historical_data", return_value=[])
    mocker.patch("main.time.sleep")

    m.backfill()
    assert m.recorder.backfill_of(
        "AAPL", runtime_state.FORWARD).skipped == \
        runtime_state.SKIP_NO_SERIES

    quotes.record_history(store, "AAPL", [
        {"timestamp": datetime.now(UTC), "price": 101.0}])
    m.backfill()
    assert m.recorder.backfill_of(
        "AAPL", runtime_state.FORWARD).skipped == \
        runtime_state.SKIP_TOO_RECENT


# ===================================================================== #
# The perf record
# ===================================================================== #

def test_every_perf_cycle_records_that_it_ran(store, mocker):
    """Two verdicts, not three (issue #707): a cycle ran, or it failed.

    The record survives the gate's removal for the reason #656 gave it — a
    verdict is *recorded*, never inferred by a reader — but it has nothing
    beside it any more: an unconditional recompute has no decision to explain,
    and ``PERF_SKIPPED`` names a state nothing can reach.
    """
    m = _metrics([_share()], store, mocker)

    m.recompute_perf()
    record = m.recorder.perf()

    assert record.verdict == runtime_state.PERF_RAN
    assert record.error is None
    assert not hasattr(runtime_state, 'PERF_SKIPPED')


def test_a_failed_perf_recompute_records_the_error_it_only_logged(
        store, mocker):
    m = _metrics([_share()], store, mocker)
    mocker.patch.object(m, "update_account_metrics",
                        side_effect=Exception("the store is unreadable"))

    m.recompute_perf()
    record = m.recorder.perf()

    assert record.verdict == runtime_state.PERF_FAILED
    assert "the store is unreadable" in record.error


# ===================================================================== #
# The effective environment (#654 §6a → #656, halved by #701)
# ===================================================================== #
#
# What is left here is the half ADR-0014's test keeps in the environment: what
# the process must know *before* it can open the store. The dials moved into the
# store and are covered by ``test_settings.py``.

def test_the_database_variables_are_gone_and_are_named_as_such(monkeypatch):
    """#700. The three ``INFLUXDB_*`` names describe a server this version never
    contacts, so they leave the inventory — and are **named** on the way out.

    Removing them silently is what earns *"the token must be wrong"*: an install
    upgrading from v4 keeps an InfluxDB container running beside the app,
    answering healthchecks and receiving nothing.
    """
    monkeypatch.setenv("INFLUXDB_TOKEN", "apiv3_supersecret")
    monkeypatch.setenv("INFLUXDB_HOST", "http://influxdb:8181")

    names = {s["name"] for s in main.effective_environment()}
    assert names.isdisjoint(
        {"INFLUXDB_HOST", "INFLUXDB_TOKEN", "INFLUXDB_DATABASE"})

    assert "INFLUXDB_TOKEN" in main.unread_environment()
    assert "INFLUXDB_HOST" in main.unread_environment()


def test_the_dials_are_not_in_the_environment_list_any_more():
    """#701: a dial has no environment form at all — not even a reported one.

    Listing it here would be the precedence rule ADR-0014 removes, dressed as a
    read-only view: a reader seeing ``SB_REGULAR_INTERVAL`` next to the store's
    own value would reasonably conclude that setting it does something.
    """
    names = {s["name"] for s in main.effective_environment()}

    assert names.isdisjoint({
        "SB_REGULAR_INTERVAL", "SB_BACKFILL_INTERVAL", "SB_BACKFILL_DELAY",
        "SB_BACKFILL_CHUNK_DAYS", "SB_STALENESS_HORIZON", "SB_PERF_INTERVAL",
        "SB_EXECUTOR_POOL", "SB_DYNAMIC_EXECUTOR_POOL",
    })


def test_the_log_level_is_reported_from_the_running_logger(monkeypatch):
    """The one of these the app can change while it runs (#654 §6b)."""
    monkeypatch.setenv("LOG_LEVEL", "INFO")
    main.set_log_level("DEBUG")
    try:
        entry = {s["name"]: s for s in main.effective_environment()}["LOG_LEVEL"]
        assert entry["value"] == "DEBUG"
    finally:
        main.set_log_level("INFO")


def test_compose_only_variables_are_not_in_the_list(monkeypatch):
    """#654 trap 13. ``SB_VERSION`` and ``SB_CONFIG_DIR`` carry the prefix and
    are consumed by the docker daemon — from inside the container the config
    directory is *always* ``/home/appuser/.config/SuiviBourse``. Listing them
    would imply they are reachable from in here."""
    names = {s["name"] for s in main.effective_environment()}

    assert "SB_VERSION" not in names
    assert "SB_CONFIG_DIR" not in names
    assert "COMPOSE_PROJECT_NAME" not in names


def test_the_inventory_is_the_four_and_no_fifth():
    """#740, ADR-0033. The environment says four things; everything else is a
    dial, and the two the exporter answered for left with it.

    Named here rather than only in ``test_boot_env.py`` because this is the list
    ``/api/config`` publishes: a fifth name appearing in the payload is a fifth
    name the documentation would have to explain.
    """
    names = [s["name"] for s in main.effective_environment()]

    assert len(names) == 4
    assert set(names) == {
        "LOG_LEVEL", "SB_STORE_DIR", "SB_IMPORT_DIR", "SB_WEB_PORT"}


def test_the_bundle_location_is_no_longer_an_environment_variable(monkeypatch):
    """``SB_STATIC_DIR`` leaves with #740 rather than becoming the seventh name.

    It existed for "anyone serving the bundle from elsewhere", and that person
    has no existence left: one image, one path, and a checkout resolves it from
    the package. Setting it now does nothing and is *said* to do nothing.
    """
    monkeypatch.setenv("SB_STATIC_DIR", "/somewhere/else")

    assert "SB_STATIC_DIR" not in {
        s["name"] for s in main.effective_environment()}
    assert "SB_STATIC_DIR" in main.unread_environment()


def test_no_entry_claims_a_secret_could_be_redacted(monkeypatch):
    """#740. ``INFLUXDB_TOKEN`` was the environment's only credential and it
    left with the database (#700), so "redact by name, never by value" has had
    no subject since. A rule kept warm for a credential that may never come back
    is a rule nobody exercises — and a ``secret: false`` on every row reads as a
    promise this view knows how to keep."""
    assert all("secret" not in entry
               for entry in main.effective_environment())
