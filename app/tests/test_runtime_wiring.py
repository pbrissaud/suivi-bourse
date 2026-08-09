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

import main
import runtime_state
import scheduling
from events.schemas import Event, EventType


UTC = timezone.utc
NOW = datetime(2026, 8, 5, 15, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _no_jitter(mocker):
    mocker.patch("main.random.uniform", return_value=0.0)


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

    def __init__(self, shares, events=None, raises=None):
        self._shares = shares
        self._events = events if events is not None else []
        self._raises = raises

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


def _metrics(shares, mock_influx, mocker, **manager):
    cfg = _FakeConfigManager(shares, **manager)
    m = main.SuiviBourseMetrics(
        cfg, influxdb_writer=mock_influx,
        prometheus_exporter=mocker.MagicMock())
    m.scheduler = mocker.MagicMock(spec=BackgroundScheduler)
    m.regular_interval = 120
    return m


# ===================================================================== #
# The scrape record
# ===================================================================== #

def test_a_regular_pass_records_the_state_it_acted_on_and_its_counter(
        mock_influx, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share(account="pea")], mock_influx, mocker)
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
    assert record.accounts_written == ("pea",)


def test_a_failed_fetch_records_no_market_state_rather_than_a_stale_one(
        mock_influx, mocker):
    """#656 trap 3, at the call site.

    ``_share_info_cache`` is written **only on a successful fetch**, so a symbol
    whose fetch keeps failing has a cache entry describing the market *before*
    its failure. Reading the pill from there would report REGULAR on a symbol the
    app has not reached in hours — the exact case the pill exists to show. The
    record carries what this cycle read, which on a failure is nothing.
    """
    m = _metrics([_share()], mock_influx, mocker)
    m._share_info_cache["AAPL"] = {"marketState": "REGULAR"}
    mocker.patch.object(m, "_fetch_ticker_data", return_value=(None, None))

    m._scrape_symbol("AAPL", now=NOW)
    record = m.recorder.scrape_of("AAPL")

    assert record.market_state is None
    assert record.verdict == runtime_state.SCRAPE_NO_PRICE
    assert record.failure_count == 1


def test_an_unrecognised_state_records_the_coercion_beside_the_raw_value(
        mock_influx, fake_ticker, mocker, monkeypatch):
    """#656 trap 2. ``decide`` fail-opens to REGULAR while yfinance's raw string
    stays whatever it was, so the record carries both and the pill reads the
    coercion — otherwise the row would claim a state the scheduler ignored."""
    m = _metrics([_share()], mock_influx, mocker)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(market_state="SOMETHING_NEW"))

    m._scrape_symbol("AAPL", now=NOW)
    record = m.recorder.scrape_of("AAPL")

    assert record.market_state == "SOMETHING_NEW"
    assert record.closed is False
    assert record.verdict == runtime_state.SCRAPE_WROTE


def test_a_refused_influx_write_is_recorded_although_617s_counter_stays_zero(
        mock_influx, fake_ticker, mocker, monkeypatch):
    """The finding this record makes visible.

    ``scheduling.decide`` resets the failure counter whenever a price was
    present, so an InfluxDB outage leaves the symbol polling at ``base_interval``
    with a counter of zero — perfectly healthy by every measure the scheduler
    keeps, and persisting nothing. The dead-ticker guard watches yfinance by
    design; without ``SCRAPE_WRITE_FAILED`` nothing in the app would say this.
    """
    m = _metrics([_share()], mock_influx, mocker)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(market_state="REGULAR"))
    mock_influx.write_metrics.side_effect = Exception("connection refused")

    m._scrape_symbol("AAPL", now=NOW)
    record = m.recorder.scrape_of("AAPL")

    assert record.verdict == runtime_state.SCRAPE_WRITE_FAILED
    assert record.accounts_written == ()
    assert record.failure_count == 0
    assert "InfluxDB refused" in record.error
    # And the cadence is untouched — the record is a diagnostic, not a gate.
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == \
        NOW + timedelta(seconds=120)


def test_a_closed_pass_is_recorded_without_touching_the_counter(
        mock_influx, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share()], mock_influx, mocker)
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
        mock_influx, fake_ticker, mocker, monkeypatch):
    """The sonde's memory belongs to the scrape thread, so its verdict must too.

    Recomputing "is this series frozen" from a request thread would need
    ``_sonde_state`` *and* a fresh live price, read at a second instant — the
    composed read #656 déc. 4 exists to forbid, and it would disagree with the
    warning already in the log.
    """
    m = _metrics([_share(account="pea")], mock_influx, mocker)
    monkeypatch.setattr(main.yf, "Ticker",
                        lambda s: fake_ticker(close=185.0, market_state="REGULAR"))
    # The stored price is frozen while the live quote moved, and the sonde's
    # memory says it has been frozen for longer than the horizon.
    mock_influx.get_newest_price.return_value = 100.0
    m.staleness_horizon = 900
    m._sonde_state[("AAPL", "pea")] = scheduling.SondeState(
        stored_price=100.0,
        frozen_since=NOW - timedelta(seconds=1000),
        last_seen=NOW - timedelta(seconds=120))

    m._scrape_symbol("AAPL", now=NOW)
    record = m.recorder.scrape_of("AAPL")

    assert record.stale_accounts == ("pea",)


def test_a_departed_symbol_loses_its_records_with_its_counter(
        mock_influx, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share("AAPL")], mock_influx, mocker)
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
        mock_influx, mocker):
    """The silent failure #656 singled out.

    Since #658 an invalid configuration is never published, so the app keeps
    running on its previous snapshot — correctly, and with no trace anywhere but
    a log line. This record is that trace.
    """
    m = _metrics([_share()], mock_influx, mocker,
                 raises=ValueError("Invalid 'accounts' block"))

    m.ingest()
    record = m.recorder.ingest()

    assert record.outcome == runtime_state.INGEST_FAILED
    assert "Invalid 'accounts' block" in record.error


def test_an_unchanged_ingestion_is_told_apart_from_an_updated_one(
        mock_influx, mocker):
    events = [Event(datetime(2024, 1, 15).date(), EventType.BUY, "AAPL",
                    "Apple", quantity=10, unit_price=150.0)]
    m = _metrics([_share()], mock_influx, mocker, events=events)

    m.ingest()
    record = m.recorder.ingest()

    assert record.outcome == runtime_state.INGEST_UNCHANGED
    assert record.shares == 1
    assert record.events == 1
    assert record.error is None


# ===================================================================== #
# The backfill records — the three terminals at their call sites
# ===================================================================== #

def test_a_symbol_with_no_buy_records_its_own_terminal(
        mock_influx, mocker):
    """A GRANT-only position: nothing to reach back to, and never was.

    Distinct from ``complete`` (which means the reaching finished) and from
    manual mode (where the pass itself does not run).
    """
    events = [Event(datetime(2024, 6, 1).date(), EventType.GRANT, "AAPL",
                    "Apple", quantity=1)]
    m = _metrics([_share()], mock_influx, mocker, events=events)

    m.backfill()
    record = m.recorder.backfill_of("AAPL", "default", runtime_state.BACKWARD)

    assert record.terminal == runtime_state.TERMINAL_NO_BUY


def test_a_completed_backward_pass_records_both_dates_of_the_bar(
        mock_influx, mocker):
    events = [Event(datetime(2024, 1, 15).date(), EventType.BUY, "AAPL",
                    "Apple", quantity=10, unit_price=150.0)]
    m = _metrics([_share()], mock_influx, mocker, events=events)
    m._share_info_cache["AAPL"] = {"currency": "USD", "exchange": "NMS",
                                   "quoteType": "EQUITY"}
    mock_influx.get_oldest_timestamp.return_value = datetime(
        2024, 1, 10, tzinfo=UTC)

    m.backfill()
    record = m.recorder.backfill_of("AAPL", "default", runtime_state.BACKWARD)

    assert record.terminal == runtime_state.TERMINAL_COMPLETE
    assert record.oldest == datetime(2024, 1, 10, tzinfo=UTC)
    assert record.target == datetime(2024, 1, 15, tzinfo=UTC)


def test_a_failed_history_fetch_raises_the_consecutive_counter(
        mock_influx, mocker):
    """#656's driving question, answered at last.

    ``_backfill_backward`` logs a warning and returns ``0`` here — the same value
    a healthy weekend returns — so nothing in the app distinguished "pacing" from
    "wedged on yfinance". The counter does.
    """
    events = [Event(datetime(2020, 1, 15).date(), EventType.BUY, "AAPL",
                    "Apple", quantity=10, unit_price=150.0)]
    m = _metrics([_share()], mock_influx, mocker, events=events)
    m._share_info_cache["AAPL"] = {"currency": "USD", "exchange": "NMS",
                                   "quoteType": "EQUITY"}
    mock_influx.get_oldest_timestamp.return_value = datetime(
        2024, 1, 10, tzinfo=UTC)
    mocker.patch.object(m, "_fetch_historical_data", return_value=None)

    m.backfill()
    m.backfill()
    record = m.recorder.backfill_of("AAPL", "default", runtime_state.BACKWARD)

    assert record.failures == 2
    assert record.window is not None
    assert record.error is not None


def test_an_empty_window_is_recorded_without_raising_the_counter(
        mock_influx, mocker):
    """A weekend classifies itself by coming back empty (#606). Counting it
    would have every Monday morning read as wedged."""
    events = [Event(datetime(2020, 1, 15).date(), EventType.BUY, "AAPL",
                    "Apple", quantity=10, unit_price=150.0)]
    m = _metrics([_share()], mock_influx, mocker, events=events)
    m._share_info_cache["AAPL"] = {"currency": "USD", "exchange": "NMS",
                                   "quoteType": "EQUITY"}
    mock_influx.get_oldest_timestamp.return_value = datetime(
        2024, 1, 10, tzinfo=UTC)
    mocker.patch.object(m, "_fetch_historical_data", return_value=[])
    mocker.patch("main.time.sleep")

    m.backfill()
    record = m.recorder.backfill_of("AAPL", "default", runtime_state.BACKWARD)

    assert record.failures == 0
    assert record.terminal is None


def test_the_forward_pass_tells_an_unseeded_series_from_the_live_no_op(
        mock_influx, mocker):
    """Two no-ops meaning opposite things.

    ``no_series`` is waiting on the backward pass to seed it; ``too_recent`` is
    what a healthy portfolio looks like all day, the forward pass standing aside
    so the REGULAR writer stays the sole writer of the present.
    """
    events = [Event(datetime(2024, 1, 15).date(), EventType.BUY, "AAPL",
                    "Apple", quantity=10, unit_price=150.0)]
    m = _metrics([_share()], mock_influx, mocker, events=events)
    m._share_info_cache["AAPL"] = {"currency": "USD", "exchange": "NMS",
                                   "quoteType": "EQUITY"}
    mock_influx.get_oldest_timestamp.return_value = datetime(
        2024, 1, 10, tzinfo=UTC)

    m.backfill()
    assert m.recorder.backfill_of(
        "AAPL", "default", runtime_state.FORWARD).skipped == \
        runtime_state.SKIP_NO_SERIES

    mock_influx.get_newest_timestamp.return_value = datetime.now(UTC)
    m.backfill()
    assert m.recorder.backfill_of(
        "AAPL", "default", runtime_state.FORWARD).skipped == \
        runtime_state.SKIP_TOO_RECENT


# ===================================================================== #
# The perf record
# ===================================================================== #

def test_a_skipped_perf_run_is_recorded_because_its_signal_is_consumed(
        mock_influx, mocker):
    """#656 trap 4, and the reason this record cannot be replaced by a pull.

    ``recompute_perf`` reads **and clears** ``_perf_dirty_live`` under
    ``_perf_lock``, so a request thread reading that flag learns about a run that
    is pending and nothing at all about the one that just happened. The verdict
    has to be recorded.
    """
    m = _metrics([_share()], mock_influx, mocker)
    m._perf_dirty_live = False
    # Align with the published events so `events_changed` is False: the gate is
    # an identity check, so a different (even equal) list reads as a reload.
    m._perf_last_events = m.config_manager.get_events()

    m.recompute_perf()
    record = m.recorder.perf()

    assert record.verdict == runtime_state.PERF_SKIPPED
    assert (record.events_changed, record.backfill_pending, record.live_write) \
        == (False, False, False)


def test_a_perf_run_records_which_of_618s_three_signals_fired(
        mock_influx, mocker):
    m = _metrics([_share()], mock_influx, mocker)
    m._perf_dirty_live = True
    m._perf_last_events = m.config_manager.get_events()

    m.recompute_perf()
    record = m.recorder.perf()

    assert record.verdict == runtime_state.PERF_RAN
    assert record.live_write is True
    assert record.events_changed is False


def test_a_failed_perf_recompute_records_the_error_it_only_logged(
        mock_influx, mocker):
    m = _metrics([_share()], mock_influx, mocker)
    m._perf_dirty_live = True
    mocker.patch.object(m, "update_account_metrics",
                        side_effect=Exception("influx down"))

    m.recompute_perf()
    record = m.recorder.perf()

    assert record.verdict == runtime_state.PERF_FAILED
    assert "influx down" in record.error


# ===================================================================== #
# The effective configuration (#654 §6a, handed to #656)
# ===================================================================== #

def test_the_token_is_redacted_by_name_never_by_value(monkeypatch):
    """#654 trap 12. The prototype has no authentication — auth is out of the
    map's scope — so the secret never leaves the process. ``set`` is the only
    thing worth saying about it."""
    monkeypatch.setenv("INFLUXDB_TOKEN", "apiv3_supersecret")

    entry = {s["name"]: s for s in main.effective_settings()}["INFLUXDB_TOKEN"]

    assert entry["secret"] is True
    assert entry["value"] is None
    assert entry["set"] is True


def test_a_runtime_dial_is_reported_from_the_attribute_not_the_environment(
        mock_influx, mocker, monkeypatch):
    """#654 §2.1: five dials are held on a mutable attribute re-read every cycle,
    so the effective value and the environment can diverge. The attribute is the
    one the app is actually running on."""
    monkeypatch.setenv("SB_BACKFILL_CHUNK_DAYS", "365")
    m = _metrics([_share()], mock_influx, mocker)
    m.backfill_chunk_days = 180

    entry = {s["name"]: s
             for s in main.effective_settings(m)}["SB_BACKFILL_CHUNK_DAYS"]

    assert entry["value"] == "180"
    assert entry["scope"] == "runtime"


def test_compose_only_variables_are_not_in_the_list(monkeypatch):
    """#654 trap 13. ``SB_VERSION`` and ``SB_CONFIG_DIR`` carry the prefix and
    are consumed by the docker daemon — from inside the container the config
    directory is *always* ``/home/appuser/.config/SuiviBourse``. Listing them
    would imply they are reachable from in here."""
    names = {s["name"] for s in main.effective_settings()}

    assert "SB_VERSION" not in names
    assert "SB_CONFIG_DIR" not in names
    assert "COMPOSE_PROJECT_NAME" not in names


def test_a_variable_with_no_scalar_fallback_reads_unset_not_default(monkeypatch):
    """``INFLUXDB_TOKEN`` is required and has no default, so there is nothing to
    show — and showing one would be a guess about a value the app cannot know."""
    monkeypatch.delenv("INFLUXDB_TOKEN", raising=False)

    entry = {s["name"]: s for s in main.effective_settings()}["INFLUXDB_TOKEN"]

    assert entry["source"] == "unset"
    assert entry["value"] is None
