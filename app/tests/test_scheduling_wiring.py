"""
Tests for the per-symbol scheduler wiring in ``main`` (issue #616 / #614).

The scheduler is a ``MagicMock(spec=BackgroundScheduler)`` spy — no real
scheduler runs, because what is under test is the *wiring* and not APScheduler.
The store, on the other hand, is real (issue #700): a write is asserted on the
row it produced, never on a call it made. These cover the runtime glue that the
pure ``scheduling`` module can't: re-arm delay, ingest() reconciliation (add /
remove / revive / untouched + the race guard), the write-gate vs reschedule-gate
split, and the Prometheus fetch-success gate (#609).
"""

import threading
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from apscheduler.jobstores.base import JobLookupError
from apscheduler.schedulers.background import BackgroundScheduler

import main
import quotes
import runtime_state
import scheduling
import settings
import settings_registry
from events.schemas import Event, EventType
from main import (
    SuiviBourseMetrics, _scrape_job_id,
    register_interval_jobs, SCRAPE_JOB_PREFIX)


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


def _share(symbol="AAPL", name="Apple", account="default", quantity=10):
    """One position in the v5 shape — a quantity and a cost basis (#699).

    ``quantity=0`` is what a sold position looks like, and the only thing that
    takes a symbol out of ``_held_symbols`` and therefore out of the scrape.
    """
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
    #: No configuration directory: the two v4 files an advisory names are
    #: *unobservable* from here rather than absent (issue #709).
    config_dir = None

    def __init__(self, shares, opened_store=None):
        self._shares = shares
        self._store = opened_store
        self._events = []

    def current(self):
        return main.ConfigSnapshot(shares=self._shares, events=self._events,
                                   accounts=None, cache_key=None)

    def reload(self, force=False):
        return self.current()

    def load_shares(self, force=False):
        return self._shares

    def load_accounts(self):
        return None

    def get_events(self):
        return self._events

    @property
    def store(self):
        return self._store

    @contextmanager
    def writing(self):
        yield self._store


def _metrics(shares, store, mocker, prometheus=None):
    """A metrics object over a real store, with the declaration it references.

    The two ``INSERT``s are the configuration path's rows the foreign keys ask
    for: the market writer never invents a declaration, which is the schema rule
    (one writer per row) seen from a test's side.
    """
    for share in shares:
        store.execute(
            "INSERT INTO account (id, type, label) VALUES (?, 'CTO', ?) "
            "ON CONFLICT (id) DO NOTHING",
            [share["account"], share["account"]])
        store.execute(
            "INSERT INTO symbol (symbol) VALUES (?) "
            "ON CONFLICT (symbol) DO NOTHING", [share["symbol"]])
    cfg = _FakeConfigManager(shares, opened_store=store)
    m = SuiviBourseMetrics(cfg,
                           prometheus_exporter=prometheus or mocker.MagicMock())
    m.scheduler = mocker.MagicMock(spec=BackgroundScheduler)
    m.regular_interval = 120
    return m


def _prices(store, symbol="AAPL"):
    """A symbol's stored prices, oldest first — what a write is asserted on."""
    return [row[0] for row in store.query(
        "SELECT price_native FROM price_point WHERE symbol = ? ORDER BY ts",
        [symbol])]


def _job(job_id):
    return SimpleNamespace(id=job_id)


# ---------------------------------------------------------------------------
# _scrape_symbol — write gate vs reschedule gate
# ---------------------------------------------------------------------------

def test_scrape_symbol_regular_writes_and_rearms_at_base_interval(
        store, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share()], store, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    assert _prices(store) == [185.0]
    # Re-armed as a one-shot 'date' job, base_interval from now.
    call = m.scheduler.add_job.call_args
    assert call.args[1] == "date"            # trigger (positional)
    assert call.kwargs["id"] == _scrape_job_id("AAPL")
    assert call.kwargs["run_date"] == NOW + timedelta(seconds=120)
    assert call.kwargs["args"] == ["AAPL"]


def test_scrape_symbol_coerces_unknown_state_to_regular_and_writes(
        store, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share()], store, mocker)
    # Default fake_ticker has no marketState -> coerced REGULAR (fail-open).
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker())

    m._scrape_symbol("AAPL", now=NOW)

    assert _prices(store) == [185.0]
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(seconds=120)


def test_scrape_symbol_closed_skips_write_and_sleeps_to_next_open(
        store, fake_ticker, mocker, monkeypatch):
    m = _metrics([_share()], store, mocker)
    next_open_ts = (NOW + timedelta(hours=2)).timestamp()
    meta = {"currentTradingPeriod": {"regular": {"start": next_open_ts}}}
    monkeypatch.setattr(
        main.yf, "Ticker",
        lambda s: fake_ticker(market_state="CLOSED", history_metadata=meta))

    m._scrape_symbol("AAPL", now=NOW)

    assert _prices(store) == []
    # Slept to the exact next open (no lead-in margin).
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(hours=2)


def test_scrape_symbol_price_failure_keeps_polling_without_writing(
        store, mocker):
    m = _metrics([_share()], store, mocker)
    mocker.patch.object(m, "_fetch_ticker_data", return_value=(None, None))

    m._scrape_symbol("AAPL", now=NOW)

    assert _prices(store) == []
    # Reschedule gate still REGULAR (fail-open) -> keeps polling at base_interval.
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(seconds=120)


def test_scrape_symbol_writes_one_point_however_many_accounts_hold_it(
        store, fake_ticker, mocker, monkeypatch):
    """#700's structural decision, at the write.

    The loop used to run per holding because the *series* carried the account.
    It does not: a market observation belongs to no account, so two holdings of
    one share are one point. Writing it twice would inflate the series by the
    number of accounts and leave every read of it choosing between duplicates.
    """
    shares = [_share(account="pea"), _share(account="cto")]
    m = _metrics(shares, store, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    assert _prices(store) == [185.0]
    # One fetch, one point, one re-arm.
    m.scheduler.add_job.assert_called_once()


# ---------------------------------------------------------------------------
# Dead-ticker backoff wiring (#617) — per-job failure state
# ---------------------------------------------------------------------------

def test_scrape_symbol_failure_increments_and_backs_off(
        store, mocker):
    """A run of non-closed no-price cycles grows the re-arm delay past base."""
    m = _metrics([_share("AAPL")], store, mocker)
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
        store, fake_ticker, mocker, monkeypatch):
    """A successful write clears an accumulated backoff back to base_interval."""
    m = _metrics([_share("AAPL")], store, mocker)
    m._failure_counts["AAPL"] = 5
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    assert m._failure_counts["AAPL"] == 0
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(seconds=120)


def test_reconcile_removes_departed_symbol_failure_state(
        store, mocker):
    """Failure state must not survive symbol removal (per-job lifetime)."""
    m = _metrics([_share("AAPL")], store, mocker)
    m._failure_counts = {"AAPL": 1, "MSFT": 9}
    m.scheduler.get_jobs.return_value = [
        _job(_scrape_job_id("AAPL")), _job(_scrape_job_id("MSFT"))]

    m._reconcile_jobs()  # MSFT departed (only AAPL held)

    m.scheduler.remove_job.assert_called_once_with(_scrape_job_id("MSFT"))
    assert "MSFT" not in m._failure_counts
    assert m._failure_counts == {"AAPL": 1}


def test_scrape_symbol_departed_does_not_persist_failure_count(
        store, mocker):
    """A scrape whose symbol has already departed must not (re)write its
    backoff counter — the held-recheck guards the persist (issue #617)."""
    m = _metrics([_share("AAPL")], store, mocker)
    m._failure_counts["AAPL"] = 3
    mocker.patch.object(m, "_fetch_ticker_data", return_value=(None, None))
    m.config_manager._shares = []  # departed between the last reconcile and this cycle

    m._scrape_symbol("AAPL", now=NOW)

    assert "AAPL" not in m._failure_counts     # not resurrected
    m.scheduler.add_job.assert_not_called()    # and not re-armed


def test_inflight_scrape_racing_with_cleanup_does_not_resurrect_counter(
        store, mocker):
    """The named race: a scrape in-flight when reconcile removes its symbol
    must not write the failure counter back after cleanup popped it.

    The fetch blocks the scrape thread *before* its lock-guarded persist, so the
    reconcile pop is forced to win the shared lock first; when the scrape then
    resumes it sees the symbol no longer held and skips the write. Without the
    lock + held-recheck this would leave a stale 'AAPL' entry (resurrection)."""
    m = _metrics([_share("AAPL")], store, mocker)
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
    m.config_manager._shares = []
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
# Perf recompute — its own interval job, ungated (#618, #707)
# ---------------------------------------------------------------------------

def test_the_scrape_carries_no_perf_state_at_all(
        store, fake_ticker, mocker, monkeypatch):
    """A REGULAR write signals nothing to the perf job (issue #707).

    The write path raised a global live-write bool, which was the last thing the
    scrape and the recompute shared. The recompute is unconditional now, so the
    price this cycle wrote is simply read by the next one out of the store —
    and there is no attribute left for a future cycle to consult.
    """
    m = _metrics([_share()], store, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    assert _prices(store) == [185.0]
    assert not [name for name in vars(m) if name.startswith("_perf")]


def test_scrape_symbol_failed_store_write_is_named_as_such(
        store, fake_ticker, mocker, monkeypatch):
    """A refused write persists no point, and the verdict is what says so.

    #617's counter cannot see a refused write — ``decide`` fetched a price
    successfully — so the record is the only thing that can (issue #668).
    """
    m = _metrics([_share()], store, mocker)
    mocker.patch.object(main.quotes, "record_quote",
                        side_effect=RuntimeError("the store refused the write"))
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    assert _prices(store) == []
    record = m.recorder.scrape_of("AAPL")
    assert record.verdict == runtime_state.SCRAPE_WRITE_FAILED
    assert record.wrote is False


def test_every_perf_cycle_recomputes(store, mocker):
    """No gate: a quiet cycle recomputes exactly like a busy one.

    Run twice with nothing whatever happening in between — no write, no
    backfill, no reload. Both cycles rebuild the cache, which is the shape a
    self-repairing one has: it costs 0,4 % of its own tick and it is never
    behind by more than one.
    """
    m = _metrics([_share()], store, mocker)
    spy = mocker.patch.object(m, "update_account_metrics")

    m.recompute_perf()
    m.recompute_perf()

    assert spy.call_count == 2


def test_the_backfill_signals_nothing_to_the_perf_job(
        store, fake_ticker, mocker, monkeypatch):
    """The last coupling between the two jobs is gone (issue #707).

    A chunk landing used to lower a watermark the recompute read, through the
    two methods asserted absent below. The chunk still lands — the price rows
    say so — and the perf job learns about it the only way it learns about
    anything: by reading the store on its next tick.
    """
    m = _metrics([_share()], store, mocker)
    m.config_manager._events = [
        Event(date(2020, 1, 15), EventType.BUY, "AAPL", "Apple",
              quantity=10, unit_price=150.0)]
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(rows=2))

    m.backfill()

    assert _prices(store)
    assert not hasattr(m, "_mark_perf_dirty")
    assert not hasattr(m, "_consume_perf_dirty_from")


def test_recompute_perf_error_does_not_propagate(store, mocker):
    """An update_account_metrics failure is logged, never killing the thread.

    Nothing is re-armed afterwards, and nothing needs to be: the next tick
    recomputes the whole series whatever happened here.
    """
    m = _metrics([_share()], store, mocker)
    mocker.patch.object(m, "update_account_metrics", side_effect=RuntimeError("boom"))

    m.recompute_perf()  # must not raise

    assert m.recorder.perf().verdict == runtime_state.PERF_FAILED


# ---------------------------------------------------------------------------
# register_interval_jobs — the perf job is separate from the scrape (#618/#701)
# ---------------------------------------------------------------------------

def test_register_interval_jobs_registers_perf_on_its_own_tick(
        store, mocker):
    m = _metrics([_share()], store, mocker)
    scheduler = mocker.MagicMock(spec=BackgroundScheduler)

    register_interval_jobs(scheduler, m, backfill_interval=60)

    by_id = {c.kwargs["id"]: c for c in scheduler.add_job.call_args_list}
    # Two, not three: the ``ingest`` job left with SB_INGESTION_INTERVAL
    # (issue #697). The replay follows the write now, so there is no cadence
    # for it to be registered at.
    assert set(by_id) == {"backfill", "perf"}
    perf = by_id["perf"]
    # The perf tick is a constant, not a dial (#701/#707): the two tables are a
    # cache and a full recompute costs 0,4 % of the tick, so there is nothing
    # left for an operator to trade off.
    assert perf.args[0].__func__ is SuiviBourseMetrics.recompute_perf
    assert perf.args[1] == "interval"
    assert perf.kwargs["seconds"] == scheduling.PERF_TICK
    # And it fires **at the boot**, not one tick later (#707): an interval
    # trigger schedules at ``start + interval``, which would leave the pages on
    # the previous process's cache — or on nothing at all — for two minutes.
    assert perf.kwargs["next_run_time"] <= datetime.now(UTC)
    assert "next_run_time" not in by_id["backfill"].kwargs
    # The backfill's cadence *is* a dial, and it arrives as an argument.
    assert by_id["backfill"].kwargs["seconds"] == 60
    # Separate from the per-symbol scrape jobs (no scrape: prefixed id here).
    assert not any(jid.startswith(SCRAPE_JOB_PREFIX) for jid in by_id)


# ---------------------------------------------------------------------------
# Prometheus fetch-success gate (#609)
# ---------------------------------------------------------------------------

def test_prometheus_updates_on_closed_market_probe(
        store, fake_ticker, mocker, monkeypatch):
    prom = mocker.MagicMock()
    m = _metrics([_share()], store, mocker, prometheus=prom)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="CLOSED"))

    m._scrape_symbol("AAPL", now=NOW)

    # Closed -> no write, but the market gauges still update (fetch success).
    assert _prices(store) == []
    prom.update_quote.assert_called_once()
    # And the scrape never touches the position half — the replay owns it (#699).
    prom.update_position.assert_not_called()


def test_prometheus_not_updated_when_fetch_fails(
        store, mocker):
    prom = mocker.MagicMock()
    m = _metrics([_share()], store, mocker, prometheus=prom)
    mocker.patch.object(m, "_fetch_ticker_data", return_value=(None, None))

    m._scrape_symbol("AAPL", now=NOW)

    prom.update_share.assert_not_called()


# ---------------------------------------------------------------------------
# Price-freshness liveness sonde (#628) — diagnostic only
# ---------------------------------------------------------------------------

def _freeze_the_writer(store, mocker, stored=180.0):
    """Seed a stored price and stop the writer from ever advancing it.

    The sonde's exact subject: a symbol whose **fetch works** and whose
    persistence does not. With a real store there is no other way to produce it —
    a healthy write refreshes ``symbol_quote.last_price_native`` in the same
    transaction as the point, which is precisely why the sonde re-baselines on a
    writer that is doing its job.
    """
    quotes.record_quote(store, "AAPL", NOW - timedelta(hours=1), stored)
    mocker.patch.object(main.quotes, "record_quote")


def test_sonde_flags_writer_frozen_across_consecutive_regular_cycles(
        store, fake_ticker, mocker, monkeypatch, caplog):
    """A writer whose stored price stays frozen across consecutive REGULAR cycles
    for >= the horizon while the live quote moves → WARNING + gauge 1. The signal
    needs a first cycle to baseline, then a later cycle past the horizon."""
    prom = mocker.MagicMock()
    m = _metrics([_share()], store, mocker, prometheus=prom)
    m.staleness_horizon = 900
    # Live close is 185.0 (fake_ticker default); the stored value never advances.
    _freeze_the_writer(store, mocker)
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
    # Diagnostic only: it never gates the write or the re-arm.
    assert m.recorder.scrape_of("AAPL").stale is True
    assert m.recorder.scrape_of("AAPL").verdict == runtime_state.SCRAPE_WROTE


def test_the_sonde_watches_the_native_price_and_never_a_converted_one(
        store, fake_ticker, mocker, monkeypatch):
    """Spec #695 § 7, and it is a rule rather than a detail.

    The question is whether the *writer* has gone silently stale. A converted
    price moves whenever the exchange rate does, so a sonde watching one would
    read a currency tick as a refreshed price and answer "fresh" about a symbol
    frozen since Tuesday. The column it reads is named here so #702 cannot point
    it at the other one by accident.
    """
    m = _metrics([_share()], store, mocker)
    m.staleness_horizon = 900
    _freeze_the_writer(store, mocker)
    # A conversion lands on the same row without the native price moving.
    store.execute("UPDATE symbol_quote SET last_price_converted = 210.0, "
                  "last_fx_rate = 1.1 WHERE symbol = 'AAPL'")
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)
    m._scrape_symbol("AAPL", now=NOW + timedelta(seconds=900))

    assert m.recorder.scrape_of("AAPL").stale is True


def test_sonde_no_false_positive_first_tick_after_close(
        store, fake_ticker, mocker, monkeypatch):
    """The market-open-after-close fix: a polling gap wider than the horizon
    (overnight) re-baselines, so the first morning tick raises no signal even
    though the stored point is legitimately hours old and the quote gapped."""
    prom = mocker.MagicMock()
    m = _metrics([_share()], store, mocker, prometheus=prom)
    m.staleness_horizon = 900
    _freeze_the_writer(store, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    # Yesterday's last REGULAR cycle baselines the series.
    m._scrape_symbol("AAPL", now=NOW)
    # This morning, 16h later (a break in consecutive polling): re-baseline, not stale.
    m._scrape_symbol("AAPL", now=NOW + timedelta(hours=16))

    assert prom.update_price_staleness.call_args == mocker.call(m.shares[0], False)


def test_sonde_no_false_positive_when_writer_advances_value(
        store, fake_ticker, mocker, monkeypatch):
    """A normally-updating symbol advances the stored value each cycle → the
    sonde re-baselines and never flags, however long it runs.

    Nothing is faked here at all: the real writer refreshes the ``latest`` row
    in the same transaction as the point, which is what makes the healthy case
    healthy.
    """
    prom = mocker.MagicMock()
    m = _metrics([_share()], store, mocker, prometheus=prom)
    m.staleness_horizon = 900
    quotes.record_quote(store, "AAPL", NOW - timedelta(hours=1), 180.0)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)
    m._scrape_symbol("AAPL", now=NOW + timedelta(seconds=900))

    assert prom.update_price_staleness.call_args == mocker.call(m.shares[0], False)


def test_sonde_does_not_run_on_closed_market(
        store, fake_ticker, mocker, monkeypatch):
    """The sonde is a REGULAR-only check: a closed probe writes nothing and never
    reads the stored price or touches the staleness gauge."""
    prom = mocker.MagicMock()
    m = _metrics([_share()], store, mocker, prometheus=prom)
    m.staleness_horizon = 900
    read = mocker.spy(main.quotes, "last_price")
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="CLOSED"))

    m._scrape_symbol("AAPL", now=NOW)

    read.assert_not_called()
    prom.update_price_staleness.assert_not_called()


def test_sonde_disabled_when_horizon_non_positive(
        store, fake_ticker, mocker, monkeypatch):
    """A non-positive horizon turns the sonde off: no read, no gauge, write intact."""
    prom = mocker.MagicMock()
    m = _metrics([_share()], store, mocker, prometheus=prom)
    m.staleness_horizon = 0
    read = mocker.spy(main.quotes, "last_price")
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    read.assert_not_called()
    prom.update_price_staleness.assert_not_called()
    assert _prices(store) == [185.0]


def test_sonde_read_error_never_disturbs_scrape(
        store, fake_ticker, mocker, monkeypatch):
    """A read error in the sonde is swallowed: the write, re-arm, and backoff
    reset all proceed exactly as if the sonde were absent (diagnostic only)."""
    m = _metrics([_share()], store, mocker)
    m.staleness_horizon = 900
    mocker.patch.object(main.quotes, "last_price",
                        side_effect=RuntimeError("db down"))
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    assert _prices(store) == [185.0]
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == NOW + timedelta(seconds=120)


def test_the_sonde_asks_once_per_symbol_and_reports_to_every_holding(
        store, fake_ticker, mocker, monkeypatch):
    """It was per ``(symbol, account)`` until #700 and is per symbol now: the
    series it watches has one row per symbol, so the same value would have been
    compared against the same memory once per holding.

    The **gauge** keeps its per-account identity, because that is how a headless
    dashboard joins it to the position gauges beside it.
    """
    prom = mocker.MagicMock()
    shares = [_share(account="pea"), _share(account="cto")]
    m = _metrics(shares, store, mocker, prometheus=prom)
    m.staleness_horizon = 900
    read = mocker.spy(main.quotes, "last_price")
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    assert read.call_count == 1
    # Nothing stored yet → not stale, and both holdings' gauges are cleared.
    assert prom.update_price_staleness.call_count == 2


# ---------------------------------------------------------------------------
# _reconcile_jobs — add / remove / revive / untouched + race guard
# ---------------------------------------------------------------------------

def test_reconcile_adds_new_symbols_firing_immediately(
        store, mocker):
    m = _metrics([_share("AAPL"), _share("MSFT", "Microsoft")],
                 store, mocker)
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
        store, mocker):
    m = _metrics([_share("AAPL")], store, mocker)
    m.scheduler.get_jobs.return_value = [
        _job(_scrape_job_id("AAPL")), _job(_scrape_job_id("MSFT"))]

    m._reconcile_jobs()

    m.scheduler.add_job.assert_not_called()            # AAPL untouched
    m.scheduler.remove_job.assert_called_once_with(_scrape_job_id("MSFT"))


def test_a_sold_position_is_not_a_held_symbol(store, mocker):
    """The filter is on ``quantity``, which is what makes the docstring true (#699)."""
    m = _metrics([_share("AAPL"), _share("ALO", quantity=0)], store, mocker)

    assert m._held_symbols() == {"AAPL"}
    # And the row itself has not gone anywhere: the replay still writes its
    # realized gain and the page still shows it.
    assert {s["symbol"] for s in m.shares} == {"AAPL", "ALO"}


def test_an_account_that_sold_out_stops_being_written(
        store, fake_ticker, mocker, monkeypatch):
    """The holding still decides **whether** to write, not how many times (#700).

    Held in the PEA, sold out in the CTO: the job stays armed for the symbol and
    the point lands once. What #699 was guarding against — the CTO collecting a
    point of zeros every cycle — cannot happen at all now that the observation
    carries no account; what survives is that a symbol nobody holds any more is
    not written for.
    """
    m = _metrics([_share("AAPL", account="pea"),
                  _share("AAPL", account="cto", quantity=0)],
                 store, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    assert _prices(store) == [185.0]


def test_the_synchronous_driver_skips_a_sold_position_too(
        store, fake_ticker, mocker, monkeypatch):
    """The one place a sold line could still have reached Yahoo (#699)."""
    fetched = []
    m = _metrics([_share("AAPL"), _share("ALO", quantity=0)], store, mocker)

    def ticker(symbol):
        fetched.append(symbol)
        return fake_ticker()
    monkeypatch.setattr(main.yf, "Ticker", ticker)

    m.expose_metrics()

    assert fetched == ["AAPL"]
    assert _prices(store) == [185.0]
    assert _prices(store, "ALO") == []


def test_selling_out_removes_the_scrape_job_and_its_quote_gauges(
        store, mocker):
    prom = mocker.MagicMock()
    m = _metrics([_share("AAPL"), _share("ALO", quantity=0)], store,
                 mocker, prometheus=prom)
    m.scheduler.get_jobs.return_value = [
        _job(_scrape_job_id("AAPL")), _job(_scrape_job_id("ALO"))]

    m._reconcile_jobs()

    m.scheduler.remove_job.assert_called_once_with(_scrape_job_id("ALO"))
    # A frozen sb_share_price is unreadable; an absent one is not (#672 D6).
    prom.forget_quotes.assert_called_once_with("ALO")


def test_a_failing_gauge_removal_never_aborts_the_reconcile(
        store, mocker):
    prom = mocker.MagicMock()
    prom.forget_quotes.side_effect = RuntimeError("registry is unhappy")
    m = _metrics([_share("AAPL", quantity=0), _share("MSFT", quantity=0)],
                 store, mocker, prometheus=prom)
    m.scheduler.get_jobs.return_value = [
        _job(_scrape_job_id("AAPL")), _job(_scrape_job_id("MSFT"))]

    m._reconcile_jobs()

    assert m.scheduler.remove_job.call_count == 2


def test_buying_back_re_arms_the_job_with_nothing_to_unset(store, mocker):
    """No flag was written, so the revival is the ordinary revive path (#672 D5)."""
    m = _metrics([_share("ALO", quantity=0)], store, mocker)
    m.scheduler.get_jobs.return_value = [_job(_scrape_job_id("ALO"))]
    m._reconcile_jobs()
    m.scheduler.reset_mock()

    m.shares[0]["quantity"] = 4
    m.scheduler.get_jobs.return_value = []
    m._reconcile_jobs()

    m.scheduler.add_job.assert_called_once()
    assert m.scheduler.add_job.call_args.kwargs["args"] == ["ALO"]


def test_reconcile_revives_missing_job(store, mocker):
    # Held symbol whose job vanished (e.g. a misfire death) is re-armed. Foreign
    # (non-scrape) jobs in the store are ignored by the prefix filter.
    m = _metrics([_share("AAPL")], store, mocker)
    m.scheduler.get_jobs.return_value = [_job("ingest"), _job("backfill")]

    m._reconcile_jobs()

    m.scheduler.add_job.assert_called_once()
    assert m.scheduler.add_job.call_args.kwargs["id"] == _scrape_job_id("AAPL")
    m.scheduler.remove_job.assert_not_called()


def test_reconcile_leaves_unchanged_jobs_untouched(
        store, mocker):
    m = _metrics([_share("AAPL"), _share("MSFT", "Microsoft")],
                 store, mocker)
    m.scheduler.get_jobs.return_value = [
        _job(_scrape_job_id("AAPL")), _job(_scrape_job_id("MSFT"))]

    m._reconcile_jobs()

    m.scheduler.add_job.assert_not_called()
    m.scheduler.remove_job.assert_not_called()


def test_reconcile_one_remove_failure_does_not_abort_the_pass(
        store, mocker):
    """A JobLookupError from one vanished job (a self-re-armed date job that
    just fired) must not skip the remaining removals or arms."""
    m = _metrics([_share("AAPL"), _share("TSLA", "Tesla")],
                 store, mocker)
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
        store, fake_ticker, mocker, monkeypatch):
    """In-flight half of the race guard: a job removed mid-cycle must not
    re-add itself after reconcile's remove_job."""
    m = _metrics([_share("AAPL")], store, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))
    # Symbol departs between fetch and re-arm.
    m.config_manager._shares = []

    m._scrape_symbol("AAPL", now=NOW)

    m.scheduler.add_job.assert_not_called()


def test_ingest_reconciles_against_scheduler(
        store, mocker):
    m = _metrics([_share("AAPL")], store, mocker)
    m.scheduler.get_jobs.return_value = []  # nothing scheduled yet

    m.ingest()

    # First ingest arms the held symbol (bootstrap via immediate fire).
    m.scheduler.add_job.assert_called_once()
    assert m.scheduler.add_job.call_args.kwargs["id"] == _scrape_job_id("AAPL")


def test_reconcile_noop_without_scheduler(store, mocker):
    cfg = _FakeConfigManager([_share("AAPL")])
    m = SuiviBourseMetrics(cfg, prometheus_exporter=mocker.MagicMock())
    # scheduler is None -> reconcile is a safe no-op (unit tests that never wire
    # a scheduler still exercise ingest()).
    assert m.scheduler is None
    m._reconcile_jobs()  # must not raise


# ---------------------------------------------------------------------------
# The dials come from the registry and then from the store (#701, ADR-0014)
# ---------------------------------------------------------------------------

def test_a_fresh_metrics_carries_the_registry_s_values(store, mocker):
    """No environment read left: the code's values, then the store's.

    The environment holds what the process must know before it can open the
    store, and a poll cadence is not that.
    """
    m = _metrics([_share()], store, mocker)

    assert m.regular_interval == 120
    assert m.backfill_delay == 10
    assert m.backfill_chunk_days == 365
    assert m.staleness_horizon == 900


def test_apply_dials_sets_only_the_keys_it_is_given(store, mocker):
    """A PUT naming one dial must not reset the other four."""
    m = _metrics([_share()], store, mocker)

    m.apply_dials({"regular_interval": 600})

    assert m.regular_interval == 600
    assert m.backfill_delay == 10


def test_apply_dials_ignores_the_unanswered_currency(store, mocker):
    """``base_currency`` is the one dial that can be ``None``, and it has no attribute."""
    m = _metrics([_share()], store, mocker)

    m.apply_dials(settings_registry.defaults())  # carries base_currency=None

    assert m.regular_interval == 120


def test_a_retired_environment_variable_is_named_and_not_obeyed(monkeypatch):
    """ADR-0014's gesture, and it is computed rather than written down."""
    monkeypatch.setenv("SB_REGULAR_INTERVAL", "600")

    assert "SB_REGULAR_INTERVAL" in main.unread_environment()


def test_a_variable_the_app_still_reads_is_not_in_the_notice(monkeypatch):
    monkeypatch.setenv("SB_WEB_PORT", "9000")

    assert "SB_WEB_PORT" not in main.unread_environment()


def test_a_compose_only_variable_is_not_in_the_notice(monkeypatch):
    """Naming them would suggest the app once obeyed them. It never did."""
    monkeypatch.setenv("SB_VERSION", "5")
    monkeypatch.setenv("SB_UID", "501")

    found = main.unread_environment()

    assert "SB_VERSION" not in found and "SB_UID" not in found


def test_a_blank_retired_variable_is_not_reported(monkeypatch):
    """Compose renders an undefined substitution as an empty string."""
    monkeypatch.setenv("SB_PERF_INTERVAL", "")

    assert "SB_PERF_INTERVAL" not in main.unread_environment()


def test_the_notice_is_one_line_and_not_one_per_variable(monkeypatch, mocker):
    """Five warnings would bury the sentence that matters: where the dials went."""
    monkeypatch.setenv("SB_REGULAR_INTERVAL", "600")
    monkeypatch.setenv("SB_PERF_INTERVAL", "120")
    warn = mocker.patch.object(main.app_logger, "warning")

    main.report_unread_environment()

    warn.assert_called_once()
    assert "SB_REGULAR_INTERVAL" in warn.call_args.args[0]
    assert "SB_PERF_INTERVAL" in warn.call_args.args[0]


def test_nothing_is_logged_when_there_is_nothing_to_say(mocker):
    """A clean environment gets no line at all — an install that set nothing
    must not read a warning about it (#740)."""
    mocker.patch.object(main, "unread_environment", return_value=[])
    warn = mocker.patch.object(main.app_logger, "warning")

    assert main.report_unread_environment() == []
    warn.assert_not_called()


def test_the_notice_separates_what_moved_from_what_was_deleted(
        monkeypatch, mocker):
    """"Turn it on the settings page" is wrong for a dial that no longer exists.

    An operator told that ``SB_EXECUTOR_POOL`` lives in the app now goes looking
    for a field that has never existed, and a ``PUT`` naming it answers 422.
    """
    monkeypatch.setenv("SB_REGULAR_INTERVAL", "600")
    monkeypatch.setenv("SB_EXECUTOR_POOL", "10")
    warn = mocker.patch.object(main.app_logger, "warning")

    main.report_unread_environment()

    message = warn.call_args.args[0]
    assert "SB_REGULAR_INTERVAL → the regular_interval dial" in message
    assert "removed and have no replacement: SB_EXECUTOR_POOL" in message


def test_a_name_the_app_never_read_gets_no_instruction(monkeypatch, mocker):
    """A typo must not send its author hunting for a dial that never existed."""
    monkeypatch.setenv("SB_REGULAR_INTERVALL", "600")
    warn = mocker.patch.object(main.app_logger, "warning")

    main.report_unread_environment()

    message = warn.call_args.args[0]
    assert "ever read: SB_REGULAR_INTERVALL" in message
    assert "settings page" not in message


# ---------------------------------------------------------------------------
# env_str / env_int / env_flag — blank means unset (compose substitution)
# ---------------------------------------------------------------------------

def test_env_str_treats_blank_as_unset(monkeypatch):
    """Whitespace-only reads as None; a real value comes back stripped."""
    monkeypatch.setenv("SB_TEST_VAR", "   ")
    assert main.env_str("SB_TEST_VAR") is None
    monkeypatch.setenv("SB_TEST_VAR", " value ")
    assert main.env_str("SB_TEST_VAR") == "value"
    monkeypatch.delenv("SB_TEST_VAR")
    assert main.env_str("SB_TEST_VAR") is None


def test_env_int_falls_back_on_blank(monkeypatch):
    """A blank int var yields the default; a set one is parsed."""
    monkeypatch.setenv("SB_TEST_INT", "")
    assert main.env_int("SB_TEST_INT", 42) == 42
    monkeypatch.setenv("SB_TEST_INT", "7")
    assert main.env_int("SB_TEST_INT", 42) == 7


def test_env_int_raises_a_named_error_on_garbage(monkeypatch):
    """A non-numeric value names the variable, so the log says what to fix."""
    monkeypatch.setenv("SB_TEST_INT", "abc")
    with pytest.raises(ValueError, match="SB_TEST_INT"):
        main.env_int("SB_TEST_INT", 42)


def test_env_flag_parses_common_spellings(monkeypatch):
    """Both truthy and falsy spellings are honoured; blank keeps the default."""
    for raw in ("true", "TRUE", "1", "yes", "on"):
        monkeypatch.setenv("SB_TEST_FLAG", raw)
        assert main.env_flag("SB_TEST_FLAG", False) is True
    for raw in ("false", "0", "no", "off"):
        monkeypatch.setenv("SB_TEST_FLAG", raw)
        assert main.env_flag("SB_TEST_FLAG", True) is False
    monkeypatch.setenv("SB_TEST_FLAG", "")
    assert main.env_flag("SB_TEST_FLAG", True) is True


# ---------------------------------------------------------------------------
# Anti-herd jitter + misfire/max_instances on the per-symbol jobs (issue #619)
# ---------------------------------------------------------------------------

def test_arm_symbol_offsets_run_date_by_jitter(
        store, mocker):
    """Jitter is applied as a uniform(0, JITTER_SECONDS) offset on run_date."""
    m = _metrics([_share()], store, mocker)
    # Re-patch over the autouse zero-jitter with a fixed non-zero offset.
    uniform = mocker.patch("main.random.uniform", return_value=7.5)

    m._arm_symbol("AAPL", 120, NOW)

    uniform.assert_called_once_with(0, scheduling.JITTER_SECONDS)
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == \
        NOW + timedelta(seconds=127.5)


def test_arm_symbol_jitter_stays_within_window(
        store, mocker):
    """With real randomness the offset lands in [0, JITTER_SECONDS]."""
    m = _metrics([_share()], store, mocker)
    mocker.stopall()  # drop the autouse zero-jitter -> real random.uniform

    lo = NOW + timedelta(seconds=120)
    hi = lo + timedelta(seconds=scheduling.JITTER_SECONDS)
    for _ in range(50):
        m._arm_symbol("AAPL", 120, NOW)
        run_date = m.scheduler.add_job.call_args.kwargs["run_date"]
        assert lo <= run_date <= hi


def test_arm_symbol_registers_misfire_none_and_single_instance(
        store, mocker):
    """Per-symbol jobs carry misfire_grace_time=None and max_instances=1."""
    m = _metrics([_share()], store, mocker)

    m._arm_symbol("AAPL", 120, NOW)

    kwargs = m.scheduler.add_job.call_args.kwargs
    assert kwargs["misfire_grace_time"] is None
    assert kwargs["max_instances"] == 1
    assert kwargs["replace_existing"] is True


def test_scrape_symbol_rearm_carries_misfire_and_max_instances(
        store, fake_ticker, mocker, monkeypatch):
    """The self-reschedule (not just the bootstrap) keeps the misfire policy."""
    m = _metrics([_share()], store, mocker)
    monkeypatch.setattr(main.yf, "Ticker", lambda s: fake_ticker(market_state="REGULAR"))

    m._scrape_symbol("AAPL", now=NOW)

    kwargs = m.scheduler.add_job.call_args.kwargs
    assert kwargs["misfire_grace_time"] is None
    assert kwargs["max_instances"] == 1


# ---------------------------------------------------------------------------
# Saving a dial: re-arm only what moved, and only where it applies (#701)
# ---------------------------------------------------------------------------

def _scrape_job(symbol):
    return SimpleNamespace(id=_scrape_job_id(symbol), next_run_time=NOW)


def _with_jobs(m, *symbols):
    """Point the spy scheduler at a fixed set of idle scrape jobs."""
    m.scheduler.get_jobs.return_value = [_scrape_job(s) for s in symbols]
    return m


def _scraped(m, symbol, closed):
    """Record one completed pass for ``symbol`` — what the split classifies on."""
    m.recorder.record_scrape(runtime_state.ScrapeRecord(
        symbol=symbol, at=NOW, market_state="CLOSED" if closed else "REGULAR",
        closed=closed, price_present=not closed,
        verdict=runtime_state.SCRAPE_CLOSED if closed
        else runtime_state.SCRAPE_WROTE,
        failure_count=0, next_delay=120.0))


def test_rearm_touches_only_the_symbols_whose_market_is_open(
        store, mocker):
    """A sleeping symbol is off-topic — it reads the dial when it wakes."""
    m = _metrics([_share(symbol="AAPL"), _share(symbol="MC.PA")],
                 store, mocker)
    _with_jobs(m, "AAPL", "MC.PA")
    _scraped(m, "AAPL", closed=False)
    _scraped(m, "MC.PA", closed=True)
    m.regular_interval = 600
    mocker.patch("main.datetime", **{"now.return_value": NOW})

    reached, sleeping = m.rearm_regular_scrapes()

    assert (reached, sleeping) == (1, 1)
    armed = [c.kwargs["id"] for c in m.scheduler.add_job.call_args_list]
    assert armed == [_scrape_job_id("AAPL")]


def test_rearm_starts_the_new_cadence_from_now(store, mocker):
    m = _metrics([_share()], store, mocker)
    _with_jobs(m, "AAPL")
    _scraped(m, "AAPL", closed=False)
    m.regular_interval = 600
    mocker.patch("main.datetime", **{"now.return_value": NOW})

    m.rearm_regular_scrapes()

    # Jitter is zeroed by the autouse fixture, so this is the bare cadence.
    assert m.scheduler.add_job.call_args.kwargs["run_date"] == \
        NOW + timedelta(seconds=600)


def test_rearm_rescales_a_failing_symbol_s_backoff_rather_than_flattening_it(
        store, mocker):
    """#617's guard must survive a save, and the rescaling is the announced effect.

    Six consecutive failures put the symbol at ``base × 2^3``. Re-arming it at
    the bare cadence would discard the whole dead-ticker guard every time
    somebody touches the settings page; re-arming it at ``600 × 8`` is the same
    arithmetic ``decide`` would apply on its next pass, and it is exactly the
    retroactive rescaling the dial's documentation promises.
    """
    m = _metrics([_share()], store, mocker)
    _with_jobs(m, "AAPL")
    _scraped(m, "AAPL", closed=False)
    m._failure_counts["AAPL"] = 6
    m.regular_interval = 600
    mocker.patch("main.datetime", **{"now.return_value": NOW})

    m.rearm_regular_scrapes()

    assert m.scheduler.add_job.call_args.kwargs["run_date"] == \
        NOW + timedelta(seconds=600 * 8)


def test_rearm_leaves_a_symbol_being_scraped_to_re_arm_itself(
        store, mocker):
    """Trap 1: a ``date`` job leaves the jobstore while it runs.

    It is counted as reached — it picks the new value up at the end of its own
    pass — but arming it here would race that pass. The figures still cover the
    portfolio, which is the whole reason they are published.
    """
    m = _metrics([_share()], store, mocker)
    _with_jobs(m)  # the job is gone from the store: it is running
    _scraped(m, "AAPL", closed=False)
    mocker.patch("main.datetime", **{"now.return_value": NOW})

    reached, sleeping = m.rearm_regular_scrapes()

    assert (reached, sleeping) == (1, 0)
    m.scheduler.add_job.assert_not_called()


def test_rearm_leaves_a_symbol_that_has_never_been_scraped_alone(
        store, mocker):
    """At boot every held symbol is armed to fire immediately — do not delay it."""
    m = _metrics([_share()], store, mocker)
    _with_jobs(m, "AAPL")  # armed, never fired: no last-pass record
    mocker.patch("main.datetime", **{"now.return_value": NOW})

    reached, sleeping = m.rearm_regular_scrapes()

    assert (reached, sleeping) == (1, 0)
    m.scheduler.add_job.assert_not_called()


def test_rearm_without_a_scheduler_is_a_quiet_zero(store, mocker):
    m = _metrics([_share()], store, mocker)
    m.scheduler = None

    assert m.rearm_regular_scrapes() == (0, 0)


def test_a_jobstore_error_never_turns_a_saved_dial_into_a_failure(
        store, mocker):
    """The value is in the store either way; the next boot reads it from there."""
    m = _metrics([_share()], store, mocker)
    m.scheduler.get_jobs.side_effect = RuntimeError("boom")

    assert m.rearm_regular_scrapes() == (0, 0)


def _runtime(m, scheduler=None):
    return SimpleNamespace(metrics=m, scheduler=scheduler or m.scheduler)


def test_apply_settings_re_arms_the_scrape_jobs_when_the_cadence_moved(
        store, mocker):
    m = _metrics([_share(symbol="AAPL"), _share(symbol="MC.PA")],
                 store, mocker)
    _with_jobs(m, "AAPL", "MC.PA")
    _scraped(m, "AAPL", closed=False)
    _scraped(m, "MC.PA", closed=True)
    mocker.patch("main.datetime", **{"now.return_value": NOW})

    report = main.apply_settings(
        _runtime(m), (settings.Change("regular_interval", 120, 600),))

    assert m.regular_interval == 600
    assert report["symbols_rescheduled"] == 1
    assert report["symbols_at_market_open"] == 1


def test_apply_settings_leaves_an_untouched_job_s_timer_alone(
        store, mocker):
    """The criterion of #701: a save button is not a reset button.

    ``reschedule_job`` recomputes ``next_run_time`` from *now*, so re-arming a
    job whose dial did not move would silently put its timer back to zero on
    every click.
    """
    m = _metrics([_share()], store, mocker)
    _with_jobs(m, "AAPL")
    _scraped(m, "AAPL", closed=False)
    mocker.patch("main.datetime", **{"now.return_value": NOW})

    report = main.apply_settings(
        _runtime(m), (settings.Change("backfill_delay", 10, 20),))

    assert m.backfill_delay == 20
    m.scheduler.add_job.assert_not_called()
    m.scheduler.reschedule_job.assert_not_called()
    assert report["symbols_rescheduled"] == 0


def test_apply_settings_re_cadences_the_backfill_job(store, mocker):
    m = _metrics([_share()], store, mocker)

    report = main.apply_settings(
        _runtime(m), (settings.Change("backfill_interval", 60, 300),))

    m.scheduler.reschedule_job.assert_called_once_with(
        "backfill", trigger="interval", seconds=300)
    assert report["jobs_rescheduled"] == ["backfill"]


def test_apply_settings_survives_a_missing_backfill_job(store, mocker):
    """A runtime with no such job answers "reached nothing", never a 503."""
    m = _metrics([_share()], store, mocker)
    m.scheduler.reschedule_job.side_effect = JobLookupError("backfill")

    report = main.apply_settings(
        _runtime(m), (settings.Change("backfill_interval", 60, 300),))

    assert report["jobs_rescheduled"] == []


def test_apply_settings_before_the_fork_changes_nothing_and_says_so(mocker):
    """The dial is already in the store, and the boot reads it from there."""
    report = main.apply_settings(
        SimpleNamespace(metrics=None, scheduler=None),
        (settings.Change("regular_interval", 120, 600),))

    assert report == {
        "symbols_rescheduled": 0,
        "symbols_at_market_open": 0,
        "jobs_rescheduled": [],
    }


# ---------------------------------------------------------------------------
# capture_exchange_of — pre-scheduler exchange snapshot (issue #619)
# ---------------------------------------------------------------------------

def test_capture_exchange_of_reads_info_cache_and_fetches_missing(
        store, mocker):
    m = _metrics([_share(symbol="AAPL"), _share(symbol="MSFT")],
                 store, mocker)
    # AAPL already cached; MSFT must be fetched.
    m._share_info_cache["AAPL"] = {"exchange": "NMS"}
    fetch = mocker.patch.object(
        m, "_fetch_ticker_data", return_value=(1.0, {"exchange": "PAR"}))

    result = m.capture_exchange_of()

    assert result == {"AAPL": "NMS", "MSFT": "PAR"}
    fetch.assert_called_once_with("MSFT")   # cached AAPL not re-fetched


def test_capture_exchange_of_maps_failed_and_undefined_to_none(
        store, mocker):
    m = _metrics([_share(symbol="AAA"), _share(symbol="BBB")],
                 store, mocker)

    def _fetch(symbol):
        return (None, None) if symbol == "AAA" else (1.0, {"exchange": "undefined"})

    mocker.patch.object(m, "_fetch_ticker_data", side_effect=_fetch)

    result = m.capture_exchange_of()

    # Failed fetch and the 'undefined' sentinel both become solo (None).
    assert result == {"AAA": None, "BBB": None}


def test_capture_exchange_of_times_out_to_solo_market(
        store, mocker):
    """A fetch that outlives the deadline maps to a solo market, not a hang."""
    m = _metrics([_share(symbol="SLOW")], store, mocker)
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
