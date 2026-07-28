"""
Tests for the per-symbol scheduler wiring in ``main`` (issue #616 / #614).

The scheduler is a ``MagicMock(spec=BackgroundScheduler)`` spy — no real
scheduler runs. yfinance and InfluxDB are mocked. These cover the runtime glue
that the pure ``scheduling`` module can't: re-arm delay, ingest() reconciliation
(add / remove / revive / untouched + the race guard), the write-gate vs
reschedule-gate split, and the Prometheus fetch-success gate (#609).
"""

import threading
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from apscheduler.jobstores.base import JobLookupError
from apscheduler.schedulers.background import BackgroundScheduler

import main
import scheduling
from main import (
    SuiviBourseMetrics, _scrape_job_id, resolve_regular_interval,
    resolve_executor_pool_size, register_interval_jobs, SCRAPE_JOB_PREFIX)


UTC = timezone.utc
NOW = datetime(2024, 1, 15, 15, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _no_jitter(mocker):
    """Zero the anti-herd jitter (issue #619) for the cadence/reconcile tests.

    Jitter is an orthogonal concern: these tests pin the exact base re-arm delay,
    so the random ``uniform(0, JITTER_SECONDS)`` offset ``_arm_symbol`` adds would
    make ``run_date`` non-deterministic. Zero it here; the dedicated jitter tests
    below re-patch ``main.random.uniform`` to assert the spread.
    """
    mocker.patch("main.random.uniform", return_value=0.0)


def _share(symbol="AAPL", name="Apple", account="default"):
    return {
        "name": name,
        "symbol": symbol,
        "account": account,
        "purchase": {"quantity": 10, "fee": 2.5, "cost_price": 150.0},
        "estate": {"quantity": 10, "received_dividend": 2.4},
    }


class _FakeConfigManager:
    def __init__(self, shares):
        self._shares = shares

    def load_shares(self, force=False):
        return self._shares

    def get_mode(self):
        return "manual"

    def load_accounts(self):
        return None

    def get_events(self):
        return None


def _metrics(shares, mock_influx, shares_validator, mocker, prometheus=None):
    cfg = _FakeConfigManager(shares)
    m = SuiviBourseMetrics(cfg, shares_validator, influxdb_writer=mock_influx,
                           prometheus_exporter=prometheus or mocker.MagicMock())
    m.scheduler = mocker.MagicMock(spec=BackgroundScheduler)
    m.regular_interval = 120
    return m


def _job(job_id):
    return SimpleNamespace(id=job_id)


# ---------------------------------------------------------------------------
# _scrape_symbol — write gate vs reschedule gate
# ---------------------------------------------------------------------------

def test_scrape_symbol_regular_writes_and_rearms_at_base_interval(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    mock_influx.write_metrics.assert_called_once()
    # Re-armed as a one-shot 'date' job, base_interval from now.
    call = m.scheduler.add_job.call_args
    assert call.args[1] == "date"            # trigger (positional)
    assert call.kwargs["id"] == _scrape_job_id("AAPL")
    assert call.kwargs["run_date"] == NOW + timedelta(seconds=120)
    assert call.kwargs["args"] == ["AAPL"]


def test_scrape_symbol_coerces_unknown_state_to_regular_and_writes(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    # Default fake_ticker has no marketState -> coerced REGULAR (fail-open).
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker())

    m._scrape_symbol("AAPL", now=NOW)

    mock_influx.write_metrics.assert_called_once()
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(seconds=120)


def test_scrape_symbol_closed_skips_write_and_sleeps_to_next_open(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    next_open_ts = (NOW + timedelta(hours=2)).timestamp()
    meta = {"currentTradingPeriod": {"regular": {"start": next_open_ts}}}
    monkeypatch.setattr(
        main.yf, "Ticker",
        lambda s: fake_ticker(market_state="CLOSED", history_metadata=meta))

    m._scrape_symbol("AAPL", now=NOW)

    mock_influx.write_metrics.assert_not_called()
    # Slept to the exact next open (no lead-in margin).
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(hours=2)


def test_scrape_symbol_price_failure_keeps_polling_without_writing(
        mock_influx, shares_validator, mocker):
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    mocker.patch.object(m, "_fetch_ticker_data", return_value=(None, None))

    m._scrape_symbol("AAPL", now=NOW)

    mock_influx.write_metrics.assert_not_called()
    # Reschedule gate still REGULAR (fail-open) -> keeps polling at base_interval.
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(seconds=120)


def test_scrape_symbol_writes_one_point_per_account_holding_symbol(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    shares = [_share(account="pea"), _share(account="cto")]
    m = _metrics(shares, mock_influx, shares_validator, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    assert mock_influx.write_metrics.call_count == 2
    accounts = {c.kwargs["account"] for c in mock_influx.write_metrics.call_args_list}
    assert accounts == {"pea", "cto"}
    # One fetch feeds both account points.
    m.scheduler.add_job.assert_called_once()


# ---------------------------------------------------------------------------
# Dead-ticker backoff wiring (#617) — per-job failure state
# ---------------------------------------------------------------------------

def test_scrape_symbol_failure_increments_and_backs_off(
        mock_influx, shares_validator, mocker):
    """A run of non-closed no-price cycles grows the re-arm delay past base."""
    m = _metrics([_share("AAPL")], mock_influx, shares_validator, mocker)
    mocker.patch.object(m, "_fetch_ticker_data", return_value=(None, None))

    # First three failures stay at base_interval (grace window).
    for _ in range(3):
        m._scrape_symbol("AAPL", now=NOW)
    assert m._failure_counts["AAPL"] == 3
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(seconds=120)

    # Fourth failure backs off to base×2.
    m._scrape_symbol("AAPL", now=NOW)
    assert m._failure_counts["AAPL"] == 4
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(seconds=240)


def test_scrape_symbol_success_resets_failure_count(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """A successful write clears an accumulated backoff back to base_interval."""
    m = _metrics([_share("AAPL")], mock_influx, shares_validator, mocker)
    m._failure_counts["AAPL"] = 5
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    assert m._failure_counts["AAPL"] == 0
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(seconds=120)


def test_reconcile_removes_departed_symbol_failure_state(
        mock_influx, shares_validator, mocker):
    """Failure state must not survive symbol removal (per-job lifetime)."""
    m = _metrics([_share("AAPL")], mock_influx, shares_validator, mocker)
    m._failure_counts = {"AAPL": 1, "MSFT": 9}
    m.scheduler.get_jobs.return_value = [
        _job(_scrape_job_id("AAPL")), _job(_scrape_job_id("MSFT"))]

    m._reconcile_jobs()  # MSFT departed (only AAPL held)

    m.scheduler.remove_job.assert_called_once_with(_scrape_job_id("MSFT"))
    assert "MSFT" not in m._failure_counts
    assert m._failure_counts == {"AAPL": 1}


def test_scrape_symbol_departed_does_not_persist_failure_count(
        mock_influx, shares_validator, mocker):
    """A scrape whose symbol has already departed must not (re)write its
    backoff counter — the held-recheck guards the persist (issue #617)."""
    m = _metrics([_share("AAPL")], mock_influx, shares_validator, mocker)
    m._failure_counts["AAPL"] = 3
    mocker.patch.object(m, "_fetch_ticker_data", return_value=(None, None))
    m.shares = []  # departed between the last reconcile and this cycle

    m._scrape_symbol("AAPL", now=NOW)

    assert "AAPL" not in m._failure_counts     # not resurrected
    m.scheduler.add_job.assert_not_called()    # and not re-armed


def test_inflight_scrape_racing_with_cleanup_does_not_resurrect_counter(
        mock_influx, shares_validator, mocker):
    """The named race: a scrape in-flight when reconcile removes its symbol
    must not write the failure counter back after cleanup popped it.

    The fetch blocks the scrape thread *before* its lock-guarded persist, so the
    reconcile pop is forced to win the shared lock first; when the scrape then
    resumes it sees the symbol no longer held and skips the write. Without the
    lock + held-recheck this would leave a stale 'AAPL' entry (resurrection)."""
    m = _metrics([_share("AAPL")], mock_influx, shares_validator, mocker)
    m._failure_counts["AAPL"] = 2  # a backoff already building

    fetch_started = threading.Event()
    release_fetch = threading.Event()

    def blocking_fetch(symbol):
        fetch_started.set()
        assert release_fetch.wait(timeout=5)
        return (None, None)  # failure -> decide would increment + persist

    mocker.patch.object(m, "_fetch_ticker_data", side_effect=blocking_fetch)

    scrape_thread = threading.Thread(target=m._scrape_symbol, args=("AAPL",))
    scrape_thread.start()
    assert fetch_started.wait(timeout=5)  # scrape is in-flight, pre-persist

    # Symbol departs: ingest updates shares, reconcile removes the job + pops.
    m.shares = []
    m.scheduler.get_jobs.return_value = [_job(_scrape_job_id("AAPL"))]
    m._reconcile_jobs()
    assert "AAPL" not in m._failure_counts  # cleanup popped it

    # Let the in-flight scrape finish; it must NOT restore the counter.
    release_fetch.set()
    scrape_thread.join(timeout=5)
    assert not scrape_thread.is_alive()
    assert "AAPL" not in m._failure_counts
    m.scheduler.add_job.assert_not_called()  # also does not re-arm


# ---------------------------------------------------------------------------
# Perf recompute — gated interval job (#618)
# ---------------------------------------------------------------------------

def test_scrape_symbol_regular_write_sets_perf_dirty_live(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """A REGULAR write raises the global live-write dirty bool (issue #618)."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    m._perf_dirty_live = False  # start clean to prove the write sets it
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    mock_influx.write_metrics.assert_called_once()
    assert m._perf_dirty_live is True


def test_scrape_symbol_closed_does_not_set_perf_dirty_live(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """A closed-market probe writes nothing and leaves the flag clean, so a
    fully-closed wave produces no perf point (non-trading-day gap #606)."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    m._perf_dirty_live = False
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="CLOSED"))

    m._scrape_symbol("AAPL", now=NOW)

    mock_influx.write_metrics.assert_not_called()
    assert m._perf_dirty_live is False


def test_scrape_symbol_price_failure_does_not_set_perf_dirty_live(
        mock_influx, shares_validator, mocker):
    """A non-closed cycle with no writable price writes nothing -> flag stays."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    m._perf_dirty_live = False
    mocker.patch.object(m, "_fetch_ticker_data", return_value=(None, None))

    m._scrape_symbol("AAPL", now=NOW)

    assert m._perf_dirty_live is False


def test_scrape_symbol_failed_influx_write_does_not_set_perf_dirty_live(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """write_metrics raising (Influx outage) must not raise the dirty flag —
    no point persisted, so there is nothing new for perf to read (#618)."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    m._perf_dirty_live = False
    mock_influx.write_metrics.side_effect = Exception("influx unreachable")
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    mock_influx.write_metrics.assert_called_once()
    assert m._perf_dirty_live is False


def test_recompute_perf_skips_when_all_quiet(
        mock_influx, shares_validator, mocker):
    """No dirty signal -> update_account_metrics is not called (no Parquet drip)."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    # Clear the boot seed and align _perf_last_events with current events so
    # events_changed is False (get_events() returns None for the fake manager).
    m._perf_dirty_live = False
    m._perf_last_events = m.config_manager.get_events()
    spy = mocker.patch.object(m, "update_account_metrics")

    m.recompute_perf()

    spy.assert_not_called()


def test_recompute_perf_boot_seed_runs_first_cycle(
        mock_influx, shares_validator, mocker):
    """Seeded True at boot -> the first cycle always runs (fresh restart point)."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    assert m._perf_dirty_live is True          # boot seed
    spy = mocker.patch.object(m, "update_account_metrics")

    m.recompute_perf()

    spy.assert_called_once()


def test_recompute_perf_runs_and_clears_live_flag_under_lock(
        mock_influx, shares_validator, mocker):
    """A live REGULAR write triggers a run; the flag is checked-and-cleared."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    m._perf_dirty_live = False
    m._perf_last_events = m.config_manager.get_events()
    spy = mocker.patch.object(m, "update_account_metrics")

    # A live write lands (as _scrape_symbol would set it).
    with m._perf_lock:
        m._perf_dirty_live = True

    m.recompute_perf()
    spy.assert_called_once()
    assert m._perf_dirty_live is False         # cleared

    # Next quiet cycle skips — the flag was consumed, not sticky.
    spy.reset_mock()
    m.recompute_perf()
    spy.assert_not_called()


def test_recompute_perf_runs_when_backfill_watermark_pending(
        mock_influx, shares_validator, mocker):
    """A pending backfill watermark alone triggers a run (checked, not consumed
    here — update_account_metrics consumes it)."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    m._perf_dirty_live = False
    m._perf_last_events = m.config_manager.get_events()
    m._mark_perf_dirty(date(2024, 1, 2))
    spy = mocker.patch.object(m, "update_account_metrics")

    m.recompute_perf()

    spy.assert_called_once()
    # Watermark is only *checked* in the gate; consumption stays downstream.
    assert m._perf_dirty_from == date(2024, 1, 2)


def test_recompute_perf_runs_when_events_changed(
        mock_influx, shares_validator, mocker):
    """A reloaded events cache (new list object) alone triggers a run."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    m._perf_dirty_live = False
    # _perf_last_events differs from get_events() (None) -> events_changed True.
    m._perf_last_events = ["stale"]
    spy = mocker.patch.object(m, "update_account_metrics")

    m.recompute_perf()

    spy.assert_called_once()


def test_recompute_perf_error_does_not_propagate_and_rearms_live_flag(
        mock_influx, shares_validator, mocker):
    """An update_account_metrics failure is logged (never killing the thread) and
    the consumed live-write signal is re-armed so the next cycle retries."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    m._perf_dirty_live = True  # a live write triggered this cycle
    mocker.patch.object(m, "update_account_metrics", side_effect=RuntimeError("boom"))

    m.recompute_perf()  # must not raise

    assert m._perf_dirty_live is True  # re-armed for the next cycle


# ---------------------------------------------------------------------------
# register_interval_jobs — perf job at SB_PERF_INTERVAL, separate from scrape
# ---------------------------------------------------------------------------

def test_register_interval_jobs_registers_perf_at_its_own_interval(
        mock_influx, shares_validator, mocker):
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    scheduler = mocker.MagicMock(spec=BackgroundScheduler)

    register_interval_jobs(
        scheduler, m, ingestion_interval=300, backfill_interval=60,
        perf_interval=90)

    by_id = {c.kwargs["id"]: c for c in scheduler.add_job.call_args_list}
    assert set(by_id) == {"ingest", "backfill", "perf"}
    perf = by_id["perf"]
    # perf is an interval job at SB_PERF_INTERVAL, bound to recompute_perf.
    assert perf.args[0].__func__ is SuiviBourseMetrics.recompute_perf
    assert perf.args[1] == "interval"
    assert perf.kwargs["seconds"] == 90
    # Separate from the per-symbol scrape jobs (no scrape: prefixed id here).
    assert not any(jid.startswith(SCRAPE_JOB_PREFIX) for jid in by_id)


# ---------------------------------------------------------------------------
# Prometheus fetch-success gate (#609)
# ---------------------------------------------------------------------------

def test_prometheus_updates_on_closed_market_probe(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    prom = mocker.MagicMock()
    m = _metrics([_share()], mock_influx, shares_validator, mocker, prometheus=prom)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="CLOSED"))

    m._scrape_symbol("AAPL", now=NOW)

    # Closed -> no write, but the sb_share_* gauges still update (fetch success).
    mock_influx.write_metrics.assert_not_called()
    prom.update_share.assert_called_once()


def test_prometheus_not_updated_when_fetch_fails(
        mock_influx, shares_validator, mocker):
    prom = mocker.MagicMock()
    m = _metrics([_share()], mock_influx, shares_validator, mocker, prometheus=prom)
    mocker.patch.object(m, "_fetch_ticker_data", return_value=(None, None))

    m._scrape_symbol("AAPL", now=NOW)

    prom.update_share.assert_not_called()


# ---------------------------------------------------------------------------
# Price-freshness liveness sonde (#628) — diagnostic only
# ---------------------------------------------------------------------------

def test_sonde_flags_writer_frozen_across_consecutive_regular_cycles(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch, caplog):
    """A writer whose stored price stays frozen across consecutive REGULAR cycles
    for >= the horizon while the live quote moves → WARNING + gauge 1. The signal
    needs a first cycle to baseline, then a later cycle past the horizon."""
    prom = mocker.MagicMock()
    m = _metrics([_share()], mock_influx, shares_validator, mocker, prometheus=prom)
    m.staleness_horizon = 900
    # Live close is 185.0 (fake_ticker default); stored value never advances.
    mock_influx.get_newest_price.return_value = 180.0
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    # Cycle 1: baseline — no signal yet.
    m._scrape_symbol("AAPL", now=NOW)
    assert prom.update_price_staleness.call_args == mocker.call(m.shares[0], False)

    # Cycle 2, one horizon later (gap not wider than the horizon): still frozen,
    # quote moved → stale.
    with caplog.at_level("WARNING"):
        m._scrape_symbol("AAPL", now=NOW + timedelta(seconds=900))

    assert any("Price-freshness sonde" in r.message and "AAPL" in r.message
               for r in caplog.records)
    assert prom.update_price_staleness.call_args == mocker.call(m.shares[0], True)
    # Diagnostic only: writes and re-arms happened normally each cycle.
    assert mock_influx.write_metrics.call_count == 2


def test_sonde_no_false_positive_first_tick_after_close(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """The market-open-after-close fix: a polling gap wider than the horizon
    (overnight) re-baselines, so the first morning tick raises no signal even
    though the stored point is legitimately hours old and the quote gapped."""
    prom = mocker.MagicMock()
    m = _metrics([_share()], mock_influx, shares_validator, mocker, prometheus=prom)
    m.staleness_horizon = 900
    mock_influx.get_newest_price.return_value = 180.0  # frozen value across the gap
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    # Yesterday's last REGULAR cycle baselines the series.
    m._scrape_symbol("AAPL", now=NOW)
    # This morning, 16h later (a break in consecutive polling): re-baseline, not stale.
    m._scrape_symbol("AAPL", now=NOW + timedelta(hours=16))

    assert prom.update_price_staleness.call_args == mocker.call(m.shares[0], False)


def test_sonde_no_false_positive_when_writer_advances_value(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """A normally-updating symbol advances the stored value each cycle → the
    sonde re-baselines and never flags, however long it runs."""
    prom = mocker.MagicMock()
    m = _metrics([_share()], mock_influx, shares_validator, mocker, prometheus=prom)
    m.staleness_horizon = 900
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    mock_influx.get_newest_price.return_value = 180.0
    m._scrape_symbol("AAPL", now=NOW)
    # Next cycle the writer has persisted a new value (healthy).
    mock_influx.get_newest_price.return_value = 184.0
    m._scrape_symbol("AAPL", now=NOW + timedelta(seconds=900))

    assert prom.update_price_staleness.call_args == mocker.call(m.shares[0], False)


def test_sonde_does_not_run_on_closed_market(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """The sonde is a REGULAR-only check: a closed probe writes nothing and never
    reads the stored price or touches the staleness gauge."""
    prom = mocker.MagicMock()
    m = _metrics([_share()], mock_influx, shares_validator, mocker, prometheus=prom)
    m.staleness_horizon = 900
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="CLOSED"))

    m._scrape_symbol("AAPL", now=NOW)

    mock_influx.get_newest_price.assert_not_called()
    prom.update_price_staleness.assert_not_called()


def test_sonde_disabled_when_horizon_non_positive(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """A non-positive horizon turns the sonde off: no read, no gauge, write intact."""
    prom = mocker.MagicMock()
    m = _metrics([_share()], mock_influx, shares_validator, mocker, prometheus=prom)
    m.staleness_horizon = 0
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    mock_influx.get_newest_price.assert_not_called()
    prom.update_price_staleness.assert_not_called()
    mock_influx.write_metrics.assert_called_once()


def test_sonde_read_error_never_disturbs_scrape(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """A read error in the sonde is swallowed: the write, re-arm, and backoff
    reset all proceed exactly as if the sonde were absent (diagnostic only)."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    m.staleness_horizon = 900
    mock_influx.get_newest_price.side_effect = RuntimeError("db down")
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    mock_influx.write_metrics.assert_called_once()
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(seconds=120)


def test_sonde_checks_each_account_holding(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """One live fetch, but the sonde reads and reports per (symbol, account)."""
    prom = mocker.MagicMock()
    shares = [_share(account="pea"), _share(account="cto")]
    m = _metrics(shares, mock_influx, shares_validator, mocker, prometheus=prom)
    m.staleness_horizon = 900
    mock_influx.get_newest_price.return_value = None  # no stored price yet
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    # Scoped per account on the read side...
    read_accounts = {c.kwargs["account"]
                     for c in mock_influx.get_newest_price.call_args_list}
    assert read_accounts == {"pea", "cto"}
    # ...and both cleared to fresh (None stored price → not stale).
    assert prom.update_price_staleness.call_count == 2


# ---------------------------------------------------------------------------
# _reconcile_jobs — add / remove / revive / untouched + race guard
# ---------------------------------------------------------------------------

def test_reconcile_adds_new_symbols_firing_immediately(
        mock_influx, shares_validator, mocker):
    m = _metrics([_share("AAPL"), _share("MSFT", "Microsoft")],
                 mock_influx, shares_validator, mocker)
    m.scheduler.get_jobs.return_value = [_job(_scrape_job_id("AAPL"))]

    before = datetime.now(UTC)
    m._reconcile_jobs()

    added = {c.kwargs["id"] for c in m.scheduler.add_job.call_args_list}
    assert added == {_scrape_job_id("MSFT")}          # AAPL untouched
    m.scheduler.remove_job.assert_not_called()
    # New symbol fires immediately (~now).
    run_date = m.scheduler.add_job.call_args.kwargs["run_date"]
    assert before <= run_date <= datetime.now(UTC) + timedelta(seconds=1)


def test_reconcile_removes_departed_symbols(
        mock_influx, shares_validator, mocker):
    m = _metrics([_share("AAPL")], mock_influx, shares_validator, mocker)
    m.scheduler.get_jobs.return_value = [
        _job(_scrape_job_id("AAPL")), _job(_scrape_job_id("MSFT"))]

    m._reconcile_jobs()

    m.scheduler.add_job.assert_not_called()            # AAPL untouched
    m.scheduler.remove_job.assert_called_once_with(_scrape_job_id("MSFT"))


def test_reconcile_revives_missing_job(mock_influx, shares_validator, mocker):
    # Held symbol whose job vanished (e.g. a misfire death) is re-armed. Foreign
    # (non-scrape) jobs in the store are ignored by the prefix filter.
    m = _metrics([_share("AAPL")], mock_influx, shares_validator, mocker)
    m.scheduler.get_jobs.return_value = [_job("ingest"), _job("backfill")]

    m._reconcile_jobs()

    m.scheduler.add_job.assert_called_once()
    assert m.scheduler.add_job.call_args.kwargs["id"] == _scrape_job_id("AAPL")
    m.scheduler.remove_job.assert_not_called()


def test_reconcile_leaves_unchanged_jobs_untouched(
        mock_influx, shares_validator, mocker):
    m = _metrics([_share("AAPL"), _share("MSFT", "Microsoft")],
                 mock_influx, shares_validator, mocker)
    m.scheduler.get_jobs.return_value = [
        _job(_scrape_job_id("AAPL")), _job(_scrape_job_id("MSFT"))]

    m._reconcile_jobs()

    m.scheduler.add_job.assert_not_called()
    m.scheduler.remove_job.assert_not_called()


def test_reconcile_one_remove_failure_does_not_abort_the_pass(
        mock_influx, shares_validator, mocker):
    """A JobLookupError from one vanished job (a self-re-armed date job that
    just fired) must not skip the remaining removals or arms."""
    m = _metrics([_share("AAPL"), _share("TSLA", "Tesla")],
                 mock_influx, shares_validator, mocker)
    m.scheduler.get_jobs.return_value = [
        _job(_scrape_job_id("MSFT")), _job(_scrape_job_id("GOOG"))]
    # First removal raises (job already gone); the second must still run.
    m.scheduler.remove_job.side_effect = [JobLookupError("gone"), None]

    m._reconcile_jobs()

    armed = {c.kwargs["id"] for c in m.scheduler.add_job.call_args_list}
    assert armed == {_scrape_job_id("AAPL"), _scrape_job_id("TSLA")}
    removed = {c.args[0] for c in m.scheduler.remove_job.call_args_list}
    assert removed == {_scrape_job_id("MSFT"), _scrape_job_id("GOOG")}


def test_scrape_symbol_does_not_rearm_when_symbol_no_longer_held(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """In-flight half of the race guard: a job removed mid-cycle must not
    re-add itself after reconcile's remove_job."""
    m = _metrics([_share("AAPL")], mock_influx, shares_validator, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))
    # Symbol departs between fetch and re-arm.
    m.shares = []

    m._scrape_symbol("AAPL", now=NOW)

    m.scheduler.add_job.assert_not_called()


def test_ingest_reconciles_against_scheduler(
        mock_influx, shares_validator, mocker):
    m = _metrics([_share("AAPL")], mock_influx, shares_validator, mocker)
    m.scheduler.get_jobs.return_value = []  # nothing scheduled yet

    m.ingest()

    # First ingest arms the held symbol (bootstrap via immediate fire).
    m.scheduler.add_job.assert_called_once()
    assert m.scheduler.add_job.call_args.kwargs["id"] == _scrape_job_id("AAPL")


def test_reconcile_noop_without_scheduler(mock_influx, shares_validator, mocker):
    cfg = _FakeConfigManager([_share("AAPL")])
    m = SuiviBourseMetrics(cfg, shares_validator, influxdb_writer=mock_influx,
                           prometheus_exporter=mocker.MagicMock())
    # scheduler is None -> reconcile is a safe no-op (unit tests that never wire
    # a scheduler still exercise ingest()).
    assert m.scheduler is None
    m._reconcile_jobs()  # must not raise


# ---------------------------------------------------------------------------
# resolve_regular_interval — precedence + deprecation warning (#607)
# ---------------------------------------------------------------------------

def test_regular_interval_defaults_to_120(monkeypatch):
    monkeypatch.delenv("SB_REGULAR_INTERVAL", raising=False)
    monkeypatch.delenv("SB_SCRAPING_INTERVAL", raising=False)
    assert resolve_regular_interval() == 120


def test_regular_interval_prefers_new_var(monkeypatch, mocker):
    monkeypatch.setenv("SB_REGULAR_INTERVAL", "60")
    monkeypatch.setenv("SB_SCRAPING_INTERVAL", "300")
    warn = mocker.patch.object(main.app_logger, "warning")
    assert resolve_regular_interval() == 60          # new wins
    warn.assert_called_once()                        # deprecated var flagged


def test_regular_interval_falls_back_to_old_var_with_warning(monkeypatch, mocker):
    monkeypatch.delenv("SB_REGULAR_INTERVAL", raising=False)
    monkeypatch.setenv("SB_SCRAPING_INTERVAL", "90")
    warn = mocker.patch.object(main.app_logger, "warning")
    assert resolve_regular_interval() == 90          # honored as fallback
    warn.assert_called_once()


def test_regular_interval_no_warning_when_old_var_absent(monkeypatch, mocker):
    monkeypatch.setenv("SB_REGULAR_INTERVAL", "45")
    monkeypatch.delenv("SB_SCRAPING_INTERVAL", raising=False)
    warn = mocker.patch.object(main.app_logger, "warning")
    assert resolve_regular_interval() == 45
    warn.assert_not_called()


# ---------------------------------------------------------------------------
# Anti-herd jitter + misfire/max_instances on the per-symbol jobs (issue #619)
# ---------------------------------------------------------------------------

def test_arm_symbol_offsets_run_date_by_jitter(
        mock_influx, shares_validator, mocker):
    """Jitter is applied as a uniform(0, JITTER_SECONDS) offset on run_date."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    # Re-patch over the autouse zero-jitter with a fixed non-zero offset.
    uniform = mocker.patch("main.random.uniform", return_value=7.5)

    m._arm_symbol("AAPL", 120, NOW)

    uniform.assert_called_once_with(0, scheduling.JITTER_SECONDS)
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == \
        NOW + timedelta(seconds=127.5)


def test_arm_symbol_jitter_stays_within_window(
        mock_influx, shares_validator, mocker):
    """With real randomness the offset lands in [0, JITTER_SECONDS]."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    mocker.stopall()  # drop the autouse zero-jitter -> real random.uniform

    lo = NOW + timedelta(seconds=120)
    hi = lo + timedelta(seconds=scheduling.JITTER_SECONDS)
    for _ in range(50):
        m._arm_symbol("AAPL", 120, NOW)
        run_date = m.scheduler.add_job.call_args.kwargs["run_date"]
        assert lo <= run_date <= hi


def test_arm_symbol_registers_misfire_none_and_single_instance(
        mock_influx, shares_validator, mocker):
    """Per-symbol jobs carry misfire_grace_time=None and max_instances=1."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)

    m._arm_symbol("AAPL", 120, NOW)

    kwargs = m.scheduler.add_job.call_args.kwargs
    assert kwargs["misfire_grace_time"] is None
    assert kwargs["max_instances"] == 1
    assert kwargs["replace_existing"] is True


def test_scrape_symbol_rearm_carries_misfire_and_max_instances(
        mock_influx, shares_validator, fake_ticker, mocker, monkeypatch):
    """The self-reschedule (not just the bootstrap) keeps the misfire policy."""
    m = _metrics([_share()], mock_influx, shares_validator, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    kwargs = m.scheduler.add_job.call_args.kwargs
    assert kwargs["misfire_grace_time"] is None
    assert kwargs["max_instances"] == 1


# ---------------------------------------------------------------------------
# resolve_executor_pool_size — the two dials (issue #619)
# ---------------------------------------------------------------------------

def _never_capture():  # a capture callable that must NOT be invoked
    raise AssertionError("capture_exchanges called on the fixed-pool path")


def test_executor_pool_defaults_to_ten(monkeypatch):
    monkeypatch.delenv("SB_DYNAMIC_EXECUTOR_POOL", raising=False)
    monkeypatch.delenv("SB_EXECUTOR_POOL", raising=False)
    # Fixed path: capture must not run (no pre-scheduler fetch).
    assert resolve_executor_pool_size("manual", [], _never_capture) == 10


def test_executor_pool_honors_fixed_dial(monkeypatch):
    monkeypatch.setenv("SB_DYNAMIC_EXECUTOR_POOL", "false")
    monkeypatch.setenv("SB_EXECUTOR_POOL", "4")
    assert resolve_executor_pool_size("manual", [], _never_capture) == 4


def test_executor_pool_fixed_enforces_at_least_one(monkeypatch):
    monkeypatch.setenv("SB_EXECUTOR_POOL", "0")
    monkeypatch.delenv("SB_DYNAMIC_EXECUTOR_POOL", raising=False)
    assert resolve_executor_pool_size("manual", [], _never_capture) == 1


def test_executor_pool_auto_uses_compute_pool_size(monkeypatch):
    monkeypatch.setenv("SB_DYNAMIC_EXECUTOR_POOL", "true")
    monkeypatch.delenv("SB_EXECUTOR_POOL", raising=False)
    shares = [{"symbol": f"S{i}"} for i in range(30)]
    exchange_of = {s["symbol"]: "NMS" for s in shares}
    # events/30-same-exchange -> 3 + ceil(150/30) = 8 (design #611 example).
    assert resolve_executor_pool_size(
        "events", shares, lambda: exchange_of) == 8


def test_executor_pool_auto_warns_when_fixed_also_set(monkeypatch, mocker):
    monkeypatch.setenv("SB_DYNAMIC_EXECUTOR_POOL", "true")
    monkeypatch.setenv("SB_EXECUTOR_POOL", "10")
    warn = mocker.patch.object(main.app_logger, "warning")
    size = resolve_executor_pool_size("manual", [], lambda: {})
    warn.assert_called_once()          # conflicting fixed dial flagged
    assert size == 1                   # empty portfolio, manual -> reserved 1


# ---------------------------------------------------------------------------
# capture_exchange_of — pre-scheduler exchange snapshot (issue #619)
# ---------------------------------------------------------------------------

def test_capture_exchange_of_reads_info_cache_and_fetches_missing(
        mock_influx, shares_validator, mocker):
    m = _metrics([_share(symbol="AAPL"), _share(symbol="MSFT")],
                 mock_influx, shares_validator, mocker)
    # AAPL already cached; MSFT must be fetched.
    m._share_info_cache["AAPL"] = {"exchange": "NMS"}
    fetch = mocker.patch.object(
        m, "_fetch_ticker_data", return_value=(1.0, {"exchange": "PAR"}))

    result = m.capture_exchange_of()

    assert result == {"AAPL": "NMS", "MSFT": "PAR"}
    fetch.assert_called_once_with("MSFT")   # cached AAPL not re-fetched


def test_capture_exchange_of_maps_failed_and_undefined_to_none(
        mock_influx, shares_validator, mocker):
    m = _metrics([_share(symbol="AAA"), _share(symbol="BBB")],
                 mock_influx, shares_validator, mocker)

    def _fetch(symbol):
        return (None, None) if symbol == "AAA" else (1.0, {"exchange": "undefined"})

    mocker.patch.object(m, "_fetch_ticker_data", side_effect=_fetch)

    result = m.capture_exchange_of()

    # Failed fetch and the 'undefined' sentinel both become solo (None).
    assert result == {"AAA": None, "BBB": None}


def test_capture_exchange_of_times_out_to_solo_market(
        mock_influx, shares_validator, mocker):
    """A fetch that outlives the deadline maps to a solo market, not a hang."""
    m = _metrics([_share(symbol="SLOW")], mock_influx, shares_validator, mocker)
    mocker.patch("main._EXCHANGE_CAPTURE_TIMEOUT_SECONDS", 0.2)
    release = threading.Event()

    def _slow(symbol):
        release.wait(timeout=5)          # outlasts the 0.2s deadline
        return (1.0, {"exchange": "NMS"})

    mocker.patch.object(m, "_fetch_ticker_data", side_effect=_slow)
    try:
        result = m.capture_exchange_of()
        # Startup didn't block on the slow fetch; the symbol fell back to solo.
        assert result == {"SLOW": None}
    finally:
        release.set()                    # let the worker thread exit cleanly
