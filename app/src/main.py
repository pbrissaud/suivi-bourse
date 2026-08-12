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
from typing import Any, List, Dict, Optional, Tuple

import pandas as pd
import yfinance as yf
from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.schedulers.background import BackgroundScheduler
from logfmt_logger import getLogger
from urllib3 import exceptions as u_exceptions
from yfinance.exceptions import YFRateLimitError

import accounts as accounts_module
import advisories
import boot_env
import carrying
import fx
import ledger
import perf_series
import performance
import positions
import quotes
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
from events.schemas import EventType, Portfolio
from prometheus_exporter import PrometheusExporter

# Blank counts as unset throughout (``boot_env.text``): compose renders an
# undefined substitution as an empty string rather than omitting the variable.
LOG_LEVEL = boot_env.text(os.environ, boot_env.LOG_LEVEL,
                          boot_env.DEFAULT_LOG_LEVEL)
app_logger = getLogger("suivi_bourse", level=LOG_LEVEL)
scheduler_logger = getLogger("apscheduler.scheduler", level=LOG_LEVEL)
yfinance_logger = getLogger("yfinance", level=LOG_LEVEL)

#: Every logger the app names, across all its modules. The list is explicit
#: rather than a walk of ``logging.root.manager``, so turning the app to DEBUG
#: cannot accidentally turn a dependency's own logger up with it.
MANAGED_LOGGERS = (
    'suivi_bourse', 'apscheduler.scheduler', 'yfinance', 'store',
    'quotes', 'perf_series', 'ledger', 'positions', 'prometheus_exporter',
    'advisories', 'web.api',
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
    """Read an env var from the process, treating blank as unset.

    The rule lives in :func:`boot_env.text`, which takes the mapping; these
    three are the process-wide spellings of it, for the handful of callers that
    have no mapping to hand (``gunicorn.conf.py``, chiefly, which runs before
    the application is imported).
    """
    return boot_env.text(os.environ, name)


def env_int(name: str, default: int) -> int:
    """Read an int env var, tolerating blanks and failing with a clear message."""
    return boot_env.integer(os.environ, name, default)


def env_flag(name: str, default: bool) -> bool:
    """Read a boolean env var, tolerating blanks."""
    return boot_env.flag(os.environ, name, default)


# --------------------------------------------------------------------- #
# The environment: what the process must know before it can open the store
# --------------------------------------------------------------------- #

#: Every environment variable **this application reads**, with its own default —
#: the list ``/api/config`` publishes. Six names, and there is no seventh: the
#: whole of the reasoning is in :mod:`boot_env`, which is also where the pure
#: reading of them lives (#740). The alias survives because the inventory is
#: what the API resource is written against.
ENVIRONMENT_INVENTORY = boot_env.INVENTORY


def unread_environment() -> List[str]:
    """The ``SB_*``/``INFLUXDB_*`` variables that are set and no longer read.

    **Computed, never hard-coded** — the difference between what is present and
    what :data:`ENVIRONMENT_INVENTORY` names, minus the four the app has never
    read. A written list of retired names is a third writer of the same
    inventory and the one nobody re-reads at release time; this one cannot
    drift, because the day a variable is added to the inventory it leaves this
    list by construction, and the day a dial is added to the registry it changes
    clause by construction.
    """
    return list(boot_env.unread(os.environ))


def report_unread_environment() -> List[str]:
    """Name what is set and not obeyed, in **one** grouped notice.

    One line per variable would put fourteen warnings in front of an operator
    upgrading from v4 and bury the sentence that matters, which is not *which*
    name was ignored but *where the setting went*. The sentence itself is
    :func:`boot_env.notice`, which is pure; what belongs here is the one thing
    that is not — emitting it, once, at start-up.
    """
    found = unread_environment()
    message = boot_env.notice(tuple(found))
    if message is not None:
        app_logger.warning(message)
    return found


def effective_environment() -> List[Dict]:
    """What this container was started with, read-only (#654 §6a → #656).

    Not a settings view any more (#701): the dials moved into the store and are
    served by :func:`settings.describe`, so what is left here is the half that
    genuinely cannot be answered from the store — the two directories, the
    sockets, the log level. None of it is writable from in here and none of it
    claims to be.

    **No entry is redacted, and there is no flag saying one could be** (#740).
    ``INFLUXDB_TOKEN`` was the environment's only secret and it left with the
    database (#700); "redact by name, never by value" (#654 trap 12) has had no
    subject since, and a rule kept warm for a credential that may never come
    back is a rule nobody exercises. What survives untouched is trap 2:
    ``source`` is **factual, not helpful** — reporting a variable as "unset,
    using the default" *because it equals the default* would be a guess.
    """
    return boot_env.effective(os.environ, log_level=current_log_level())


def advisory_context(config_manager, metrics=None) -> advisories.Context:
    """Gather what the advisories' predicates read (issue #709).

    The seam between :mod:`advisories`, which holds the text and the predicates,
    and the three places their sources actually live: the configuration directory
    on the manager, the environment inventory here, and the reconstruction's
    progress in the scheduler's own memory. **One builder**, so the observation a
    job makes and the one a request renders cannot come from two different
    readings of the same three sources.

    A caller with no ``metrics`` — the gunicorn master, a web request on a
    runtime that has not started its scheduler — reports the reconstruction as
    **unobservable** rather than as finished. That distinction is the whole of
    :data:`advisories.UNOBSERVED`: without it, a page being opened would drop the
    row a running scheduler armed.
    """
    return advisories.Context(
        config_dir=config_manager.config_dir,
        unread_variables=tuple(unread_environment()),
        reconstruction=(None if metrics is None
                        else metrics.reconstruction_state()),
    )


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
    ``scheduling.PERF_TICK``, a constant, because the two tables it writes are a
    cache and a full recompute costs 0,4 % of the tick (ADR-0011).

    The perf job carries ``next_run_time=now`` (issue #707), which is the
    interval trigger's *only* way to fire at boot rather than one tick later:
    APScheduler schedules an interval job at ``start + interval``, so without it
    a restart would leave the pages showing the previous process's cache — or
    nothing at all on a first boot — for two minutes. A self-repairing cache has
    nothing to know about the past, so there is nothing to wait for.
    """
    scheduler.add_job(
        sb_metrics.backfill, 'interval',
        seconds=backfill_interval,
        id='backfill',
        name='Historical backfill')
    scheduler.add_job(
        sb_metrics.recompute_perf, 'interval',
        seconds=scheduling.PERF_TICK,
        next_run_time=datetime.now(timezone.utc),
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


#: What starts a holding window (issue #703). A ``GRANT`` is an acquisition: the
#: share is held from the day it lands, priced or not (``events.schemas.
#: declared_value`` decides the second question and not this one). Reading only
#: ``BUY`` left a portfolio held entirely by grant with no backfill target at
#: all, which is the state the retired ``no_buy`` terminal was reporting.
ACQUISITION_EVENT_TYPES = (EventType.BUY, EventType.GRANT)


def holding_windows(events, held) -> Dict[str, Tuple[date, Optional[date]]]:
    """``{symbol: (first acquisition, last exit or None)}`` out of a raw ledger.

    Pure, and module-level rather than a method, because it has **two** callers
    since #706 and they hold two different things.
    :meth:`ConfigSnapshot.backfill_windows` reads the published snapshot; the
    perf recompute reads the store directly (its only inputs are the store and
    the clock, #707) and derives ``held`` from its own replay. Both have to reach
    the same window, since one drives the backfill and the other asks whether
    that backfill is finished — and a second spelling of *"when did this position
    start"* would put them a day apart, which is one chunk of disagreement about
    whether a symbol is terminal.
    """
    first: Dict[str, date] = {}
    exits: Dict[str, date] = {}
    for event in events:
        if not event.symbol:
            continue
        if event.event_type in ACQUISITION_EVENT_TYPES:
            known = first.get(event.symbol)
            if known is None or event.date < known:
                first[event.symbol] = event.date
        elif event.event_type == EventType.SELL:
            known = exits.get(event.symbol)
            if known is None or event.date > known:
                exits[event.symbol] = event.date

    return {
        symbol: (acquired, None if symbol in held else exits.get(symbol))
        for symbol, acquired in first.items()
    }


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

    def backfill_windows(self) -> Dict[str, Tuple[date, Optional[date]]]:
        """``{symbol: (first acquisition, last exit or None)}`` — the backfill's pilot.

        **The backfill is driven by the replay, not by what is held today**
        (issue #703, ADR-0009). The set is the union over the *whole* timeline
        and each symbol carries its own holding window, which is the first place
        the scrape and the backfill stop having the same symbols: *what do we
        poll live* and *whose history do we need* are two different questions the
        moment a position can close. Iterating current positions leaves a share
        bought in 2020 and sold in 2022 with no reconstructed price at all — so
        the account's ``xirr`` and ``twr_index`` are wrong **permanently**, not
        for the duration of the reconstruction. v4 hid it because the live series
        accumulated while the share was held; it is fatal the moment history is
        rebuilt from nothing.

        A ``None`` end means *still held*, and therefore *today* — the caller
        turns it into an instant, because a snapshot reads no clock.

        The start is the first **acquisition**, ``BUY`` *and* ``GRANT``: a granted
        share is held from the day it was granted, and a portfolio held entirely
        by grant used to reach the backfill with no target at all.

        A symbol the ledger names without ever acquiring it (a stray
        ``DIVIDEND``) is simply **not in the set**: it has no holding window, so
        there is nothing to reconstruct and no state to report about it. That is
        what retires the old ``no_buy`` terminal rather than renaming it.

        A pure read of this snapshot, so a concurrent reload can never empty it
        mid-cycle.
        """
        # Held **anywhere**: one account selling out does not end the window of a
        # share another account still holds, and the series they share is one.
        held = {share['symbol'] for share in self.shares
                if share.get('symbol') and share.get('quantity')}
        return holding_windows(self.events, held)

    def first_acquisition_date(self, symbol: str) -> Optional[date]:
        """Date of the earliest ``BUY`` **or ``GRANT``** for ``symbol``, or ``None``.

        The backward pass's target, read off :meth:`backfill_windows` rather than
        recomputed beside it: two spellings of *"when did this position start"*
        would eventually disagree by a day, and the symptom is a reconstruction
        that stops one chunk short and reads as a stall.
        """
        window = self.backfill_windows().get(symbol)
        return window[0] if window is not None else None


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

    def __init__(self, config_dir: Optional[str] = None, opened_store=None,
                 import_dir: Optional[str] = None):
        """
        Initialize the configuration manager.

        Args:
            config_dir: Override configuration directory (for testing).
            opened_store: The open :class:`store.Store` the ledger lives in
                (issue #697). Production always passes one — ``build_runtime``
                on the master's side of the fork, ``start_runtime`` on the
                worker's, via :meth:`attach_store`. When it is omitted, one is
                opened lazily under ``config_dir``.
            import_dir: The drop folder. Production passes what
                ``SB_IMPORT_DIR`` resolved to (issue #740); this manager reads
                no environment of its own, which is what keeps *one* place in
                the process reading ``os.environ``. Omitted, it falls back to
                ``config_dir/events`` — v4's shape, and what every test uses.
        """
        if config_dir:
            self.config_dir = Path(config_dir).expanduser()
        else:
            self.config_dir = Path('~/.config/SuiviBourse').expanduser()

        # Named, never read (issue #698). The attribute survives so the startup
        # observation has a path to name and the tests have one to write to.
        self.settings_path = self.config_dir / self.LEGACY_SETTINGS_FILE
        self._events_source: Optional[str] = str(
            import_dir if import_dir else self.config_dir / 'events')
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

    @property
    def store(self):
        """The store this process reads through — the lock-free accessor.

        A **read** path. Its writer sibling is :meth:`writing`, which is the
        mutex, and the two are named apart on purpose: the scheduled jobs read
        the price series far more often than they write it, and taking the
        writers' mutex to answer *"what is the oldest stored point"* would
        serialise a backfill's arithmetic against an ingestion for no reason.
        What makes an individual statement safe under threads is the store's own
        per-statement lock (:class:`store.Store`); what makes a *transaction*
        safe is :meth:`writing`.
        """
        return self._require_store()

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

        It is **not** the file the boot opens, and since #740 it cannot be: the
        store's directory is ``SB_IMPORT_DIR``'s sibling ``SB_STORE_DIR``,
        defaulting to ``/data``, while ``config_dir`` stays
        ``~/.config/SuiviBourse``. No production path reaches this fallback —
        ``build_runtime`` and ``start_runtime`` both hand over an already-open
        store — so it exists for the caller that has only a directory: a test,
        a one-shot script. Anything that must read *the app's* ledger passes
        the store in.
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

        ``SB_IMPORT_DIR``, resolved once at boot and handed in (issue #740), or
        the configuration directory's ``events/`` folder when nothing named one.
        No file decides it: ``events.source`` was the last thing
        ``settings.yaml`` was read for, and a v5 that read it would let a v4
        file decide where the product looks (issue #698). The container names
        the mount instead (ADR-0015).
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

    def get_first_acquisition_date(self, symbol: str) -> Optional[date]:
        """Date of the first ``BUY`` **or ``GRANT``** for a symbol (issue #703).

        From the published snapshot; ``None`` before anything is published.
        """
        snap = self._config
        return snap.first_acquisition_date(symbol) if snap is not None else None

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
                 prometheus_exporter: Optional[PrometheusExporter] = None,
                 recorder: Optional[runtime_state.RuntimeRecorder] = None):
        self.config_manager = config_manager

        # The store, reached through the manager and never held as a second
        # reference (issue #700). It is what the ``InfluxDBWriter`` argument used
        # to be, minus the injection point: there is one store per process, the
        # manager already owns the connection *and* the mutex that keeps a
        # transaction whole, and a second handle here would be a second answer to
        # "which generation of the ledger is this job looking at".

        # Prometheus exporter (legacy /metrics endpoint, on by default for
        # backward compatibility). The HTTP server is started separately.
        self.prometheus = prometheus_exporter
        if self.prometheus is None and env_flag(
                boot_env.PROMETHEUS_ENABLED,
                boot_env.DEFAULT_PROMETHEUS_ENABLED):
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
        #   base_currency — the reporting currency (issue #702, ADR-0002). The
        #     one dial with **no default**, so this attribute is legitimately
        #     ``None`` and every write path reads it as *"nothing has a unit
        #     yet"*: prices are still fetched and stored natively, nothing is
        #     converted, and no performance figure is written at all.
        #
        # Assigned by one loop and not by five literals, deliberately: a default
        # spelled here as well as in the registry is the second list ADR-0014
        # exists to forbid, and it would be the copy nobody updates.
        self.base_currency: Optional[str] = None
        self.apply_dials(settings_registry.defaults())

        # The exchange rate (issue #702, ADR-0002). A TTL cache in front of two
        # yfinance fetches, and the TTL is what makes a market-open wave share
        # **one** rate per pair: converted at N slightly different rates, the
        # positions of one wave would not add up to their own total. It is
        # deliberately not a job and not a pseudo-symbol in the scheduler — a
        # currency pair has no ``marketState`` that projects onto the equity
        # cadence model — and there is no ``fx_rates`` table: the rate that was
        # used is stored on the point it produced.
        self.rates = fx.Rates(self._fetch_fx_rate, self._fetch_fx_series)

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

        # Symbols whose backward pass has reached their first acquisition, mapped
        # to that date so an earlier newly-added event re-opens the pass. A
        # process-lifetime shortcut, not the watermark: what survives a restart is
        # ``symbol_quote.oldest_window_tried`` (issue #703).
        self._backfill_complete: Dict[str, datetime] = {}

        # There is **no perf state here**, and its absence is the ticket (issue
        # #707, ADR-0011). Four attributes stood at this line — a mutex, a
        # backfill watermark, the identity of the last events list, and a
        # live-write bool the scrape raised — and all four served one gate that
        # decided whether recomputing was worth it. The two tables are a cache;
        # the recompute is integral and unconditional every cycle, so nothing
        # about the *past* is worth remembering, and the last coupling between
        # the backfill and the perf goes with the memory of it.

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
                # market hours, defeating the missed-session gap-fill (#627).
                # Mirror the per-row NaN skip _fetch_historical_data does.
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
                    # bars come back as NaN) so no NaN price reaches the store.
                    close = row['Close']
                    if pd.isna(close):
                        continue
                    # idx is a pandas Timestamp
                    ts = idx.to_pydatetime()
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    # The close, and only the close (issue #700). OHLC and
                    # volume are not dropped for economy: the *live* writer set
                    # open = high = low = close on every point it ever wrote, so
                    # the four columns disagreed about what they meant depending
                    # on which pass had filled them, and a candlestick drawn from
                    # them showed a flat doji through every session the app was
                    # up for. A column that lies is worse than one that is
                    # missing.
                    prices.append({'timestamp': ts, 'price': float(close)})

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

    # ------------------------------------------------------------------ #
    # The exchange rate (issue #702, ADR-0002)
    # ------------------------------------------------------------------ #

    def _fetch_fx_rate(self, pair: str) -> Optional[float]:
        """The newest close of one currency pair, or ``None``.

        The live half of what :attr:`rates` caches. Deliberately **not**
        ``_fetch_ticker_data``: that one fills ``_share_info_cache``, which the
        backfill reads to learn a *symbol's* exchange, and a currency pair
        landing in it would put an instrument that is not a holding into the
        portfolio's own memory. What is wanted here is one number.

        Errors are swallowed into ``None`` on purpose — an unresolvable pair is
        an ordinary state (spec #695 § 7), it writes a ``NULL`` converted price
        and never a lost quote.
        """
        try:
            history = yf.Ticker(pair).history()
        except Exception as e:
            app_logger.warning(f"Could not fetch the {pair} rate: {e}")
            return None
        if history is None or history.empty or 'Close' not in history.columns:
            return None
        closes = history['Close'].dropna()
        return float(closes.iloc[-1]) if not closes.empty else None

    def _fetch_fx_series(self, pair: str, start: date,
                         end: date) -> Dict[date, float]:
        """The pair's **daily** closes over ``[start, end]``.

        The rebuild's half: the pair's history is fetched beside the price
        history it is converting, so a point placed five years ago is converted
        at the rate of *its own day* rather than at today's — which is what makes
        the stored rate a journal one can read back.

        Daily whatever the window's age, unlike the price fetch: an hourly rate
        would be a hundredfold more rows for a series whose consumer is a
        calendar day, and Yahoo caps hourly at 730 days anyway.
        """
        try:
            history = yf.Ticker(pair).history(
                start=start, end=end, interval='1d')
        except Exception as e:
            app_logger.warning(
                f"Could not fetch the {pair} history over [{start}, {end}]: {e}")
            return {}
        if history is None or history.empty:
            return {}

        series: Dict[date, float] = {}
        for index, row in history.iterrows():
            close = row['Close']
            if pd.isna(close):
                continue
            moment = index.to_pydatetime()
            day = moment.date() if moment.tzinfo is None else moment.astimezone(
                timezone.utc).date()
            # The **last** close of a day wins, the survivor rule the rest of
            # the store follows.
            series[day] = float(close)
        return series

    def _convert(self, price, currency: Optional[str],
                 at: Optional[date] = None) -> Tuple[Optional[float], Optional[float]]:
        """``(converted, rate)`` for one observed price, in one call.

        The single place a write path asks the currency question, so that no
        writer has to remember the order of *"is there a reporting currency"*
        and *"is there a rate"*. Both answers are ``None`` together, and the
        caller writes the point anyway.
        """
        return fx.convert(price, currency, self.base_currency, self.rates, at)

    def _update_share_prometheus(self, share, last_quote, info,
                                 converted=None, fx_rate=None) -> None:
        """Update one share's **market** gauges from a fetched quote.

        Kept independent of the store write so ``/metrics`` stays populated
        even if the store errors, and gated by the caller on **fetch success**
        (price present) rather than the write/REGULAR gate — a closed-market
        restart must still leave the share gauges populated (design #609).

        The position half left with #699: it is fed by the replay
        (:meth:`_publish_position_gauges`), because a sold position's figures
        change at the very instant its scrape stops.

        ``converted`` / ``fx_rate`` ride through untouched (issue #702): the
        exporter publishes the native price always and the converted one only
        when there is one, because *never a gauge whose unit depends on a
        setting*.
        """
        if self.prometheus is None:
            return
        try:
            self.prometheus.update_quote(share, last_quote, info,
                                         converted, fx_rate)
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

    @staticmethod
    def _quote_attributes(info: Dict) -> Dict:
        """The ``symbol_quote`` columns a fetched ``info`` supplies.

        The fundamentals are stored in **current value only** (spec #695 § 3):
        yfinance gives them on the live quote alone, so v4's attempt at a history
        of them was a comb of ``NULL`` down the price series that nothing ever
        read as one.
        """
        yield_pct = info.get('dividendYield')
        return {
            'currency': info.get('currency'),
            'exchange': info.get('exchange'),
            'quote_type': info.get('quoteType'),
            'dividend_yield': yield_pct * 100 if yield_pct is not None else None,
            'pe_ratio': info.get('peRatio'),
            'market_cap': info.get('marketCap'),
        }

    def _write_quote(self, symbol: str, last_quote, info, now: datetime,
                     converted=None, fx_rate=None) -> bool:
        """Persist one live observation: ``symbol_quote`` + one ``price_point``.

        **One call per symbol**, not one per holding (issue #700). The account
        dimension left the price series with this ticket — a market price
        belongs to no account — so a symbol held in three accounts is one row,
        not three identical ones.

        Guarded so a transient store error on one symbol does not abort the
        surrounding cycle, and returns whether the point actually landed, so a
        caller can tell a real write from a swallowed failure — the last-pass
        ``ScrapeRecord`` publishes it as ``wrote``, and a swallowed failure is
        what its ``error`` names (issue #668).

        The conversion arrives from the caller rather than being worked out here
        (issue #702), so the rate stored beside the price is provably the one
        the price was multiplied by — and so the same pair of numbers reaches
        ``/metrics`` and the store without being computed twice at two instants.
        Both ``None`` writes the point with a ``NULL`` converted price, which is
        the ordinary state while the reporting currency is unanswered.

        Takes the writers' mutex: the write is a transaction on the one DuckDB
        connection this process owns, and an ingestion running between its
        ``BEGIN`` and its ``ROLLBACK`` in another thread would take this point
        into its own rollback.
        """
        try:
            with self.config_manager.writing() as opened:
                quotes.record_quote(opened, symbol, now, last_quote,
                                    self._quote_attributes(info),
                                    converted, fx_rate)
            return True
        except Exception as e:
            app_logger.error(f"Failed to write the quote for {symbol}: {e}")
            return False

    def expose_metrics(self):
        """
        Fetch and store every held symbol's quote, once.

        Synchronous whole-portfolio scrape, kept as a driver for the end-to-end
        harness; the scheduled runtime drives per-symbol jobs via
        ``_scrape_symbol``.

        Scoped to the **held** positions, like the scheduled path (issue #699):
        a position at zero quantity is one the app has stopped following, and
        this driver would otherwise be the one place a sold line still reached
        Yahoo.
        """
        # One snapshot for the whole pass, like every other job (issue #658):
        # the symbol set and the holdings it publishes gauges for have to come
        # from the same generation. The *instant*, on the other hand, is taken
        # per symbol: a pass over forty tickers takes minutes, and one ``now``
        # for all of them would stamp the last ones at a moment they were not
        # observed at — on the table whose whole subject is when a price was
        # seen.
        shares = self.shares
        held = sorted({share['symbol'] for share in shares
                       if share.get('symbol') and share.get('quantity')})
        for symbol in held:
            last_quote, info = self._fetch_ticker_data(symbol)
            converted, rate = self._convert(
                last_quote, (info or {}).get('currency'))

            # The Prometheus quote gauges stay per holding: a series identity
            # there carries the account, and it is what tells two positions in
            # the same share apart on a headless dashboard.
            for share in shares:
                if share.get('symbol') == symbol and share.get('quantity'):
                    self._update_share_prometheus(
                        share, last_quote, info, converted, rate)

            if last_quote is None or info is None:
                app_logger.warning(
                    f"No data fetched for {symbol}, skipping the quote write")
            else:
                self._write_quote(symbol, last_quote, info,
                                  datetime.now(timezone.utc), converted, rate)

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
        dial must not reset the other four), and so is a ``None`` value. The
        only dial that can be ``None`` is the unanswered reporting currency, and
        skipping it is what it needs rather than a gap: the attribute starts at
        ``None``, the boot's read of an unanswered store hands back ``None``, and
        the first ``PUT`` that answers hands back a code — so the write path
        moves it exactly once, in the one direction it can move.
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
                # Same cleanup, one storey up (issue #668) — but the **scrape**
                # record only since #703. Leaving this job is no longer leaving
                # the ledger: the backward pass goes on reconstructing the
                # history of a line the owner has sold, and taking its records
                # away here would blank the progress of a pass still running,
                # permanently. What drops a backfill record is the symbol
                # leaving the ledger, and that is `recorder.retain` in `ingest`.
                self.recorder.forget_scrape(symbol)
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

    def _check_price_freshness(self, symbol: str, holdings: List[dict],
                               live_price, now: datetime) -> bool:
        """Price-freshness liveness sonde (issue #628, design #626).

        Runs only on the ``REGULAR`` write path (the caller's ``should_write``
        gate): read the newest stored price and advance the pure
        ``scheduling.price_freshness_step`` against this symbol's remembered
        state. When the stored price has stayed frozen across consecutive
        ``REGULAR`` cycles for at least ``staleness_horizon`` while the live
        quote has moved, the writer is silently stale — emit a WARNING and raise
        the ``sb_price_staleness`` gauge (cleared to 0 otherwise so it
        auto-recovers). Measuring over consecutive polling (not the stored
        point's raw age) is what keeps the first tick after an overnight/weekend
        close — legitimately hours old — from firing a false positive.

        **Per symbol since #700**, where it was per ``(symbol, account)``: the
        series it watches has no account dimension left, so the same value would
        have been compared against the same memory once per holding.

        **It reads ``price_native``**, and that is a rule rather than an
        implementation detail (spec #695 § 7). The question is whether the
        *writer* has gone silently stale; a converted price moves whenever the
        exchange rate does, so watching one would let a currency tick pass for a
        price that is still being refreshed — the sonde would answer "fresh"
        about a symbol frozen since Tuesday.

        **Diagnostic only** — never changes scrape cadence, write gating, or the
        #617 dead-ticker backoff. Fully guarded: a read or metric error here must
        never disturb the surrounding scrape cycle. Called *before* this cycle's
        write so it reads the coverage as it stood, not the point the write is
        about to refresh.

        Returns whether it flagged the symbol, so the caller can carry it into
        the scrape record (issue #668). The signal was already computed here, by
        the one thread that holds this series' sonde memory — a reader
        recomputing it would need that memory *and* a fresh price, at a second
        instant, which is the composed read #656 déc. 4 exists to forbid.
        """
        if self.staleness_horizon <= 0:
            return False
        stale = False
        try:
            stored_price = quotes.last_price(self.config_manager.store, symbol)
            with self._sonde_lock:
                new_state, stale = scheduling.price_freshness_step(
                    self._sonde_state.get(symbol), live_price, stored_price,
                    now, self.staleness_horizon)
                if new_state is None:
                    self._sonde_state.pop(symbol, None)
                else:
                    self._sonde_state[symbol] = new_state

            if stale:
                app_logger.warning(
                    f"Price-freshness sonde: the stored price for {symbol} is "
                    f"frozen at {stored_price} across REGULAR polling while the "
                    f"live quote is {live_price} — the writer may be silently "
                    f"stale")
            if self.prometheus is not None:
                # The gauge keeps its per-holding identity: it is labelled by
                # account like every other share gauge, so a headless dashboard
                # can join it to the position gauges beside it.
                for share in holdings:
                    self.prometheus.update_price_staleness(share, stale)
        except Exception as e:
            app_logger.debug(f"Price-freshness sonde failed for {symbol}: {e}")
        return stale

    @staticmethod
    def _scrape_verdict(should_write: bool, state, wrote: bool,
                        has_holdings: bool) -> str:
        """Name what one scrape pass did, at the instant it did it (issue #668).

        Four values, and the fourth is the one worth having.
        ``scheduling.decide`` resets the #617 counter whenever a price was
        present, so a store that refuses the write leaves a symbol polling
        happily at ``base_interval`` with its counter at zero and **nothing
        persisted** — the dead-ticker guard watches yfinance, by design, and
        cannot see this. ``SCRAPE_WRITE_FAILED`` is where that shows up.

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
        (closed → sleep to next open, else ``base_interval``). Writes **one**
        point — a market observation belongs to no account (issue #700) — and
        re-arms only while the symbol is still held (the in-flight half of the
        self-reschedule↔removal race guard).
        """
        injected_now = now is not None
        now = now or datetime.now(timezone.utc)
        last_quote, info = self._fetch_ticker_data(symbol)
        price_present = last_quote is not None and info is not None

        # The conversion, computed **once** for this pass (issue #702) and used
        # by both the gauges and the write: two calls would be two rates for one
        # observation the moment a TTL expired between them, and the row would
        # then say a price was produced by a rate it was not.
        converted, rate = self._convert(last_quote, (info or {}).get('currency'))

        # The holdings this symbol has, which since #700 decide **whether** to
        # write and no longer **how many times**: the price series carries no
        # account, so a symbol held in three accounts is one point. What the
        # list is still needed for is the Prometheus gauges, whose series
        # identity does carry the account, and the "is anyone still holding
        # this" question the write gate asks (issue #699).
        holdings = [s for s in self.shares
                    if s.get('symbol') == symbol and s.get('quantity')]

        # Prometheus sb_share_* gauges stay on the fetch-success gate (#609),
        # never the write/REGULAR gate.
        if price_present:
            for share in holdings:
                self._update_share_prometheus(
                    share, last_quote, info, converted, rate)

        if info is not None:
            state, next_open = scheduling.extract_market_context(
                info, info.get('_history_meta'), now)
        else:
            # Fetch failed outright: no state to read, fail-open as REGULAR so a
            # transient failure keeps the job polling rather than sleeping it.
            state, next_open = None, None

        with self._failure_counts_lock:
            should_write, next_delay, new_failure_count = scheduling.decide(
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

        stale = False
        if should_write:
            # Price-freshness liveness sonde (issue #628): read the stored price
            # *before* this cycle's write refreshes it, so a silently stale writer
            # is caught. Purely diagnostic — never gates the write below.
            stale = self._check_price_freshness(symbol, holdings, last_quote, now)

            # One write, and only while something is held: a symbol whose last
            # holding was sold between this cycle's fetch and here has nothing
            # to record, and nothing wrong with it either.
            wrote_live_data = bool(holdings) and self._write_quote(
                symbol, last_quote, info, now, converted, rate)
            # Nothing is signalled to the perf job from here any more (issue
            # #707). A REGULAR write used to raise a global live-write bool the
            # gate read; the recompute is unconditional now, so the price this
            # cycle wrote is simply read by the next one out of the store.
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
            wrote=wrote_live_data,
            stale=stale,
            error=(
                f"No point persisted for {symbol}: the store refused the write"
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
        """Rebuild the perf cache, in full, every cycle (issue #707, ADR-0011).

        Its **own** interval job, and it stays one. Three other shapes were
        available and each is wrong for a reason worth keeping written down: an
        end-of-backfill step is right only while the reconstruction runs and
        false the moment it finishes, since the live scrape goes on moving
        today's value with the backfill triggering nothing; a subscription to an
        event bus rebuilds the coupling this ticket removes, one indirection
        further away; and a step of the scrape fires N recomputes per
        market-open wave.

        There is **no gate**. The recompute reads the store and the clock, and
        that is all it reads — no watermark, no flag, no snapshot identity. A
        cycle either lays the cache down or raises; there is no third outcome,
        which is why ``PERF_SKIPPED`` left with the predicate.

        Guarded so an error never kills the scheduler thread.
        """
        horizons: Dict[str, Optional[date]] = {}
        try:
            horizons = self.update_account_metrics()
            verdict, error = runtime_state.PERF_RAN, None
        except Exception as e:
            app_logger.error(f"Failed to update account metrics: {e}")
            verdict, error = runtime_state.PERF_FAILED, str(e)
        # Recorded rather than inferred, same as every other job's last pass. The
        # horizons ride along (issue #708) rather than being a record of their
        # own: they are *what this pass wrote from*, so a reader taking them from
        # one pass and the verdict from another would be reading a cache that no
        # longer exists. A failed pass publishes none, which is the honest state —
        # the previous cycle's cache still stands but this cycle established
        # nothing.
        self.recorder.record_perf(runtime_state.PerfRecord(
            at=datetime.now(timezone.utc), verdict=verdict, error=error,
            horizons=horizons))

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
            if import_files:
                self._adopt_declared_currency()
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
            # The last-pass records of a symbol the ledger no longer names at
            # all — a forgotten import (issue #703). The parallel of
            # ``retain_positions`` just above, and the *only* thing that drops a
            # backfill record: leaving the held set is not leaving the ledger,
            # and a sold position's backward pass is still running.
            self.recorder.retain({share['symbol'] for share in after
                                  if share.get('symbol')})
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

        # Re-observe the advisories (issue #709). Here because this is the
        # gesture that runs at the boot, on a file landing and after a write —
        # the three moments the *installation's* advisories can change — and
        # because it is the only one that runs on an install holding nothing at
        # all, where the backfill returns before doing anything.
        self.review_advisories()

    # ------------------------------------------------------------------ #
    # The advisories (issue #709)
    # ------------------------------------------------------------------ #

    def reconstruction_state(self) -> Tuple[int, int]:
        """``(series complete, series in the reconstruction)`` — process memory.

        The source of the one advisory that is neither a file nor an environment
        variable, and it is memory rather than a query for the same reason
        ``/api/runtime`` reads none: ``_backfill_complete`` is where "this pass
        has reached its first acquisition" lives, and no row anywhere says it —
        a symbol Yahoo answers nothing about has a completed pass and an empty
        series.

        **This method never answers ``None``**, and that is the whole of it:
        across the seam ``None`` means :data:`advisories.UNOBSERVED` — *this
        process cannot see the scheduler* — and it is :func:`advisory_context`
        alone that says it, for a caller holding no ``metrics`` at all. Nothing
        ever held is ``(0, 0)``: an observation, made from here, saying there is
        no reconstruction to run. A fresh install still announces no reprise
        d'historique — ``_observe_reconstruction`` stands the advisory down on
        ``total <= 0`` exactly as it does on a finished one — but it *stands it
        down* instead of leaving it untouched, which is what the criterion
        demands: forgetting every import while the reconstruction was armed used
        to leave its row standing for ever, on a portfolio that no longer names
        a single symbol.
        """
        windows = self.config_manager.current().backfill_windows()
        now = datetime.now(timezone.utc)
        targets = {
            symbol: carrying.holding_bounds(window[0], window[1], now)[0]
            for symbol, window in windows.items()}
        complete = sum(1 for symbol, target in targets.items()
                       if self._backfill_complete.get(symbol) == target)
        return complete, len(windows)

    def review_advisories(self) -> None:
        """Re-observe every advisory, and record the one that is an event.

        The whole call-site pattern of the feature: the observation is made where
        the sources are — the ingest and the backfill cycle — and **never on a
        ``GET``**, an advisory dated by the moment somebody happened to open a
        page saying nothing about when the thing it names started.

        Both callers see all four sources, this object being where the
        reconstruction's memory lives, so neither of them can drop a row the
        other armed. What cannot see it is a runtime with no scheduler — the
        gunicorn master, a web request — and :func:`advisory_context` answers
        *unobservable* for those rather than *finished*.

        Guarded: a store that refuses this must not take a scheduled job with it.
        A missed review costs one cycle, and the next one re-observes everything
        from scratch, there being no state to catch up on.
        """
        try:
            context = advisory_context(self.config_manager, self)
            with self.config_manager.writing() as opened:
                # Order matters, and only in one direction: the reconstruction
                # concluding is what *produces* the assumed-currency advisory, so
                # it is recorded before the refresh that stands its sibling down.
                if context.reconstruction_concluded:
                    advisories.record(
                        opened, advisories.ASSUMED_BASE_CURRENCY, context)
                advisories.refresh(opened, context)
        except Exception as e:
            app_logger.error(f"Failed to review the advisories: {e}")

    def _adopt_declared_currency(self) -> None:
        """Take up a reporting currency an import has just declared (issue #710).

        A dial reaches this process from exactly two places: the boot reads them
        all once into the attributes every cycle re-reads (``start_runtime``),
        and ``PUT /api/settings`` assigns the same attributes after writing the
        row. That pair is the whole of *"no dial requires a restart"*.

        An **import** is the third writer of one of them, and of one only: an
        exported file states its reporting currency, and a store that has none
        takes it (``ledger._currency_to_adopt``, ADR-0021). Without this line the
        row would be in the store and the running process would go on converting
        nothing until the next restart — and that is the one dial where the
        symptom is invisible, since a missing currency writes ``NULL``
        conversions rather than failing anything.

        Read after the reload and not before it: the value this looks for is
        written *by* the import the reload performs.
        """
        stored = self.config_manager.store.setting('base_currency')
        if stored and stored != self.base_currency:
            app_logger.info(
                f"Reporting currency taken from an imported file: {stored}")
            self.base_currency = stored

    def backfill(self):
        """
        Backfill historical price data, one series per **symbol**, in both
        directions. This runs as its own scheduled job, progressively filling
        gaps.

        For each symbol, delegates to ``_backfill_symbol`` which runs two
        independent passes (issue #626):
          * Backward: extend the series toward the first **acquisition**, one
            ``backfill_chunk_days`` chunk per cycle, until ``_backfill_complete``
            is set.
          * Forward: recover a session missed while the app was down by fetching
            ``[newest, now]`` (issue #627) — independent of the backward
            watermark.
        Fetches one chunk (default: 1 year) of history per direction and rate
        limits between requests.

        **Per symbol and no longer per position** (issue #700). The unit was the
        ``(account, symbol)`` pair because the *series* was, and a price series
        with no account dimension left would have made a share held in three
        accounts fetch the same window from Yahoo three times a cycle — three
        times the rate-limit exposure, on the job that already emits more
        requests than anything else in the app.

        **Driven by the replay and not by current holdings** (issue #703,
        ADR-0009). The symbol set is the union over the whole timeline and each
        symbol carries its own holding window — see
        :meth:`ConfigSnapshot.backfill_windows`. This is where the backfill and
        the scrape stop having the same symbols: the scrape keeps its own set,
        filtered on ``quantity``.

        **The rhythm does not change and there is no accelerated mode.**
        ``backfill_delay`` is a courtesy to Yahoo at the exact moment the app
        emits more requests than at any other time of its life, and a code path
        that runs once per installation is a code path nobody ever tests. One
        chunk per symbol per cycle: ~25 minutes for 30 symbols over 5 years.
        """
        # One snapshot for the whole cycle (issue #658). Shares, events and
        # accounts have to come from the same generation: reading them one call
        # at a time let a mid-cycle reload pair this cycle's shares with the
        # next cycle's events, and — through the old invalidate-then-load pair —
        # with no events at all, which quietly neutralised the backward pass.
        snapshot = self.config_manager.current()
        windows = snapshot.backfill_windows()
        if not windows:
            app_logger.debug("Nothing was ever held, skipping backfill")
            return

        app_logger.info("Starting backfill cycle")
        backfilled_count = 0

        # Held **off this cycle's snapshot** and not through ``_held_symbols``,
        # which would take a second one: shares, events and accounts have to
        # come from the same generation (issue #658), and a reload landing
        # between the two reads would pair one cycle's symbol set with another
        # cycle's holdings. It is the forward pass's gate alone — the backward
        # one runs on a closed position too, because the chart wants the history
        # of a line the owner held.
        held = {share['symbol'] for share in snapshot.shares
                if share.get('symbol') and share.get('quantity')}

        for symbol in sorted(windows):
            backfilled_count += self._backfill_symbol(
                symbol, windows[symbol], symbol in held)

        if backfilled_count > 0:
            app_logger.info(f"Backfill cycle complete: {backfilled_count} data points written")
        else:
            app_logger.debug("Backfill cycle complete: no new data to write")

        # The cycle that just moved the reconstruction is the one that re-observes
        # it (issue #709), and it is also where the *event* advisory is born: the
        # last backward pass reaching its first acquisition is the earliest
        # instant at which every symbol's quote currency has been observed, and
        # therefore the earliest at which the app can say what it assumed of the
        # amounts it imported. The condition is re-tested every cycle rather than
        # latched — the currency may be answered long after the reconstruction
        # ended — and the write is idempotent, so it is produced exactly once.
        self.review_advisories()

    def _backfill_symbol(self, symbol: str,
                         window: Tuple[date, Optional[date]],
                         held: bool) -> int:
        """Backfill one symbol over its own holding window (issue #626, #703).

        The **backward** pass extends the series toward the first acquisition and
        stops once ``_backfill_complete`` is set; the **forward** pass recovers a
        recent session missed while the app was down. The two directions are
        **independent** — a completed backward watermark never suppresses the
        forward pass (issue #627). Returns points written this cycle.

        ``window`` is ``(first acquisition, last exit or None)``. A ``None`` end
        means *still held*, so the ceiling is **now**; a closed position's
        ceiling is the day after its last sale, since yfinance reads the end of a
        range as exclusive and the price of the day one sells is part of the
        history one held.

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
        acquired, exited = window
        # One definition of the window's two instants, shared with the
        # terminality read (issue #706): the pass that fills the history and the
        # question "is this history finished" must not measure two windows.
        target, ceiling = carrying.holding_bounds(
            acquired, exited, datetime.now(timezone.utc))

        written = 0
        # Backward pass — skip once complete to avoid refetching the same window
        # every cycle (e.g. a first acquisition on a non-trading day never lets
        # the anchor reach it exactly). This skip must NOT gate the forward pass.
        if self._backfill_complete.get(symbol) == target:
            app_logger.debug(f"Backfill already complete for {symbol}")
        else:
            written += self._backfill_backward(symbol, target, ceiling)

        # Forward pass — independent of the backward-completion watermark, but
        # not of the holding: there is no live writer to catch up with once the
        # position is sold out.
        if held:
            written += self._backfill_forward(symbol)
        return written

    def _fetch_and_store(self, symbol, start_date, end_date):
        """Fetch one ``[start, end]`` chunk and, if non-empty, write it.

        The shared tail of both backfill passes (they differ only in window
        sizing and how they treat an empty window). Returns ``(prices, written)``:

          * ``prices is None`` — the fetch failed; the caller logs and retries.
          * ``prices == []`` — an empty window (yfinance returned no rows); the
            caller decides what an empty window means for its direction.
          * otherwise ``prices`` is the fetched rows and ``written`` the count
            persisted.

        The **enrichment is gone with the shape it fed** (issue #700). Every
        chunk used to be walked date by date so each point could be stamped with
        the position held that day, because a price point carried position
        fields; a market observation says nothing about who held what, so the
        write is now the prices and only the prices.

        The **conversion rides along** (issue #702): the pair's daily history is
        fetched beside the price history — one request for the whole chunk,
        because the rates are cached — so every point is converted at the rate of
        its own day. Converting a five-year-old close at today's rate would put a
        currency move into a chart of a share price.

        Rate-limits (``backfill_delay``) after any completed fetch — empty or
        written — but not after a fetch failure.
        """
        prices = self._fetch_historical_data(symbol, start_date, end_date)
        if prices is None:
            return None, 0
        if not prices:
            time.sleep(self.backfill_delay)
            return prices, 0

        self._convert_history(symbol, prices)

        written = 0
        try:
            with self.config_manager.writing() as opened:
                written = quotes.record_history(opened, symbol, prices)
        except Exception as e:
            app_logger.error(
                f"Failed to write historical prices for {symbol}: {e}")
        # Newly filled prices change ``holdings_value`` over that window, and
        # this is where the backfill used to lower a perf watermark so the next
        # recompute would rewrite the tail. It tells the perf job nothing now
        # (issue #707): the next cycle recomputes the whole series from the
        # prices the store holds, this chunk included.
        # Rate limit between symbols
        time.sleep(self.backfill_delay)
        return prices, written

    def _backward_anchor(self, symbol: str, ceiling: datetime) -> datetime:
        """Where the backward pass resumes from — **the oldest window tried**.

        The anchor used to be the oldest *stored* point, and that is a silent
        infinite loop (issue #703, ADR-0009): a delisted symbol stores nothing,
        so the anchor never moves, the stop condition is never reached, and the
        same window is asked of Yahoo every 60 seconds for the life of the
        process. Neither guard that could have caught it does: an empty return is
        classified as a **gap** and not a failure (#606), deliberately, so the
        consecutive-failure counter stays at zero too.

        So the anchor is the oldest window this pass has **attempted**, persisted
        on ``symbol_quote`` (spec #695 § 4's one named exception to *watermarks
        stay derived* — the argument for deriving is "it recomputes itself from
        the rows", which is exactly what a symbol with no rows cannot do).

        The **minimum** of three, so it can only ever move backwards:

        * the holding window's ``ceiling`` — where a symbol with nothing stored
          and nothing tried starts, which for a closed position is its last exit
          and not today;
        * the oldest stored point, which keeps the pass working **strictly
          before** the series it already has. That is half of the geometry
          ``price_point`` has instead of a uniqueness constraint (ADR-0007), and
          it is also what makes an install that predates this anchor resume
          where its data ends rather than re-fetching from the ceiling;
        * the oldest window tried, which is the only one that moves on a symbol
          Yahoo answers nothing about.

        The minimum itself is :func:`carrying.backward_anchor` since #706, so
        this pass and the terminality question :func:`quotes.terminal_symbols`
        puts to the whole portfolio compute one anchor and not two. What stays
        here is the *reading* of the three inputs, one symbol at a time — which
        is affordable on a job that visits one symbol per cycle with a rate-limit
        sleep between them, and is exactly what that batched read exists to avoid
        doing per request.
        """
        return carrying.backward_anchor(
            ceiling,
            quotes.oldest_ts(self.config_manager.store, symbol),
            quotes.oldest_window_tried(self.config_manager.store, symbol))

    def _convert_history(self, symbol: str, prices: List[Dict]) -> None:
        """Stamp a fetched chunk with its converted price and rate, in place.

        One prefetch of the pair over the chunk's own span — :meth:`fx.Rates.series`
        caches it, so the per-point :meth:`fx.Rates.rate` calls that follow are
        dictionary lookups — then one conversion per point at the rate of **its**
        day.

        The symbol's currency is read from ``_share_info_cache`` rather than
        fetched: the backfill runs on symbols the scrape has already met, and a
        second ``.info`` call per chunk would double the rate-limit exposure of
        the job that already emits the most requests in the app. A symbol not in
        the cache yet — a position sold before this install existed, which the
        live scrape never polls — simply leaves the conversion ``NULL`` until
        #704's lateral pass, which is exactly what that pass is for.

        Nothing is raised: a chunk that cannot be converted is still a chunk of
        prices, and losing it over a currency is the one outcome ADR-0002 rules
        out.
        """
        if not prices or not self.base_currency:
            return
        currency = (self._share_info_cache.get(symbol) or {}).get('currency')
        if not currency:
            return

        days = [point['timestamp'].date() for point in prices]
        try:
            self.rates.series(currency, self.base_currency, min(days), max(days))
        except Exception as e:
            app_logger.warning(
                f"Could not prefetch the rates for {symbol}: {e}")

        for point, day in zip(prices, days):
            converted, rate = self._convert(point.get('price'), currency, day)
            point['converted'] = converted
            point['rate'] = rate

    def _backfill_backward(self, symbol: str, target: datetime,
                           ceiling: datetime) -> int:
        """Backward pass: extend the series toward the first acquisition, one chunk
        (``backfill_chunk_days``) per cycle. Returns points written this cycle.

        ``target`` is the first acquisition — ``BUY`` **or ``GRANT``**, since a
        granted share is held from the day it lands — and ``ceiling`` the top of
        the holding window. Between them the pass walks backwards one chunk at a
        time from :meth:`_backward_anchor`.

        Every exit publishes a last-pass record (issue #668). That is the whole
        answer to #656's driving question: this method used to log a warning and
        return ``0`` on failure, which is indistinguishable from the ``0`` a
        healthy weekend returns — so nothing anywhere told "pacing normally"
        apart from "wedged on yfinance". The record carries the window it
        attempted, the **three** dates the progress bar is drawn from — target,
        ceiling and oldest — and, through the recorder's fold, how many
        consecutive cycles have now failed. The ceiling is on the record for the
        same reason the target is: the bar measures ``[target, ceiling]``, and a
        reader given only two of the three would divide by the wrong span on
        every sold line.
        """
        def publish(**fields) -> None:
            self.recorder.record_backfill(runtime_state.BackfillRecord(
                symbol=symbol,
                direction=runtime_state.BACKWARD,
                at=datetime.now(timezone.utc),
                target=target, ceiling=ceiling, **fields))

        # The oldest stored point — reported, not decided upon: it is what the
        # progress bar is drawn from, while the resume point is the anchor below.
        oldest_timestamp = quotes.oldest_ts(self.config_manager.store, symbol)
        end_date = self._backward_anchor(symbol, ceiling)

        # Compare at day granularity to avoid chasing tiny windows — and through
        # :func:`carrying.is_terminal`, which is the same predicate the carrying
        # convention's second term reads (issue #706). The watermark this branch
        # sets and the store-derived answer that convention takes must not be two
        # different notions of "finished".
        if carrying.is_terminal(end_date, target):
            app_logger.debug(
                f"Backfill complete for {symbol}: "
                f"anchor={end_date.date()}, target={target.date()}")
            self._backfill_complete[symbol] = target
            publish(anchor=end_date, oldest=oldest_timestamp,
                    terminal=runtime_state.TERMINAL_COMPLETE)
            return 0

        # Calculate the chunk to fetch (going backwards in time)
        start_date = end_date - timedelta(days=self.backfill_chunk_days)

        # Don't go before the first acquisition
        if start_date < target:
            start_date = target

        # Skip if window is less than 1 day (avoids useless requests outside market hours)
        if (end_date - start_date).days < 1:
            app_logger.debug(
                f"Backfill window too small for {symbol}, skipping until next cycle")
            publish(anchor=end_date, oldest=oldest_timestamp,
                    skipped=runtime_state.SKIP_WINDOW_TOO_SMALL)
            return 0

        app_logger.info(
            f"Backfilling {symbol}: {start_date.date()} to {end_date.date()}")

        prices, written = self._fetch_and_store(symbol, start_date, end_date)

        if prices is None:
            app_logger.warning(f"Failed to fetch history for {symbol}, will retry next cycle")
            publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date),
                    failed=True,
                    error=f"yfinance returned no history for {symbol} over "
                          f"{start_date.date()} → {end_date.date()}")
            return 0

        # The fetch completed — empty or not — so this window has been tried and
        # the anchor moves. Only here: a *failed* fetch has attempted nothing the
        # app is entitled to skip, and persisting it would let one Yahoo hiccup
        # erase a year of history the pass will never come back to.
        self._record_window_tried(symbol, start_date.date())

        if not prices:
            # Empty window: the fetch succeeded but returned no rows. If we
            # have already reached the first acquisition there is no earlier
            # trading data (e.g. it fell on a weekend/holiday), so mark the
            # symbol complete to avoid refetching this window forever.
            if start_date <= target:
                app_logger.debug(
                    f"Backfill complete for {symbol}: reached the first "
                    f"acquisition with no earlier trading data")
                self._backfill_complete[symbol] = target
                publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date),
                        terminal=runtime_state.TERMINAL_COMPLETE)
                return written
            # An empty window that has *not* reached the target is a gap
            # classifying itself (#606) — a weekend, a holiday. Emphatically not
            # a failure: counting it would make every Monday morning read as
            # wedged, which is the exact misreading the counter exists to prevent.
            # A mute symbol lands here every cycle, and what stops it is the
            # anchor just persisted, never the counter.
            publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date))
            return written

        publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date),
                written=written)
        return written

    def _record_window_tried(self, symbol: str, oldest: date) -> None:
        """Persist the backward pass's anchor, guarded like every other write.

        A store that refuses this must not abort the cycle: the points of the
        chunk are already in, and the only cost of losing the anchor is one
        re-fetched window next cycle.
        """
        try:
            with self.config_manager.writing() as opened:
                quotes.record_window_tried(opened, symbol, oldest)
        except Exception as e:
            app_logger.error(
                f"Failed to persist the backfill anchor for {symbol}: {e}")

    def _backfill_forward(self, symbol: str) -> int:
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
        newest = quotes.newest_ts(self.config_manager.store, symbol)

        def publish(**fields) -> None:
            self.recorder.record_backfill(runtime_state.BackfillRecord(
                symbol=symbol,
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

        app_logger.info(
            f"Forward-filling {symbol}: {start_date.date()} to {end_date.date()}")

        # Same granularity/chunking as the backward pass: 1h within 730d, 1d beyond.
        prices, written = self._fetch_and_store(symbol, start_date, end_date)

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
        own interval job, never piggybacked here — a step of the scrape would
        fire N recomputes per market-open wave.
        """
        if not self.shares:
            app_logger.warning("No shares configured, skipping scrape")
            return

        self.expose_metrics()

    # ``_midnight`` left with the type it worked around (issue #700). A perf
    # point was stamped at midnight UTC because InfluxDB had one kind of time
    # and every reader then had to un-stamp it; the store has two and never
    # mixes them, so the day is a ``DATE`` and there is nothing to convert.

    @staticmethod
    def _value_kwargs(dp, last: bool, perf) -> dict:
        """Shared value + perf fields for a metric point built from a DailyPerf.

        twr_index is per-day; xirr / gain_absolu land only on the latest point.

        **The per-field rule is applied here, once** (issue #708): a field the
        entity may not publish is written as ``None`` — therefore as ``NULL``,
        therefore as an absent Prometheus series — rather than as a zero that
        every ``sum()`` would count. One site for the two tables, because the
        rule is by *field* and the account and the global carry the same seven.
        """
        writable = performance.writable_fields(
            perf.has_cash_ledger, perf.has_external_flow)
        values = dict(
            cash_balance=dp.cash_balance,
            holdings_value=dp.holdings_value,
            total_value=dp.total_value,
            net_contributed=dp.net_contributed,
            twr_index=dp.twr_index,
            xirr=perf.xirr if last else None,
            gain_absolu=perf.gain_absolu if last else None,
        )
        return {name: (value if name in writable else None)
                for name, value in values.items()}

    # ``_mark_perf_dirty`` and ``_consume_perf_dirty_from`` stood here (issue
    # #707). They were the backfill's and the perf job's two ends of one
    # watermark, and they leave together with the incremental window they
    # bounded: the whole series is recomputed and upserted every cycle, so there
    # is no tail to remember and nothing to re-arm when a write fails.

    @staticmethod
    def _holding_windows(timeline, account_id: str, symbols,
                         today: date) -> Dict[str, Tuple[date, date]]:
        """``{symbol: (first, last) day this account held it}`` — the horizon's
        bound (issue #708).

        The symbols this account never touched are simply absent: a line held on
        another account constrains nothing here, and reading the whole ledger's
        symbol set into every account's horizon is exactly how one slow
        reconstruction would hold back an account that owns none of it.
        """
        windows = {}
        for symbol in symbols:
            window = timeline.holding_window(account_id, symbol, today)
            if window is not None:
                windows[symbol] = window
        return windows

    @staticmethod
    def _spans(points, key) -> Dict[Any, Tuple[date, date]]:
        """``{key: (first_day, last_day)}`` over the points a cycle produced.

        What the prune is bounded by (issue #707). Taken from the points and not
        from the window they were computed over, so an entity that produced
        nothing has **no** span and loses every cached day it had — which is how
        a forgotten import takes its days with it.
        """
        spans: Dict[Any, Tuple[date, date]] = {}
        for point in points:
            identity = key(point)
            first, last = spans.get(identity, (point.day, point.day))
            spans[identity] = (min(first, point.day), max(last, point.day))
        return spans

    def update_account_metrics(self) -> Dict[str, Optional[date]]:
        """Rebuild the daily ``account_metrics`` + ``portfolio_totals`` cache.

        Returns ``{account: horizon}`` — the first day each account's figures were
        written from, ``None`` where nothing constrained it (issue #708). It is
        the one thing this method knows that no query can recover, which is why
        it is returned and published on the runtime record rather than derived
        from the rows: the rows say where the series *starts*, and an account
        whose first activity is later than its horizon would answer the wrong
        question.

        **The series is written on a sliding horizon** (spec #695 § 11): the
        figures of today are right from the first cycle, and the page fills in
        towards the left as the reconstruction walks back. Below the horizon
        nothing at all is written — not a zero, not a ``NULL`` row — because a
        held position with no price yet would be counted as worth nothing beside a
        cash ledger that has already paid for it, and a time-weighted index chains
        that crater forward for the whole cycle.

        **Integral and unconditional** (issue #707, ADR-0011): every cycle
        recomputes the whole series — earliest event date → today, one point per
        calendar day — and hands it to a block upsert followed by a bounded
        prune. The incremental window this method carried since #597 is gone
        with its subject: it existed because a full rewrite on InfluxDB 3 Core
        landed never-compacted Parquet files and grew the file without bound,
        and an upsert on a primary key does not (44,8 MB against 1,1 over a
        thousand cycles).

        **Its only inputs are the store and the clock.** The events come from
        ``ledger.read_events`` and the declaration from
        ``accounts.read_accounts`` — every declared row since #708, the opt-in
        guard's ``declared_portfolio`` having gone with it — not from the
        published snapshot: the
        snapshot's *identity* was the third gate signal, and reading it here
        would leave the cache's freshness tied to the configuration's
        publication rhythm rather than to what the store holds. What it costs is
        worth naming: a ledger the whole-ledger validation would refuse is
        replayed here anyway. It cannot be one an import made — an import
        validates the ledger it *would* make before committing (#697) — so the
        case is a hand-edited store, and it ends as a ``PERF_FAILED`` record
        rather than as a wrong figure: the replay raises on what the validator
        refuses, and nothing is written.

        **The job replays its own ``Timeline``**, and that is not a duplication
        of the ingestion's replay: ``position`` and ``account_state`` are
        **current** states, while performance needs the state of *every day* —
        the cash balance on the day of a deposit, the quantity held on the day a
        price moved. There is no daily state in the store to read instead.

        The series is **dense over calendar days** — weekends and holidays
        included, prices forward-filled by ``price_at``. "No point on a
        non-trading day" is a property of *observed* prices, never of a derived
        daily series: TWR chains over consecutive days, and a weekend deposit
        needs somewhere to land.

        Money-weighted performance (xirr / gain_absolu / twr_index) comes from
        ``performance.py``; xirr / gain_absolu land only on the latest point.
        """
        # **Nothing at all until the reporting currency is answered** (issue
        # #702, ADR-0002). Not zeros, not ``NULL``s, not a partial series: every
        # figure this method writes is money, and an amount whose unit is not
        # settled is not a figure. Writing them "for later" would also be
        # unrecoverable in the ordinary sense — the rows would be indexed by day
        # and the next cycle would upsert over them, but a chart drawn in the
        # meantime would have shown a total that means nothing.
        #
        # It sits **above** the recompute rather than inside ``performance``
        # because it is true of every figure at once rather than of any one
        # computation, and what it protects is the *write*: prices go on being
        # collected the whole time, natively, so answering late costs nothing.
        #
        # It is a gate and the cycle is still unconditional (#707): what #707
        # removed is *change detection* — has anything happened since last time
        # — and this asks a different question, whether the figures have a unit
        # at all. Note it leaves the prune below unreached too, which is right:
        # a currency answered and then unanswered is not a state that exists.
        if not self.base_currency:
            app_logger.debug(
                "No base currency answered yet: no performance series is written")
            return {}

        store_handle = self.config_manager.store
        events = ledger.read_events(store_handle)
        # **The opt-in guard is gone** (issue #708). It read
        # ``accounts.declared_portfolio``, whose ``None`` means *"nothing was
        # declared beyond the seed"* — and ADR-0013 seeds a ``default`` row at
        # the creation of the schema and never removes it, so the condition had
        # lost its subject: a single-account install, the ordinary shape of a v4
        # coming over, had **no performance series written at all** while the
        # guard read as a deliberate opt-in. Every account row is computed now,
        # and what replaces the guard is the per-field rule
        # (:func:`performance.writable_fields`), applied in :meth:`_value_kwargs`.
        # An account the ledger never names produces no daily point, so it costs
        # a replay of nothing and the prune takes its days away.
        declared = accounts_module.read_accounts(store_handle)

        today = datetime.now(timezone.utc).date()
        acc_points: List[AccountMetricPoint] = []
        total_points: List[PortfolioTotalPoint] = []
        latest_by_account: Dict[str, AccountMetricPoint] = {}
        horizons: Dict[str, Optional[date]] = {}
        total = None

        if declared and events:
            timeline = EventAggregator().replay(events)

            # Injected price source: per-symbol daily closes, forward-filled. The
            # performance module never touches the store — it only calls price_at.
            # The symbol set comes from the events rather than from the current
            # positions: a line sold in 2022 has no position left and every day
            # it was held still needs its price.
            symbols = {e.symbol for e in events if e.symbol}
            price_pairs = {
                sym: sorted(quotes.price_series(store_handle, sym).items())
                for sym in symbols
            }

            def price_at(symbol, day):
                pairs = price_pairs.get(symbol)
                return timeline.state_at(pairs, day) if pairs else None

            # The carrying convention's **second** term (issue #706, ADR-0004):
            # which symbols the backward pass has finished with. Derived from
            # this replay rather than from the published snapshot, for the same
            # reason the events above are — the job's only inputs are the store
            # and the clock (#707), so a snapshot read here would tie the cache's
            # freshness back to the configuration's publication rhythm. ``held``
            # comes from the replay's own current state, which is what
            # ``ConfigSnapshot.shares`` is a projection of.
            held = {position['symbol']
                    for position in timeline.current()
                    if position.get('symbol') and position.get('quantity')}
            carried = quotes.terminal_symbols(
                store_handle, holding_windows(events, held),
                datetime.now(timezone.utc))
            # And its **first** term, which ``price_at`` cannot supply: that
            # callable reads ``price_converted``, so a symbol whose pair does not
            # resolve is priceless to it while its quote is known. Carrying those
            # would answer a valuation where the app owes *waiting for a rate*
            # (#706, repaired in the store by #704).
            first_quoted = quotes.first_quoted_days(store_handle)

            start = min(e.date for e in events)

            # --- the sliding horizon (issue #708) ----------------------------
            # The oldest **usable** price of each symbol, which is the oldest day
            # ``price_at`` can answer for: ``price_series`` is converted-only, so
            # a symbol quoted in a currency whose pair does not resolve is absent
            # here while being perfectly well quoted. That is the second half of
            # ``settled`` below — an absence no cycle of the backward pass will
            # ever repair, as opposed to the reconstruction simply not having
            # reached that far yet.
            oldest_priced = {symbol: pairs[0][0]
                             for symbol, pairs in price_pairs.items() if pairs}
            settled = set(carried) | {
                symbol for symbol in first_quoted if symbol not in oldest_priced}
            horizons = {
                account.id: performance.account_horizon(
                    self._holding_windows(timeline, account.id, symbols, today),
                    oldest_priced, settled)
                for account in declared
            }

            def _from(account_id: str) -> date:
                """Where this account's series begins: its horizon, never before
                the ledger's own first day."""
                horizon = horizons[account_id]
                return start if horizon is None else max(start, horizon)

            per_account = {
                account.id: performance.compute_account(
                    timeline, account, symbols, price_at, _from(account.id),
                    today, carried, first_quoted)
                for account in declared
            }
            # The global takes the **max** of the horizons: it is written only
            # where every account is, since a sum missing one of its terms draws
            # a step nothing caused. An account with no horizon at all does not
            # raise it — it has nothing waiting for a price.
            bounds = [horizon for horizon in horizons.values()
                      if horizon is not None]
            total = performance.compute_portfolio_total(
                timeline, declared, symbols, price_at,
                max([start] + bounds), today, per_account)

            # --- account_metrics --------------------------------------------
            for account in declared:
                perf = per_account[account.id]
                for i, dp in enumerate(perf.daily):
                    last = i == len(perf.daily) - 1
                    pt = AccountMetricPoint(
                        account=account.id,
                        account_type=account.type,
                        day=dp.date,
                        **self._value_kwargs(dp, last, perf),
                    )
                    acc_points.append(pt)
                    if last:
                        latest_by_account[account.id] = pt
            # --- portfolio_totals (global) -----------------------------------
            # The "only if single currency" condition left with
            # ``Account.currency`` (issue #702): accounts cannot disagree about
            # a currency they do not have. ``total`` is ``None`` only when
            # nothing is declared.
            if total is not None:
                total_points = [
                    PortfolioTotalPoint(
                        day=dp.date,
                        **self._value_kwargs(dp, i == len(total.daily) - 1, total),
                    )
                    for i, dp in enumerate(total.daily)
                ]

        # What this cycle produced, per entity, is what the prune keeps. Read off
        # the points themselves rather than off ``[start, today]``: accounts
        # begin on different days, and a global window would leave one account's
        # orphaned early days standing inside another's span.
        acc_spans = self._spans(acc_points, lambda pt: pt.account)
        total_span = self._spans(total_points, lambda _: None).get(None)

        with self.config_manager.writing() as opened:
            # **One** transaction for the four statements: they describe the
            # same cycle, and a reader landing between the upsert and the prune
            # would see days no computation produced beside days it just did.
            # A failure rolls the lot back, and the previous cache — a complete
            # one, from the previous cycle — stands until the next tick rebuilds
            # it. There is nothing to re-arm: that is what a cache buys.
            with opened.transaction():
                perf_series.write_account_metrics(opened, acc_points)
                perf_series.write_portfolio_totals(opened, total_points)
                perf_series.prune_account_metrics(opened, acc_spans)
                perf_series.prune_portfolio_totals(opened, total_span)

        # Permissive cash policy: a negative balance is allowed (it keeps a user
        # who adds accounts without rewriting their DEPOSIT history running), but
        # it is worth a non-blocking warning. ``None`` is not negative: an account
        # with no cash ledger does not publish a balance at all since #708, and
        # warning about the one it does not have would name the *ordinary* state
        # the per-field rule exists to keep silent.
        for acc, p in latest_by_account.items():
            if p.cash_balance is not None and p.cash_balance < 0:
                app_logger.warning(
                    f"Account '{acc}' has a negative cash balance "
                    f"({p.cash_balance:.2f}) — insufficient recorded cash")

        # Prometheus: expose the latest (today) value per account + global.
        #
        # **What a cycle publishes, and nothing more** (issue #708). The two
        # retracts below are the same gesture ``retain_positions`` makes on the
        # replay's side, and they are the row-level half of *"a gauge whose field
        # is absent is not published"*: the per-field rule lives inside
        # :meth:`PrometheusExporter.update_account`, which is only ever reached
        # for a row this cycle produced. An account that stops producing rows —
        # its import forgotten, its events withdrawn — is never visited, so
        # without the retract its seven gauges would keep the last values they
        # ever had for the life of the process, while ``prune_account_metrics``
        # took its days out of the store in this very transaction. A stale real
        # figure is worse than the zero the rule was written against: a scraper
        # has no way to tell it from a current one.
        if self.prometheus is not None:
            for acc, p in latest_by_account.items():
                try:
                    self.prometheus.update_account(p)
                except Exception as e:
                    app_logger.error(
                        f"Failed to update Prometheus account metrics for {acc}: {e}")
            try:
                self.prometheus.retain_accounts(latest_by_account.keys())
            except Exception as e:
                app_logger.error(f"Failed to retract Prometheus accounts: {e}")
            try:
                # ``None`` says *this cycle produced no global series at all*,
                # which is a different call from a point whose fields are absent
                # — and it is the one an emptied ledger makes.
                self.prometheus.update_portfolio(
                    total_points[-1]
                    if total is not None and total.daily else None)
            except Exception as e:
                app_logger.error(f"Failed to update Prometheus portfolio totals: {e}")

        # The horizons, handed back rather than stored: ``/api/runtime`` publishes
        # them from **process memory** (issue #708), and the record the perf job
        # writes is where a figure computed by a job becomes readable without a
        # query. They are the answer of *this* cycle, so they travel with it.
        return horizons

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
        """Release what this object owns — which since #700 is nothing.

        The InfluxDB client left with the database, and the store's connection
        was never this object's to close: it belongs to the ``Runtime`` and is
        closed **last** by :func:`shutdown_runtime`, once nothing is left running
        that could still write into it. The method survives because
        ``worker_exit`` calls it and a shutdown hook that has to know which
        objects have a teardown is a hook that will one day forget one.
        """


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
    fork: the store connection, the scheduler and its threads, the watchdog
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

    # The environment, read **once** and as a whole (issue #740). Six values and
    # the list of names that are set and no longer obeyed come out of the same
    # call, which is what keeps the two from being computed against different
    # readings of the same mapping.
    boot = boot_env.read(os.environ)

    # Name what is set and no longer obeyed, before anything reads anything
    # (issue #701, ADR-0014). The gesture ``config.yaml`` and ``settings.yaml``
    # already get: an install upgrading from v4 carries a whole .env of dials,
    # and a cadence that silently stops being honoured is exactly the kind of
    # change that reads as a regression six weeks later. One grouped line, and
    # only when there is something to say.
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
    store_path = boot.store_dir / store.STORE_FILENAME
    opened = store.open_store(store_path)

    config_manager = ConfigurationManager(opened_store=opened,
                                          import_dir=str(boot.import_dir))

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
    prometheus = PrometheusExporter() if boot.prometheus_enabled else None

    return Runtime(config_manager, prometheus, store_path=store_path)


def start_runtime(runtime: Runtime) -> Runtime:
    """Worker-side boot (``post_fork``): everything a fork would have broken.

    The store connection, the scheduler's threads, the watchdog observer, and
    the first ``ingest()`` — which is also what arms the per-symbol scrape jobs
    (issue #616), their immediate first fire being the bootstrap.
    """
    # The worker's own store connection (issue #696). The master proved the file
    # openable and closed it; this is the connection that lives for the process,
    # and it is the one thing here a ``fork()`` could not have carried: DuckDB's
    # buffers are not something two processes may inherit from one another.
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

    # Init SuiviBourseMetrics. The exporter comes from the master so the gauges
    # the Flask app already publishes are the ones the scrape path updates;
    # passing None when it is disabled leaves it disabled. The store is not
    # passed at all — the manager owns it, and with it the mutex that keeps a
    # write whole against a concurrent ingestion.
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
    # Register the two fixed-cadence interval jobs (backfill, perf recompute).
    # Per-symbol scrape jobs are armed by ingest() above and kept separate; the
    # perf recompute is its own job (issue #618) and rebuilds its cache in full
    # on every tick, starting with this boot's (issue #707).
    register_interval_jobs(scheduler, sb_metrics, backfill_interval)
    scheduler.start()
    app_logger.info(
        f"Scheduler started: per-symbol scraping (REGULAR every "
        f"{sb_metrics.regular_interval}s), ingestion on write (watched drop "
        f"folder), backfill every {backfill_interval}s, perf recomputed every "
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
