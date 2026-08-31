"""
SuiviBourse
Paul Brissaud
"""
import logging
import os
import threading
from contextlib import contextmanager
from dataclasses import dataclass
# ``time.sleep`` and the clock-of-day class both left with the backfill (issue
# #848): the politeness delay was the module's one caller here, and the two
# instants a last-pass record carries are spelled in :mod:`backfill` now.
from datetime import date, datetime, timezone
from pathlib import Path
from typing import List, Dict, Optional, Tuple

from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.schedulers.background import BackgroundScheduler
from logfmt_logger import getLogger

import accounts as accounts_module
import boot_conditions
import boot_env
import carrying
import installation_facts
import ledger
import mounts
import positions
import runtime_state
import scheduling
import settings as settings_module
import settings_registry
import store
import workloads
from events import EventValidator, EventAggregator
from events.loader import EventLoaderError
from events.validator import EventValidationError
from events.aggregator import AggregationError
from events.schemas import Portfolio

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
    'quotes', 'perf_series', 'ledger', 'positions',
    'installation_facts', 'web.api',
    # Four names the list had never caught up with. `PUT /api/config/log-level`
    # turned the app to DEBUG and left them at the boot level — `fx` above all,
    # which is the module that most often explains why a conversion is missing,
    # i.e. the commonest reason to reach for DEBUG in the first place.
    'fx', 'accounts', 'entries', 'reassignment',
    # The upload's own (#811). A file refused at the door leaves no row to look
    # at, so the log line is the whole of what an owner debugging one has.
    'uploads',
    # The advisories' own (#829). An advisory is derived on every read and
    # stored nowhere, so the acknowledgement's line is the only trace there is
    # of one having ever been raised.
    'advisories',
    # The market edge's own (#846). It is the app's one line to the outside, so
    # what it says of a rate limit or a refused ticker is what an owner reaches
    # for DEBUG to read — the fetch paths logged under `suivi_bourse` while
    # they were methods of the runtime, and the name follows the module.
    #
    # The rename has a consequence at boot, and it is the norm rather than a
    # regression: `LOG_LEVEL` reaches only the three loggers built with it
    # above, so `market` starts at `logfmt_logger`'s INFO like the eleven
    # other module loggers. A rate-limit warning is emitted where
    # `LOG_LEVEL=ERROR` used to swallow it, and `price_history`'s debug line
    # is not where `LOG_LEVEL=DEBUG` used to raise it. Below is how they are
    # turned, and it is the only way any module logger is.
    'market',
)


def set_log_level(level: str) -> str:
    """Change the log level of the running process. **Ephemeral** by design.

    The one survivor of #654's settings page, and the reason it survived is the
    reason it is not persisted: ``LOG_LEVEL`` is read from the environment the
    container was created with, so a "saved" level would revert the next time
    that container is recreated — a setting that silently reverts is worse than
    one that never claimed to stick. This lasts until the process restarts, and
    says so.

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


# --------------------------------------------------------------------- #
# The environment: what the process must know before it can open the store
# --------------------------------------------------------------------- #

# Every environment variable **this application reads**, with its own default,
# is :data:`boot_env.INVENTORY` — four names, and there is no fifth. The whole
# of the reasoning is in :mod:`boot_env`, which is also where the pure reading
# of them lives (#740).
#
# *Which* of them are set and no longer obeyed is
# :func:`installation_facts.unread_environment` since #850 — it lives beside the
# installation fact it feeds, and beside the one gatherer that reads it. What
# stays here is the one thing that is neither pure nor derivable: **saying it**,
# once, at start-up.


def report_unread_environment() -> List[str]:
    """Name what is set and not obeyed, in **one** grouped notice.

    One line per variable would put fourteen warnings in front of an operator
    upgrading from v4 and bury the sentence that matters, which is not *which*
    name was ignored but *where the setting went*. The sentence itself is
    :func:`boot_env.notice`, which is pure; what belongs here is the one thing
    that is not — emitting it, once, at start-up.
    """
    found = installation_facts.unread_environment()
    message = boot_env.notice(tuple(found))
    if message is not None:
        app_logger.warning(message)
    return found


def report_boot_conditions(boot: boot_env.BootEnvironment, persistence: str,
                           base_currency: Optional[str],
                           recorded_events: int) -> List[str]:
    """Say the three things that are true of this start-up, once each (#741).

    The same split as :func:`report_unread_environment`: the sentences and the
    predicates are pure (:func:`boot_conditions.observe`), and what belongs here
    is the one thing that is not — emitting them.

    *Once* is a property of **where this is called** rather than of a flag: it
    runs in :func:`build_runtime` — one call per process, before the scheduler
    exists at all. A condition that ends afterwards (a currency answered, a first
    event recorded) is not re-announced and its line is not retracted; the live states are what ``/api/runtime`` and
    ``/api/config`` carry, and the terminal is a record of the boot.

    Returns the keys said, so a test asserts *which* lines stood rather than
    capturing a logger.
    """
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
    """What this container was started with, read-only (#654 §6a → #656).

    Not a settings view any more (#701): the dials moved into the store and are
    served by :func:`settings.describe`, so what is left here is the half that
    genuinely cannot be answered from the store — the store's directory, the
    socket, the log level. None of it is writable from in here and none of it
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


def register_interval_jobs(scheduler, workloads_,
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
    is armed by the boot and it follows a write instead of a timer, the folder
    it used to poll having left the product altogether (ADR-0032).

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
    workloads and of one with no scheduler (the boot before ``start_runtime``,
    a test) — the dial is already in the store, and the boot reads it from
    there.
    """
    report = {
        'symbols_rescheduled': 0,
        'symbols_at_market_open': 0,
        'jobs_rescheduled': [],
    }
    running = getattr(runtime, 'workloads', None)
    if running is None:
        return report

    # The live attributes first, in one loop over the registry — five hand
    # written assignments here would be the second list ADR-0014 forbids.
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
            # Answering the reporting currency is the one dial change that is
            # **retroactive** (issue #704): every point written before it carries
            # a ``NULL`` conversion, and the lateral pass is what gives them one.
            # Reported as a rescheduled job because that is literally what it is
            # — the pass rides the backfill, so triggering it is advancing that
            # job's next run.
            started = running.repair_conversions_now()
            if started and scheduling.BACKFILL_JOB_ID not in report['jobs_rescheduled']:
                report['jobs_rescheduled'].append(scheduling.BACKFILL_JOB_ID)
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
        return carrying.holding_windows(self.events, held)

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
      mutex, ``_write_lock``, serialises the writers — which since ADR-0032 are
      the boot and the web handlers, the drop folder's watcher having left with
      the folder.
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
                opened lazily under ``config_dir``.

        **No drop folder any more** (ADR-0032). The manager took one directory
        to scan on every build; a file now reaches the app through
        ``POST /api/events/import``, is parsed once and is never seen again, so
        there is no second path to hand in and no environment left for this
        class to be given a reading of.
        """
        if config_dir:
            self.config_dir = Path(config_dir).expanduser()
        else:
            self.config_dir = Path('~/.config/SuiviBourse').expanduser()

        # Named, never read (issue #698). The attribute survives so the startup
        # observation has a path to name and the tests have one to write to.
        self.settings_path = self.config_dir / self.LEGACY_SETTINGS_FILE
        self._store = opened_store

        # The published snapshot, and the mutex that serialises publishers.
        # Both are created here, which in production means during
        # ``build_runtime`` — before the scheduler exists and before the socket
        # is bound, so the first publication has no concurrent reader to race.
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

        Called once in production, by :func:`build_runtime`, with the connection
        this process lives on. It was called twice when a ``fork()`` split the
        boot — the master attaching its own and detaching it before forking, the
        worker attaching the one it opened — and ADR-0039 left one connection and
        one call. It still takes ``None``, which is what a boot that fails
        mid-load hands back.
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
        declared in the app, and there is no folder left for a setting to name
        (ADR-0032). Reading it would keep a v4 format alive in v5 indefinitely.

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

    def _compute_cache_key(self) -> Optional[str]:
        """Fingerprint the **ledger** a snapshot is built from (issue #697).

        The mtime fingerprint of #658 moved to its new subject. The files are no
        longer the truth, so what a published snapshot has to be invalidated
        against is the store: :func:`ledger.stamp` fingerprints the event rows
        themselves and the declaration, so it moves on every write and on
        nothing else.

        **One part, and no file left in it** (issue #698). ``settings.yaml``'s
        mtime used to join the key because the ``accounts:`` block was re-read
        from it on every build; the accounts now live in the store, so the store
        alone says whether a snapshot is stale — and a v4 file being touched can
        no longer invalidate anything.

        ``None`` when nothing has been recorded and nothing declared — a fresh
        install with nothing to fingerprint yet.
        """
        return ledger.stamp(self._require_store())

    # ------------------------------------------------------------------ #
    # Publication (issue #658)
    # ------------------------------------------------------------------ #

    def current(self) -> ConfigSnapshot:
        """The published snapshot — the lock-free read path.

        One attribute read, because publication is a single rebind. Builds and
        publishes one on first use, which in production has already happened at
        boot (:func:`build_runtime`).
        """
        snap = self._config
        if snap is not None:
            return snap
        return self.reload()

    def replay(self) -> ConfigSnapshot:
        """Republish from the ledger, whatever the fingerprint says.

        **The distinction this method used to carry is gone** (ADR-0032).
        *Replaying* and *replaying while importing* were two things because a
        file could have moved on disk between two replays: the scan had to be
        skipped after a revocation, or it would import the revoked file straight
        back in the same request. There is no folder to scan, so the flag went
        with its reason and what is left is a **forced** rebuild — which is what
        a write through the API asks for, and for a reason of its own: the
        caller has just moved the ledger, so recomputing the fingerprint in
        order to be told so is work with one possible answer.
        """
        return self.reload(force=True)

    def reload(self, force: bool = False) -> ConfigSnapshot:
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
            candidate = self._build_snapshot(published, force)
            if candidate is not published:
                # The publication. A single rebind, so a concurrent reader sees
                # either the whole previous snapshot or the whole new one.
                self._config = candidate
            return candidate

    def _build_snapshot(self, published: Optional[ConfigSnapshot],
                        force: bool) -> ConfigSnapshot:
        """Assemble a validated snapshot, or return ``published`` on a cache hit.

        Runs under ``_write_lock``. Never touches ``self._config``: publication
        is :meth:`reload`'s business.
        """
        opened = self._require_store()

        # **Nothing is read from disk here** (ADR-0032). This is where the drop
        # folder was scanned on every build, which is why the accounts had to be
        # declared after it; a file is now written through ``entries`` before
        # anything replays, so a build reads the store and only the store.
        accounts = accounts_module.declared_portfolio(opened)

        cache_key = self._compute_cache_key()
        if not force and published is not None and published.cache_key == cache_key:
            app_logger.debug("Using cached configuration (the ledger is unchanged)")
            return published

        # An empty portfolio is a legitimate state, not a broken ledger: an
        # install starts life with nothing recorded and must keep running (with
        # a warning) until the first event lands.
        shares, events = self._load_from_store(opened)

        accounts_are_new = published is None or published.accounts != accounts
        if accounts is not None and accounts_are_new:
            app_logger.info(
                f"Loaded {len(accounts.accounts)} declared account(s): "
                f"{', '.join(sorted(accounts.ids()))}")

        return ConfigSnapshot(shares=shares, events=events, accounts=accounts,
                              cache_key=cache_key)

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
                "The ledger is empty; running on an empty portfolio until a "
                "first event is recorded or a .csv/.xlsx is handed to the app")
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


# ---------------------------------------------------------------------------
# Boot — three steps of one sequence (issue #651, ADR-0039)
# ---------------------------------------------------------------------------
#
# The web API lives in this process, so the ``__main__`` block that used to sit
# here is three importable pieces instead:
#
#   build_runtime()     the store, the configuration, the first replay
#   start_runtime()     the scheduler and its jobs
#   shutdown_runtime()  the teardown
#
# They were once the two sides of gunicorn's ``fork()`` plus its ``worker_exit``,
# and the line between the first two was load-bearing: only the calling thread
# survives a fork, so nothing holding a thread, a socket or a file descriptor
# could be built before it. ADR-0039 removed the fork, and with it that reason:
# the three are now simply consecutive, ``boot.py`` calls them in order, and
# **the store is opened once** — by ``build_runtime``, for the life of the
# process.


class Runtime:
    """The application's long-lived objects, filled in as the boot proceeds.

    :func:`build_runtime` supplies the store and the configuration manager;
    :func:`start_runtime` then adds the scheduler and its threads. The two used
    to be the two sides of a fork, which is why the connection was opened twice;
    since ADR-0039 they are consecutive steps of one sequence and the connection
    is opened once. The registry this object used to carry left with
    ``/metrics`` (ADR-0033), and the filesystem observer with the drop folder
    (ADR-0032).
    """

    def __init__(self, config_manager: ConfigurationManager,
                 store_path: Optional[Path] = None,
                 store_persistence: str = mounts.UNKNOWN,
                 opened_store: Optional['store.Store'] = None):
        self.config_manager = config_manager
        self.workloads: Optional[workloads.Workloads] = None
        self.scheduler: Optional[BackgroundScheduler] = None

        # The store (issue #696, ADR-0039). **One connection, for the life of
        # the process**: ``build_runtime`` opens it, everything downstream reads
        # and writes through it, and ``shutdown_runtime`` gives it back. It used
        # to be opened in the master and closed again — DuckDB's buffers are not
        # something two processes may inherit — with the worker opening its own
        # on the far side of the fork; there is no fork left to close it for.
        # The path stays beside it because ``GET /api/runtime`` publishes it.
        self.store_path: Optional[Path] = store_path
        self.store: Optional[store.Store] = opened_store

        # Whether that path outlives the container (issue #741, ADR-0015).
        # Observed **once**, at boot, and carried on this object like the path
        # itself: a mount namespace is fixed for the life of a process, so
        # re-reading ``/proc/self/mountinfo`` per request would be a query whose
        # answer was settled at ``execve``. It defaults to
        # :data:`mounts.UNKNOWN`, which is the honest reading of a runtime
        # nobody observed — a test's, or the one a Docker-less checkout builds.
        self.store_persistence: str = store_persistence

        # The scheduler's last-pass records (issue #668). Built here, with the
        # object itself, rather than in ``start_runtime``: ``GET /api/runtime``
        # must answer *before* and *without* a working scheduler, since
        # explaining a screen that is not working is the entire reason the
        # resource exists (#656 déc. 6). A recorder that only came into being
        # with the scheduler would be absent exactly then.
        self.recorder = runtime_state.RuntimeRecorder()


def log_fatal(exc: BaseException) -> None:
    """Log a boot-fatal exception under the message its class earned.

    The branch list is the one ``__main__`` carried before gunicorn, and it
    outlived it. *How* the process then dies is the caller's business and there
    is one caller: ``boot.run`` returns 1, once, whichever step raised
    (ADR-0039).
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
    """The store and the configuration — the boot's second step (ADR-0039).

    Opens the store **and keeps it open**: the connection returned on the
    :class:`Runtime` is the one this process lives on. It used to be closed
    again here, because a DuckDB file descriptor is exactly what must not cross
    a ``fork()``; there is no fork left, so the file is opened once.

    A failure at any line of it raises, and ``boot.run`` turns that into one
    non-zero exit.
    """
    app_logger.info('SuiviBourse is running !')

    # The environment, read **once** and as a whole (issue #740). Four values and
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
    # place #658 gave the Cerberus validation — first, so that a failure is one
    # clean exit before anything has been started — for a different cause: the
    # app has one store, everything downstream branches off it, and a file it
    # cannot open is not a degraded mode.
    #
    # Opened, brought to its schema, seeded, and **left open** (ADR-0039): this
    # is the connection every job and every request handler goes through, and
    # ``shutdown_runtime`` is what gives it back.
    store_path = boot.store_dir / store.STORE_FILENAME
    opened = store.open_store(store_path)

    # Whether that directory outlives the container (issue #741, ADR-0015).
    # Observed here rather than demanded before: #677/D12 refused to boot
    # without an explicit store location, and the amendment is safe precisely
    # because ``/proc/self/mountinfo`` answers the question with certainty
    # instead of leaving it to a generic "did you mount a volume?" printed at
    # every start. Read after the store is proved openable, so a container that
    # cannot write at all still dies of the one cause that matters.
    persistence = mounts.store_persistence(boot.store_dir)

    config_manager = ConfigurationManager(opened_store=opened)

    # Before anything is loaded, name what is *not* going to be (issue #711).
    # An install coming from a manual v4 has a config.yaml and no events, so
    # every page it opens is empty — and an empty page is indistinguishable
    # from a portfolio the update erased unless the app says which file it
    # stopped reading.
    config_manager.report_unread_files()

    # First publication. Reading, aggregating and validating all happen here,
    # which is what keeps a broken configuration a single clean exit — nothing
    # has been started yet, so there is nothing to tear down. ``start_runtime``'s
    # ``ingest()`` is then a cache hit that only arms the jobs.
    #
    # It reads the store and nothing else (ADR-0032): the drop folder used to be
    # scanned here, so that a file the ledger refuses was a boot-time event,
    # logged before anything had been started — and there is no longer a file to
    # be found anywhere at boot.
    try:
        config_manager.reload()
        # The three lines (issue #741), here rather than before the load: two of
        # the three are read off what the load just published, and a boot that
        # ends in an exception has a fatal message to say instead of three
        # conditions about a portfolio it never managed to read.
        report_boot_conditions(
            boot, persistence,
            base_currency=opened.setting('base_currency'),
            recorded_events=len(config_manager.current().events))
    except BaseException:
        # A boot that will not finish gives the file back before it raises: the
        # connection is only worth keeping open for a process that is going to
        # serve, and a test that provokes a failure must not be left holding a
        # store nobody closes. On the way through, it stays open — that is the
        # whole of ADR-0039's "opened once".
        config_manager.attach_store(None)
        opened.close()
        raise

    # The exporter used to be built here, and the ephemerality gauge raised with
    # it. Both left with ``/metrics`` (ADR-0033): the fact the gauge carried is
    # published by the runtime and store resources under their *persistence*
    # member, and said again by the boot lines above — so it changed instrument
    # rather than status.
    return Runtime(config_manager, store_path=store_path,
                   store_persistence=persistence, opened_store=opened)


def start_runtime(runtime: Runtime) -> Runtime:
    """The scheduler and its jobs — the boot's fourth step (ADR-0039).

    The scheduler's threads and the first ``ingest()``, which is also what arms
    the per-symbol scrape jobs (issue #616), their immediate first fire being the
    bootstrap.

    **It opens nothing.** This used to be ``post_fork`` and its first act was to
    open the worker's own store connection, because the one ``build_runtime``
    proved openable had to be closed before the fork. There is no fork and no
    second connection: the store on the runtime is already open and already
    attached to the configuration manager.
    """
    # The dials, from the store and from nowhere else (issue #701, ADR-0014).
    # Read *once*, into the attributes every cycle re-reads, so the scrape path
    # never queries DuckDB from a scrape thread. The write path assigns the same
    # attributes, which is the whole of "no dial requires a restart".
    dials = settings_registry.defaults() if runtime.store is None \
        else settings_module.read_all(runtime.store)
    backfill_interval = dials['backfill_interval']

    # The four workloads and the state they share (issue #850, :mod:`workloads`).
    # The store is not passed at all — the manager owns it, and with it the
    # mutex that keeps a write whole against a concurrent ingestion.
    running = workloads.Workloads(
        runtime.config_manager,
        recorder=runtime.recorder)
    running.apply_dials(dials)
    runtime.workloads = running

    # Size the executor pool, always automatically (issue #701, formula #619).
    # The fixed dial was deleted rather than moved into the store: the executor
    # is built once here and a ThreadPoolExecutor does not shrink hot, so it was
    # the one setting that would still have required recreating the container —
    # and it was a silent trap besides, a cohort of thirty symbols on a pool of
    # ten serialising its own scrapes with nothing anywhere to say so. The
    # same-exchange cohorts are read off the store this step was handed — one
    # query, no network (issue #851). They used to cost one yfinance fetch per
    # held symbol, behind a 30-second deadline and ahead of the socket, so a
    # boot spent up to half a minute answering nothing to buy an integer the
    # store already knew.
    pool_size = scheduling.compute_pool_size(
        running.shares, running.read_exchange_of())
    # Wire the scheduler before bootstrapping so ingest() can arm the
    # per-symbol scrape jobs (issue #616). Their immediate first fire IS the
    # bootstrap — no separate initial scrape. Background, not Blocking: uvicorn's
    # event loop owns the foreground.
    scheduler = BackgroundScheduler(
        executors={'default': ThreadPoolExecutor(pool_size)})
    running.scheduler = scheduler
    runtime.scheduler = scheduler
    # Bootstrap: load shares + arm one self-rescheduling scrape job per
    # symbol (each fires immediately, then re-arms on its market cadence).
    running.ingest()
    # Register the two fixed-cadence interval jobs (backfill, perf recompute).
    # Per-symbol scrape jobs are armed by ingest() above and kept separate; the
    # perf recompute is its own job (issue #618) and rebuilds its cache in full
    # on every tick, starting with this boot's (issue #707).
    register_interval_jobs(scheduler, running, backfill_interval)
    scheduler.start()
    app_logger.info(
        f"Scheduler started: per-symbol scraping (REGULAR every "
        f"{running.regular_interval}s), ingestion on write (watched drop "
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

    **And it carries the performance with it** (issue #812, ADR-0032). The
    positions followed the write from the start; the series waited for the
    ``PERF_TICK``, so correcting a mistake made in 2019 left every curve exactly
    as it was for up to two minutes — during which *taken*, *taken wrong* and
    *not taken yet* were one screen. The recompute is
    :meth:`workloads.Workloads.recompute_perf` and not
    ``update_account_metrics``: it is the guarded shape, so a cache that fails to
    rebuild is a ``PERF_FAILED`` record rather than a ``500`` on a write that
    committed, and the pass is recorded exactly as a tick's is — because it is
    one.

    **Integral, and that is the decision.** ADR-0011 measured the full rebuild at
    460 ms over five years and removed the incremental windows on purpose. A
    window *from the event's date to today* would buy four hundred milliseconds
    against a frontier to reason about for ever — and this seam exists precisely
    because a false day left behind a frontier is invisible.

    The periodic job does not move: it stays the net for the changes that go
    through no write at all — a quote landing, a backfill chunk arriving. The
    third one it used to be the net for was a file dropped in the folder, whose
    watcher was wired straight to ``ingest`` rather than through here and which
    therefore kept the tick's old symptom on the headless road; the folder is
    gone (ADR-0032), and with it the one path into this ledger that did not
    come through a write.
    """
    if runtime.workloads is not None:
        runtime.workloads.ingest(force=True)
        runtime.workloads.recompute_perf()
    else:
        runtime.config_manager.replay()


def shutdown_runtime(runtime: Runtime) -> None:
    """The teardown — ``boot.sequence``'s ``finally``, and the heir of ``__main__``'s.

    Carries an explicit ``scheduler.shutdown``: under ``BlockingScheduler`` the
    scheduler was dead by the time the ``finally`` ran, so there was nothing to
    stop. ``wait=False`` because the process is already on its way out — a scrape
    in flight must not hold the shutdown open for a whole yfinance timeout.
    """
    if runtime.scheduler is not None and runtime.scheduler.running:
        runtime.scheduler.shutdown(wait=False)
    # The store last: it is the thing every job was writing into, so it closes
    # once nothing is left running to write.
    if runtime.store is not None:
        runtime.store.close()
        runtime.store = None
