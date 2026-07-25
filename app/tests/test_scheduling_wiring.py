"""
Tests for the per-symbol scheduler wiring in ``main`` (issue #616 / #614).

The scheduler is a ``MagicMock(spec=BackgroundScheduler)`` spy — no real
scheduler runs. yfinance and InfluxDB are mocked. These cover the runtime glue
that the pure ``scheduling`` module can't: re-arm delay, ingest() reconciliation
(add / remove / revive / untouched + the race guard), the write-gate vs
reschedule-gate split, and the Prometheus fetch-success gate (#609).
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from apscheduler.schedulers.background import BackgroundScheduler

import main
from main import SuiviBourseMetrics, _scrape_job_id, resolve_regular_interval


UTC = timezone.utc
NOW = datetime(2024, 1, 15, 15, 0, tzinfo=UTC)


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
