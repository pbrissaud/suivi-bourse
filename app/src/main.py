"""
SuiviBourse
Paul Brissaud
"""
import concurrent.futures
import logging
import os
import random
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from typing import List, Dict, Optional, Tuple

import pandas as pd
import yfinance as yf
from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.schedulers.background import BackgroundScheduler
from logfmt_logger import getLogger
from urllib3 import exceptions as u_exceptions
from yfinance.exceptions import YFRateLimitError

import accounts as accounts_module
import ledger
import legacy_influx_shape
import performance
import positions
import runtime_state
import scheduling
import settings as settings_module
import settings_registry
import store
from events import (
    EventValidator, EventAggregator, EventWatcher,
    AccountMetricPoint, PortfolioTotalPoint,
)
from events.loader import EventLoaderError
from events.validator import EventValidationError
from events.aggregator import AggregationError
from events.schemas import EventType, Portfolio, DEFAULT_ACCOUNT
from influxdb_writer import InfluxDBWriter
from prometheus_exporter import PrometheusExporter

# Blank counts as unset throughout (see ``env_str``): compose renders an
# undefined substitution as an empty string rather than omitting the variable.
LOG_LEVEL = (os.getenv('LOG_LEVEL') or '').strip() or 'INFO'
app_logger = getLogger("suivi_bourse", level=LOG_LEVEL)
scheduler_logger = getLogger("apscheduler.scheduler", level=LOG_LEVEL)
yfinance_logger = getLogger("yfinance", level=LOG_LEVEL)

#: Every logger the app names, across all its modules. The list is explicit
#: rather than a walk of ``logging.root.manager``, so turning the app to DEBUG
#: cannot accidentally turn a dependency's own logger up with it.
MANAGED_LOGGERS = (
    'suivi_bourse', 'apscheduler.scheduler', 'yfinance', 'influxdb_writer',
    'influx_reads', 'ledger', 'positions', 'prometheus_exporter', 'web.api',
)


def set_log_level(level: str) -> str:
    """Change the log level of the running process. **Ephemeral** by design.

    The one survivor of #654's settings page, and the reason it survived is the
    reason it is not persisted: ``.env`` is a host file the container never
    sees, so a "saved" level would revert on the next ``docker compose up`` —
    a setting that silently reverts is worse than one that never claimed to
    stick. This lasts until the process restarts, and says so.

    The trap is the second line of the loop. ``logfmt_logger.getLogger`` attaches
    a ``StreamHandler`` and calls ``ch.setLevel(level)`` on it, so a logger
    raised to ``DEBUG`` still has every debug record dropped by its own handler
    — the call appears to work and changes nothing.
    """
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


# Per-symbol scrape jobs are keyed ``scrape:<symbol>`` in the APScheduler
# jobstore (issue #616). One job per symbol — scraping is account-independent.
SCRAPE_JOB_PREFIX = 'scrape:'


def _scrape_job_id(symbol: str) -> str:
    return f'{SCRAPE_JOB_PREFIX}{symbol}'


def scrape_next_runs(scheduler) -> Dict[str, Optional[datetime]]:
    """``symbol -> next_run_time`` for the live per-symbol scrape jobs.

    The one pull from the scheduler's internals (#656 déc. 4), and it is one
    function because it has two callers that must not disagree: ``/api/runtime``
    renders these times as pills, and :meth:`SuiviBourseMetrics.rearm_regular_scrapes`
    decides from the same times which symbols a new cadence reaches. Two loops
    stripping the same prefix would eventually classify a symbol two ways in one
    request.

    A symbol **absent** from the result is trap 1 and not an error: a ``date``
    job is removed from the jobstore *while it runs*, so absence means "being
    scraped right now" **or** "symbol departed". Each caller reads that
    ambiguity in its own terms.
    """
    if scheduler is None:
        return {}
    runs = {}
    for job in (scheduler.get_jobs() or []):
        job_id = getattr(job, 'id', '') or ''
        if job_id.startswith(SCRAPE_JOB_PREFIX):
            runs[job_id[len(SCRAPE_JOB_PREFIX):]] = getattr(
                job, 'next_run_time', None)
    return runs


# Pre-scheduler exchange capture for auto pool sizing (issue #619). At boot the
# whole app blocks on this before the scheduler is even built, so the
# fetch is fanned out over a small bounded pool and hard-capped by an overall
# deadline — a slow / rate-limited yfinance session must not delay startup
# indefinitely. Symbols unresolved within the deadline fall back to solo markets.
_EXCHANGE_CAPTURE_WORKERS = 8
_EXCHANGE_CAPTURE_TIMEOUT_SECONDS = 30


def env_str(name: str) -> Optional[str]:
    """Read an env var, treating blank/whitespace-only as unset.

    Compose substitutes an undefined variable as the *empty string* rather than
    omitting it, so ``SB_FOO=${FOO}`` with no ``FOO`` in ``.env`` hands the
    container ``SB_FOO=""``. A bare ``os.getenv`` sees a set-but-empty value and
    every ``int()`` downstream blows up at boot; blank means "not configured".
    """
    raw = os.getenv(name)
    if raw is None:
        return None
    raw = raw.strip()
    return raw or None


def env_int(name: str, default: int) -> int:
    """Read an int env var, tolerating blanks and failing with a clear message."""
    raw = env_str(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(
            f"Invalid value for {name}: {raw!r} is not an integer") from None


def env_flag(name: str, default: bool) -> bool:
    """Read a boolean env var, tolerating blanks."""
    raw = env_str(name)
    if raw is None:
        return default
    return raw.lower() in ('1', 'true', 'yes', 'on')


# --------------------------------------------------------------------- #
# The environment: what the process must know before it can open the store
# --------------------------------------------------------------------- #

#: Every environment variable **this application reads**, with its own default.
#:
#: The line is drawn by a mechanical test rather than by a judgement about nature
#: (ADR-0014): *the environment holds what the process must know before it can
#: open the store*. Everything else is a dial and lives in the store, with no
#: environment form at all — no precedence rule, no seed-on-first-boot, no
#: settings file. That is what makes :mod:`settings_registry` the single list.
#:
#: The list still has to be chosen and named, because "what the app reads" and
#: "what compose sends" are *different lists* (#654 trap 11): ``SB_VERSION`` and
#: ``SB_CONFIG_DIR`` carry the ``SB_`` prefix and are consumed by the docker
#: daemon, never by Python (trap 13) — a page listing "the SB_* settings" that
#: showed them would imply they are reachable from in here, and they are not:
#: from inside the container the config directory is *always*
#: ``/home/appuser/.config/SuiviBourse``.
#:
#: ``default`` is ``None`` for the two that have no scalar fallback: the token is
#: required, and ``SB_STATIC_DIR`` simply has no value when unset.
ENVIRONMENT_INVENTORY = (
    # name, default, secret
    # Read before the store can report anything, which is exactly why it is
    # here: the most likely failure of this app is the store failing to open,
    # and a log level kept inside the store could not report that.
    ('LOG_LEVEL', 'INFO', False),
    # Where the store is. Boot-scope by nature and not by choice (ADR-0014): it
    # is one of the few things the process must know *before* it can open the
    # store, and therefore before it can ask the store anything.
    (store.STORE_DIR_VAR, store.DEFAULT_STORE_DIR, False),
    ('INFLUXDB_HOST', 'http://influxdb:8181', False),
    ('INFLUXDB_TOKEN', None, True),
    ('INFLUXDB_DATABASE', 'suivi_bourse', False),
    # The two ports pass the test twice: they are read in the gunicorn master
    # before the app is imported, and a port changed from the interface would
    # cut the connection the interface arrived by.
    ('SB_PROMETHEUS_ENABLED', 'true', False),
    ('SB_METRICS_PORT', '8081', False),
    ('SB_WEB_PORT', '8080', False),
    ('SB_STATIC_DIR', None, False),
)

#: The prefixes a v4 ``.env`` used. Anything set under one of them and not read
#: is named at boot — the gesture ``config.yaml`` and ``settings.yaml`` already
#: get (ADR-0008, ADR-0014).
_OWNED_PREFIXES = ('SB_', 'INFLUXDB_')

#: Carried the prefix and were **never read by the app**: they belong to the
#: compose file and the docker daemon. Naming them in the notice would suggest
#: the app once obeyed them, which is the opposite of what the notice says.
_COMPOSE_ONLY = frozenset({'SB_VERSION', 'SB_CONFIG_DIR', 'SB_UID', 'SB_GID'})

#: Where a v4 variable's subject went, for the notice's second sentence. The
#: *detection* stays computed (see :func:`unread_environment`) — this only
#: explains what was found, and an explanation of a name that no longer exists
#: is history, which nothing can derive. Getting it wrong is not cosmetic: a
#: notice telling an operator that ``SB_EXECUTOR_POOL`` "lives in the app now"
#: sends them to a settings page that has never had such a field, and to a
#: ``PUT`` that answers ``422``.
_RETIRED_VARIABLES = {
    'SB_REGULAR_INTERVAL': 'regular_interval',
    'SB_BACKFILL_INTERVAL': 'backfill_interval',
    'SB_BACKFILL_DELAY': 'backfill_delay',
    'SB_BACKFILL_CHUNK_DAYS': 'backfill_chunk_days',
    'SB_STALENESS_HORIZON': 'staleness_horizon',
    # Deleted outright rather than moved — each of them has *no* successor, and
    # saying so is the whole value of naming them.
    'SB_EXECUTOR_POOL': None,
    'SB_DYNAMIC_EXECUTOR_POOL': None,
    'SB_PERF_INTERVAL': None,
    'SB_INGESTION_INTERVAL': None,
    'SB_SCRAPING_INTERVAL': None,
    'SB_CONFIG_MODE': None,
}


def unread_environment() -> List[str]:
    """The ``SB_*``/``INFLUXDB_*`` variables that are set and no longer read.

    **Computed, never hard-coded** — the difference between what is present and
    what :data:`ENVIRONMENT_INVENTORY` names. A written list of retired names is
    a third writer of the same inventory and the one nobody re-reads at release
    time; this one cannot drift, because the day a variable is added to the
    inventory it leaves this list by construction.
    """
    read = {name for name, _, _ in ENVIRONMENT_INVENTORY}

    def is_unread(name: str) -> bool:
        if not name.startswith(_OWNED_PREFIXES):
            return False
        if name in read or name in _COMPOSE_ONLY:
            return False
        # Blank counts as unset here too: compose renders an undefined
        # substitution as an empty string, so a v4 compose file left in place
        # would otherwise report every variable it forwards as *set*.
        return bool((os.environ.get(name) or '').strip())

    return sorted(name for name in os.environ if is_unread(name))


def report_unread_environment() -> List[str]:
    """Name what is set and not obeyed, in **one** grouped notice.

    One line per variable would put five warnings in front of an operator
    upgrading from v4 and bury the sentence that matters, which is not *which*
    name was ignored but *where the setting went*.

    And *where it went* has three answers, not one, so the notice has three
    clauses. A variable that became a dial is worth following up; one that was
    deleted outright has no successor to look for, and telling its owner to
    "turn it on the settings page" sends them hunting for a field that has never
    existed; and a name the app has simply never read (a typo, a leftover from
    another tool) deserves neither instruction.
    """
    found = unread_environment()
    if not found:
        return found

    moved = [f"{name} → the {_RETIRED_VARIABLES[name]} dial" for name in found
             if _RETIRED_VARIABLES.get(name)]
    deleted = [name for name in found
               if name in _RETIRED_VARIABLES and not _RETIRED_VARIABLES[name]]
    unknown = [name for name in found if name not in _RETIRED_VARIABLES]

    # "not read" rather than "no longer read": the header covers all three
    # groups, and one of them is names this application has never read at all.
    parts = [f"These environment variables are set and not read: "
             f"{', '.join(found)}."]
    if moved:
        parts.append(
            f"These settings live in the app since v5 ({', '.join(moved)}) — "
            f"turn them on the settings page, or with one PUT /api/settings.")
    if deleted:
        parts.append(
            f"These were removed and have no replacement: "
            f"{', '.join(deleted)}.")
    if unknown:
        parts.append(
            f"These are not settings this application has ever read: "
            f"{', '.join(unknown)}.")
    app_logger.warning(' '.join(parts))
    return found


def effective_environment() -> List[Dict]:
    """What this container was started with, read-only (#654 §6a → #656).

    Not a settings view any more (#701): the dials moved into the store and are
    served by :func:`settings.describe`, so what is left here is the half that
    genuinely cannot be answered from the store — the store's own location, the
    sockets, the log level. None of it is writable from in here and none of it
    claims to be.

    Two rules survive from #654's traps:

    * **Redact by name, never by value** (trap 12). ``INFLUXDB_TOKEN`` sits in
      the same environment and the prototype has no authentication — auth is out
      of the map's scope — so the value never leaves the process. ``set`` says
      whether there is one, which is the only thing worth knowing about it.
    * **``source`` is factual, not helpful** (trap 2). Compose renders
      ``${SB_WEB_PORT:-8080}`` as ``8080`` even when ``.env`` omits the line, so
      under compose almost everything reads ``environment`` and the app's own
      defaults are dead code. Reporting a variable as "unset, using the default"
      *because it equals the default* would be a guess; this reports what was
      found.
    """
    reported = []
    for name, default, secret in ENVIRONMENT_INVENTORY:
        raw = env_str(name)
        if raw is not None:
            source, value = 'environment', raw
        elif default is not None:
            source, value = 'default', default
        else:
            # No scalar fallback: the token is required, the static dir
            # override simply has no value when unset.
            source, value = 'unset', None

        if name == 'LOG_LEVEL':
            # The one of these the app can change while it runs (#654 §6b), so
            # the level `logging` holds now is the effective one — the variable
            # is merely where it started.
            value = current_log_level()

        reported.append({
            'name': name,
            'value': None if secret else value,
            'set': raw is not None,
            'source': source,
            'secret': secret,
        })
    return reported


def register_interval_jobs(scheduler, sb_metrics,
                           backfill_interval: int) -> None:
    """Register the two fixed-cadence interval jobs on ``scheduler``.

    Kept separate from the per-symbol scrape jobs (issue #616), which are ``date``
    triggers armed by ``ingest``/``_reconcile_jobs`` under the ``scrape:`` id
    prefix. The perf recompute is its own job (issue #618), never piggybacked on
    the scrape. Extracted from ``__main__`` so the wiring is unit-testable
    against a spy scheduler.

    **Two, not three** (issue #697). The ``ingest`` job left with
    ``SB_INGESTION_INTERVAL``: it polled the drop folder because the files were
    the truth, and the store is the truth now. The ingestion still happens — it
    is armed by the boot and by the always-on watcher, and it follows a write
    instead of a timer.

    **One interval, not two** (issue #701). The backfill's cadence is a dial in
    the store and arrives as an argument; the perf job's is
    ``scheduling.PERF_TICK``, a constant, because ``perf_should_run`` is the real
    gate and the number only decides how long a recompute waits after the change
    that earned it.
    """
    scheduler.add_job(
        sb_metrics.backfill, 'interval',
        seconds=backfill_interval,
        id='backfill',
        name='Historical backfill')
    scheduler.add_job(
        sb_metrics.recompute_perf, 'interval',
        seconds=scheduling.PERF_TICK,
        id='perf',
        name='Performance recompute')


#: The interval job a dial's ``REARM_BACKFILL_JOB`` effect reschedules.
BACKFILL_JOB_ID = 'backfill'


def apply_settings(runtime, changes) -> Dict:
    """Make a set of saved dials take effect, and say what they reached (#701).

    The other half of "no dial requires a restart", and the half that has to be
    careful. Three rules, each of them a bug someone would otherwise ship:

    * **only what changed.** ``reschedule_job`` recomputes ``next_run_time``
      from *now*, so re-arming a job whose dial did not move would reset its
      timer — and a save button that rewrote every row would reset every timer
      on every click, in a way that looks like nothing at all from outside.
    * **only the symbols whose market is open.** :func:`scheduling.rearm_split`
      owns the decision; a sleeping symbol reads the new cadence when it wakes.
    * **count what happened.** The caller answers a human, and "3 symbols now,
      8 more when their market opens" is the only honest way to say that a
      portfolio-wide dial did not reach the whole portfolio this second.

    Returns the report the route publishes. Tolerant of a runtime with no
    metrics or no scheduler (before the fork, and in a test) — the dial is
    already in the store, and the boot reads it from there.
    """
    report = {
        'symbols_rescheduled': 0,
        'symbols_at_market_open': 0,
        'jobs_rescheduled': [],
    }
    metrics = getattr(runtime, 'metrics', None)
    if metrics is None:
        return report

    # The live attributes first, in one loop over the registry — five hand
    # written assignments here would be the second list ADR-0014 forbids.
    metrics.apply_dials({change.key: change.after for change in changes})

    for change in changes:
        effect = settings_registry.spec_for(change.key).effect
        if effect == settings_registry.REARM_SCRAPE:
            reached, sleeping = metrics.rearm_regular_scrapes()
            report['symbols_rescheduled'] += reached
            report['symbols_at_market_open'] += sleeping
        elif effect == settings_registry.REARM_BACKFILL_JOB:
            if _reschedule_interval_job(
                    runtime.scheduler, BACKFILL_JOB_ID, change.after):
                report['jobs_rescheduled'].append(BACKFILL_JOB_ID)
    return report


def _reschedule_interval_job(scheduler, job_id: str, seconds: int) -> bool:
    """Re-cadence one interval job. ``False`` when there is nothing to re-cadence.

    Guarded like every other scheduler touch in this module: a
    ``JobLookupError`` on a job that is not registered (a runtime built without
    a scheduler, a shutdown in flight) must not turn a saved setting into a
    ``503`` — the value is in the store either way, and the next boot reads it.
    """
    if scheduler is None:
        return False
    try:
        scheduler.reschedule_job(job_id, trigger='interval', seconds=seconds)
        return True
    except Exception as e:
        app_logger.error(f"Failed to reschedule the {job_id} job: {e}")
        return False


# ``InvalidConfigFile`` and ``load_shares_schema`` left with ``schema.yaml``
# (issue #696). The schema validated the *aggregated share list*, which since
# #711 is no longer read from a file at all — it is computed from the event
# ledger, whose own validation is ``events/validator.py``. Where a real
# constraint is wanted, it now goes in the store's DDL, at the point the error
# enters (ADR-0007).


@dataclass(frozen=True)
class ConfigSnapshot:
    """One complete, validated view of the configuration (issue #658).

    The three fields ``ConfigurationManager`` used to mutate one by one
    (``_cached_shares`` / ``_cached_events`` / ``_cache_key``) are a single
    object here, built off-line and published by one attribute rebind. Readers
    take the snapshot once and work on it, so they never see a half-written
    configuration: a reload landing mid-cycle is invisible to whoever already
    holds the previous one, and there is no window in which ``events`` is
    ``None`` while ``shares`` is being repopulated.

    Frozen, and treated as immutable all the way down: the lists inside are
    rebuilt by every load and never edited in place.

    ``events`` is always a list — ``[]`` when the source holds no file yet
    (issue #711: the event ledger is the only way a portfolio is described, so
    there is no longer a shape of configuration that has no events at all);
    ``accounts`` is ``None`` unless an ``accounts:`` block is declared.
    ``cache_key`` is the mtime fingerprint this snapshot was built from —
    ``None`` when nothing cacheable was read.
    """

    shares: List[Dict]
    events: List
    accounts: Optional[Portfolio]
    cache_key: Optional[str]

    def first_buy_date(self, symbol: str) -> Optional[date]:
        """Date of the earliest BUY event for ``symbol``, or ``None``.

        The backfill target. A pure read of this snapshot's events, so a
        concurrent reload can never turn it into ``None`` mid-cycle.
        """
        buy_dates = [
            e.date for e in self.events
            if e.symbol == symbol and e.event_type == EventType.BUY
        ]
        return min(buy_dates) if buy_dates else None


class ConfigurationManager:
    """Publishes the configuration as an immutable snapshot (issue #658).

    Reads the event files, validates the result, and publishes it as a
    :class:`ConfigSnapshot`. **One loading path** since #711: a portfolio is a
    dated event ledger and nothing else, so there is no mode to resolve, no
    ``config.yaml`` to fall back to, and no branch anywhere downstream that has
    to ask which of two configurations it is looking at.

    Two rules shape the class, both from design #653:

    * **Never mutate published state in place.** ``_config`` is rebound, never
      edited, so the read path takes no lock at all — a reader holding a
      snapshot is holding a consistent one for as long as it needs it. One
      mutex, ``_write_lock``, serialises the writers (the ingestion job, the
      watchdog callback, and — once it exists — a web handler reloading
      synchronously after a file edit).
    * **Never publish what is not validated.** Loading, validating and
      aggregating all run *inside* snapshot construction, so a rejected
      configuration never becomes a snapshot and therefore cannot be read by
      anyone. This closes a split-brain that predates the web UI: the cache used
      to be written before validation, so a file the validator refused was still
      consumed by backfill and by the performance recompute while scraping ran
      on the previous one. What validates is ``events/validator.py`` and, from
      #696, the store's own DDL — the schema that checked the *aggregated* list
      is gone with the hand-written file it was written for.
    """

    #: The two v4 files this version no longer reads. ``config.yaml`` went with
    #: the manual mode (#711); ``settings.yaml`` goes with the accounts block
    #: (#698) — reading it would keep a v4 format alive in v5 forever, and it
    #: mixes deployment (``events.*``, ``mode:``) with user data, which is the
    #: seam ADR-0006 exists to separate. Both are **named, never read** — see
    #: :meth:`report_unread_files`.
    LEGACY_MANUAL_FILE = 'config.yaml'
    LEGACY_SETTINGS_FILE = 'settings.yaml'

    def __init__(self, config_dir: Optional[str] = None, opened_store=None):
        """
        Initialize the configuration manager.

        Args:
            config_dir: Override configuration directory (for testing).
            opened_store: The open :class:`store.Store` the ledger lives in
                (issue #697). Production always passes one — ``build_runtime``
                on the master's side of the fork, ``start_runtime`` on the
                worker's, via :meth:`attach_store`. When it is omitted, one is
                opened lazily under ``config_dir``, which is where
                ``SB_STORE_DIR`` points by default anyway.
        """
        if config_dir:
            self.config_dir = Path(config_dir).expanduser()
        else:
            self.config_dir = Path('~/.config/SuiviBourse').expanduser()

        # Named, never read (issue #698). The attribute survives so the startup
        # observation has a path to name and the tests have one to write to.
        self.settings_path = self.config_dir / self.LEGACY_SETTINGS_FILE
        self._events_source: Optional[str] = str(self.config_dir / 'events')
        self._watcher: Optional[EventWatcher] = None
        self._reload_callback: Optional[callable] = None
        self._store = opened_store

        # The published snapshot, and the mutex that serialises publishers.
        # Both are created here, which under gunicorn's ``preload_app`` means
        # *in the master, before the fork* — a ``threading.Lock`` survives
        # ``fork()`` unharmed because the master is single-threaded at that
        # instant, and the worker inherits an unlocked one.
        self._config: Optional[ConfigSnapshot] = None
        self._write_lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # The store the ledger lives in (issue #697)
    # ------------------------------------------------------------------ #

    @contextmanager
    def writing(self):
        """Hold the writers' mutex while a caller writes to the store.

        The ingestion's import is a ``BEGIN``/``COMMIT`` on the **one** DuckDB
        connection this process owns (the engine refuses a second), and a Flask
        handler runs in another thread of that same process. A write landing
        between another thread's ``BEGIN`` and its ``ROLLBACK`` is not a
        concurrent write — it is *part of that transaction*, and disappears with
        it, after the handler has already answered ``201``.

        So a route that writes takes the same lock :meth:`reload` takes. The
        lock is **not** reentrant: the replay that follows a write has to happen
        after the block, never inside it, or the handler deadlocks against
        itself.
        """
        with self._write_lock:
            yield self._require_store()

    def attach_store(self, opened_store) -> None:
        """Hand the manager the connection it should read the ledger through.

        Called on both sides of gunicorn's ``fork()``: the master opens the
        store, publishes the first snapshot from it and closes it again; the
        worker opens its own and attaches that one. The connection is what must
        not cross the fork — the manager itself does, and keeps its published
        snapshot with it.
        """
        self._store = opened_store

    def _require_store(self):
        """The attached store, opening one under ``config_dir`` if there is none.

        The fallback is not a second configuration path: ``SB_STORE_DIR``
        defaults to the configuration directory, so "the store next to the
        settings" is the same file the boot would have opened. It exists so that
        a caller holding only a directory — a test, a one-shot script — reads
        the same ledger the app does instead of a different one.
        """
        if self._store is None:
            self._store = store.open_store(
                self.config_dir / store.STORE_FILENAME)
        return self._store

    def report_unread_files(self) -> List[str]:
        """Name the v4 files this version finds and does not read (#711, #698).

        Four empty pages read as *"the update erased my portfolio"* unless the
        app says out loud which file it stopped reading. This is that sentence,
        and it is deliberately only a sentence: nothing is migrated, nothing is
        renamed, nothing is deleted — the file the user wrote stays exactly
        where they put it (ADR-0008).

        Two files now, and the second one is #698's. ``settings.yaml`` held a
        deployment setting (``events.source``) *and* user data (the ``accounts:``
        block) in one document, which is the seam v5 separates: the accounts are
        declared by a file in the events' format, and the drop folder is a mount.
        Reading it would keep a v4 format alive in v5 indefinitely.

        Returns the paths it named, so a caller can test the observation rather
        than the log line.
        """
        named = []

        legacy = self.config_dir / self.LEGACY_MANUAL_FILE
        if legacy.exists():
            named.append(str(legacy))
            app_logger.warning(
                f"Found {legacy}, and this version does not read it: a "
                f"portfolio is described by dated events only. Your positions "
                f"are loaded from {self.get_events_source()} — the file above "
                f"is left untouched.")

        settings = self.config_dir / self.LEGACY_SETTINGS_FILE
        if settings.exists():
            named.append(str(settings))
            app_logger.warning(
                f"Found {settings}, and this version does not read it: "
                f"accounts are declared by a file in the events' format "
                f"({', '.join(accounts_module.ACCOUNT_COLUMNS)}) or in the app, "
                f"and the drop folder is {self.get_events_source()}. The file "
                f"above is left untouched.")

        return named

    def load_accounts(self) -> Optional[Portfolio]:
        """The declared accounts, or ``None`` when nothing has been declared.

        Served from the published snapshot once there is one, so a caller never
        sees accounts from a different generation than the shares they were
        aggregated with. ``None`` is ergonomics rather than a discriminant
        (ADR-0013): the store always holds at least one account, and no write
        path asks this question — only the pages do.
        """
        snap = self._config
        if snap is not None:
            return snap.accounts
        return accounts_module.declared_portfolio(self._require_store())

    def get_events_source(self) -> str:
        """Where files are dropped to be imported.

        The configuration directory's ``events/`` folder, and nothing overrides
        it any more: ``events.source`` was the last thing ``settings.yaml`` was
        read for, and a v5 that read it would let a v4 file decide where the
        product looks (issue #698). The container names the mount instead
        (ADR-0015), which is #740's business.
        """
        return self._events_source

    def _compute_cache_key(self) -> Optional[str]:
        """Fingerprint the **ledger** a snapshot is built from (issue #697).

        The mtime fingerprint of #658 moved to its new subject. The files are no
        longer the truth, so what a published snapshot has to be invalidated
        against is the store: :func:`ledger.stamp` moves when a re-drop changed
        content, when an import is forgotten, when the declaration changes, and
        on nothing else.

        **One part, and no file left in it** (issue #698). ``settings.yaml``'s
        mtime used to join the key because the ``accounts:`` block was re-read
        from it on every build; the accounts now live in the store, so the store
        alone says whether a snapshot is stale — and a v4 file being touched can
        no longer invalidate anything.

        ``None`` when nothing has been imported and nothing declared — a fresh
        install with nothing to fingerprint yet.
        """
        return ledger.stamp(self._require_store())

    # ------------------------------------------------------------------ #
    # Publication (issue #658)
    # ------------------------------------------------------------------ #

    def current(self) -> ConfigSnapshot:
        """The published snapshot — the lock-free read path.

        One attribute read, because publication is a single rebind. Builds and
        publishes one on first use, which in production has already happened in
        the gunicorn master (:func:`build_runtime`).
        """
        snap = self._config
        if snap is not None:
            return snap
        return self.reload()

    def replay(self) -> ConfigSnapshot:
        """Republish from the ledger **without** scanning the drop folder.

        The one caller that must not import (issue #697). Importing is a write
        to the ledger and replaying is a read of it; every other caller wants
        both, because a file sitting in the folder is what an inbox means. The
        exception is the replay that follows a write *through the API*: after
        forgetting an import, a scan would find the file still on disk and
        import it straight back, so the revocation would undo itself in the same
        request that made it.

        The consequence is worth naming rather than hiding: a forgotten import
        whose file is still in the drop folder does come back the next time the
        folder is scanned — a restart, or any filesystem event there. That is
        the inbox reading of the folder, and it is what keeps *"a mistakenly
        forgotten import stays reversible"* (#695 § 10) true. The store carries
        no tombstone for a filename, and the DDL — which is authoritative —
        declares none.
        """
        return self.reload(force=True, do_import=False)

    def reload(self, force: bool = False,
               do_import: bool = True) -> ConfigSnapshot:
        """Build a candidate snapshot and, if it is new, publish it.

        The only writer. Everything fallible — reading, parsing, aggregating,
        validating — happens on the candidate *before* the rebind, so a failure
        raises with the previously published snapshot still standing and still
        complete. That is what makes "the previous valid configuration is kept"
        true of the whole application rather than half of it.

        ``force`` replaces the old ``invalidate_cache()`` + ``load_shares()``
        pair. Those two calls had a window between them in which the caches were
        ``None``: a backfill cycle landing there read ``events = None``, got no
        first-BUY date, and silently skipped its backward pass. Expressed as an
        argument, the window cannot exist — there is only ever a complete
        snapshot published.

        Raises:
            EventLoaderError, EventValidationError, AggregationError: the event
                files could not be read, validated or aggregated.
        """
        with self._write_lock:
            published = self._config
            candidate = self._build_snapshot(published, force, do_import)
            if candidate is not published:
                # The publication. A single rebind, so a concurrent reader sees
                # either the whole previous snapshot or the whole new one.
                self._config = candidate
            return candidate

    def _build_snapshot(self, published: Optional[ConfigSnapshot],
                        force: bool, do_import: bool = True) -> ConfigSnapshot:
        """Assemble a validated snapshot, or return ``published`` on a cache hit.

        Runs under ``_write_lock``. Never touches ``self._config``: publication
        is :meth:`reload`'s business.
        """
        opened = self._require_store()

        # The import. Idempotent and fingerprinted, so running it on every
        # build costs one hash per unchanged file — which is what lets the
        # watcher fire on any filesystem event without a dial deciding whether
        # it should have. Skipped by :meth:`replay` alone, and only because a
        # scan there would re-import the file a revocation has just revoked
        # (issue #697).
        #
        # It is also what **declares the accounts**, which is why nothing is
        # read before it: an accounts source in the folder is imported first
        # (issue #698), so the declaration this build publishes is the one the
        # events were just validated against, not the one from before the scan.
        if do_import:
            self._import_drop_folder(opened)

        accounts = accounts_module.declared_portfolio(opened)

        cache_key = self._compute_cache_key()
        if not force and published is not None and published.cache_key == cache_key:
            app_logger.debug("Using cached configuration (the ledger is unchanged)")
            return published

        # An empty portfolio is a legitimate state, not a broken ledger: an
        # install starts life with an empty drop folder and must keep running
        # (with a warning) until the first file lands.
        shares, events = self._load_from_store(opened)

        accounts_are_new = published is None or published.accounts != accounts
        if accounts is not None and accounts_are_new:
            app_logger.info(
                f"Loaded {len(accounts.accounts)} declared account(s): "
                f"{', '.join(sorted(accounts.ids()))}")

        return ConfigSnapshot(shares=shares, events=events, accounts=accounts,
                              cache_key=cache_key)

    def _import_drop_folder(self, opened_store) -> None:
        """Bring the drop folder into the store, and say what happened.

        A folder that does not exist yet is a **fresh install**, not a broken
        one: the user has not dropped a file into what the mount will create for
        them. :func:`ledger.sync_drop_folder` answers ``[]`` for it, same as for
        an empty folder, rather than turning a first boot into a failure that
        would respawn forever.

        A refused file is logged and *not* raised, which is the one place this
        differs from v4 and deliberately so. With the files as the truth a bad
        file had to stop the load, because the alternative was running on half a
        portfolio. With the store as the truth the refused file simply never
        entered it, so the ledger standing behind it is whole and the app goes
        on serving it.

        The account sources in the same folder are imported first and by the
        same call (issue #698) — the ordering is a property of the sync, not of
        its caller, so no caller can get it wrong.
        """
        source = Path(self._events_source).expanduser()
        outcomes = ledger.sync_drop_folder(opened_store, source)

        tally = ledger.import_counts(outcomes)
        if tally[ledger.IMPORTED]:
            app_logger.info(
                f"Imported {tally[ledger.IMPORTED]} file(s) from {source}")
        for refused in (o for o in outcomes if o.outcome == ledger.REFUSED):
            app_logger.error(
                f"Refused {refused.filename}, nothing from it was imported: "
                f"{refused.error}")

    def _load_from_store(self, opened_store) -> Tuple[List[Dict], List]:
        """Replay the ledger the store holds. Returns ``(shares, events)``.

        The heir of ``_load_from_events``, and the change of subject is the
        whole ticket: the events come from the ``event`` table and not from a
        directory scan, so a file removed from disk changes nothing here and a
        file re-dropped under the same name has already replaced its own rows
        upstream.

        Validation runs again on the ledger as a whole even though every import
        validated before committing, because the two are not the same assertion:
        an import validates *the ledger that import would make*, this validates
        the ledger that is — which is what gets published. It is also what keeps
        a hand-edited store from being published without a word.

        **This is where the replay writes** (issue #699). ``position`` and
        ``account_state`` are laid down here, from the same timeline the
        snapshot is built out of, so the rows in the store and the rows the app
        publishes cannot be two different generations of the ledger. The write
        comes after the validation for the same reason the publication does: a
        ledger the validator refuses never becomes state anywhere.
        """
        events = ledger.read_events(opened_store)

        if not events:
            app_logger.warning(
                f"The ledger is empty; running on an empty portfolio until a "
                f".csv/.xlsx lands in {self._events_source}")
            # Emptiness is a result and is written as one: forgetting the last
            # import has to take the positions with it, and a table left
            # standing would go on describing a portfolio nobody declares.
            positions.write_state(opened_store, [], {})
            return [], []

        # The account rules read the store, which is where the declaration is
        # (issue #698): every event must name an account that exists, and a
        # blank column means 'default' only until something is declared. One
        # code path either way — the replay keys by ``(account, symbol)``
        # unconditionally, because there is always at least one account.
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
        """Publish a snapshot and return its shares.

        Kept as the ergonomic façade over :meth:`reload` for callers that only
        want the share list.

        Args:
            force: Rebuild even when the mtime fingerprint is unchanged.

        Returns:
            List of share configurations.
        """
        return self.reload(force=force).shares

    def get_first_buy_date(self, symbol: str) -> Optional[date]:
        """Date of the first BUY event for a symbol, from the published snapshot.

        ``None`` before anything is published.
        """
        snap = self._config
        return snap.first_buy_date(symbol) if snap is not None else None

    def get_events(self) -> Optional[List]:
        """The published snapshot's events.

        Returns:
            List of events, or None if nothing has been published yet.
        """
        snap = self._config
        return snap.events if snap is not None else None

    def start_watcher(self, reload_callback: callable) -> None:
        """Watch the drop folder. **Always**, and with no dial (issue #697).

        The ``events.watch`` setting is gone and has no heir. Watching used to
        be optional because the files were the truth and re-reading them was the
        expensive part; now the ledger is the store, the import is idempotent
        and fingerprinted, and watching is simply *how a headless install
        imports* — there is nobody there to press a button. A dial on it would
        be a dial on whether the product works without a UI.

        The folder is created if it is missing, for the same reason: a first
        boot must end with something watching the place the user is about to
        drop a file into, not with a warning they will never read.

        Args:
            reload_callback: Function to call when files change.
        """
        if self._watcher is not None:
            return

        source = Path(self.get_events_source()).expanduser()
        try:
            source.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            # A read-only or unreachable mount. Not fatal — the app runs on
            # whatever the store already holds, which is the whole point of the
            # store being the truth — but it is the one case where dropping a
            # file will not do anything, so it is said out loud.
            app_logger.warning(
                f"Cannot create the drop folder {source} ({exc}); files dropped "
                f"there will not be imported")
            return

        self._reload_callback = reload_callback

        def on_change():
            app_logger.info("Event files changed, triggering reload...")
            try:
                reload_callback()
            except Exception as e:
                app_logger.error(f"Error during hot-reload: {e}")

        self._watcher = EventWatcher(str(source), on_change)
        self._watcher.start()
        app_logger.info(f"Started watching for event file changes: {source}")

    def stop_watcher(self) -> None:
        """Stop the file watcher."""
        if self._watcher is not None:
            self._watcher.stop()
            self._watcher = None
            app_logger.info("Stopped event file watcher")


class SuiviBourseMetrics:
    """
    Class for managing and exposing metrics related to stock shares.
    """

    def __init__(self, config_manager: ConfigurationManager,
                 influxdb_writer: Optional[InfluxDBWriter] = None,
                 prometheus_exporter: Optional[PrometheusExporter] = None,
                 recorder: Optional[runtime_state.RuntimeRecorder] = None):
        self.config_manager = config_manager

        # InfluxDB writer
        self.influxdb = influxdb_writer or InfluxDBWriter()
        self.influxdb.connect()

        # Prometheus exporter (legacy /metrics endpoint, on by default for
        # backward compatibility). The HTTP server is started separately.
        self.prometheus = prometheus_exporter
        if self.prometheus is None and env_flag('SB_PROMETHEUS_ENABLED', True):
            self.prometheus = PrometheusExporter()

        # The dials (issue #701, ADR-0014). Constructed at the **code's** values
        # and overwritten by the store in ``start_runtime``, which is the only
        # order that keeps the registry the single list: an object that read the
        # store here would need one, and a test that builds one directly would
        # need a store to build it. Each is a plain mutable attribute every
        # cycle re-reads, which is what makes a saved dial take effect with no
        # restart — the write path assigns it and the next pass reads it.
        #
        #   backfill_delay / backfill_chunk_days — the backfill's politeness and
        #     window.
        #   staleness_horizon — the price-freshness liveness sonde (issue #628,
        #     design #626): the signal fires only once the newest stored price
        #     has gone unrefreshed for this many seconds while the live quote
        #     moves, a few REGULAR cycles wide so an ordinary tick never trips
        #     it. ``0`` disables the sonde — the pure decision returns False and
        #     the check no-ops.
        #   regular_interval — see below.
        #
        # Assigned by one loop and not by four literals, deliberately: a default
        # spelled here as well as in the registry is the second list ADR-0014
        # exists to forbid, and it would be the copy nobody updates.
        self.apply_dials(settings_registry.defaults())

        # Market-aware per-symbol scheduling (issue #616). Each held symbol runs
        # as its own self-rescheduling APScheduler job; the scheduler is injected
        # from __main__ (None until then, so unit tests that never wire it skip
        # reconciliation). `regular_interval` is the REGULAR-state poll cadence
        # (base_interval), and it is also the base of the #617 back-off — so
        # changing it rescales, retroactively, the wait of a symbol that is
        # already failing. It is set by `apply_dials` above and **not** repeated
        # here: a literal at this line would win over the registry it just read,
        # and would go on agreeing with it only until the registry's default
        # changed. `_failure_counts` holds the per-symbol consecutive-failure count fed to
        # scheduling.decide for the dead-ticker backoff (issue #617); it is
        # dropped in _reconcile_jobs when a symbol departs so state is per-job.
        # Written by the scrape thread and popped by the ingest/reconcile thread
        # (APScheduler's default ThreadPoolExecutor runs jobs concurrently), so
        # guarded by `_failure_counts_lock`: without it, an in-flight scrape of a
        # just-departed symbol could resurrect its counter after cleanup.
        self.scheduler: Optional[BackgroundScheduler] = None
        self._failure_counts: Dict[str, int] = {}
        self._failure_counts_lock = threading.Lock()

        # Cache for share info (to avoid repeated API calls during backfill)
        self._share_info_cache: Dict[str, Dict] = {}

        # Track (symbol, account) pairs whose backfill has reached the first BUY
        # date, mapped to that date so an earlier newly-added event re-triggers
        # backfill for that account.
        self._backfill_complete: Dict[Tuple[str, str], datetime] = {}

        # Incremental perf-series write watermark (issue #597). Rewriting the
        # whole daily account_metrics/portfolio_totals series every scrape cycle
        # lands new, never-compacted Parquet files on InfluxDB 3 Core, so file
        # count grows without bound. Instead we rewrite only the stale tail:
        #   _perf_dirty_from — earliest day backfill has newly filled since the
        #     last write (None = nothing earlier than today is stale). Written by
        #     the backfill thread, read/reset by the scrape thread, so guarded by
        #     _perf_lock.
        #   _perf_last_events — the events list object fed to the last write; a
        #     new object means the events cache was reloaded (files changed) and
        #     the whole series must be rewritten. Touched only on the perf-job
        #     thread (recompute_perf/update_account_metrics), so it needs no lock.
        #   _perf_dirty_live — a single global bool set on the REGULAR write path
        #     in _scrape_symbol (issue #618): the live-write trigger for the
        #     gated perf job, alongside the two above. Written by the scrape
        #     threads and checked-and-cleared by the perf-job thread, so guarded
        #     by _perf_lock. Seeded True at boot so today's point is always fresh
        #     after a weekend/overnight restart.
        self._perf_lock = threading.Lock()
        self._perf_dirty_from: Optional[date] = None
        self._perf_last_events: Optional[List] = None
        self._perf_dirty_live: bool = True

        # Price-freshness liveness sonde state (issue #628). Per-(symbol, account)
        # memory so staleness is measured over *consecutive* REGULAR polling, not
        # the raw wall-clock age of the stored point (which can't tell a stuck
        # writer from a normal overnight/weekend close). Each (symbol, account) is
        # touched only by its own single scrape job (one job per symbol,
        # max_instances=1), but the dict is guarded for parity with the other
        # cross-thread scrape state.
        self._sonde_lock = threading.Lock()
        self._sonde_state: Dict[Tuple[str, str], scheduling.SondeState] = {}

        # The last-pass records (issue #668, design #656). Injected from the
        # Runtime so the web handlers reach the *same* recorder the jobs write
        # to — it is built master-side, like the ConfigWriter and for the same
        # reason. Defaulted here so a unit test that builds this class directly
        # still has somewhere to publish, and so no call site below has to check
        # for None.
        self.recorder = recorder or runtime_state.RuntimeRecorder()

    @property
    def shares(self) -> List[Dict]:
        """The held positions, read from the published configuration snapshot.

        A read, not a copy (issue #658). Holding a second copy here is what used
        to let the app run on two configurations at once: scraping worked from
        this attribute while backfill and the perf recompute read the manager's
        cache, and the two could disagree for a whole cycle — including in the
        one case that matters, a file the validator had just rejected.
        """
        return self.config_manager.current().shares

    # ``validate()`` left with ``schema.yaml`` (issue #696). It could only ever
    # answer True — a published snapshot has been validated by construction
    # since #658 — and the schema it called no longer exists.

    def _fetch_ticker_data(self, symbol: str, max_retries: int = 3):
        """
        Fetch ticker data from yfinance with retry logic for rate limiting.

        Args:
            symbol: The stock symbol to fetch
            max_retries: Maximum number of retry attempts

        Returns:
            Tuple of (last_quote, info_dict) or (None, None) if fetch fails
        """
        for attempt in range(max_retries):
            try:
                ticker = yf.Ticker(symbol)
                ticker_history = ticker.history()
                if ticker_history.empty:
                    app_logger.warning(f"No price history returned for {symbol}")
                    return None, None
                # Use the last row that actually has a close. Yahoo returns the
                # most recent daily bar with a NaN close for a while after a
                # session ends (the daily aggregate lags the intraday data), so a
                # blind tail(1) would reject a perfectly good series outside
                # market hours — and, via _ensure_share_info, defer ALL backfill
                # (both passes) whenever the market is closed, defeating the
                # missed-session gap-fill (#627). Mirror the per-row NaN skip that
                # _fetch_historical_data already does.
                valid_close = ticker_history['Close'].dropna()
                if valid_close.empty:
                    app_logger.warning(f"No non-NaN close price for {symbol}, skipping")
                    return None, None
                last_quote = valid_close.iloc[-1]
                # Get hourly volume instead of daily volume
                ticker_history_hourly = ticker.history(period='1d', interval='1h')
                if not ticker_history_hourly.empty and 'Volume' in ticker_history_hourly.columns:
                    last_volume = ticker_history_hourly.tail(1)['Volume'].iloc[0]
                else:
                    last_volume = None
                ticker_info = ticker.info
                info = {
                    'currency': ticker_info.get('currency', 'undefined'),
                    'exchange': ticker_info.get('exchange', 'undefined'),
                    'quoteType': ticker_info.get('quoteType', 'undefined'),
                    'dividendYield': ticker_info.get('dividendYield'),
                    'peRatio': ticker_info.get('trailingPE') or ticker_info.get('forwardPE'),
                    'marketCap': ticker_info.get('marketCap'),
                    'volume': int(last_volume) if pd.notna(last_volume) else None,
                    # Market-context fields feed the per-symbol scheduler
                    # (scheduling.extract_market_context). They ride on `info`
                    # so _fetch_ticker_data keeps its (last_quote, info) shape;
                    # _history_meta carries currentTradingPeriod for the exact
                    # next-open. Extra keys are ignored by the write path.
                    'marketState': ticker_info.get('marketState'),
                    'exchangeTimezoneName': ticker_info.get('exchangeTimezoneName'),
                    '_history_meta': getattr(ticker, 'history_metadata', None),
                }
                # Cache the info for backfill use
                self._share_info_cache[symbol] = info
                return last_quote, info
            except YFRateLimitError:
                if attempt < max_retries - 1:
                    wait_time = 2 ** (attempt + 1)
                    app_logger.warning(
                        f"Rate limited for {symbol}, retrying in {wait_time}s "
                        f"(attempt {attempt + 1}/{max_retries})")
                    time.sleep(wait_time)
                else:
                    app_logger.error(
                        f"Rate limited for {symbol}, max retries exceeded")
                    return None, None
            except (u_exceptions.NewConnectionError, RuntimeError):
                app_logger.error(
                    "Error while retrieving data from Yfinance API",
                    exc_info=True)
                return None, None
        return None, None

    def _fetch_historical_data(self, symbol: str, start: datetime, end: datetime,
                               max_retries: int = 3) -> Optional[List[Dict]]:
        """
        Fetch historical price data from yfinance.

        Args:
            symbol: Stock symbol
            start: Start date
            end: End date
            max_retries: Maximum retry attempts

        Returns:
            List of dicts with 'timestamp' and 'price' keys, or None on failure
        """
        for attempt in range(max_retries):
            try:
                ticker = yf.Ticker(symbol)
                # Use hourly interval for data within 730 days, daily for older
                days_ago = (datetime.now(timezone.utc) - start).days
                interval = '1h' if days_ago <= 729 else '1d'
                history = ticker.history(start=start, end=end, interval=interval)

                if history.empty:
                    app_logger.debug(f"No historical data for {symbol} from {start} to {end}")
                    return []

                prices = []
                for idx, row in history.iterrows():
                    # Skip rows without a valid close price (holidays / partial
                    # bars come back as NaN) so no NaN point reaches InfluxDB.
                    close = row['Close']
                    if pd.isna(close):
                        continue
                    # idx is a pandas Timestamp
                    ts = idx.to_pydatetime()
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    prices.append({
                        'timestamp': ts,
                        'price': float(close),
                        'price_open': float(row['Open']) if pd.notna(row['Open']) else None,
                        'price_high': float(row['High']) if pd.notna(row['High']) else None,
                        'price_low': float(row['Low']) if pd.notna(row['Low']) else None,
                        'volume': int(row['Volume']) if 'Volume' in row and pd.notna(row['Volume']) else None
                    })

                return prices

            except YFRateLimitError:
                if attempt < max_retries - 1:
                    wait_time = self.backfill_delay * (2 ** attempt)
                    app_logger.warning(
                        f"Rate limited fetching history for {symbol}, "
                        f"retrying in {wait_time}s (attempt {attempt + 1}/{max_retries})")
                    time.sleep(wait_time)
                else:
                    app_logger.error(
                        f"Rate limited fetching history for {symbol}, max retries exceeded")
                    return None
            except Exception as e:
                app_logger.error(f"Error fetching history for {symbol}: {e}")
                return None

        return None

    def _update_share_prometheus(self, share, last_quote, info) -> None:
        """Update one share's **market** gauges from a fetched quote.

        Kept independent of the InfluxDB write so ``/metrics`` stays populated
        even if InfluxDB errors, and gated by the caller on **fetch success**
        (price present) rather than the write/REGULAR gate — a closed-market
        restart must still leave the share gauges populated (design #609).

        The position half left with #699: it is fed by the replay
        (:meth:`_publish_position_gauges`), because a sold position's figures
        change at the very instant its scrape stops.
        """
        if self.prometheus is None:
            return
        try:
            self.prometheus.update_quote(share, last_quote, info)
        except Exception as e:
            app_logger.error(
                f"Failed to update Prometheus metrics for {share['symbol']}: {e}")

    def _publish_position_gauges(self, shares) -> None:
        """Publish every position's state gauges after a replay (issue #699).

        Every position, sold ones included — ``sb_realized_gain`` and
        ``sb_received_dividend`` are what a sold line has left to say, and the
        scrape that used to carry them is gone by then. It is a **retain**: a
        position the replay no longer produces (a forgotten import) has its
        series removed rather than left standing at its last value.

        Guarded like every other Prometheus call: ``/metrics`` is a mirror, and
        a mirror must never be able to abort the ingestion it reflects.
        """
        if self.prometheus is None:
            return
        try:
            self.prometheus.retain_positions(shares)
        except Exception as e:
            app_logger.error(f"Failed to publish the position gauges: {e}")

    def _write_share_metrics(self, share, last_quote, info) -> bool:
        """Write one share's live metrics point to InfluxDB.

        Guarded so a transient InfluxDB error on one share does not abort the
        surrounding cycle. Callers only invoke this once the fetch succeeded, so
        currency/exchange/quote_type tags are always present and the point lands
        in the same enriched series as its history. Returns whether the point
        was actually persisted, so callers can tell a real write from a
        swallowed failure (issue #618 — an all-failed wave must not raise the
        perf dirty flag).
        """
        try:
            self.influxdb.write_metrics(
                share_name=share['name'],
                share_symbol=share['symbol'],
                account=share.get('account', DEFAULT_ACCOUNT),
                share_price=last_quote,
                **legacy_influx_shape.legacy_position_fields(share),
                share_currency=info['currency'],
                share_exchange=info['exchange'],
                quote_type=info['quoteType'],
                dividend_yield=info['dividendYield'] * 100 if info['dividendYield'] is not None else None,
                pe_ratio=info['peRatio'],
                market_cap=info['marketCap'],
                volume=info['volume']
            )
            return True
        except Exception as e:
            app_logger.error(
                f"Failed to write metrics for {share['symbol']}: {e}")
            return False

    def expose_metrics(self):
        """
        Expose the metrics for each stock share to InfluxDB.

        Synchronous whole-portfolio scrape, kept as a driver for the end-to-end
        harness; the scheduled runtime drives per-symbol jobs via
        ``_scrape_symbol``.

        Scoped to the **held** positions, like the scheduled path (issue #699):
        a position at zero quantity is one the app has stopped following, and
        this driver would otherwise be the one place a sold line still reached
        Yahoo — and the one place an account that sold out still received a
        point of zeros.
        """
        for share in self.shares:
            share_symbol = share['symbol']
            if not share.get('quantity'):
                continue

            last_quote, info = self._fetch_ticker_data(share_symbol)
            self._update_share_prometheus(share, last_quote, info)

            # Skip writing when the fetch failed: writing portfolio fields with
            # missing currency/exchange/quote_type tags would land them in a
            # different InfluxDB series than the enriched (tagged) points.
            if last_quote is None or info is None:
                app_logger.warning(
                    f"No data fetched for {share_symbol}, skipping metrics write")
            else:
                self._write_share_metrics(share, last_quote, info)

    # ------------------------------------------------------------------ #
    # Market-aware per-symbol scheduling (issue #616)
    # ------------------------------------------------------------------ #

    def _held_symbols(self) -> set:
        """The set of symbols currently held across all accounts.

        The filter on ``quantity`` is what finally makes this docstring true
        (issue #699, #672 D5). It used to be every symbol the configuration
        named, so a position sold four years ago went on being polled at Yahoo
        for as long as the process lived.

        **The filtering line is here and not in the timeline.** A sold position
        must stay in ``self.shares``: the replay writes its realized gain and
        the page shows it. What departs is the scrape job — and the pair is
        free, because ``_reconcile_jobs`` arms any held symbol without a live
        job, so a buy-back revives on the next replay with nothing to remember.
        """
        return {s['symbol'] for s in self.shares
                if s.get('symbol') and s.get('quantity')}

    @staticmethod
    def _exchange_from_info(info: Optional[dict]) -> Optional[str]:
        """The exchange from a ticker ``info`` dict, or ``None``.

        ``None`` for a failed fetch or the ``'undefined'`` sentinel (yfinance's
        default for a missing exchange), so ``compute_pool_size`` treats the
        symbol as a solo market rather than grouping every unknown into one giant
        cohort.
        """
        exchange = (info or {}).get('exchange')
        return exchange if exchange and exchange != 'undefined' else None

    def capture_exchange_of(self) -> Dict[str, Optional[str]]:
        """Map each held symbol to its exchange for auto pool sizing (#619, #611).

        Same-exchange cohorts drive ``scheduling.compute_pool_size``, but the
        exchange lives only in the yfinance ``info`` — not the config — so we fetch
        it once up front, before the scheduler's executor is fixed at construction
        (the design's "pre-scheduler scrape"). Reuses the shared
        ``_share_info_cache`` so a symbol already fetched isn't fetched twice.

        The whole app blocks here at boot, so the uncached symbols are fetched
        concurrently over a bounded pool (``_EXCHANGE_CAPTURE_WORKERS``) and the
        collection is hard-capped by ``_EXCHANGE_CAPTURE_TIMEOUT_SECONDS``: a slow
        or rate-limited yfinance session can't delay scheduler startup
        indefinitely. Any symbol that fails or doesn't resolve in time maps to
        ``None`` — a solo market (see ``_exchange_from_info``).

        **Every boot pays this since #701**, the opt-in flag that used to gate it
        having been deleted along with the fixed pool it selected. That is what
        makes the cap above load-bearing rather than defensive, and why
        ``gunicorn.conf.py`` sets an explicit ``timeout``: this whole call
        happens in ``post_fork``, before the worker reaches the accept loop that
        answers the arbiter's heartbeat.
        """
        exchange_of: Dict[str, Optional[str]] = {}
        to_fetch = []
        for symbol in sorted(self._held_symbols()):
            info = self._share_info_cache.get(symbol)
            if info is None:
                to_fetch.append(symbol)
                exchange_of[symbol] = None  # solo unless the fetch resolves below
            else:
                exchange_of[symbol] = self._exchange_from_info(info)

        if not to_fetch:
            return exchange_of

        pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=min(_EXCHANGE_CAPTURE_WORKERS, len(to_fetch)))
        futures = {pool.submit(self._fetch_ticker_data, s): s for s in to_fetch}
        try:
            for future in concurrent.futures.as_completed(
                    futures, timeout=_EXCHANGE_CAPTURE_TIMEOUT_SECONDS):
                symbol = futures[future]
                try:
                    _, info = future.result()
                except Exception as e:
                    app_logger.warning(
                        f"Exchange capture failed for {symbol}, treating as a "
                        f"solo market: {e}")
                    continue
                exchange_of[symbol] = self._exchange_from_info(info)
        except concurrent.futures.TimeoutError:
            unresolved = sorted(s for f, s in futures.items() if not f.done())
            app_logger.warning(
                f"Exchange capture timed out after "
                f"{_EXCHANGE_CAPTURE_TIMEOUT_SECONDS}s; treating "
                f"{len(unresolved)} symbol(s) as solo markets: "
                f"{', '.join(unresolved)}")
        finally:
            # Don't block startup joining slow/hung in-flight fetches; cancel what
            # hasn't started yet (cancel_futures: py3.9+).
            pool.shutdown(wait=False, cancel_futures=True)
        return exchange_of

    def _scheduled_symbols(self) -> set:
        """Symbols that currently have a live per-symbol scrape job."""
        out = set()
        for job in (self.scheduler.get_jobs() or []):
            jid = getattr(job, 'id', '') or ''
            if jid.startswith(SCRAPE_JOB_PREFIX):
                out.add(jid[len(SCRAPE_JOB_PREFIX):])
        return out

    def _arm_symbol(self, symbol: str, delay: float, now: datetime) -> None:
        """(Re)schedule a symbol's scrape job to fire ``delay`` seconds from now.

        A single ``date`` trigger — the job re-arms itself each cycle, so this is
        both the immediate bootstrap (``delay=0``) and the self-reschedule.

        Anti-herd jitter (issue #619): offset every arming by a fresh
        ``uniform(0, JITTER_SECONDS)`` — the heir of the removed inter-share
        ``time.sleep(1)``. A same-exchange cohort sharing one next-open thus
        spreads over ``[open, open + JITTER_SECONDS]``, and the ``REGULAR``-poll
        lockstep is re-randomized each cycle. A ``date`` trigger can't carry
        APScheduler's own ``jitter`` (only interval/cron can), so we apply it to
        ``run_date`` directly, mirroring APScheduler's ``uniform(0, jitter)``.

        ``misfire_grace_time=None`` (run however late): under per-symbol jobs each
        job *is* its own scheduler (it re-arms inside ``_scrape_symbol``), so a
        misfired-and-skipped run would permanently kill the symbol and ingest()'s
        set-diff wouldn't revive it. Running late is safe — the on-wake
        ``marketState`` re-read (#608/#616) self-corrects. ``max_instances=1``
        (no overlap; ``coalesce`` is moot with one pending run per job).
        """
        jitter = random.uniform(0, scheduling.JITTER_SECONDS)
        run_date = now + timedelta(seconds=delay + jitter)
        self.scheduler.add_job(
            self._scrape_symbol, 'date', run_date=run_date,
            args=[symbol], id=_scrape_job_id(symbol),
            name=f'Scrape {symbol}', replace_existing=True,
            misfire_grace_time=None, max_instances=1)

    def apply_dials(self, values: Dict[str, object]) -> None:
        """Set the live attributes a mapping of dials names (issue #701).

        One loop over :data:`settings_registry.SETTINGS`, so the attribute a dial
        feeds is declared once — in the registry, next to its bounds and its
        effect — instead of in a hand-written assignment here that can silently
        fall out of step with it.

        Keys the mapping does not carry are left alone (a ``PUT`` naming one
        dial must not reset the other four), and so is a ``None`` value: the
        only dial that can be ``None`` is the unanswered currency, and it has no
        attribute anyway.
        """
        for spec in settings_registry.SETTINGS:
            if spec.attribute is None:
                continue
            if values.get(spec.key) is not None:
                setattr(self, spec.attribute, values[spec.key])

    def rearm_regular_scrapes(self) -> Tuple[int, int]:
        """Re-arm the symbols a new ``regular_interval`` reaches (issue #701).

        Returns ``(reached, at_market_open)`` — the two figures the API
        publishes, and they **add up to the held portfolio**, because a
        portfolio-wide dial that reaches three symbols out of eleven has to say
        so rather than let the reader assume the other eight are broken.

        The classification is :func:`scheduling.rearm_split`'s, off the
        scheduler's own last-pass records; the re-arm is the ordinary
        :meth:`_arm_symbol`, so the anti-herd jitter (#619) applies here as it
        does everywhere else — saving a cadence must not put a whole cohort back
        into lockstep.

        **A failing symbol keeps its back-off, rescaled.** The delay is
        ``scheduling.backoff_delay(new_interval, failures)`` and not the flat
        cadence, which is the same arithmetic ``decide`` would have applied on
        the symbol's next pass. Re-arming a dead ticker at the bare interval
        would silently discard #617's whole guard on every save — and the
        rescaling *is* the retroactive effect the settings page has to announce:
        the wait is a multiple of the number in the form, so lowering the form's
        number shortens the wait of a symbol that has been silent since this
        morning.

        The new cadence otherwise starts **now**, not from the symbol's last
        poll: a shortened interval waits one full new interval rather than
        firing immediately, and a lengthened one does not honour the old short
        one. One sentence in either direction is worth more than a saved cycle.

        Guarded end to end. A saved setting is in the store whatever the
        scheduler does with it, so a jobstore hiccup is logged and reported as
        "reached nothing", never raised into the handler as a ``503`` on a write
        that in fact succeeded.
        """
        if self.scheduler is None:
            return 0, 0
        try:
            now = datetime.now(timezone.utc)
            held = self._held_symbols()
            armed = set(scrape_next_runs(self.scheduler))
            closed = {symbol: self._last_pass_closed(symbol) for symbol in held}
            split = scheduling.rearm_split(held, closed, armed)
        except Exception as e:
            app_logger.error(f"Failed to read the scrape jobs to re-arm: {e}")
            return 0, 0

        reached = len(split.self_arming)
        for symbol in split.rearm:
            try:
                with self._failure_counts_lock:
                    failures = self._failure_counts.get(symbol, 0)
                self._arm_symbol(
                    symbol,
                    scheduling.backoff_delay(self.regular_interval, failures),
                    now)
                reached += 1
            except Exception as e:
                app_logger.error(f"Failed to re-arm scrape job for {symbol}: {e}")

        app_logger.info(
            f"Poll cadence is now {self.regular_interval}s: {reached} "
            f"symbol(s) reached, {len(split.asleep)} waiting for their market "
            f"to open")
        return reached, len(split.asleep)

    def _last_pass_closed(self, symbol: str) -> Optional[bool]:
        """Was this symbol's market shut on its last pass? ``None`` if it has none.

        One ``get`` per key, never an iteration: the records are written by the
        scrape threads, and copying the dict they are writing raises
        ``RuntimeError: dictionary changed size during iteration`` — with forty
        symbols, and only in production (#668).
        """
        record = self.recorder.scrape_of(symbol)
        return None if record is None else record.closed

    def _reconcile_jobs(self) -> None:
        """Diff the held-symbol set against the scheduled jobs (design #604).

        New **and** revived (missing) symbols are armed to fire immediately (the
        first fire is the bootstrap); departed symbols are ``remove_job``'d;
        unchanged symbols keep their existing timers untouched. Guarded so a
        scheduler hiccup never aborts ingestion.
        """
        if self.scheduler is None:
            return
        try:
            now = datetime.now(timezone.utc)
            held = self._held_symbols()
            scheduled = self._scheduled_symbols()
        except Exception as e:
            app_logger.error(f"Failed to reconcile per-symbol jobs: {e}")
            return
        # Add new + revive missing in one pass: any held symbol without a live
        # job fires immediately. Remove departed symbols' idle jobs (belt-and-
        # braces with the in-flight membership re-check in _scrape_symbol).
        # Each op is guarded on its own so one failure — e.g. a JobLookupError
        # from a self-re-arming date job that just fired and vanished — never
        # aborts the rest of the reconcile pass.
        for symbol in held - scheduled:
            try:
                self._arm_symbol(symbol, 0, now)
            except Exception as e:
                app_logger.error(f"Failed to arm scrape job for {symbol}: {e}")
        for symbol in scheduled - held:
            try:
                self.scheduler.remove_job(_scrape_job_id(symbol))
            except Exception as e:
                app_logger.debug(f"Job for {symbol} already gone, skipping: {e}")
            finally:
                # Failure-backoff state is per-job (issue #617): drop it when the
                # symbol departs so a later revival starts fresh at base_interval
                # rather than inheriting a stale dead-ticker backoff. Under the
                # shared lock so a concurrent in-flight scrape (which re-checks
                # membership under the same lock) can't write the entry back.
                with self._failure_counts_lock:
                    self._failure_counts.pop(symbol, None)
                # Same cleanup, one storey up (issue #668): the last-pass
                # records of a departed symbol are invisible to a reader — the
                # row set comes from the configuration snapshot — but a process
                # running for months through many portfolio edits would keep
                # them all, and #597 is this app's story of a structure that
                # grew without bound.
                self.recorder.forget_symbol(symbol)
                # And the market gauges (issue #699, #672 D6). Nothing will
                # ever fetch this symbol again, so ``sb_share_price`` would sit
                # at its last observed value for the life of the process,
                # indistinguishable from a price that is simply not moving.
                if self.prometheus is not None:
                    try:
                        self.prometheus.forget_quotes(symbol)
                    except Exception as e:
                        app_logger.error(
                            f"Failed to remove quote gauges for {symbol}: {e}")

    def _check_price_freshness(self, holdings: List[dict], live_price,
                               now: datetime) -> Tuple[str, ...]:
        """Price-freshness liveness sonde (issue #628, design #626).

        Runs only on the ``REGULAR`` write path (the caller's ``should_write``
        gate): for each (symbol, account) holding, read the newest stored price
        and advance the pure ``scheduling.price_freshness_step`` against this
        series' remembered state. When the stored price has stayed frozen across
        consecutive ``REGULAR`` cycles for at least ``staleness_horizon`` while
        the live quote has moved, the writer is silently stale — emit a WARNING
        and raise the ``sb_price_staleness`` gauge (cleared to 0 otherwise so it
        auto-recovers). Measuring over consecutive polling (not the stored
        point's raw age) is what keeps the first tick after an overnight/weekend
        close — legitimately hours old — from firing a false positive.

        **Diagnostic only** — never changes scrape cadence, write gating, or the
        #617 dead-ticker backoff. Fully guarded: a read or metric error here must
        never disturb the surrounding scrape cycle (the sonde complements #617
        from the monitoring side, it is not part of the writer's control flow).
        Called *before* this cycle's write so it reads the coverage as it stood,
        not the point the write is about to refresh.

        Returns the accounts it flagged, so the caller can carry them into the
        scrape record (issue #668). The signal was already computed here, by the
        one thread that holds this series' sonde memory — a reader recomputing it
        would need that memory *and* a fresh price, at a second instant, which is
        the composed read #656 déc. 4 exists to forbid.
        """
        stale_accounts: List[str] = []
        if self.staleness_horizon <= 0:
            return ()
        for share in holdings:
            symbol = share['symbol']
            account = share.get('account', DEFAULT_ACCOUNT)
            key = (symbol, account)
            try:
                stored_price = self.influxdb.get_newest_price(symbol, account=account)
                with self._sonde_lock:
                    new_state, stale = scheduling.price_freshness_step(
                        self._sonde_state.get(key), live_price, stored_price,
                        now, self.staleness_horizon)
                    if new_state is None:
                        self._sonde_state.pop(key, None)
                    else:
                        self._sonde_state[key] = new_state

                if stale:
                    stale_accounts.append(account)
                    app_logger.warning(
                        f"Price-freshness sonde: stored price for {share['name']} "
                        f"({symbol}, account={account}) frozen at {stored_price} "
                        f"across REGULAR polling while the live quote is "
                        f"{live_price} — the writer may be silently stale")
                if self.prometheus is not None:
                    self.prometheus.update_price_staleness(share, stale)
            except Exception as e:
                app_logger.debug(
                    f"Price-freshness sonde failed for {symbol}: {e}")
        return tuple(stale_accounts)

    @staticmethod
    def _scrape_verdict(should_write: bool, state, wrote: bool,
                        has_holdings: bool) -> str:
        """Name what one scrape pass did, at the instant it did it (issue #668).

        Four values, and the fourth is the one worth having.
        ``scheduling.decide`` resets the #617 counter whenever a price was
        present, so an InfluxDB outage leaves a symbol polling happily at
        ``base_interval`` with its counter at zero and **nothing persisted** —
        the dead-ticker guard watches yfinance, by design, and cannot see this.
        ``SCRAPE_WRITE_FAILED`` is where that shows up.

        ``has_holdings`` guards the one race that would otherwise read as that
        failure: a symbol removed from the portfolio between this cycle's fetch
        and its write has nothing to write *and nothing wrong with it*.
        """
        if scheduling.is_closed(state):
            return runtime_state.SCRAPE_CLOSED
        if not should_write:
            return runtime_state.SCRAPE_NO_PRICE
        if wrote or not has_holdings:
            return runtime_state.SCRAPE_WROTE
        return runtime_state.SCRAPE_WRITE_FAILED

    def _scrape_symbol(self, symbol: str, now: Optional[datetime] = None) -> None:
        """Scrape one symbol, gate the write, and re-arm the job (design #602).

        Fetch once, then apply ``scheduling.decide`` to split the two gates:
        the write gate (not-closed AND price present) and the reschedule gate
        (closed → sleep to next open, else ``base_interval``). Writes one point
        per account holding this symbol. Re-arms only while the symbol is still
        held (the in-flight half of the self-reschedule↔removal race guard).
        """
        injected_now = now is not None
        now = now or datetime.now(timezone.utc)
        last_quote, info = self._fetch_ticker_data(symbol)
        price_present = last_quote is not None and info is not None

        # Held, per **(symbol, account)** — `_held_symbols` is per symbol, so a
        # share still held in one account keeps its job while the account that
        # sold out must stop being written (issue #699). Without the quantity
        # here, that account goes on receiving a point of zeros every cycle and
        # the shares page grows a phantom row under the symbol.
        holdings = [s for s in self.shares
                    if s.get('symbol') == symbol and s.get('quantity')]

        # Prometheus sb_share_* gauges stay on the fetch-success gate (#609),
        # never the write/REGULAR gate.
        if price_present:
            for share in holdings:
                self._update_share_prometheus(share, last_quote, info)

        if info is not None:
            state, next_open = scheduling.extract_market_context(
                info, info.get('_history_meta'), now)
        else:
            # Fetch failed outright: no state to read, fail-open as REGULAR so a
            # transient failure keeps the job polling rather than sleeping it.
            state, next_open = None, None

        with self._failure_counts_lock:
            should_write, next_delay, new_failure_count, mark_dirty = scheduling.decide(
                state, price_present, next_open, now,
                self._failure_counts.get(symbol, 0), self.regular_interval)
            # Persist the backoff counter only while the symbol is still held. A
            # concurrent ingest() reconcile may have removed it (and popped its
            # entry) between this cycle's fetch and here; the held-recheck under
            # the shared lock stops this write from resurrecting a departed
            # symbol's counter after cleanup (issue #617 race). Both branches run
            # under the lock so the reconcile pop can't interleave mid-decision.
            if symbol in self._held_symbols():
                self._failure_counts[symbol] = new_failure_count
            else:
                self._failure_counts.pop(symbol, None)

        stale_accounts: Tuple[str, ...] = ()
        accounts_written: List[str] = []
        if should_write:
            # Price-freshness liveness sonde (issue #628): read the stored price
            # *before* this cycle's write refreshes it, so a silently stale writer
            # is caught. Purely diagnostic — never gates the write below.
            stale_accounts = self._check_price_freshness(holdings, last_quote, now)

            wrote_live_data = False
            for share in holdings:
                wrote = self._write_share_metrics(share, last_quote, info)
                if wrote:
                    accounts_written.append(
                        share.get('account', DEFAULT_ACCOUNT))
                wrote_live_data = wrote_live_data or wrote
            # A REGULAR write makes today's perf series stale: raise the global
            # live-write dirty bool so the gated perf job (issue #618) runs its
            # next cycle. One flag for the whole market-open wave — it coalesces
            # N symbols' writes into a single recompute by construction. Only
            # when a point actually persisted — an all-failed Influx outage
            # must not trigger a perf recompute with nothing new to read.
            if mark_dirty and wrote_live_data:
                with self._perf_lock:
                    self._perf_dirty_live = True
        else:
            wrote_live_data = False
            app_logger.debug(
                f"Skipping write for {symbol} (state={state}, "
                f"price_present={price_present})")

        # The last-pass record (issue #668, design #656 déc. 1). Published here,
        # once, out of values this pass already holds — `decide` handed back the
        # verdict, the delay and the counter in one call, so the three are
        # coherent with each other in a way no reader could reconstruct.
        #
        # Neither `state` nor the coercion is read from `_share_info_cache`
        # (traps 2 and 3): `decide` fail-opens an unrecognised state to REGULAR
        # while the cache keeps yfinance's raw string, and the cache is written
        # only on a *successful* fetch — so a failing symbol's cache entry
        # reports the market state from before its failure, which is the very
        # case a pill exists to show. `state` here is what this cycle read, and
        # `closed` is what the scheduler acted on.
        self.recorder.record_scrape(runtime_state.ScrapeRecord(
            symbol=symbol,
            at=now,
            market_state=state,
            closed=scheduling.is_closed(state),
            price_present=price_present,
            verdict=self._scrape_verdict(
                should_write, state, wrote_live_data, bool(holdings)),
            failure_count=new_failure_count,
            next_delay=next_delay,
            accounts_written=tuple(accounts_written),
            stale_accounts=stale_accounts,
            error=(
                f"No point persisted for {symbol}: InfluxDB refused the write"
                if should_write and not wrote_live_data and holdings else None),
        ))

        # Re-arm only if still held — the in-flight guard against a job that was
        # removed mid-cycle re-adding itself after reconcile's remove_job.
        if self.scheduler is not None and symbol in self._held_symbols():
            # Schedule from a fresh wall-clock, not the decision `now` captured
            # before the fetch: _fetch_ticker_data can sleep on rate-limit
            # retries, which for a small next_delay would otherwise put run_date
            # in the past and let APScheduler drop the job, breaking the
            # self-reschedule chain. Tests inject `now` to keep run_date
            # deterministic; production recomputes it here.
            arm_now = now if injected_now else datetime.now(timezone.utc)
            self._arm_symbol(symbol, next_delay, arm_now)

    def recompute_perf(self) -> None:
        """Recompute the perf series as its own gated interval job (#605, #618).

        Now that per-symbol jobs replaced the global scrape loop, the
        account_metrics/portfolio_totals recompute runs as its own scheduled
        job at ``SB_PERF_INTERVAL`` — never inside the scrape, which would fire N
        recomputes per market-open wave.

        Read the three dirty signals up front and gate on
        ``scheduling.perf_should_run`` so a fully-closed market wave writes
        nothing (no closed-day Parquet drip, #597/#606):
          * the live-write bool ``_perf_dirty_live`` — set on the REGULAR write
            path in ``_scrape_symbol``; **checked-and-cleared here** under
            ``_perf_lock`` (seeded True at boot so today's point is fresh after
            an overnight restart).
          * the backfill watermark ``_perf_dirty_from`` — merely *checked* here;
            its consume/clear stays in ``update_account_metrics``.
          * ``events_changed`` — a reloaded events cache (a new list object).

        Guarded so an error never kills the scheduler thread.
        """
        with self._perf_lock:
            live_write = self._perf_dirty_live
            self._perf_dirty_live = False
            backfill_pending = self._perf_dirty_from is not None
        # One snapshot for the whole cycle: the gate and the recompute must
        # agree on which configuration they are talking about, and a reload can
        # land between them.
        snapshot = self.config_manager.current()
        events_changed = snapshot.events is not self._perf_last_events

        def publish(verdict: str, error: Optional[str] = None) -> None:
            # #656 trap 4: `_perf_dirty_live` is *consumed* by this method — read
            # and cleared under `_perf_lock` above — so a request thread reading
            # it learns about a run that is pending, never about the one that
            # just happened. The verdict has to be recorded; it cannot be
            # inferred. The three inputs ride along rather than a single
            # "reason", because a skip *is* the three of them being quiet.
            self.recorder.record_perf(runtime_state.PerfRecord(
                at=datetime.now(timezone.utc), verdict=verdict,
                events_changed=events_changed,
                backfill_pending=backfill_pending, live_write=live_write,
                error=error))

        if not scheduling.perf_should_run(events_changed, backfill_pending, live_write):
            app_logger.debug(
                "Perf recompute skipped: nothing changed since last run")
            publish(runtime_state.PERF_SKIPPED)
            return
        try:
            self.update_account_metrics(snapshot)
            publish(runtime_state.PERF_RAN)
        except Exception as e:
            # The live-write signal was consumed up front (for concurrency), so a
            # failed write would otherwise drop today's fresh point until the next
            # REGULAR scrape re-sets the flag. Re-arm it on error so the next
            # cycle retries, mirroring the _perf_dirty_from re-arm inside
            # update_account_metrics.
            if live_write:
                with self._perf_lock:
                    self._perf_dirty_live = True
            app_logger.error(f"Failed to update account metrics: {e}")
            publish(runtime_state.PERF_FAILED, str(e))

    def ingest(self, import_files: bool = True):
        """Import the drop folder, replay the ledger, reconcile the scrape jobs.

        **No longer a polled job** (issue #697). In v4 this ran every 300 s
        because the files were the truth and nothing else could notice they had
        changed. The ledger now changes only when a write changes it, so this is
        the *replay that follows the write* — a quiet, synchronous, in-process
        gesture with exactly three callers:

        * the boot, in ``start_runtime``, where it is also what arms the
          per-symbol scrape jobs for the first time;
        * the drop-folder watcher, which is on always and has no dial;
        * a write through the API (forgetting an import), via
          :func:`replay_after_write` — and that one passes
          ``import_files=False``, because the ledger has just been changed by
          hand and re-scanning the folder would import the revoked file straight
          back.

        ``SB_INGESTION_INTERVAL`` is gone with the polling it paced, and there
        is no timer anywhere that re-reads the folder on its own.

        Errors are logged but not raised to avoid blocking the scraping job.
        The previous valid configuration is kept until the error is fixed —
        which since #658 is true by construction rather than by this method's
        care: the manager publishes a snapshot only once it is complete *and*
        valid, so a failure anywhere above leaves the previous one standing for
        every reader, not just for this one.
        """
        now = datetime.now(timezone.utc)
        try:
            before = self.config_manager.current().shares
            snapshot = (self.config_manager.reload() if import_files
                        else self.config_manager.replay())
            after = snapshot.shares
            # The gauges the replay owns (issue #699). Published on every
            # ingest, not only on a change: a restart replays an unchanged
            # ledger and must still leave ``/metrics`` populated.
            self._publish_position_gauges(after)
            if after != before:
                app_logger.info("Shares configuration updated from events")
            else:
                app_logger.debug("No changes in shares configuration")
            self.recorder.record_ingest(runtime_state.IngestRecord(
                at=now,
                outcome=(runtime_state.INGEST_UPDATED if after != before
                         else runtime_state.INGEST_UNCHANGED),
                shares=len(after),
                events=len(snapshot.events) if snapshot.events is not None else None,
            ))
        except Exception as e:
            app_logger.error(f"Error during ingestion (keeping previous config): {e}")
            # The record #656 called out as the one gap worth closing on its
            # own: since #658 a rejected configuration is never published, so
            # the app goes on running — correctly — on its previous snapshot,
            # and the only trace of that anywhere is the line just above.
            self.recorder.record_ingest(runtime_state.IngestRecord(
                at=now, outcome=runtime_state.INGEST_FAILED, error=str(e)))

        # Reconcile the per-symbol scrape jobs against the (possibly unchanged)
        # held-symbol set. Idempotent and always run — on the first ingest it
        # arms every symbol, later it only touches the diff. No-op until the
        # scheduler is wired in __main__.
        self._reconcile_jobs()

    def backfill(self):
        """
        Backfill historical price data for all shares, in both directions.
        This runs as a third scheduled job, progressively filling gaps.

        For each share, delegates to ``_backfill_share`` which runs two
        independent passes (issue #626):
          * Backward: extend the series toward the first BUY date, one
            ``backfill_chunk_days`` chunk per cycle, until ``_backfill_complete``
            is set.
          * Forward: recover a session missed while the app was down by fetching
            ``[newest, now]`` (issue #627) — independent of the backward
            watermark.
        Fetches one chunk (default: 1 year) of history per direction and rate
        limits between requests.
        """
        # One snapshot for the whole cycle (issue #658). Shares, events and
        # accounts have to come from the same generation: reading them one call
        # at a time let a mid-cycle reload pair this cycle's shares with the
        # next cycle's events, and — through the old invalidate-then-load pair —
        # with no events at all, which quietly neutralised the backward pass.
        snapshot = self.config_manager.current()
        if not snapshot.shares:
            app_logger.debug("No shares configured, skipping backfill")
            return

        app_logger.info("Starting backfill cycle")
        backfilled_count = 0

        # A single replay per cycle serves every symbol and every date; each
        # per-date lookup below is a forward-fill on this timeline, never a
        # re-replay (backfill drops from O(days × events) to O(events + days)).
        # Positions are keyed per (account, symbol) unconditionally since #698,
        # so a symbol held in two accounts backfills each series independently
        # without anyone having to ask whether accounts were declared.
        events = snapshot.events
        timeline = EventAggregator().replay(events) if events else None

        for share in snapshot.shares:
            backfilled_count += self._backfill_share(share, snapshot, timeline)

        if backfilled_count > 0:
            app_logger.info(f"Backfill cycle complete: {backfilled_count} data points written")
        else:
            app_logger.debug("Backfill cycle complete: no new data to write")

    def _backfill_share(self, share, snapshot: ConfigSnapshot, timeline) -> int:
        """Backfill one share in both directions (issue #626).

        The **backward** pass extends the series toward the first BUY date and
        stops once ``_backfill_complete`` is set; the **forward** pass recovers a
        recent session missed while the app was down. The two directions are
        **independent** — a completed backward watermark never suppresses the
        forward pass (issue #627). Returns points written this cycle.

        **The two directions part company on a sold position** (issue #699,
        #672 D5). The backward pass keeps running: the chart wants the history
        of a line the user held, and the watermark bounds it, so it finishes and
        stops. The forward pass stops at the same predicate as the scrape — it
        exists to catch a writer up, and that writer has just been removed.
        Left running it would be *worse than useless*: its own no-op guard is
        "the newest point is under a day old", which only the live writer keeps
        true, so the moment the job departs the anchor ages past the guard and
        the pass fetches ``[newest → now]`` from Yahoo **every day, forever**,
        for every symbol the user has ever sold out of.
        """
        symbol = share['symbol']
        account = share.get('account', DEFAULT_ACCOUNT)

        # Get the target date (first BUY), from this cycle's snapshot.
        first_buy_date = snapshot.first_buy_date(symbol)
        if not first_buy_date:
            app_logger.debug(f"No BUY events found for {symbol}, skipping backfill")
            # The second terminal (#656 trap 6). A GRANT-only position is the
            # ordinary case, and it has no history to reach back to — distinct
            # from "complete", which it never started.
            self.recorder.record_backfill(runtime_state.BackfillRecord(
                symbol=symbol, account=account,
                direction=runtime_state.BACKWARD,
                at=datetime.now(timezone.utc),
                terminal=runtime_state.TERMINAL_NO_BUY))
            return 0

        # Convert date to datetime if needed and make timezone-aware
        if isinstance(first_buy_date, datetime):
            if first_buy_date.tzinfo is None:
                first_buy_date = first_buy_date.replace(tzinfo=timezone.utc)
        else:
            # It's a date object, convert to datetime
            first_buy_date = datetime.combine(
                first_buy_date, datetime.min.time(), tzinfo=timezone.utc)

        written = 0
        # Backward pass — skip once complete to avoid refetching the same window
        # every cycle (e.g. a first BUY on a non-trading day never lets oldest
        # reach it exactly). This skip must NOT gate the forward pass below.
        if self._backfill_complete.get((symbol, account)) == first_buy_date:
            app_logger.debug(f"Backfill already complete for {symbol} ({account})")
        else:
            written += self._backfill_backward(share, first_buy_date, timeline)

        # Forward pass — independent of the backward-completion watermark, but
        # not of the holding: there is no live writer to catch up with once the
        # position is sold out.
        if share.get('quantity'):
            written += self._backfill_forward(share, timeline)
        return written

    def _ensure_share_info(self, symbol: str) -> Optional[Dict]:
        """Resolve the share info (tags) so historical points share the same
        series identity as live scrape points.

        Fetches it if the scrape job has not populated the cache yet; returns
        ``None`` (the caller defers this cycle) if still unavailable.
        """
        info = self._share_info_cache.get(symbol)
        if not info:
            self._fetch_ticker_data(symbol)
            info = self._share_info_cache.get(symbol)
        if not info:
            app_logger.warning(
                f"No share info available for {symbol}, deferring backfill")
        return info

    def _enrich_and_write(self, share, info, prices, perf_from_date,
                          timeline) -> int:
        """Enrich a fetched price chunk with portfolio state and write it.

        Shared by the backward and forward passes so recovered points carry the
        **same** enriched series identity/tags as live and backward-filled ones,
        letting the perf ``holdings_value`` pick them up on the next recompute.
        Guarded like ``expose_metrics`` so a transient InfluxDB error on one
        share does not abort backfilling the remaining shares. Returns the number
        of points written.
        """
        symbol = share['symbol']
        name = share['name']
        account = share.get('account', DEFAULT_ACCOUNT)

        # Enrich price data with portfolio state at each date, read from the
        # single per-cycle timeline. Many price points (esp. hourly) share the
        # same calendar day and thus the same state; look up once per date.
        if timeline is not None:
            state_by_date: Dict = {}
            for price_point in prices:
                ts = price_point['timestamp']
                # Convert datetime to date for the timeline lookup
                point_date = ts.date() if isinstance(ts, datetime) else ts
                if point_date not in state_by_date:
                    state_by_date[point_date] = timeline.position_at(
                        account, symbol, point_date)
                state = state_by_date[point_date]
                if state:
                    price_point.update(
                        legacy_influx_shape.legacy_position_fields(state))

        try:
            written = self.influxdb.write_historical_prices(
                share_name=name,
                share_symbol=symbol,
                prices=prices,
                share_currency=info.get('currency'),
                share_exchange=info.get('exchange'),
                quote_type=info.get('quoteType'),
                account=account
            )
            # Newly filled prices change holdings_value for that window; re-arm
            # the perf series so the next recompute rewrites the tail from here
            # (issue #597).
            if written > 0:
                self._mark_perf_dirty(perf_from_date)
            return written
        except Exception as e:
            app_logger.error(
                f"Failed to write historical prices for {symbol}: {e}")
            return 0

    def _fetch_and_store(self, share, info, start_date, end_date, timeline):
        """Fetch one ``[start, end]`` chunk and, if non-empty, enrich + write it.

        The shared tail of both backfill passes (they differ only in window
        sizing and how they treat an empty window). Returns ``(prices, written)``:

          * ``prices is None`` — the fetch failed; the caller logs and retries.
          * ``prices == []`` — an empty window (yfinance returned no rows); the
            caller decides what an empty window means for its direction.
          * otherwise ``prices`` is the fetched rows and ``written`` the count
            persisted.

        Rate-limits (``backfill_delay``) after any completed fetch — empty or
        written — but not after a fetch failure.
        """
        prices = self._fetch_historical_data(
            share['symbol'], start_date, end_date)
        if prices is None:
            return None, 0
        if not prices:
            time.sleep(self.backfill_delay)
            return prices, 0
        written = self._enrich_and_write(
            share, info, prices, start_date.date(), timeline)
        # Rate limit between symbols
        time.sleep(self.backfill_delay)
        return prices, written

    def _backfill_backward(self, share, first_buy_date, timeline) -> int:
        """Backward pass: extend the series toward the first BUY date, one chunk
        (``backfill_chunk_days``) per cycle. Returns points written this cycle.

        Every exit publishes a last-pass record (issue #668). That is the whole
        answer to #656's driving question: this method used to log a warning and
        return ``0`` on failure, which is indistinguishable from the ``0`` a
        healthy weekend returns — so nothing anywhere told "pacing normally"
        apart from "wedged on yfinance". The record carries the window it
        attempted, the two dates the progress bar is drawn from, and — through
        the recorder's fold — how many consecutive cycles have now failed.
        """
        symbol = share['symbol']
        name = share['name']
        account = share.get('account', DEFAULT_ACCOUNT)

        def publish(**fields) -> None:
            self.recorder.record_backfill(runtime_state.BackfillRecord(
                symbol=symbol, account=account,
                direction=runtime_state.BACKWARD,
                at=datetime.now(timezone.utc),
                target=first_buy_date, **fields))

        info = self._ensure_share_info(symbol)
        if info is None:
            # Not counted as a failure: the tags are missing, not the history,
            # and the next scrape of this symbol supplies them.
            publish(skipped=runtime_state.SKIP_NO_SHARE_INFO)
            return 0

        # Get the oldest data point in InfluxDB for this (symbol, account)
        oldest_timestamp = self.influxdb.get_oldest_timestamp(symbol, account=account)

        # Determine if we need to backfill (compare at day granularity)
        if oldest_timestamp is not None:
            # Already have some data, check if we need to go further back
            # Compare dates only to avoid tiny time windows
            if oldest_timestamp.date() <= first_buy_date.date():
                app_logger.debug(
                    f"Backfill complete for {symbol} ({account}): "
                    f"oldest={oldest_timestamp.date()}, target={first_buy_date.date()}")
                self._backfill_complete[(symbol, account)] = first_buy_date
                publish(oldest=oldest_timestamp,
                        terminal=runtime_state.TERMINAL_COMPLETE)
                return 0

            # Need to fetch data before oldest_timestamp
            # Use the actual timestamp to minimize gaps with hourly data
            end_date = oldest_timestamp
            if end_date.tzinfo is None:
                end_date = end_date.replace(tzinfo=timezone.utc)
        else:
            # No data at all, start from now
            end_date = datetime.now(timezone.utc)

        # Calculate the chunk to fetch (going backwards in time)
        start_date = end_date - timedelta(days=self.backfill_chunk_days)

        # Don't go before the first BUY date
        if start_date < first_buy_date:
            start_date = first_buy_date

        # Skip if window is less than 1 day (avoids useless requests outside market hours)
        if (end_date - start_date).days < 1:
            app_logger.debug(
                f"Backfill window too small for {symbol}, skipping until next cycle")
            publish(oldest=oldest_timestamp,
                    skipped=runtime_state.SKIP_WINDOW_TOO_SMALL)
            return 0

        app_logger.info(
            f"Backfilling {name} ({symbol}): {start_date.date()} to {end_date.date()}")

        prices, written = self._fetch_and_store(
            share, info, start_date, end_date, timeline)

        if prices is None:
            app_logger.warning(f"Failed to fetch history for {symbol}, will retry next cycle")
            publish(oldest=oldest_timestamp, window=(start_date, end_date),
                    failed=True,
                    error=f"yfinance returned no history for {symbol} over "
                          f"{start_date.date()} → {end_date.date()}")
            return 0

        if not prices:
            # Empty window: the fetch succeeded but returned no rows. If we
            # have already reached the first BUY date there is no earlier
            # trading data (e.g. the first BUY fell on a weekend/holiday), so
            # mark the symbol complete to avoid refetching this window forever.
            if start_date <= first_buy_date:
                app_logger.debug(
                    f"Backfill complete for {symbol} ({account}): reached first BUY "
                    f"date with no earlier trading data")
                self._backfill_complete[(symbol, account)] = first_buy_date
                publish(oldest=oldest_timestamp, window=(start_date, end_date),
                        terminal=runtime_state.TERMINAL_COMPLETE)
                return written
            # An empty window that has *not* reached the target is a gap
            # classifying itself (#606) — a weekend, a holiday. Emphatically not
            # a failure: counting it would make every Monday morning read as
            # wedged, which is the exact misreading the counter exists to prevent.
            publish(oldest=oldest_timestamp, window=(start_date, end_date))
            return written

        publish(oldest=oldest_timestamp, window=(start_date, end_date),
                written=written)
        return written

    def _backfill_forward(self, share, timeline) -> int:
        """Forward pass: recover a session missed while the app was down by
        fetching ``[newest, now]`` (issue #627).

        Window sizing is delegated to the pure
        ``scheduling.forward_backfill_window`` and gap classification to yfinance
        — an empty window (weekend/holiday, or already covered) writes nothing.
        The pure ``< 1 day`` guard makes this **no-op during live trading**
        (newest ≈ now → sub-day window → skip), so the live ``REGULAR`` writer
        stays the sole writer of the present with no duplicate at the seam.
        Returns points written this cycle.
        """
        symbol = share['symbol']
        name = share['name']
        account = share.get('account', DEFAULT_ACCOUNT)

        newest = self.influxdb.get_newest_timestamp(symbol, account=account)

        def publish(**fields) -> None:
            self.recorder.record_backfill(runtime_state.BackfillRecord(
                symbol=symbol, account=account,
                direction=runtime_state.FORWARD,
                at=datetime.now(timezone.utc),
                newest=newest, **fields))

        window = scheduling.forward_backfill_window(
            newest, datetime.now(timezone.utc), self.backfill_chunk_days)
        if window is None:
            # The two no-ops the pure window sizing returns, told apart because
            # they mean opposite things: an empty series is waiting on the
            # *backward* pass to seed it, while `too_recent` is the healthy
            # steady state during live trading — `newest ≈ now`, so this pass
            # stands aside and the REGULAR writer stays the sole writer of the
            # present. Collapsing them would make a perfectly well portfolio and
            # an unseeded one read the same.
            publish(skipped=(runtime_state.SKIP_NO_SERIES if newest is None
                             else runtime_state.SKIP_TOO_RECENT))
            return 0
        start_date, end_date = window

        info = self._ensure_share_info(symbol)
        if info is None:
            publish(skipped=runtime_state.SKIP_NO_SHARE_INFO)
            return 0

        app_logger.info(
            f"Forward-filling {name} ({symbol}): {start_date.date()} to {end_date.date()}")

        # Same granularity/chunking as the backward pass: 1h within 730d, 1d beyond.
        prices, written = self._fetch_and_store(
            share, info, start_date, end_date, timeline)

        if prices is None:
            app_logger.warning(
                f"Failed to fetch forward history for {symbol}, will retry next cycle")
            publish(window=(start_date, end_date), failed=True,
                    error=f"yfinance returned no history for {symbol} over "
                          f"{start_date.date()} → {end_date.date()}")
            return 0

        if not prices:
            # Empty window: yfinance returned no rows — a weekend/holiday gap or
            # an already-covered range. Self-classifying no-op, nothing written.
            app_logger.debug(
                f"Forward-fill window for {symbol} returned no rows, skipping")

        publish(window=(start_date, end_date), written=written)
        return written

    def scrape(self):
        """
        Scrape stock prices from Yahoo Finance and expose metrics.

        Synchronous whole-portfolio path kept for the e2e harness; the scheduled
        runtime drives per-symbol jobs + the perf job.
        The perf recompute is **detached** from scrape (issue #618): it is its
        own gated interval job, never piggybacked here.
        """
        if not self.shares:
            app_logger.warning("No shares configured, skipping scrape")
            return

        self.expose_metrics()

    @staticmethod
    def _midnight(day) -> datetime:
        """Midnight UTC of ``day`` — never stamped in the future."""
        return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)

    @staticmethod
    def _value_kwargs(dp, last: bool, perf) -> dict:
        """Shared value + perf fields for a metric point built from a DailyPerf.

        twr_index is per-day; xirr / gain_absolu land only on the latest point.
        """
        return dict(
            cash_balance=dp.cash_balance,
            holdings_value=dp.holdings_value,
            total_value=dp.total_value,
            net_contributed=dp.net_contributed,
            twr_index=dp.twr_index,
            xirr=perf.xirr if last else None,
            gain_absolu=perf.gain_absolu if last else None,
        )

    def _mark_perf_dirty(self, from_date: date) -> None:
        """Lower the perf-series write watermark to ``from_date`` (thread-safe).

        Called by the backfill thread once it has written prices for an earlier
        day: that day's ``holdings_value`` changed and TWR compounds forward, so
        the whole tail from ``from_date`` to today must be rewritten next cycle.
        ``min`` keeps the earliest pending bound across several backfills.
        """
        with self._perf_lock:
            cur = self._perf_dirty_from
            self._perf_dirty_from = from_date if cur is None else min(cur, from_date)

    def _consume_perf_dirty_from(self) -> Optional[date]:
        """Atomically read and clear the backfill watermark (thread-safe).

        Reset happens up-front so a backfill landing mid-cycle re-arms the
        watermark for the *next* cycle instead of being swallowed by this one.
        """
        with self._perf_lock:
            pending = self._perf_dirty_from
            self._perf_dirty_from = None
            return pending

    def update_account_metrics(self, snapshot: Optional[ConfigSnapshot] = None):
        """Recompute and write the daily ``account_metrics`` + ``portfolio_totals``
        series via the performance module.

        Opt-in only: gated on ``load_accounts()`` returning a Portfolio. The full
        series (earliest event date → today, one point per calendar day at
        midnight) is recomputed every cycle, but only the **stale tail** is
        written — a steady cycle rewrites just today's point. This is the fix for
        issue #597: on InfluxDB 3 Core a full-series rewrite every scrape lands
        new, never-compacted Parquet files, so file count grew without bound. The
        write window widens back to an earlier day when backfill fills earlier
        prices (``_mark_perf_dirty``) or when the events cache is reloaded (a new
        events list object => full rewrite). Money-weighted performance (xirr /
        gain_absolu / twr_index) comes from
        ``performance.py``; xirr / gain_absolu land only on the latest point.

        ``snapshot`` is this cycle's configuration, passed down by
        ``recompute_perf`` so the gate and the recompute cannot straddle a
        reload; it defaults to the currently published one for direct callers.
        """
        snapshot = snapshot or self.config_manager.current()
        portfolio = snapshot.accounts
        if portfolio is None:
            return  # single gate: no declared accounts -> no account series

        events = snapshot.events
        if not events:
            return

        timeline = EventAggregator().replay(events)

        # Injected price source: per-symbol daily closes, forward-filled. The
        # performance module never touches InfluxDB — it only calls price_at.
        symbols = {s['symbol'] for s in snapshot.shares if s.get('symbol')}
        price_pairs = {
            sym: sorted(self.influxdb.get_price_series(sym).items())
            for sym in symbols
        }

        def price_at(symbol, day):
            pairs = price_pairs.get(symbol)
            return timeline.state_at(pairs, day) if pairs else None

        start = min(e.date for e in events)
        today = datetime.now(timezone.utc).date()

        # Incremental write window (issue #597). Consume the backfill watermark
        # first so a backfill landing mid-cycle re-arms it for the next cycle. A
        # reloaded events cache (new list object) forces a full rewrite; else we
        # write from the earliest day backfill touched, defaulting to today only.
        pending = self._consume_perf_dirty_from()
        events_changed = events is not self._perf_last_events
        self._perf_last_events = events
        if events_changed:
            write_from = start
        elif pending is not None:
            write_from = max(start, min(pending, today))
        else:
            write_from = today

        per_account = {
            account.id: performance.compute_account(
                timeline, account, symbols, price_at, start, today)
            for account in portfolio.accounts
        }
        total = performance.compute_portfolio_total(
            timeline, portfolio.accounts, symbols, price_at, start, today, per_account)

        # --- account_metrics ------------------------------------------------
        # ``last`` (and thus xirr / gain_absolu) is decided over the FULL series
        # so it always lands on today's point; only points on/after write_from
        # are actually written. today >= write_from always, so the latest point
        # (Prometheus + negative-cash warning) is present every cycle.
        acc_points = []
        latest_by_account: Dict[str, AccountMetricPoint] = {}
        for account in portfolio.accounts:
            perf = per_account[account.id]
            for i, dp in enumerate(perf.daily):
                last = i == len(perf.daily) - 1
                if dp.date < write_from:
                    continue
                pt = AccountMetricPoint(
                    account=account.id,
                    account_type=account.type,
                    account_currency=account.currency,
                    timestamp=self._midnight(dp.date),
                    **self._value_kwargs(dp, last, perf),
                )
                acc_points.append(pt)
                if last:
                    latest_by_account[account.id] = pt
        # --- portfolio_totals (global, untagged; only if single currency) ---
        total_points = []
        if total is not None:
            total_points = [
                PortfolioTotalPoint(
                    timestamp=self._midnight(dp.date),
                    **self._value_kwargs(dp, i == len(total.daily) - 1, total),
                )
                for i, dp in enumerate(total.daily)
                if dp.date >= write_from
            ]

        # The watermark was consumed up front (for concurrency), so a failed
        # write would otherwise drop the stale tail silently. Re-arm it on any
        # write error so the next cycle retries the same slice; today's point is
        # rewritten every cycle anyway, so only a sub-today tail needs re-arming.
        try:
            if acc_points:
                self.influxdb.write_account_metrics(acc_points)
            if total_points:
                self.influxdb.write_portfolio_totals(total_points)
        except Exception:
            if write_from < today:
                self._mark_perf_dirty(write_from)
            raise

        # Permissive cash policy: a negative balance is allowed (it keeps a user
        # who adds accounts without rewriting their DEPOSIT history running), but
        # it is worth a non-blocking warning.
        for acc, p in latest_by_account.items():
            if p.cash_balance < 0:
                app_logger.warning(
                    f"Account '{acc}' has a negative cash balance "
                    f"({p.cash_balance:.2f}) — insufficient recorded cash")

        # Prometheus: expose the latest (today) value per account + global.
        if self.prometheus is not None:
            for acc, p in latest_by_account.items():
                try:
                    self.prometheus.update_account(p)
                except Exception as e:
                    app_logger.error(
                        f"Failed to update Prometheus account metrics for {acc}: {e}")
            if total is not None and total.daily:
                try:
                    self.prometheus.update_portfolio(total_points[-1])
                except Exception as e:
                    app_logger.error(f"Failed to update Prometheus portfolio totals: {e}")

    # ``reload()`` used to live here, assigning ``self.shares`` from a forced
    # load and thereby bypassing validation entirely — the one path that could
    # publish a rejected configuration outright. There is nothing left for it to
    # do: ``ConfigurationManager.reload(force=True)`` is the publisher, and this
    # class reads what it publishes.

    def run(self):
        """
        Run the full metrics collection process (ingest + scrape).
        Used for initial startup and backward compatibility.
        """
        self.ingest()
        self.scrape()

    def close(self):
        """Close connections."""
        if self.influxdb:
            self.influxdb.close()


# ---------------------------------------------------------------------------
# Boot — split across gunicorn's fork (issue #651)
# ---------------------------------------------------------------------------
#
# The web API lives in this process, so gunicorn is the container entrypoint and
# the ``__main__`` block that used to sit here is now three importable pieces:
#
#   build_runtime()     in the master, under ``preload_app``
#   start_runtime()     in ``post_fork``, in the single worker
#   shutdown_runtime()  in ``worker_exit``
#
# The line between the first two is not a matter of taste. ``preload_app`` runs
# the application factory *before any fork*, so a configuration error raised
# there ends the process once and cleanly — exactly what the five fatal branches
# always did. But only the calling thread survives ``fork()``, and an inherited
# connection pool would be shared with the master, so every thread, socket and
# client has to be built on the far side. ``gunicorn.conf.py`` wires the three.


class Runtime:
    """The application's long-lived objects, filled in on both sides of the fork.

    :func:`build_runtime` supplies the pure half — configuration manager,
    Prometheus registry, and the *path* the store was proved openable at — and
    :func:`start_runtime` then attaches the half that could not have survived a
    fork: the store connection, the InfluxDB client (inside
    ``SuiviBourseMetrics``), the scheduler and its threads, the watchdog
    observer.
    """

    def __init__(self, config_manager: ConfigurationManager,
                 prometheus: Optional[PrometheusExporter],
                 store_path: Optional[Path] = None):
        self.config_manager = config_manager
        self.prometheus = prometheus
        self.metrics: Optional['SuiviBourseMetrics'] = None
        self.scheduler: Optional[BackgroundScheduler] = None

        # The store (issue #696). The *path* crosses the fork; the connection
        # never does. ``build_runtime`` opens the file in the master — which is
        # what makes an unreadable store one named exit instead of a respawn
        # loop — and closes it again, because DuckDB's buffers are not something
        # two processes may inherit from one another. ``start_runtime`` opens
        # the connection the worker will actually use.
        self.store_path: Optional[Path] = store_path
        self.store: Optional[store.Store] = None

        # The scheduler's last-pass records (issue #668). Master-side on
        # purpose — a mutex and three references, and a ``threading.Lock``
        # crosses ``fork()`` unharmed, the master being single-threaded at that
        # instant — plus a reason of its own:
        # ``GET /api/runtime`` must answer *before* and *without* a working
        # scheduler, since explaining a screen that is not working is the entire
        # reason the resource exists (#656 déc. 6). A recorder that only came
        # into being in ``start_runtime`` would be absent exactly then.
        self.recorder = runtime_state.RuntimeRecorder()


def log_fatal(exc: BaseException) -> None:
    """Log a boot-fatal exception under the message its class earned.

    The branch list is the one ``__main__`` carried before gunicorn. *How* the
    process then dies differs by side of the fork and stays the caller's
    business: the master exits 1 before forking; ``post_fork`` re-raises, so
    gunicorn reports WORKER_BOOT_ERROR and halts the arbiter instead of
    respawning a worker that would fail identically.
    """
    if isinstance(exc, store.StoreUnavailable):
        # Named first because it is the earliest thing that can go wrong, and
        # because it must never read as "the portfolio is empty" (issue #696).
        app_logger.fatal(f'The store could not be opened : {exc}')
    elif isinstance(exc, (EventLoaderError, EventValidationError, AggregationError)):
        app_logger.fatal(f'An error occurred while loading events : {exc}')
    elif isinstance(exc, ValueError):
        app_logger.fatal(f'Configuration error: {exc}')
    else:
        app_logger.fatal(f'An unexpected error occurred: {exc}', exc_info=True)


def build_runtime() -> Runtime:
    """Master-side boot: the pure half, run under ``preload_app`` before any fork.

    Loading the configuration here is the whole point — it is the only remaining
    place where a broken config still exits the process once, cleanly, with the
    arbiter holding nothing to respawn.
    """
    app_logger.info('SuiviBourse is running !')

    # Name what is set and no longer obeyed, before anything reads anything
    # (issue #701, ADR-0014). The gesture ``config.yaml`` and ``settings.yaml``
    # already get: an install upgrading from v4 carries a whole .env of dials,
    # and a cadence that silently stops being honoured is exactly the kind of
    # change that reads as a regression six weeks later.
    report_unread_environment()

    # The store, first and before anything else (issue #696). It takes the exact
    # place #658 gave the Cerberus validation — same side of the fork, same
    # "nothing has been spawned yet, so a failure is one clean exit" — for a
    # different cause: the app has one store, everything downstream branches off
    # it, and a file it cannot open is not a degraded mode.
    #
    # Opened, brought to its schema, seeded, and closed again. The connection
    # the worker uses is opened in ``start_runtime``; leaving this one open
    # would hand the child a buffer manager its parent still holds, which is the
    # exact arrangement DuckDB refuses.
    store_path = store.store_path()
    opened = store.open_store(store_path)

    config_manager = ConfigurationManager(opened_store=opened)

    # Before anything is loaded, name what is *not* going to be (issue #711).
    # An install coming from a manual v4 has a config.yaml and no events, so
    # every page it opens is empty — and an empty page is indistinguishable
    # from a portfolio the update erased unless the app says which file it
    # stopped reading.
    config_manager.report_unread_files()

    # First publication, in the master. Reading, aggregating and validating all
    # happen here, which is what keeps a broken configuration a single clean
    # exit — the arbiter has not forked yet, so there is nothing to respawn. The
    # worker inherits the published snapshot through the fork and starts on it;
    # ``post_fork``'s ``ingest()`` is then a cache hit that only arms the jobs.
    #
    # Since #697 this is also the **first import**: the drop folder lands in the
    # store here, which keeps a file the ledger refuses a master-side event —
    # logged before anything has been forked — rather than a surprise in the
    # worker.
    try:
        config_manager.reload()
    finally:
        # The connection closes whichever way the load went, because it is the
        # file descriptor that must not cross ``fork()`` (issue #696) and a
        # failed load still exits through here. The worker opens its own in
        # ``start_runtime`` and attaches it.
        config_manager.attach_store(None)
        opened.close()

    # Registry and gauges only: pure Python, no fd, no thread. The exporter's own
    # ThreadingHTTPServer is gone, replaced by a /metrics mount on the Flask app,
    # so SB_PROMETHEUS_ENABLED now means "do not mount /metrics" rather than
    # "run no HTTP server".
    prometheus = PrometheusExporter() \
        if env_flag('SB_PROMETHEUS_ENABLED', True) else None

    return Runtime(config_manager, prometheus, store_path=store_path)


def start_runtime(runtime: Runtime) -> Runtime:
    """Worker-side boot (``post_fork``): everything a fork would have broken.

    The InfluxDB client (a connection pool the master must not share), the
    scheduler's threads, the watchdog observer, and the first ``ingest()`` —
    which is also what arms the per-symbol scrape jobs (issue #616), their
    immediate first fire being the bootstrap.
    """
    # The worker's own store connection (issue #696). The master proved the file
    # openable and closed it; this is the connection that lives for the process,
    # and it belongs on this side of the fork for the same reason the InfluxDB
    # pool does.
    if runtime.store_path is not None:
        runtime.store = store.open_store(runtime.store_path)
        # The ledger reads through this one from here on (issue #697). The
        # master's connection is closed; the published snapshot it built came
        # through the fork intact and stands until the first replay.
        runtime.config_manager.attach_store(runtime.store)

    # The dials, from the store and from nowhere else (issue #701, ADR-0014).
    # Read here rather than in the master because the master's connection is
    # closed by the time this runs — and read *once*, into the attributes every
    # cycle re-reads, so the scrape path never queries DuckDB from a scrape
    # thread. The write path assigns the same attributes, which is the whole of
    # "no dial requires a restart".
    dials = settings_registry.defaults() if runtime.store is None \
        else settings_module.read_all(runtime.store)
    backfill_interval = dials['backfill_interval']

    # Init SuiviBourseMetrics (connects to InfluxDB). The exporter comes from the
    # master so the gauges the Flask app already publishes are the ones the
    # scrape path updates; passing None when it is disabled leaves it disabled.
    sb_metrics = SuiviBourseMetrics(
        runtime.config_manager,
        prometheus_exporter=runtime.prometheus,
        recorder=runtime.recorder)
    sb_metrics.apply_dials(dials)
    runtime.metrics = sb_metrics

    # Watch the drop folder. Always, and with no dial (issue #697): dropping a
    # file is how a headless install imports, and there is nobody there to
    # click. The callback is the replay itself.
    runtime.config_manager.start_watcher(sb_metrics.ingest)
    # Size the executor pool, always automatically (issue #701, formula #619).
    # The fixed dial was deleted rather than moved into the store: the executor
    # is built once here and a ThreadPoolExecutor does not shrink hot, so it was
    # the one setting that would still have required recreating the container —
    # and it was a silent trap besides, a cohort of thirty symbols on a pool of
    # ten serialising its own scrapes with nothing anywhere to say so. Grouping
    # the held symbols into same-exchange cohorts costs a pre-scheduler exchange
    # fetch, bounded by its own deadline.
    pool_size = scheduling.compute_pool_size(
        sb_metrics.shares, sb_metrics.capture_exchange_of())
    # Wire the scheduler before bootstrapping so ingest() can arm the
    # per-symbol scrape jobs (issue #616). Their immediate first fire IS the
    # bootstrap — no separate initial scrape. Background, not Blocking: the
    # gunicorn worker owns the foreground now.
    scheduler = BackgroundScheduler(
        executors={'default': ThreadPoolExecutor(pool_size)})
    sb_metrics.scheduler = scheduler
    runtime.scheduler = scheduler
    # Bootstrap: load shares + arm one self-rescheduling scrape job per
    # symbol (each fires immediately, then re-arms on its market cadence).
    sb_metrics.ingest()
    # Register the three fixed-cadence interval jobs (ingestion, backfill,
    # perf recompute). Per-symbol scrape jobs are armed by ingest() above and
    # kept separate; the perf recompute is its own gated job (issue #618).
    register_interval_jobs(scheduler, sb_metrics, backfill_interval)
    scheduler.start()
    app_logger.info(
        f"Scheduler started: per-symbol scraping (REGULAR every "
        f"{sb_metrics.regular_interval}s), ingestion on write (watched drop "
        f"folder), backfill every {backfill_interval}s, perf checked every "
        f"{scheduling.PERF_TICK}s, executor pool: {pool_size} workers")
    return runtime


def replay_after_write(runtime: Runtime) -> None:
    """Replay the ledger right after a write changed it (issue #697).

    The named seam of *"the replay follows the write"*. Synchronous on purpose:
    the caller is an API handler that has just changed the ledger, and the user
    on the other end of it must not have to wait for a timer to see the effect
    of their own gesture — that 300-second wait is the thing #695's user story
    n°20 asks to be rid of.

    Goes through ``ingest()`` when there is a scheduler-side runtime, because
    the replay is not only the snapshot: the per-symbol scrape jobs have to be
    reconciled against the symbols the write added or removed. Before the fork
    — and in a test holding only a manager — there is nothing to reconcile, so
    the snapshot is republished directly.
    """
    if runtime.metrics is not None:
        runtime.metrics.ingest(import_files=False)
    else:
        runtime.config_manager.replay()


def shutdown_runtime(runtime: Runtime) -> None:
    """``worker_exit`` hook body — the heir of ``__main__``'s ``finally``.

    Gains an explicit ``scheduler.shutdown``: under ``BlockingScheduler`` the
    scheduler was dead by the time the ``finally`` ran, so there was nothing to
    stop. ``wait=False`` because the worker is already on its way out — a scrape
    in flight must not hold the shutdown open for a whole yfinance timeout.
    """
    if runtime.scheduler is not None and runtime.scheduler.running:
        runtime.scheduler.shutdown(wait=False)
    runtime.config_manager.stop_watcher()
    if runtime.metrics is not None:
        runtime.metrics.close()
    # The store last: it is the thing every job was writing into, so it closes
    # once nothing is left running to write.
    if runtime.store is not None:
        runtime.store.close()
        runtime.store = None
