"""SuiviBourse Paul Brissaud"""
import logging
import os
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import List, Dict, Optional, Tuple

from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.schedulers.background import BackgroundScheduler
from logfmt_logger import getLogger

from application import accounts as accounts_module
from application import boot_conditions
from application import boot_env
from application import build_info
from application import carrying
from application import installation_facts
from application import ledger
from application import mounts
from application import positions
from application import runtime_state
from application import scheduling
from application import settings as settings_module
from application import settings_registry
from application import store
from application import workloads
from application.events.validator import EventValidator
from application.events.aggregator import EventAggregator
from application.events.loader import EventLoaderError
from application.events.validator import EventValidationError
from application.events.aggregator import AggregationError
from application.events.schemas import Portfolio

LOG_LEVEL = boot_env.text(os.environ, boot_env.LOG_LEVEL,
                          boot_env.DEFAULT_LOG_LEVEL)
app_logger = getLogger("suivi_bourse", level=LOG_LEVEL)

getLogger("apscheduler.scheduler", level=LOG_LEVEL)
getLogger("yfinance", level=LOG_LEVEL)

MANAGED_LOGGERS = (
    'suivi_bourse', 'apscheduler.scheduler', 'yfinance', 'store',
    'quotes', 'perf_series', 'ledger', 'positions',
    'installation_facts', 'api.api',
    'fx', 'accounts', 'entries', 'reassignment',
    'uploads',
    'advisories',
    'market',
)


def set_log_level(level: str) -> str:
    """Change the log level of the running process. **Ephemeral** by design."""
    resolved = (level or '').strip().upper()
    if resolved not in ('CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG'):
        raise ValueError(
            f"Unknown log level {level!r}. "
            f"Expected one of CRITICAL, ERROR, WARNING, INFO, DEBUG.")

    for name in MANAGED_LOGGERS:
        target = logging.getLogger(name)
        target.setLevel(resolved)
        for handler in target.handlers:
            handler.setLevel(resolved)

    app_logger.info(f"Log level set to {resolved} (until the process restarts)")
    return resolved


def current_log_level() -> str:
    """The level the app's own logger is at, whatever set it."""
    return logging.getLevelName(logging.getLogger('suivi_bourse').level)


def report_unread_environment() -> List[str]:
    """Name what is set and not obeyed, in **one** grouped notice."""
    found = installation_facts.unread_environment()
    message = boot_env.notice(tuple(found))
    if message is not None:
        app_logger.warning(message)
    return found


def report_boot_conditions(boot: boot_env.BootEnvironment, persistence: str,
                           base_currency: Optional[str],
                           recorded_events: int) -> List[str]:
    """Say the three things that are true of this start-up, once each (#741)."""
    said = []
    for condition in boot_conditions.observe(
            persistence=persistence,
            store_dir=boot.store_dir,
            base_currency=base_currency,
            recorded_events=recorded_events,
            web_port=boot.web_port):
        app_logger.log(condition.level, condition.message,
                       extra={'context': condition.context})
        said.append(condition.key)
    return said


def effective_environment() -> List[Dict]:
    """What this container was started with, read-only (#654 §6a → #656)."""
    return boot_env.effective(os.environ, log_level=current_log_level())


def register_interval_jobs(scheduler, workloads_,
                           backfill_interval: int) -> None:
    """Register the two fixed-cadence interval jobs on ``scheduler``."""
    scheduler.add_job(
        workloads_.backfill, 'interval',
        seconds=backfill_interval,
        id=scheduling.BACKFILL_JOB_ID,
        name='Historical backfill')
    scheduler.add_job(
        workloads_.recompute_perf, 'interval',
        seconds=scheduling.PERF_TICK,
        next_run_time=datetime.now(timezone.utc),
        id=scheduling.PERF_JOB_ID,
        name='Performance recompute')


def apply_settings(runtime, changes) -> Dict:
    """Make a set of saved dials take effect, and say what they reached (#701)."""
    report = {
        'symbols_rescheduled': 0,
        'symbols_at_market_open': 0,
        'jobs_rescheduled': [],
    }
    running = getattr(runtime, 'workloads', None)
    if running is None:
        return report

    running.apply_dials({change.key: change.after for change in changes})

    for change in changes:
        effect = settings_registry.spec_for(change.key).effect
        if effect == settings_registry.REARM_SCRAPE:
            reached, sleeping = running.rearm_regular_scrapes()
            report['symbols_rescheduled'] += reached
            report['symbols_at_market_open'] += sleeping
        elif effect == settings_registry.REARM_BACKFILL_JOB:
            if _reschedule_interval_job(
                    runtime.scheduler, scheduling.BACKFILL_JOB_ID, change.after):
                report['jobs_rescheduled'].append(scheduling.BACKFILL_JOB_ID)
        elif effect == settings_registry.REPAIR_CONVERSIONS:
            started = running.repair_conversions_now()
            if started and scheduling.BACKFILL_JOB_ID not in report['jobs_rescheduled']:
                report['jobs_rescheduled'].append(scheduling.BACKFILL_JOB_ID)
    return report


def _reschedule_interval_job(scheduler, job_id: str, seconds: int) -> bool:
    """Re-cadence one interval job. ``False`` when there is nothing to re-cadence."""
    if scheduler is None:
        return False
    try:
        scheduler.reschedule_job(job_id, trigger='interval', seconds=seconds)
        return True
    except Exception as e:
        app_logger.error(f"Failed to reschedule the {job_id} job: {e}")
        return False


@dataclass(frozen=True)
class ConfigSnapshot:
    """One complete, validated view of the configuration (issue #658)."""

    shares: List[Dict]
    events: List
    accounts: Optional[Portfolio]
    cache_key: Optional[str]

    def backfill_windows(self) -> Dict[str, Tuple[date, Optional[date]]]:
        """``{symbol: (first acquisition, last exit or None)}`` — the backfill's pilot."""
        held = {share['symbol'] for share in self.shares
                if share.get('symbol') and share.get('quantity')}
        return carrying.holding_windows(self.events, held)

    def first_acquisition_date(self, symbol: str) -> Optional[date]:
        """Date of the earliest ``BUY`` **or ``GRANT``** for ``symbol``, or ``None``."""
        window = self.backfill_windows().get(symbol)
        return window[0] if window is not None else None


class ConfigurationManager:
    """Publishes the configuration as an immutable snapshot (issue #658)."""

    LEGACY_MANUAL_FILE = 'config.yaml'
    LEGACY_SETTINGS_FILE = 'settings.yaml'

    def __init__(self, config_dir: Optional[str] = None, opened_store=None):
        """Initialize the configuration manager."""
        if config_dir:
            self.config_dir = Path(config_dir).expanduser()
        else:
            self.config_dir = Path('~/.config/SuiviBourse').expanduser()

        self.settings_path = self.config_dir / self.LEGACY_SETTINGS_FILE
        self._store = opened_store

        self._config: Optional[ConfigSnapshot] = None
        self._write_lock = threading.Lock()

    @contextmanager
    def writing(self):
        """Hold the writers' mutex while a caller writes to the store."""
        with self._write_lock:
            yield self._require_store()

    @property
    def store(self):
        """The store this process reads through — the lock-free accessor."""
        return self._require_store()

    def attach_store(self, opened_store) -> None:
        """Hand the manager the connection it should read the ledger through."""
        self._store = opened_store

    def _require_store(self):
        """The attached store, opening one under ``config_dir`` if there is none."""
        if self._store is None:
            self._store = store.open_store(
                self.config_dir / store.STORE_FILENAME)
        return self._store

    def report_unread_files(self) -> List[str]:
        """Name the v4 files this version finds and does not read (#711, #698)."""
        named = []

        legacy = self.config_dir / self.LEGACY_MANUAL_FILE
        if legacy.exists():
            named.append(str(legacy))
            app_logger.warning(
                f"Found {legacy}, and this version does not read it: a "
                f"portfolio is described by dated events only. Your positions "
                f"come from the events you record in the app or hand it in a "
                f"file — the one above is left untouched.")

        settings = self.config_dir / self.LEGACY_SETTINGS_FILE
        if settings.exists():
            named.append(str(settings))
            app_logger.warning(
                f"Found {settings}, and this version does not read it: "
                f"accounts are declared in the app "
                f"({', '.join(accounts_module.ACCOUNT_COLUMNS)}), and no "
                f"setting names where a file is read from any more — you hand "
                f"the app one. The file above is left untouched.")

        return named

    def current(self) -> ConfigSnapshot:
        """The published snapshot — the lock-free read path."""
        snap = self._config
        if snap is not None:
            return snap
        return self.reload()

    def replay(self) -> ConfigSnapshot:
        """Republish from the ledger, whatever the fingerprint says."""
        return self.reload(force=True)

    def reload(self, force: bool = False) -> ConfigSnapshot:
        """Build a candidate snapshot and, if it is new, publish it."""
        with self._write_lock:
            published = self._config
            candidate = self._build_snapshot(published, force)
            if candidate is not published:
                self._config = candidate
            return candidate

    def _build_snapshot(self, published: Optional[ConfigSnapshot],
                        force: bool) -> ConfigSnapshot:
        """Assemble a validated snapshot, or return ``published`` on a cache hit."""
        opened = self._require_store()

        accounts = accounts_module.declared_portfolio(opened)

        cache_key = ledger.stamp(self._require_store())
        if not force and published is not None and published.cache_key == cache_key:
            app_logger.debug("Using cached configuration (the ledger is unchanged)")
            return published

        shares, events = self._load_from_store(opened)

        accounts_are_new = published is None or published.accounts != accounts
        if accounts is not None and accounts_are_new:
            app_logger.info(
                f"Loaded {len(accounts.accounts)} declared account(s): "
                f"{', '.join(sorted(accounts.ids()))}")

        return ConfigSnapshot(shares=shares, events=events, accounts=accounts,
                              cache_key=cache_key)

    def _load_from_store(self, opened_store) -> Tuple[List[Dict], List]:
        """Replay the ledger the store holds. Returns ``(shares, events)``."""
        events = ledger.read_events(opened_store)

        if not events:
            app_logger.warning(
                "The ledger is empty; running on an empty portfolio until a "
                "first event is recorded or a .csv/.xlsx is handed to the app")
            positions.write_state(opened_store, [], {})
            return [], []

        validator = EventValidator(
            account_ids=accounts_module.account_ids(opened_store),
            accounts_declared=accounts_module.accounts_are_declared(opened_store))
        validator.validate_or_raise(events)

        timeline = EventAggregator().replay(events)
        shares = timeline.current()
        positions.write_state(opened_store, shares, timeline.current_cash())

        app_logger.info(f"Replayed {len(events)} events for {len(shares)} shares")
        return shares, events

    def load_shares(self, force: bool = False) -> List[Dict]:
        """Publish a snapshot and return its shares."""
        return self.reload(force=force).shares


class Runtime:
    """The application's long-lived objects, filled in as the boot proceeds."""

    def __init__(self, config_manager: ConfigurationManager,
                 store_path: Optional[Path] = None,
                 store_persistence: str = mounts.UNKNOWN,
                 opened_store: Optional['store.Store'] = None,
                 build: build_info.Build = build_info.UNSTAMPED):
        self.config_manager = config_manager
        self.workloads: Optional[workloads.Workloads] = None
        self.scheduler: Optional[BackgroundScheduler] = None

        self.store_path: Optional[Path] = store_path
        self.store: Optional[store.Store] = opened_store

        self.store_persistence: str = store_persistence

        self.build: build_info.Build = build

        self.recorder = runtime_state.RuntimeRecorder()


def log_fatal(exc: BaseException) -> None:
    """Log a boot-fatal exception under the message its class earned."""
    if isinstance(exc, store.StoreUnavailable):
        app_logger.fatal(f'The store could not be opened : {exc}')
    elif isinstance(exc, (EventLoaderError, EventValidationError, AggregationError)):
        app_logger.fatal(f'An error occurred while loading events : {exc}')
    elif isinstance(exc, ValueError):
        app_logger.fatal(f'Configuration error: {exc}')
    else:
        app_logger.fatal(f'An unexpected error occurred: {exc}', exc_info=True)


def build_runtime() -> Runtime:
    """The store and the configuration — the boot's second step (ADR-0039)."""
    build = build_info.describe(os.environ, build_info.checkout_revision())
    app_logger.info(
        f'SuiviBourse {build_info.said(build)} is running !',
        extra={'context': {key: value for key, value in build.to_dict().items()
                           if value is not None}})

    boot = boot_env.read(os.environ)

    report_unread_environment()

    store_path = boot.store_dir / store.STORE_FILENAME
    opened = store.open_store(store_path)

    persistence = mounts.store_persistence(boot.store_dir)

    config_manager = ConfigurationManager(opened_store=opened)

    config_manager.report_unread_files()

    try:
        config_manager.reload()
        report_boot_conditions(
            boot, persistence,
            base_currency=opened.setting('base_currency'),
            recorded_events=len(config_manager.current().events))
    except BaseException:
        config_manager.attach_store(None)
        opened.close()
        raise

    return Runtime(config_manager, store_path=store_path,
                   store_persistence=persistence, opened_store=opened,
                   build=build)


def start_runtime(runtime: Runtime) -> Runtime:
    """The scheduler and its jobs — the boot's fourth step (ADR-0039)."""
    dials = settings_registry.defaults() if runtime.store is None \
        else settings_module.read_all(runtime.store)
    backfill_interval = dials['backfill_interval']

    running = workloads.Workloads(
        runtime.config_manager,
        recorder=runtime.recorder)
    running.apply_dials(dials)
    runtime.workloads = running

    pool_size = scheduling.compute_pool_size(
        running.shares, running.read_exchange_of())
    scheduler = BackgroundScheduler(
        executors={'default': ThreadPoolExecutor(pool_size)})
    running.scheduler = scheduler
    runtime.scheduler = scheduler
    running.ingest()
    register_interval_jobs(scheduler, running, backfill_interval)
    scheduler.start()
    app_logger.info(
        f"Scheduler started: per-symbol scraping (REGULAR every "
        f"{running.regular_interval}s), ingestion on write (watched drop "
        f"folder), backfill every {backfill_interval}s, perf recomputed every "
        f"{scheduling.PERF_TICK}s, executor pool: {pool_size} workers")
    return runtime


def replay_after_write(runtime: Runtime) -> None:
    """Replay the ledger right after a write changed it (issue #697)."""
    if runtime.workloads is not None:
        runtime.workloads.ingest(force=True)
        runtime.workloads.recompute_perf()
    else:
        runtime.config_manager.replay()


def shutdown_runtime(runtime: Runtime) -> None:
    """The teardown — ``boot.sequence``'s ``finally``, and the heir of ``__main__``'s."""
    if runtime.scheduler is not None and runtime.scheduler.running:
        runtime.scheduler.shutdown(wait=False)
    if runtime.store is not None:
        runtime.store.close()
        runtime.store = None
