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
from typing import Any, List, Dict, Optional, Set, Tuple

from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.schedulers.background import BackgroundScheduler
from logfmt_logger import getLogger

import accounts as accounts_module
import backfill
import boot_conditions
import boot_env
import carrying
import fx
import installation_facts
import ledger
import market
import mounts
import perf_series
import performance
import positions
import quotes
import runtime_state
import scheduling
import scrape
import settings as settings_module
import settings_registry
import share_info
import store
import store_reads
from events import (
    EventValidator, EventAggregator,
    AccountMetricPoint, PortfolioTotalPoint,
)
from events.loader import EventLoaderError
from events.validator import EventValidationError
from events.aggregator import AggregationError
from events.schemas import EventType, Portfolio

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
# of them lives (#740). This module used to re-export it under a second name,
# "because the inventory is what the API resource is written against" — the API
# resource calls the two functions below, and never touched the alias.


def unread_environment() -> List[str]:
    """The ``SB_*``/``INFLUXDB_*`` variables that are set and no longer read.

    **Computed, never hard-coded** — the difference between what is present and
    what :data:`boot_env.INVENTORY` names, minus the four the app has never
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


def installation_fact_context(config_manager,
                              metrics=None) -> installation_facts.Context:
    """Gather what the installation facts' predicates read (issue #709).

    The seam between :mod:`installation_facts`, which holds the predicates and
    the log's text — a reader is served the front's catalogue since #768, so
    *the* text is no longer one text — and the two places their sources
    actually live: the
    environment inventory here, and the reconstruction's progress in the
    scheduler's own memory. **One builder**, so the observation a job makes and
    the one a request renders cannot come from two different readings of the same
    two sources.

    A caller with no ``metrics`` — the boot before :func:`start_runtime`, a web
    request on a runtime whose scheduler never started — reports it as
    **unobservable** rather than as finished. That distinction is the whole of
    :data:`installation_facts.UNOBSERVED`: without it, a page being opened
    would drop the row a running scheduler armed.
    """
    return installation_facts.Context(
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


#: The interval job a dial's ``REARM_BACKFILL_JOB`` effect reschedules — and,
#: since #704, the one a ``REPAIR_CONVERSIONS`` effect brings forward: the
#: lateral pass rides on it rather than owning a job of its own.
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
        elif effect == settings_registry.REPAIR_CONVERSIONS:
            # Answering the reporting currency is the one dial change that is
            # **retroactive** (issue #704): every point written before it carries
            # a ``NULL`` conversion, and the lateral pass is what gives them one.
            # Reported as a rescheduled job because that is literally what it is
            # — the pass rides the backfill, so triggering it is advancing that
            # job's next run.
            started = metrics.repair_conversions_now()
            if started and BACKFILL_JOB_ID not in report['jobs_rescheduled']:
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


class SuiviBourseMetrics:
    """
    Class for managing and exposing metrics related to stock shares.
    """

    def __init__(self, config_manager: ConfigurationManager,
                 recorder: Optional[runtime_state.RuntimeRecorder] = None):
        self.config_manager = config_manager

        # The store, reached through the manager and never held as a second
        # reference (issue #700). It is what the ``InfluxDBWriter`` argument used
        # to be, minus the injection point: there is one store per process, the
        # manager already owns the connection *and* the mutex that keeps a
        # transaction whole, and a second handle here would be a second answer to
        # "which generation of the ledger is this job looking at".

        # The ``sb_*`` registry used to be handed in here (ADR-0012). It left
        # with ``/metrics`` (ADR-0033), and every ``is not None`` guard this
        # class carried around it left too: what a pass did is read off the rows
        # it wrote and off the record it published, which are the two surfaces
        # the interface renders.

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

        # One perf recompute at a time (issue #812). See
        # :meth:`update_account_metrics` for why this stopped being free the day
        # the replay that follows the write started recomputing the series.
        # **Reentrant**, so ``recompute_perf`` can hold it across the rebuild
        # *and* the record it publishes about that rebuild, while the rebuild
        # goes on taking it for a caller who reaches it directly.
        self._perf_lock = threading.RLock()

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
        # changed.
        self.scheduler: Optional[BackgroundScheduler] = None

        # The per-symbol ``info`` cache, built **here** and handed to each
        # workload that reads it — the scrape below (issue #847) and the
        # backfill under it (issue #848), which is where the pair is finally
        # symmetrical: one object, handed twice, and this class holds no third
        # reference to it.
        # One object because it is one memory: two caches would put the same
        # question to Yahoo twice, and a read of the store cannot answer it at
        # all, ``symbol_quote`` carrying neither the market state nor the
        # trading period. Its two gestures are named apart in
        # :mod:`share_info` — the live fetch's *observed*, the unit lookup's
        # *learned* — because the asymmetry between them is load-bearing.
        #
        # A local and not an attribute: it is *handed over*, and what this class
        # reads it back through is the property below. An attribute here would
        # be the second reference, and a later assignment to it would split the
        # memory in two — the scrape observing into one object while the
        # backfill learns from another, which is the whole defect this ticket
        # exists to close.
        info_cache = share_info.ShareInfoCache()

        # The scrape workload (issue #847, :mod:`scrape`). It holds *this*
        # object rather than the collaborators it calls, so a method replaced on
        # this instance is traversed by the pass rather than stepped over; the
        # state that is the scrape's alone — the #617 counters, the #628 sonde
        # and their locks — lives there, and the five properties below this
        # constructor are the windows this class keeps open onto it.
        self._scrape = scrape.ScrapeWorkload(self, info_cache)

        # The backfill workload (issue #848, :mod:`backfill`). Built exactly as
        # the scrape above and for the same reasons — it holds *this* object, so
        # a method replaced on the instance is traversed rather than stepped
        # over — and handed the **same** ``info_cache``: the unit its lateral
        # pass learns is the unit the scrape's fetch observes into, and that is
        # #847's other half, closed here.
        #
        # The memory the three passes share lives there: the symbols whose
        # backward pass has reached its first acquisition, the lateral pass's
        # back-off, and the symbols Yahoo named no currency for. Three
        # properties below this constructor are the windows this class keeps
        # open onto them, for the reason the scrape's five are.
        self._backfill = backfill.BackfillWorkload(self, info_cache)

        # There is **no perf state here**, and its absence is the ticket (issue
        # #707, ADR-0011). Four attributes stood at this line — a mutex, a
        # backfill watermark, the identity of the last events list, and a
        # live-write bool the scrape raised — and all four served one gate that
        # decided whether recomputing was worth it. The two tables are a cache;
        # the recompute is integral and unconditional every cycle, so nothing
        # about the *past* is worth remembering, and the last coupling between
        # the backfill and the perf goes with the memory of it.

        # The last-pass records (issue #668, design #656). Injected from the
        # Runtime so the web handlers reach the *same* recorder the jobs write
        # to — it is built master-side, like the ConfigurationManager and for the same
        # reason. Defaulted here so a unit test that builds this class directly
        # still has somewhere to publish, and so no call site below has to check
        # for None.
        self.recorder = recorder or runtime_state.RuntimeRecorder()

    # ------------------------------------------------------------------ #
    # The scrape's own state, seen from here (issue #847)
    # ------------------------------------------------------------------ #
    #
    # The five attributes that left with the workload. They are set and read on
    # *this* object — by the suite — so the class keeps a window open onto each
    # rather than a second copy: a copy would be a second answer to "how many
    # times has this symbol failed", and the #617 back-off is the one guard that
    # cannot afford two.
    #
    # The ``info`` cache is here for the same reason and one more: **two**
    # workloads hold it since #848, so the setter assigns both. A setter that
    # moved only the scrape's would be the split memory the constructor's
    # comment refuses — the scrape observing into a new object while the
    # backfill goes on learning into the old one — under the one name that
    # looks like it cannot happen.

    @property
    def _share_info_cache(self) -> share_info.ShareInfoCache:
        return self._scrape.info_cache

    @_share_info_cache.setter
    def _share_info_cache(self, cache: share_info.ShareInfoCache) -> None:
        self._scrape.info_cache = cache
        self._backfill.info_cache = cache

    @property
    def _failure_counts(self) -> Dict[str, int]:
        return self._scrape.failure_counts

    @_failure_counts.setter
    def _failure_counts(self, counts: Dict[str, int]) -> None:
        self._scrape.failure_counts = counts

    @property
    def _failure_counts_lock(self):
        return self._scrape.failure_counts_lock

    @property
    def _sonde_state(self) -> Dict[str, scheduling.SondeState]:
        return self._scrape.sonde_state

    @_sonde_state.setter
    def _sonde_state(self, state: Dict[str, scheduling.SondeState]) -> None:
        self._scrape.sonde_state = state

    @property
    def _sonde_lock(self):
        return self._scrape.sonde_lock

    # ------------------------------------------------------------------ #
    # The backfill's own state, seen from here (issue #848)
    # ------------------------------------------------------------------ #
    #
    # The three memories the passes share, under the names the suite and the
    # installation facts read them by. ``_backfill_complete`` above all: it is
    # where *"this pass has reached its first acquisition"* lives and no row
    # anywhere says it, so :meth:`reconstruction_state` reads it from here and a
    # second copy would be a second reconstruction to report.

    @property
    def _backfill_complete(self) -> Dict[str, datetime]:
        return self._backfill.complete

    @_backfill_complete.setter
    def _backfill_complete(self, complete: Dict[str, datetime]) -> None:
        self._backfill.complete = complete

    @property
    def _lateral_retry_at(self) -> Dict[str, datetime]:
        return self._backfill.lateral_retry_at

    @_lateral_retry_at.setter
    def _lateral_retry_at(self, retry_at: Dict[str, datetime]) -> None:
        self._backfill.lateral_retry_at = retry_at

    @property
    def _quote_currency_unknown(self) -> Set[str]:
        return self._backfill.quote_currency_unknown

    @_quote_currency_unknown.setter
    def _quote_currency_unknown(self, symbols: Set[str]) -> None:
        self._backfill.quote_currency_unknown = symbols

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
        """One symbol's newest close and its attributes, and the cache's fill.

        :meth:`scrape.ScrapeWorkload.fetch_ticker_data` (issue #847). It stays
        reachable under this name because it is where every live-quote path of
        this class asks the market edge, and because it is the name the suite
        replaces when it wants a fetch to fail.
        """
        return self._scrape.fetch_ticker_data(symbol, max_retries)

    def _fetch_historical_data(self, symbol: str, start: datetime, end: datetime,
                               max_retries: int = 3) -> Optional[List[Dict]]:
        """One symbol's closes over ``[start, end]``, or ``None`` on failure.

        :meth:`backfill.BackfillWorkload.fetch_historical_data` (issue #848).
        It stays reachable under this name because it is where both filling
        passes ask the market edge, and because it is the name the suite
        replaces when it wants a history to fail or to come back canned.
        """
        return self._backfill.fetch_historical_data(symbol, start, end,
                                                    max_retries)

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
        return market.pair_rate(pair)

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

        **It raises rather than swallowing** (issue #704), and that is the whole
        of how the lateral pass tells its two stopping conditions apart: a raise
        is a fetch that did not complete, an empty answer is yfinance saying the
        pair is not a ticker. :meth:`fx.Rates._ensure_window` catches it and
        logs exactly as this used to, so the *rebuild's* behaviour is unchanged —
        what changes is that the difference survives as far as the caller that
        needs it.
        """
        return market.pair_series(pair, start, end)

    def _convert(self, price, currency: Optional[str],
                 at: Optional[date] = None) -> Tuple[Optional[float], Optional[float]]:
        """``(converted, rate)`` for one observed price, in one call.

        The single place a write path asks the currency question, so that no
        writer has to remember the order of *"is there a reporting currency"*
        and *"is there a rate"*. Both answers are ``None`` together, and the
        caller writes the point anyway.
        """
        return fx.convert(price, currency, self.base_currency, self.rates, at)

    def _write_quote(self, symbol: str, last_quote, info, now: datetime,
                     converted=None, fx_rate=None) -> bool:
        """Persist one live observation: ``symbol_quote`` + one ``price_point``.

        :meth:`scrape.ScrapeWorkload.write_quote` (issue #847). The write
        itself is still :mod:`quotes`', which is the single writer of the two
        market tables (ADR-0006) — this ticket moved an orchestration and not
        a write.
        """
        return self._scrape.write_quote(symbol, last_quote, info, now,
                                        converted, fx_rate)

    def expose_metrics(self):
        """Fetch and store every held symbol's quote, once.

        :meth:`scrape.ScrapeWorkload.expose_metrics` (issue #847) — the
        synchronous whole-portfolio driver the end-to-end harness runs. The
        name is Prometheus' last word in the tree and #850 owns its renaming;
        this ticket moved the body and left the name where it stood.
        """
        return self._scrape.expose_metrics()

    # ------------------------------------------------------------------ #
    # Market-aware per-symbol scheduling (issue #616)
    # ------------------------------------------------------------------ #

    def _held_symbols(self) -> set:
        """The symbols currently held across all accounts.

        :meth:`scrape.ScrapeWorkload.held_symbols` (issue #847) — the scrape's
        population, and the filter (a quantity) that keeps a line sold four
        years ago out of it.
        """
        return self._scrape.held_symbols()

    def read_exchange_of(self) -> Dict[str, Optional[str]]:
        """Map each held symbol to its venue for auto pool sizing (#851, #619).

        :meth:`scrape.ScrapeWorkload.read_exchange_of` (issue #847), read by
        :func:`start_runtime`: one query on ``symbol_quote`` and no network.
        """
        return self._scrape.read_exchange_of()

    def _scheduled_symbols(self) -> set:
        """Symbols that currently have a live per-symbol scrape job.

        :meth:`scrape.ScrapeWorkload.scheduled_symbols` (issue #847).
        """
        return self._scrape.scheduled_symbols()

    def _arm_symbol(self, symbol: str, delay: float, now: datetime) -> None:
        """(Re)schedule a symbol's scrape job to fire ``delay`` seconds from now.

        :meth:`scrape.ScrapeWorkload.arm_symbol` (issue #847), jitter included.
        """
        return self._scrape.arm_symbol(symbol, delay, now)

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

        :meth:`scrape.ScrapeWorkload.rearm_regular_scrapes` (issue #847). The
        pair it answers is the settings write path's — ``(reached,
        at_market_open)`` — and :func:`apply_settings` reports it as such.
        """
        return self._scrape.rearm_regular_scrapes()

    def _last_pass_closed(self, symbol: str) -> Optional[bool]:
        """Was this symbol's market shut on its last pass? ``None`` if it has none.

        :meth:`scrape.ScrapeWorkload.last_pass_closed` (issue #847).
        """
        return self._scrape.last_pass_closed(symbol)

    def _reconcile_jobs(self) -> None:
        """Diff the held-symbol set against the scheduled jobs (design #604).

        :meth:`scrape.ScrapeWorkload.reconcile_jobs` (issue #847), called by
        :meth:`ingest` on every replay.
        """
        return self._scrape.reconcile_jobs()

    def _check_price_freshness(self, symbol: str,
                               live_price, now: datetime) -> bool:
        """Price-freshness liveness sonde (issue #628, design #626).

        :meth:`scrape.ScrapeWorkload.check_price_freshness` (issue #847).
        """
        return self._scrape.check_price_freshness(symbol, live_price, now)

    @staticmethod
    def _scrape_verdict(should_write: bool, state, wrote: bool,
                        has_holdings: bool) -> str:
        """Name what one scrape pass did, at the instant it did it (issue #668).

        :func:`scrape.scrape_verdict` (issue #847).
        """
        return scrape.scrape_verdict(should_write, state, wrote, has_holdings)

    def _scrape_symbol(self, symbol: str, now: Optional[datetime] = None) -> None:
        """Scrape one symbol, gate the write, and re-arm the job (design #602).

        :meth:`scrape.ScrapeWorkload.scrape_symbol` (issue #847) — the
        workload's entry point, and the callable every per-symbol job is armed
        on.
        """
        return self._scrape.scrape_symbol(symbol, now)

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

        **The record is inside the lock, with the rebuild it describes** (issue
        #812). ``_perf_lock`` orders the passes; publishing the record after
        releasing it would leave the two orderings free to disagree, and a tick
        descheduled between its own release and its ``record_perf`` would stamp
        an older ``at`` and older horizons over the record of the request that
        overtook it. ``/api/runtime`` would then name a cache that has been
        replaced — the one thing :class:`runtime_state.PerfRecord` is written not
        to do. The lock is reentrant for exactly this: the rebuild takes it again
        on the same thread, and a caller reaching
        :meth:`update_account_metrics` directly is still ordered against
        everyone else.
        """
        horizons: Dict[str, Optional[date]] = {}
        with self._perf_lock:
            try:
                horizons = self.update_account_metrics()
                verdict, error = runtime_state.PERF_RAN, None
            except Exception as e:
                app_logger.error(f"Failed to update account metrics: {e}")
                verdict, error = runtime_state.PERF_FAILED, str(e)
            # Recorded rather than inferred, same as every other job's last pass.
            # The horizons ride along (issue #708) rather than being a record of
            # their own: they are *what this pass wrote from*, so a reader taking
            # them from one pass and the verdict from another would be reading a
            # cache that no longer exists. A failed pass publishes none, which is
            # the honest state — the previous cycle's cache still stands but this
            # cycle established nothing.
            self.recorder.record_perf(runtime_state.PerfRecord(
                at=datetime.now(timezone.utc), verdict=verdict, error=error,
                horizons=horizons))

    def ingest(self, force: bool = False):
        """Replay the ledger and reconcile the scrape jobs.

        **No longer a polled job** (issue #697). In v4 this ran every 300 s
        because the files were the truth and nothing else could notice they had
        changed. The ledger now changes only when a write changes it, so this is
        the *replay that follows the write* — a quiet, synchronous, in-process
        gesture with exactly two callers:

        * the boot, in ``start_runtime``, where it is also what arms the
          per-symbol scrape jobs for the first time. It publishes nothing new:
          the master built the snapshot before the fork, so this is a cache hit
          on :func:`ledger.stamp` that only arms the jobs;
        * a write through the API, via :func:`replay_after_write`, which passes
          ``force=True``.

        **``force`` is not the flag that left** (ADR-0032). ``import_files``
        said *scan the drop folder or do not*, and it went with the folder;
        what is left is whether the fingerprint may be honoured, and the write
        path says it need not be — it has just moved the ledger and has no
        reason to ask.

        ``SB_INGESTION_INTERVAL`` is gone with the polling it paced, and there
        is no timer anywhere that re-reads a file on its own.

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
            snapshot = (self.config_manager.replay() if force
                        else self.config_manager.reload())
            # **On every ingest, and that was a defect once** (issue #812). The
            # condition here used to be ``if import_files``, which was right
            # while the only file that could carry a reporting currency arrived
            # through the drop folder. ``POST /api/events/import`` writes that
            # setting too (:func:`entries.create_many`) and comes through the
            # replay that follows the write — so the row landed in the store and
            # the running process went on holding ``None``. Since the perf gate
            # reads the *attribute*, every later tick was blind as well: an
            # install whose first gesture is an import had no performance series
            # at all until a restart.
            self._adopt_declared_currency()
            after = snapshot.shares
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

        # Re-observe the installation facts (issue #709). Here because this is
        # the gesture that runs at the boot, on a file landing and after a
        # write — the three moments an *installation fact* can change — and
        # because it is the only one that runs on an install holding nothing at
        # all, where the backfill returns before doing anything.
        self.review_installation_facts()

    # ------------------------------------------------------------------ #
    # The installation facts (issue #709)
    # ------------------------------------------------------------------ #

    def reconstruction_state(self) -> Tuple[int, int]:
        """``(series complete, series in the reconstruction)`` — process memory.

        The source of the one installation fact that is neither a file nor an
        environment variable, and it is memory rather than a query for the same
        reason ``/api/runtime`` reads none: ``_backfill_complete`` is where
        "this pass has reached its first acquisition" lives, and no row
        anywhere says it — a symbol Yahoo answers nothing about has a completed
        pass and an empty series.

        **This method never answers ``None``**, and that is the whole of it:
        across the seam ``None`` means :data:`installation_facts.UNOBSERVED` —
        *this process cannot see the scheduler* — and it is
        :func:`installation_fact_context` alone that says it, for a caller
        holding no ``metrics`` at all. Nothing ever held is ``(0, 0)``: an
        observation, made from here, saying there is no reconstruction to run.
        A fresh install still announces no reprise d'historique —
        ``_observe_reconstruction`` stands the installation fact down on
        ``total <= 0`` exactly as it does on a finished one — but it *stands it
        down* instead of leaving it untouched, which is what the criterion
        demands: forgetting every import while the reconstruction was armed
        used to leave its row standing for ever, on a portfolio that no longer
        names a single symbol.
        """
        windows = self.config_manager.current().backfill_windows()
        now = datetime.now(timezone.utc)
        targets = {
            symbol: carrying.holding_bounds(window[0], window[1], now)[0]
            for symbol, window in windows.items()}
        complete = sum(1 for symbol, target in targets.items()
                       if self._backfill_complete.get(symbol) == target)
        return complete, len(windows)

    def review_installation_facts(self) -> None:
        """Re-observe every installation fact, and record the one that is an
        event.

        The whole call-site pattern of the feature: the observation is made
        where the sources are — the ingest and the backfill cycle — and **never
        on a ``GET``**, an installation fact dated by the moment somebody
        happened to open a page saying nothing about when the thing it names
        started.

        Both callers see all four sources, this object being where the
        reconstruction's memory lives, so neither of them can drop a row the
        other armed. What cannot see it is a runtime with no scheduler — a boot
        that has not reached :func:`start_runtime`, a web request on one that
        never did — and :func:`installation_fact_context` answers *unobservable*
        for those rather than *finished*.

        Guarded: a store that refuses this must not take a scheduled job with it.
        A missed review costs one cycle, and the next one re-observes everything
        from scratch, there being no state to catch up on.
        """
        try:
            context = installation_fact_context(self.config_manager, self)
            with self.config_manager.writing() as opened:
                # Order matters, and only in one direction: the reconstruction
                # concluding is what *produces* the assumed-currency
                # installation fact, so it is recorded before the refresh that
                # stands its sibling down.
                if context.reconstruction_concluded:
                    installation_facts.record(
                        opened,
                        installation_facts.ASSUMED_BASE_CURRENCY, context)
                installation_facts.refresh(opened, context)
        except Exception as e:
            app_logger.error(f"Failed to review the installation facts: {e}")

    def _adopt_declared_currency(self) -> None:
        """Take up a reporting currency an import has just declared (issue #710).

        A dial reaches this process from exactly two places: the boot reads them
        all once into the attributes every cycle re-reads (``start_runtime``),
        and ``PUT /api/settings`` assigns the same attributes after writing the
        row. That pair is the whole of *"no dial requires a restart"*.

        An **import** is the third writer of one of them, and of one only: an
        exported file states its reporting currency, and a store that has none
        takes it (``ledger.currency_to_adopt``, ADR-0021). Without this line the
        row would be in the store and the running process would go on converting
        nothing until the next restart — and that is the one dial where the
        symptom is invisible, since a missing currency writes ``NULL``
        conversions rather than failing anything.

        Read after the replay and not before it: the value this looks for is
        written *by* the import that replay follows. And it is read on **every**
        ingest since #812 — a file uploaded to ``POST /api/events/import``
        declares a currency exactly as one dropped in the folder does, and that
        road comes through ``replay_after_write``, which scans no folder.
        Idempotent by the condition below, so the boot's own ingest and every
        write that changes nothing here cost one ``setting`` read.

        And it triggers the lateral pass for the same reason ``PUT
        /api/settings`` does (issue #704): this **is** the pose of the reporting
        currency, on the road a headless install actually takes, and every point
        already scraped is carrying a ``NULL`` conversion waiting for it.
        """
        stored = self.config_manager.store.setting('base_currency')
        if stored and stored != self.base_currency:
            app_logger.info(
                f"Reporting currency taken from an imported file: {stored}")
            self.base_currency = stored
            self.repair_conversions_now()

    def repair_conversions_now(self) -> bool:
        """Put the lateral pass in front of the queue (issue #704). Did it move?

        The effect of answering the reporting currency, and it is the *only*
        dial with one of this shape, because it is the only one whose value is
        **retroactive**: while it was unanswered every scrape and every rebuilt
        chunk wrote its point with ``price_converted NULL``, and those rows are
        not lost — the lateral pass gives them the column they are short of. The
        whole stock is therefore repairable the instant the question is answered,
        and what this does is make it start now rather than up to one
        ``backfill_interval`` later, on the single gesture that unblocks every
        money figure in the product.

        Two things happen, and the first is what makes the second honest. The
        back-off memory is **cleared**: a symbol backing off after a failed rate
        fetch was failing at a question that has just changed, and making it wait
        out a delay computed against the old world would be the interface
        punishing the repair. Then the backfill job's next run is advanced —
        the pass rides on it, so there is nothing else to start.

        Returns whether the job was actually moved. ``False`` on a runtime with
        no scheduler (the master, a test) is not a failure: the dial is in the
        store, the attribute is set, and the next cycle reads both.
        """
        self._lateral_retry_at.clear()
        if self.scheduler is None:
            return False
        try:
            self.scheduler.modify_job(
                BACKFILL_JOB_ID, next_run_time=datetime.now(timezone.utc))
        except Exception as e:
            app_logger.error(
                f"Failed to bring the conversion repair forward: {e}")
            return False
        app_logger.info(
            "Reporting currency answered: repairing the conversions of every "
            "price already stored")
        return True

    # ------------------------------------------------------------------ #
    # The backfill and its three passes (issue #848, :mod:`backfill`)
    # ------------------------------------------------------------------ #
    #
    # A third of this class stood here: the cycle, the retention ladder's
    # application, the three passes, the shared fetch-and-store, the conversion
    # of a fetched chunk and the unit lookup the lateral pass learns from. Each
    # name below stays reachable because the suite calls it — the passes are
    # driven one at a time by tests that seed a store and read the rows back —
    # and because the pass that runs calls its neighbours *through this object*,
    # so a method replaced on the instance is traversed rather than stepped
    # over.

    def backfill(self, now: Optional[datetime] = None):
        """Rebuild the past, one cycle: the ladder, then three passes a symbol.

        :meth:`backfill.BackfillWorkload.run` (issue #848) — the callable the
        ``backfill`` interval job is armed on, and the one clock the whole
        cycle reads (issue #705).
        """
        return self._backfill.run(now)

    def _backfill_symbol(self, symbol: str,
                         window: Tuple[date, Optional[date]],
                         held: bool, now: datetime) -> Tuple[int, int]:
        """Run the three passes over one symbol's holding window.

        :meth:`backfill.BackfillWorkload.backfill_symbol` (issue #848), and the
        one place the three are gated apart. Returns ``(points written,
        conversions repaired)``.
        """
        return self._backfill.backfill_symbol(symbol, window, held, now)

    def _fetch_and_store(self, symbol, start_date, end_date):
        """Fetch one ``[start, end]`` chunk and, if non-empty, write it.

        :meth:`backfill.BackfillWorkload.fetch_and_store` (issue #848) — the
        shared tail of the two filling passes, conversion and politeness delay
        included. The write itself is still :mod:`quotes`', the single writer
        of the market tables (ADR-0006).
        """
        return self._backfill.fetch_and_store(symbol, start_date, end_date)

    def _backward_anchor(self, symbol: str, ceiling: datetime) -> datetime:
        """Where the backward pass resumes from — the oldest window tried.

        :meth:`backfill.BackfillWorkload.backward_anchor` (issue #848), whose
        minimum-of-three is :func:`carrying.backward_anchor`'s since #706.
        """
        return self._backfill.backward_anchor(symbol, ceiling)

    def _convert_history(self, symbol: str, prices: List[Dict]) -> None:
        """Stamp a fetched chunk with its converted price and rate, in place.

        :meth:`backfill.BackfillWorkload.convert_history` (issue #848).
        """
        return self._backfill.convert_history(symbol, prices)

    def _backfill_backward(self, symbol: str, target: datetime,
                           ceiling: datetime,
                           now: Optional[datetime] = None) -> int:
        """Backward pass: extend the series toward the first acquisition.

        :meth:`backfill.BackfillWorkload.backward` (issue #848) — one of the
        three named entry points, and the one that says when a symbol's history
        is finished, through :func:`carrying.is_terminal` and nowhere else.
        """
        return self._backfill.backward(symbol, target, ceiling, now)

    def _collapse_to_ladder(self, now: datetime) -> int:
        """Age the stored series onto the ladder, guarded like every other write.

        :meth:`backfill.BackfillWorkload.collapse_to_ladder` (issue #848). The
        rungs and the walls stay :mod:`retention`'s, which is pure: what joined
        the backfill is the *application* of the ladder and never the rule.
        """
        return self._backfill.collapse_to_ladder(now)

    def _record_window_tried(self, symbol: str, oldest: date) -> None:
        """Persist the backward pass's anchor, guarded like every other write.

        :meth:`backfill.BackfillWorkload.record_window_tried` (issue #848).
        """
        return self._backfill.record_window_tried(symbol, oldest)

    def _backfill_forward(self, symbol: str,
                          now: Optional[datetime] = None) -> int:
        """Forward pass: recover a session missed while the app was down.

        :meth:`backfill.BackfillWorkload.forward` (issue #848).
        """
        return self._backfill.forward(symbol, now)

    def _learn_quote_currency(self, symbol: str) -> Tuple[Optional[str], bool]:
        """Ask Yahoo what unit a symbol is quoted in. ``(currency, failed)``.

        :meth:`backfill.BackfillWorkload.learn_quote_currency` (issue #848) —
        the lateral pass's exit for a symbol the live scrape never meets.
        """
        return self._backfill.learn_quote_currency(symbol)

    def _backfill_lateral(self, symbol: str) -> int:
        """Lateral pass: give the stored points the conversion they lack (#704).

        :meth:`backfill.BackfillWorkload.lateral` (issue #848), whose two
        stopping conditions stay told apart by the fact that a rate series
        **raises** where an unresolvable pair answers empty.
        """
        return self._backfill.lateral(symbol)

    def scrape(self):
        """Scrape stock prices from Yahoo Finance and expose metrics.

        :meth:`scrape.ScrapeWorkload.scrape` (issue #847) — the synchronous
        whole-portfolio path kept for the e2e harness.
        """
        return self._scrape.scrape()

    # ``_midnight`` left with the type it worked around (issue #700). A perf
    # point was stamped at midnight UTC because InfluxDB had one kind of time
    # and every reader then had to un-stamp it; the store has two and never
    # mixes them, so the day is a ``DATE`` and there is nothing to convert.

    @staticmethod
    def _value_kwargs(dp, last: bool, perf) -> dict:
        """Shared value + perf fields for a metric point built from a DailyPerf.

        ``twr_index`` and ``gain_absolu`` are per-day; ``xirr`` alone lands on
        the latest point.

        **``gain_absolu`` used to land there too, and that was the defect**
        (issue #782). It is ``total_value − contributions`` and both terms are
        known on every day the series carries, so the restriction bought
        nothing — while ``portfolio_view._ytd`` counts the movement of this
        field between the year's base day and the latest one, and the base day
        is by construction never the latest. The year-to-date gain was
        therefore ``null`` on every real install, on a figure entirely
        computable from two columns written daily. ``xirr`` keeps the
        restriction because it does not have that shape: it is annualised over
        the whole history against one terminal value, so it genuinely has one
        value and not a series of them.

        **The per-field rule is applied here, once** (issue #708): a field the
        entity may not publish is written as ``None`` — therefore as ``NULL``,
        therefore as a ``null`` on the wire — rather than as a zero that every
        ``sum()`` would count. One site for the two tables, because the rule is
        by *field* and the account and the global carry the same seven.
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
            gain_absolu=dp.gain_absolu,
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
        """Rebuild the perf cache — **one pass at a time** (issue #812).

        A thin wrapper, and the lock is the whole of it. :meth:`_rebuild_series`
        below carries the design; what is decided *here* is that two of them
        never overlap, and that became a question the day the recompute stopped
        having a single caller.

        Until #812 the only one was the ``perf`` interval job, and APScheduler's
        ``max_instances=1`` made an overlap impossible on its own. The replay
        that follows the write is a **request thread** (the WSGI pool ``boot.py``
        sizes), so two passes are now ordinary: two writes at once, or a write
        landing while the tick is mid-flight.

        Overlapping is not merely wasteful, it is **destructive**, and the shape
        of the damage is the one this ticket exists to prevent. The pass reads
        and computes outside any mutex and takes ``writing()`` only for its final
        upsert-and-prune, so the *last* transaction to commit wins — and
        :func:`perf_series.prune_account_metrics` is bounded by **that pass's own
        spans**. A tick that started before a back-dated event was recorded would
        therefore commit second with the old ledger's spans and *delete the years
        of history the request had just written*, leaving the screen wrong until
        the next tick.

        The lock is held across read, compute **and** write, which is what makes
        the ordering total: whoever acquires last reads last, so the series that
        stands is always the one computed from the freshest ledger. What it costs
        is a queue: with four request threads and the tick there are five
        possible callers, and ``threading.RLock`` is not fair, so a write can
        wait out several full rebuilds — 460 ms each over five years (ADR-0011).
        That is the price of a cache that cannot silently lose a decade, and it
        is bounded by the number of callers rather than by anything unbounded.

        It is a lock over *this pass* and not over the store. It **is** held
        while :meth:`_rebuild_series` takes ``config_manager.writing()`` — that
        is its ordinary path, not an exception — so what keeps the pair safe is
        the single ordering: ``_perf_lock`` then ``writing()``, and no path takes
        them the other way round. Every ``replay_after_write`` call site sits
        outside its own ``with writing()`` block, which is what makes that true
        by inspection.
        """
        with self._perf_lock:
            return self._rebuild_series()

    def _rebuild_series(self) -> Dict[str, Optional[date]]:
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
        towards the left as the reconstruction walks back. Outside the horizon
        nothing at all is written — not a zero, not a ``NULL`` row — because a
        held position with no price yet would be counted as worth nothing beside a
        cash ledger that has already paid for it, and a time-weighted index chains
        that crater forward for the whole cycle.

        **The horizon has two ends since #765** (:class:`performance.Horizon`).
        A block of unpriced days sitting at *today* — an ordinary purchase of a
        security the portfolio did not hold yet — used to push the left bound
        past today, so the cycle produced no point for anybody and the prune,
        doing exactly what it is written for, emptied the table: **years of
        history deleted by a purchase**. It is now treated where it is: the
        series stops the day before it, the dashboard keeps its history, its
        last point is a day old and the next cycle catches up.

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
        ``performance.py``; ``xirr`` alone lands only on the latest point (#782).
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

        # **One clock for the whole cycle**, the rule #705 gave ``backfill()``:
        # a recompute that straddles UTC midnight read one ``now`` for the
        # horizons and their caps and a second one for the holding windows
        # ``terminal_symbols`` measures, so the two were a day apart and the
        # cycle stated its figures against two different todays.
        now = datetime.now(timezone.utc)
        today = now.date()
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
            # **One scan of ``price_point`` for all of them** (issue #844), and
            # not one per symbol. :func:`quotes.price_series` is a
            # ``WHERE symbol = ?`` on a table that carries neither index nor key
            # (ADR-0007) and is not clustered by symbol, so each call reads it
            # whole: a forty-line portfolio paid forty full scans every 120 s
            # *and* again after every ``/api`` write (``replay_after_write``),
            # each of them holding the single connection's ``RLock`` and so the
            # request threads with it. It is the argument ``collapse_to_ladder``
            # already writes down — one statement partitioned by symbol pays for
            # one scan where N calls pay for N — applied where it had not been.
            #
            # Nothing about the figures moves, because the aggregated read says
            # the same thing word for word: same ``price_converted IS NOT NULL``
            # filter, same column, same survivor of the day (the last point,
            # ``ts DESC``), partitioned by ``(day, symbol)`` instead of by day
            # alone. Only the return shape differs, and the grouping below is
            # the whole of the change: ``ORDER BY day, symbol`` means each
            # symbol's list is already ascending by day, which is what
            # ``state_at`` reads.
            #
            # A symbol the ledger never names is **dropped** rather than kept:
            # ``oldest_priced`` under the horizon is read off this very table,
            # and a price observed for a line nobody ever held is not a day this
            # replay may be blocked on. A ledger symbol with no converted price
            # is **absent** from the table rather than present-and-empty —
            # ``price_at`` tells the two apart, and absence is what means *no
            # price*, never zero.
            price_pairs: Dict[str, List[Tuple[date, float]]] = {}
            for close in store_reads.PortfolioReader(store_handle).daily_closes():
                if close['symbol'] in symbols:
                    price_pairs.setdefault(close['symbol'], []).append(
                        (close['day'], float(close['price'])))

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
                store_handle, holding_windows(events, held), now)
            # And its **first** term, which ``price_at`` cannot supply: that
            # callable reads ``price_converted``, so a symbol whose pair does not
            # resolve is priceless to it while its quote is known. Carrying those
            # would answer a valuation where the app owes *waiting for a rate*
            # (#706, repaired in the store by #704). Since #773 the read also
            # asks whether that quote has a **unit**: a stored ``price_native``
            # with no ``symbol_quote.currency`` is a number no rate can turn into
            # money, so it is not a quote for a valuation and the position is
            # carried at its cost instead of counting zero for ever.
            first_quoted = quotes.first_quoted_days(store_handle)

            start = min(e.date for e in events)

            # --- the sliding horizon and its cap (issues #708, #765) ---------
            # The oldest **usable** price of each symbol, which is the oldest day
            # ``price_at`` can answer for: ``daily_closes`` is converted-only, so
            # a symbol quoted in a currency whose conversion has not landed is
            # absent here while being perfectly well quoted. It therefore blocks,
            # and that is the honest reading — the absence is transitory, lifted
            # by #704's lateral pass rather than by any cycle of the backward
            # one, and under the horizon no day is written at all rather than
            # written with the position counted at nothing.
            oldest_priced = {symbol: pairs[0][0]
                             for symbol, pairs in price_pairs.items() if pairs}
            # **Settled is terminal *and* valuable**, which is one condition
            # and used to be written as two halves that between them let the
            # opposite through. A symbol settles a day only if that day can
            # actually carry a figure: either its conversion has landed (it is
            # in ``oldest_priced``), or no quote of it was ever observed in a
            # nameable unit — in which case ADR-0004 carries it at its own cost
            # and the figure is real.
            #
            # What is excluded is the third shape: **quoted, in a unit, and
            # never converted**. ``carrying_price`` refuses it on purpose (#706
            # — a security whose quote is known and whose rate is not is
            # *waiting*, not priceless), so ``price_at`` answers ``None`` and
            # the position counts **zero** beside a cash ledger that has already
            # paid. Settling it published exactly the crater #708 measured:
            # ``twr_index`` 0,057 and a head reading −100 % on a portfolio worth
            # eleven thousand euros. Blocking is the honest reading — an account
            # holding a security it cannot value in the reporting currency
            # cannot state its performance, and ``unconvertible`` is the notice
            # that asks the owner to act. The block lifts by itself the moment
            # #704's lateral pass lands a rate.
            settled = {symbol for symbol in carried
                       if symbol in oldest_priced or symbol not in first_quoted}
            writable = {
                account.id: performance.account_horizon(
                    self._holding_windows(timeline, account.id, symbols, today),
                    oldest_priced, settled, start=start, ceiling=today)
                for account in declared
            }
            # What travels to ``/api/runtime`` is the left end, unchanged in
            # meaning by #765: *the first day this account's figures may be
            # written*. The cap stays here — it is a property of the days this
            # cycle produced, which the rows themselves already state.
            #
            # **Bounded to the accounts the ledger names**, so this list and
            # ``/api/accounts`` cannot disagree about which accounts exist.
            # ``read_accounts`` hands back every row of the table, seed
            # included, and ADR-0013 writes ``default`` at creation and never
            # removes it: on an install that has declared its own accounts, the
            # seed is a row nothing names, so ``/api/accounts`` drops it while
            # this list carried it with a horizon of its own. Two resources
            # answering *which accounts are there* two ways, on the resource
            # whose job is to explain the other.
            named = {event.account for event in events if event.account}
            horizons = {account_id: span.first
                        for account_id, span in writable.items()
                        if account_id in named}

            def _from(account_id: str) -> date:
                """Where this account's series begins: its horizon, never before
                the ledger's own first day."""
                horizon = writable[account_id].first
                return start if horizon is None else max(start, horizon)

            def _to(account_id: str) -> date:
                """Where it stops: its cap, and today when nothing caps it.

                A block reaching today is treated *where it is* (issue #765): the
                series stops the day before it rather than starting the day after
                it, which is what keeps a purchase of a security the portfolio
                did not hold yet from deleting every year it owns.
                """
                cap = writable[account_id].last
                return today if cap is None else cap

            per_account = {
                account.id: performance.compute_account(
                    timeline, account, symbols, price_at, _from(account.id),
                    _to(account.id), carried, first_quoted)
                for account in declared
            }
            # The global takes the **max** of the horizons and the **min** of the
            # caps: it is written only where every account is, since a sum
            # missing one of its terms draws a step nothing caused — upwards on
            # the left, downwards on the right. An account with neither does not
            # move either end — it has nothing waiting for a price.
            bounds = [span.first for span in writable.values()
                      if span.first is not None]
            caps = [span.last for span in writable.values()
                    if span.last is not None]
            total = performance.compute_portfolio_total(
                timeline, declared, symbols, price_at,
                max([start] + bounds), min([today] + caps), per_account)

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

        # The gauges that mirrored ``latest_by_account`` and the global point
        # left with the exporter (ADR-0033). What they were guarding against —
        # *"an entity that stops producing rows must stop publishing figures"* —
        # is guarded by the two prunes in the transaction above and by nothing
        # else now: the store holds only what this cycle produced, and the API
        # serves the store.

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

    def close(self):
        """Release what this object owns — which since #700 is nothing.

        The InfluxDB client left with the database, and the store's connection
        was never this object's to close: it belongs to the ``Runtime`` and is
        closed **last** by :func:`shutdown_runtime`, once nothing is left running
        that could still write into it. The method survives because
        :func:`shutdown_runtime` calls it, and a teardown that has to know which
        objects have one is a teardown that will one day forget one.
        """


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
        self.metrics: Optional['SuiviBourseMetrics'] = None
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

    # Init SuiviBourseMetrics. The store is not passed at all — the manager owns
    # it, and with it the mutex that keeps a write whole against a concurrent
    # ingestion.
    sb_metrics = SuiviBourseMetrics(
        runtime.config_manager,
        recorder=runtime.recorder)
    sb_metrics.apply_dials(dials)
    runtime.metrics = sb_metrics

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
        sb_metrics.shares, sb_metrics.read_exchange_of())
    # Wire the scheduler before bootstrapping so ingest() can arm the
    # per-symbol scrape jobs (issue #616). Their immediate first fire IS the
    # bootstrap — no separate initial scrape. Background, not Blocking: uvicorn's
    # event loop owns the foreground.
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

    **And it carries the performance with it** (issue #812, ADR-0032). The
    positions followed the write from the start; the series waited for the
    ``PERF_TICK``, so correcting a mistake made in 2019 left every curve exactly
    as it was for up to two minutes — during which *taken*, *taken wrong* and
    *not taken yet* were one screen. The recompute is
    :meth:`SuiviBourseMetrics.recompute_perf` and not
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
    if runtime.metrics is not None:
        runtime.metrics.ingest(force=True)
        runtime.metrics.recompute_perf()
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
    if runtime.metrics is not None:
        runtime.metrics.close()
    # The store last: it is the thing every job was writing into, so it closes
    # once nothing is left running to write.
    if runtime.store is not None:
        runtime.store.close()
        runtime.store = None
