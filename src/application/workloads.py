"""The four workloads and the state they share (issue #850).

ADR-0033 took ``/metrics``, the exporter and the second socket out of the
product; #847 to #849 then carried the scrape, the backfill and the performance
recompute out of the runtime class one at a time. What this file holds is what
was left after those four gestures — and it is not a shell, which is why the
class was **renamed rather than dissolved**: the dials every cycle re-reads, the
exchange rate cache, the scheduler handle, the last-pass recorder and the perf
pass lock each have exactly one instance per process, and a workload holding its
own copy of any of them is a bug with a name (a second answer to *what currency
is this install reporting in*, two passes overlapping, a rate wave that does not
add up to its own total).

Below the constructor the file is almost entirely **windows**: properties onto
the state a workload owns, and one-line forwards onto the methods it carries.
Both exist for the same reason, stated once here rather than thirty-six times
below — **a workload calls its collaborators through this object**, so a method
replaced on this instance is traversed by the pass rather than stepped over, and
the suite replaces methods on this instance. A forward whose body is one line is
therefore not ceremony; it is the seam.
"""
import threading
from datetime import date, datetime
from typing import Dict, List, Optional, Set, Tuple

from apscheduler.schedulers.background import BackgroundScheduler

from application import backfill
from application import fx
from application import ingestion
from application import market
from application import perf_job
from application import runtime_state
from application import scheduling
from application import scrape
from application import settings_registry
from application import share_info


class Workloads:
    """The four workloads, and the state they share (issue #850).

    Five things live here and have exactly one instance per process: the
    **dials** every cycle re-reads (issue #701, ADR-0014) — the reporting
    currency above all, which a ``PUT`` and an import both move; the **exchange
    rate cache** (issue #702, ADR-0002), whose TTL is what makes one
    market-open wave share one rate per pair; the **scheduler handle** and the
    **last-pass recorder**, which the four workloads and the web handlers read
    the same instance of; and the **perf pass lock** (issue #812), which is
    single or it is nothing.

    And the four workloads, constructed here and handed what they share:
    :class:`scrape.ScrapeWorkload`, :class:`backfill.BackfillWorkload`,
    :class:`perf_job.PerfJob` and :class:`ingestion.IngestionWorkload`.
    """

    def __init__(self, config_manager,
                 recorder: Optional[runtime_state.RuntimeRecorder] = None):
        self.config_manager = config_manager

        # The store is reached through the manager and never held as a second
        # reference (issue #700): the manager already owns the connection *and*
        # the mutex that keeps a transaction whole, and a second handle here
        # would be a second answer to "which generation of the ledger is this
        # job looking at".

        # The dials (issue #701, ADR-0014). Constructed at the **code's** values
        # and overwritten by the store in ``start_runtime``, which is the only
        # order that keeps the registry the single list: an object that read the
        # store here would need one, and a test that builds one directly would
        # need a store to build it. Each is a plain mutable attribute every
        # cycle re-reads, which is what makes a saved dial take effect with no
        # restart — the write path assigns it and the next pass reads it.
        #
        # *Which* dials, what each is worth and what each does is
        # :data:`settings_registry.SETTINGS` and is not restated here: a list
        # spelled here as well as in the registry is the second list ADR-0014
        # exists to forbid, and it would be the copy nobody updates. The loop
        # below is why five attributes appear on this object without a literal
        # anywhere naming them.
        #
        # One of them is declared all the same, and only because it is the one
        # dial with **no default**: ``base_currency`` is legitimately ``None``
        # and every write path reads that as *"nothing has a unit yet"* —
        # prices are still fetched and stored natively, nothing is converted,
        # and no performance figure is written at all (issue #702, ADR-0002).
        self.base_currency: Optional[str] = None
        self.apply_dials(settings_registry.defaults())

        # One perf recompute at a time (issue #812). See
        # :meth:`update_account_metrics` for why this stopped being free the day
        # the replay that follows the write started recomputing the series.
        # **Reentrant**, so ``recompute_perf`` can hold it across the rebuild
        # *and* the record it publishes about that rebuild, while the rebuild
        # goes on taking it for a caller who reaches it directly.
        #
        # **It stays here rather than moving with the workload** (issue #849):
        # there is one pass lock per runtime, the perf job below borrows this
        # object, and a lock built inside that job would become a second one the
        # day anything constructed a second job — two passes overlapping, and a
        # prune bounded by its own pass's spans deleting the years the other had
        # just written.
        self._perf_lock = threading.RLock()

        # The exchange rate (issue #702, ADR-0002). A TTL cache in front of two
        # yfinance fetches, and the TTL is what makes a market-open wave share
        # **one** rate per pair: converted at N slightly different rates, the
        # positions of one wave would not add up to their own total. It is
        # deliberately not a job and not a pseudo-symbol in the scheduler — a
        # currency pair has no ``marketState`` that projects onto the equity
        # cadence model — and there is no ``fx_rates`` table: the rate that was
        # used is stored on the point it produced.
        self.rates = fx.Rates(market.pair_rate, market.pair_series)

        # Market-aware per-symbol scheduling (issue #616). Each held symbol runs
        # as its own self-rescheduling APScheduler job; the scheduler is assigned
        # by ``start_runtime`` (None until then, so unit tests that never wire it
        # skip reconciliation). `regular_interval` is the REGULAR-state poll cadence
        # (base_interval), and it is also the base of the #617 back-off — so
        # changing it rescales, retroactively, the wait of a symbol that is
        # already failing. It is set by `apply_dials` above and **not** repeated
        # here: a literal at this line would win over the registry it just read,
        # and would go on agreeing with it only until the registry's default
        # changed.
        self.scheduler: Optional[BackgroundScheduler] = None

        # The per-symbol ``info`` cache, built **here** and handed to the two
        # workloads that read it — the scrape (issue #847) and the backfill
        # (#848). One object because it is one memory: two caches would put the
        # same question to Yahoo twice, and a read of the store cannot answer it
        # at all, ``symbol_quote`` carrying neither the market state nor the
        # trading period. Its two gestures are named apart in :mod:`share_info`
        # — the live fetch's *observed*, the unit lookup's *learned* — because
        # the asymmetry between them is load-bearing.
        #
        # A local and not an attribute: it is *handed over*, and the property
        # below is what reads it back. An attribute here would be a second
        # reference, and a later assignment to it would split the memory in two
        # — the scrape observing into one object while the backfill learns from
        # another.
        info_cache = share_info.ShareInfoCache()

        # The scrape workload (issue #847, :mod:`scrape`). The state that is
        # the scrape's alone — the #617 counters, the #628 sonde and their locks
        # — lives there, and the five properties below this constructor are the
        # windows this class keeps open onto it.
        self._scrape = scrape.ScrapeWorkload(self, info_cache)

        # The backfill workload (issue #848, :mod:`backfill`), handed the
        # **same** ``info_cache``: the unit its lateral pass learns is the unit
        # the scrape's fetch observes into, and that is #847's other half. The
        # memory the three passes share lives there — the symbols whose backward
        # pass has reached its first acquisition, the lateral pass's back-off,
        # and the symbols Yahoo named no currency for — under three more of the
        # windows below.
        self._backfill = backfill.BackfillWorkload(self, info_cache)

        # The performance workload (issue #849, :mod:`perf_job`). The one that
        # writes nothing itself: the four statements of a cycle are
        # :mod:`perf_series`', which is why the orchestration is its own module
        # rather than the writer's tail.
        #
        # **Constructed once**, and that is the whole of what keeps the pass
        # lock single: the job borrows :attr:`_perf_lock` above rather than
        # building one, so a second job object would be a second lock, two
        # passes could overlap, and the prune — bounded by its own pass's spans
        # — would delete the years the other had just written.
        #
        # Not named ``_perf_job``, and that is deliberate rather than a slip:
        # #707's rule is that the scrape signals nothing to the perf job, and
        # the suite holds it by reading this instance for ``_perf*`` names —
        # of which there is exactly one, the lock. A second would weaken a
        # guard that is worth more than symmetry with the two names above.
        self._recompute = perf_job.PerfJob(self)

        # There is **no perf state here**, and its absence is the ticket (issue
        # #707, ADR-0011). Four attributes stood at this line and all four
        # served one gate that decided whether recomputing was worth it. The two
        # tables are a cache and the recompute is integral every cycle, so
        # nothing about the *past* is worth remembering — and the last coupling
        # between the backfill and the perf went with the memory of it.

        # The last-pass records (issue #668, design #656). Injected from the
        # ``Runtime``, which builds it, so the web handlers reach the *same*
        # recorder the jobs write to. Defaulted here so a unit test that builds
        # this class directly still has somewhere to publish, and so no call
        # site below has to check for None.
        self.recorder = recorder or runtime_state.RuntimeRecorder()

        # The ingestion workload (issue #850, :mod:`ingestion`). The fourth,
        # and the one that is **not a job**: it runs at the boot and after a
        # write, never on a timer (#697). Built last because it is the only one
        # that reads the three above — it reconciles the scrape's jobs, it
        # reports the backfill's progress as an installation fact, and the
        # reporting currency it adopts from an imported file is the dial the
        # perf recompute gates on. It owns no state, so nothing below this
        # constructor is a window onto it.
        self._ingestion = ingestion.IngestionWorkload(self)

    # ------------------------------------------------------------------ #
    # The scrape's own state, seen from here (issue #847)
    # ------------------------------------------------------------------ #
    #
    # The three *memories* that left with the workload. A window and never a
    # second copy: a copy would be a second answer to "how many times has this
    # symbol failed", and the #617 back-off is the one guard that cannot afford
    # two. The ``info`` cache is here for one reason more: **two** workloads
    # hold it since #848, so the setter assigns both — one that moved only the
    # scrape's would split the memory under the one name that looks like it
    # cannot happen.
    #
    # The **two locks that guard them are not windowed** (#862). There were
    # windows onto them, read by nobody, and the door was worse than shut: the
    # facade is not where the synchronisation happens, and a name here saying
    # ``_failure_counts_lock`` invited a caller to take the lock at the level
    # above the state it guards. :mod:`scrape` takes its own locks, beside the
    # dictionaries they stand for.

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
    def _sonde_state(self) -> Dict[str, scheduling.SondeState]:
        return self._scrape.sonde_state

    @_sonde_state.setter
    def _sonde_state(self, state: Dict[str, scheduling.SondeState]) -> None:
        self._scrape.sonde_state = state

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

    # ``validate()`` left with ``schema.yaml`` (issue #696): it could only ever
    # answer True, a published snapshot being validated by construction (#658).

    # ------------------------------------------------------------------ #
    # The exchange rate (issue #702, ADR-0002)
    # ------------------------------------------------------------------ #
    #
    # Two methods stood here and each wrapped one :mod:`market` function under
    # a second copy of its docstring. #846 gave the market one door and both
    # reasons live behind it now (:func:`market.pair_rate`,
    # :func:`market.pair_series`), so the constructor injects them straight into
    # :attr:`rates` and #850 took the wrappers away. What is left below is the
    # one thing that was never the market's: the dial.

    def _convert(self, price, currency: Optional[str],
                 at: Optional[date] = None) -> Tuple[Optional[float], Optional[float]]:
        """``(converted, rate)`` for one observed price, in one call.

        The single place a write path asks the currency question, so that no
        writer has to remember the order of *"is there a reporting currency"*
        and *"is there a rate"*. Both answers are ``None`` together, and the
        caller writes the point anyway.
        """
        return fx.convert(price, currency, self.base_currency, self.rates, at)

    # ------------------------------------------------------------------ #
    # The dials (issue #701, ADR-0014)
    # ------------------------------------------------------------------ #

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

    # ------------------------------------------------------------------ #
    # The scrape (issue #847, :mod:`scrape`)
    # ------------------------------------------------------------------ #
    #
    # Every name the scrape pass traverses, and it traverses them **from here**.
    # Two of them are what the suite replaces when it wants the market to fail:
    # :meth:`_fetch_ticker_data` for a live quote and :meth:`_fetch_historical_data`
    # under the backfill below. The rest are named because the pass calls them,
    # or because the boot and the settings write path do.

    def _fetch_ticker_data(self, symbol: str, max_retries: int = 3):
        return self._scrape.fetch_ticker_data(symbol, max_retries)

    def _write_quote(self, symbol: str, last_quote, info, now: datetime,
                     converted=None, fx_rate=None) -> bool:
        return self._scrape.write_quote(symbol, last_quote, info, now,
                                        converted, fx_rate)

    def _held_symbols(self) -> set:
        return self._scrape.held_symbols()

    def _scheduled_symbols(self) -> set:
        return self._scrape.scheduled_symbols()

    def _arm_symbol(self, symbol: str, delay: float, now: datetime) -> None:
        return self._scrape.arm_symbol(symbol, delay, now)

    def _last_pass_closed(self, symbol: str) -> Optional[bool]:
        return self._scrape.last_pass_closed(symbol)

    def _reconcile_jobs(self) -> None:
        return self._scrape.reconcile_jobs()

    def _check_price_freshness(self, symbol: str,
                               live_price, now: datetime) -> bool:
        return self._scrape.check_price_freshness(symbol, live_price, now)

    def _scrape_symbol(self, symbol: str, now: Optional[datetime] = None) -> None:
        """Scrape one symbol and re-arm its job — what every job is armed on."""
        return self._scrape.scrape_symbol(symbol, now)

    def scrape_held(self):
        """Fetch and store every held symbol's quote, once — the e2e driver.

        It was ``expose_metrics`` until #850, Prometheus' last word in the tree:
        nothing has been exposed to anybody since ADR-0033.
        """
        return self._scrape.scrape_held()

    def scrape(self):
        """The same pass, refusing to run on an empty portfolio."""
        return self._scrape.scrape()

    def read_exchange_of(self) -> Dict[str, Optional[str]]:
        """Each held symbol's venue, for the pool sizing (#851, #619)."""
        return self._scrape.read_exchange_of()

    def rearm_regular_scrapes(self) -> Tuple[int, int]:
        """``(reached, at_market_open)`` for a new ``regular_interval`` (#701)."""
        return self._scrape.rearm_regular_scrapes()

    # ------------------------------------------------------------------ #
    # The backfill and its three passes (issue #848, :mod:`backfill`)
    # ------------------------------------------------------------------ #
    #
    # A third of this class stood here: the cycle, the retention ladder's
    # application, the three passes, the shared fetch-and-store, the conversion
    # of a fetched chunk and the unit lookup the lateral pass learns from. The
    # passes are driven one at a time by tests that seed a store and read the
    # rows back, and each pass calls its neighbours through this object — which
    # is why all twelve names survive as windows.

    def _fetch_historical_data(self, symbol: str, start: datetime, end: datetime,
                               max_retries: int = 3) -> Optional[List[Dict]]:
        return self._backfill.fetch_historical_data(symbol, start, end,
                                                    max_retries)

    def _backfill_symbol(self, symbol: str,
                         window: Tuple[date, Optional[date]],
                         held: bool, now: datetime) -> Tuple[int, int]:
        return self._backfill.backfill_symbol(symbol, window, held, now)

    def _fetch_and_store(self, symbol, start_date, end_date):
        return self._backfill.fetch_and_store(symbol, start_date, end_date)

    def _backward_anchor(self, symbol: str, ceiling: datetime) -> datetime:
        return self._backfill.backward_anchor(symbol, ceiling)

    def _convert_history(self, symbol: str, prices: List[Dict]) -> None:
        return self._backfill.convert_history(symbol, prices)

    def _backfill_backward(self, symbol: str, target: datetime,
                           ceiling: datetime,
                           now: Optional[datetime] = None) -> int:
        return self._backfill.backward(symbol, target, ceiling, now)

    def _collapse_to_ladder(self, now: datetime) -> int:
        return self._backfill.collapse_to_ladder(now)

    def _record_window_tried(self, symbol: str, oldest: date) -> None:
        return self._backfill.record_window_tried(symbol, oldest)

    def _backfill_forward(self, symbol: str,
                          now: Optional[datetime] = None) -> int:
        return self._backfill.forward(symbol, now)

    def _learn_quote_currency(self, symbol: str) -> Tuple[Optional[str], bool]:
        return self._backfill.learn_quote_currency(symbol)

    def _backfill_lateral(self, symbol: str) -> int:
        return self._backfill.lateral(symbol)

    def backfill(self, now: Optional[datetime] = None):
        """One cycle — the ladder, then three passes a symbol (issue #705)."""
        return self._backfill.run(now)

    # ------------------------------------------------------------------ #
    # The performance recompute (issue #849, :mod:`perf_job`)
    # ------------------------------------------------------------------ #
    #
    # Fewer windows than above, and the four that are missing are the pure
    # ones: ``value_kwargs``, ``account_holding_windows``, ``spans`` and
    # ``scrape_verdict`` are module functions their passes call by name (#850).
    # The façade rule exists so the suite can replace a method *on this
    # instance*; a module function has none to replace, and both callers run the
    # same code object either way.
    #
    # ``_midnight`` left with the type it worked around (#700), and
    # ``_mark_perf_dirty`` / ``_consume_perf_dirty_from`` with the incremental
    # window they bounded (#707): the whole series is recomputed and upserted
    # every cycle, so there is no tail to remember.

    def _rebuild_series(self) -> Dict[str, Optional[date]]:
        """The pass itself — the seam the suite watches for overlap."""
        return self._recompute.rebuild_series()

    def update_account_metrics(self) -> Dict[str, Optional[date]]:
        """Rebuild the perf cache — **one pass at a time** (issue #812).

        The lock it takes is :attr:`_perf_lock`, held on *this* object and
        borrowed by the job: two passes overlapping would let the second to
        commit prune away the history the first had just written.
        """
        return self._recompute.update_account_metrics()

    def recompute_perf(self) -> None:
        """Rebuild the perf cache, in full, every cycle — **guarded** (ADR-0011).

        What the ``perf`` job is armed on and what :func:`main.replay_after_write`
        calls, so a failed rebuild is a ``PERF_FAILED`` record and never a
        ``500`` on a write the store has already accepted.
        """
        return self._recompute.recompute()

    # ------------------------------------------------------------------ #
    # The ingestion (issue #850, :mod:`ingestion`)
    # ------------------------------------------------------------------ #
    #
    # The workload that is not a job. ``reload()`` used to live here too,
    # assigning ``self.shares`` from a forced load and thereby bypassing
    # validation entirely — the one path that could publish a rejected
    # configuration. ``ConfigurationManager.reload(force=True)`` is the
    # publisher, and this class reads what it publishes.

    def ingest(self, force: bool = False):
        """The boot's bootstrap, and the replay that follows a write (#697)."""
        return self._ingestion.ingest(force)

    def _adopt_declared_currency(self) -> None:
        return self._ingestion.adopt_declared_currency()

    def reconstruction_state(self) -> Tuple[int, int]:
        """``(complete, total)`` — never ``None``, which is *unobservable*."""
        return self._ingestion.reconstruction_state()

    def review_installation_facts(self) -> None:
        """Re-observe the installation facts, record the one that is an event."""
        return self._ingestion.review_installation_facts()

    def repair_conversions_now(self) -> bool:
        """Put the lateral pass in front of the queue (issue #704). Did it move?"""
        return self._ingestion.repair_conversions_now()

    # ``close()`` stood here and released nothing (issue #850). The InfluxDB
    # client left with the database and the store's connection was never this
    # object's to close — it belongs to the ``Runtime`` and is closed last by
    # :func:`main.shutdown_runtime`, once nothing is left running that could
    # still write into it. A teardown gesture that frees nothing is one more
    # thing to keep true, so the method and its call site went together.
