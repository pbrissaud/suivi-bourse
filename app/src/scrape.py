"""The scrape workload: one self-rescheduling job per held symbol (issue #847).

*What* the scrape decides is :mod:`scheduling`'s, and that module is pure — the
cadence, the market context, the back-off, the freshness step, the re-arm split.
*What it asks the market* is :mod:`market`'s, the app's one door to yfinance
since #846, and the reading of the payload it brings back is
:mod:`market_info`'s. *What it writes* is :mod:`quotes`', the single writer of
the market tables (ADR-0006). What is left — the impure orchestration that calls
those three in order — is this file, and it was spread across the runtime class
between the backfill and the performance recompute until this ticket.

The entry point is :meth:`ScrapeWorkload.scrape_symbol`: one pass over one
symbol, fetch → gates → write → record → re-arm. Everything else here is either
what arms it (:meth:`arm_symbol`, :meth:`reconcile_jobs`,
:meth:`rearm_regular_scrapes`) or what it calls on the way through.

**The workload calls its collaborators through the façade that carries it.** It
holds a reference to that object rather than the collaborators themselves, and
the reason is a property of the suite as much as of the design: several tests
replace a method *on the instance* — the fetch, the write — and expect a pass to
traverse the replacement. A workload holding references captured at construction
would step over them silently.

What it does own is the state that is the scrape's alone: the #617 failure
counters and the #628 sonde's memory, each with the lock that guards it against
the reconcile pass running in another APScheduler thread. What it is *handed* is
the one piece of state it shares with the backfill — the per-symbol ``info``
cache (:mod:`share_info`) — which is #847's other half.
"""
import logging
import random
import threading
from datetime import datetime, timezone, timedelta
from typing import Dict, Optional, Tuple

import market
import market_info
import quotes
import runtime_state
import scheduling

#: The application's own logger, by name rather than by import: :mod:`main`
#: builds it (level, handler, formatter) and this module writes to the same
#: object, so a line a scrape pass emits is the line it always was.
app_logger = logging.getLogger("suivi_bourse")


# Per-symbol scrape jobs are keyed ``scrape:<symbol>`` in the APScheduler
# jobstore (issue #616). One job per symbol — scraping is account-independent.
SCRAPE_JOB_PREFIX = 'scrape:'


def _scrape_job_id(symbol: str) -> str:
    return f'{SCRAPE_JOB_PREFIX}{symbol}'


def scrape_next_runs(scheduler) -> Dict[str, Optional[datetime]]:
    """``symbol -> next_run_time`` for the live per-symbol scrape jobs.

    The one pull from the scheduler's internals (#656 déc. 4), and it is one
    function because it has two callers that must not disagree: ``/api/runtime``
    renders these times as pills, and :meth:`ScrapeWorkload.rearm_regular_scrapes`
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


def scrape_verdict(should_write: bool, state, wrote: bool,
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


class ScrapeWorkload:
    """The scrape, whole: its state, its jobs, and the pass they run.

    ``facade`` is the object that carries the workloads — the store manager, the
    dials, the recorder, the scheduler — and every collaborator is reached
    through it (see this module's docstring). It is
    :class:`workloads.Workloads`.
    ``info_cache`` is handed in and never built here: the backfill reads the
    same one.
    """

    def __init__(self, facade, info_cache):
        self.facade = facade
        self.info_cache = info_cache

        # `failure_counts` holds the per-symbol consecutive-failure count fed to
        # scheduling.decide for the dead-ticker backoff (issue #617); it is
        # dropped in reconcile_jobs when a symbol departs so state is per-job.
        # Written by the scrape thread and popped by the ingest/reconcile thread
        # (APScheduler's default ThreadPoolExecutor runs jobs concurrently), so
        # guarded by `failure_counts_lock`: without it, an in-flight scrape of a
        # just-departed symbol could resurrect its counter after cleanup.
        self.failure_counts: Dict[str, int] = {}
        self.failure_counts_lock = threading.Lock()

        # Price-freshness liveness sonde state (issue #628). **Per symbol since
        # #700**, which took the account off the price series: staleness is
        # measured over *consecutive* REGULAR polling rather than the raw
        # wall-clock age of the stored point, which cannot tell a stuck writer
        # from a normal overnight close. Each symbol is touched only by its own
        # single scrape job (one job per symbol, max_instances=1), but the dict
        # is guarded for parity with the other cross-thread scrape state.
        self.sonde_lock = threading.Lock()
        self.sonde_state: Dict[str, scheduling.SondeState] = {}

    # ------------------------------------------------------------------ #
    # The market edge, and the writer (issue #846, ADR-0006)
    # ------------------------------------------------------------------ #

    def fetch_ticker_data(self, symbol: str, max_retries: int = 3):
        """One symbol's newest close and its attributes, and the cache's fill.

        The fetch itself is :func:`market.latest_quote` — the retries, the
        back-off and the translation of Yahoo's mapping all live at the edge
        since #846. What is left here is the **cache**: the attributes of the
        symbols this install holds, kept per symbol for the backfill to read,
        which is a memory of the portfolio and not a fact about the market. It
        is handed to this workload rather than created by it (issue #847), and
        this is the *observing* gesture — the payload a live fetch brings back
        is the richest one there is, so it replaces whatever was there.

        Returns ``(last_quote, info)``, or ``(None, None)`` if the fetch fails.
        """
        last_quote, info = market.latest_quote(symbol, max_retries)
        if info is not None:
            self.info_cache.observed(symbol, info)
        return last_quote, info

    def write_quote(self, symbol: str, last_quote, info, now: datetime,
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
        the price was multiplied by — computed once for the pass rather than at
        two instants a TTL apart.
        Both ``None`` writes the point with a ``NULL`` converted price, which is
        the ordinary state while the reporting currency is unanswered.

        Takes the writers' mutex: the write is a transaction on the one DuckDB
        connection this process owns, and an ingestion running between its
        ``BEGIN`` and its ``ROLLBACK`` in another thread would take this point
        into its own rollback.
        """
        try:
            with self.facade.config_manager.writing() as opened:
                quotes.record_quote(opened, symbol, now, last_quote,
                                    market_info.quote_columns(info),
                                    converted, fx_rate)
            return True
        except Exception as e:
            app_logger.error(f"Failed to write the quote for {symbol}: {e}")
            return False

    # ------------------------------------------------------------------ #
    # The synchronous driver (the e2e harness')
    # ------------------------------------------------------------------ #

    def scrape_held(self):
        """
        Fetch and store every held symbol's quote, once.

        Synchronous whole-portfolio scrape, kept as a driver for the end-to-end
        harness; the scheduled runtime drives per-symbol jobs via
        ``_scrape_symbol``.

        It was ``expose_metrics`` until #850 — Prometheus' last word in the
        tree, on a method that has exposed nothing to anybody since ADR-0033
        took ``/metrics`` and the exporter out of the product.

        Scoped to the **held** positions, like the scheduled path (issue #699):
        a position at zero quantity is one the app has stopped following, and
        this driver would otherwise be the one place a sold line still reached
        Yahoo.
        """
        # One snapshot for the whole pass, like every other job (issue #658):
        # the symbol set and the rows it writes have to come from the same
        # generation. The *instant*, on the other hand, is taken per symbol: a
        # pass over forty tickers takes minutes, and one ``now`` for all of them
        # would stamp the last ones at a moment they were not observed at — on
        # the table whose whole subject is when a price was seen.
        shares = self.facade.shares
        held = sorted({share['symbol'] for share in shares
                       if share.get('symbol') and share.get('quantity')})
        for symbol in held:
            last_quote, info = self.facade._fetch_ticker_data(symbol)
            converted, rate = self.facade._convert(
                last_quote, market_info.currency_of(info))

            if last_quote is None or info is None:
                app_logger.warning(
                    f"No data fetched for {symbol}, skipping the quote write")
            else:
                self.facade._write_quote(symbol, last_quote, info,
                                         datetime.now(timezone.utc),
                                         converted, rate)

    def scrape(self):
        """
        Scrape stock prices from Yahoo Finance, refusing an empty portfolio.

        Synchronous whole-portfolio path kept for the e2e harness; the scheduled
        runtime drives per-symbol jobs + the perf job.
        The perf recompute is **detached** from scrape (issue #618): it is its
        own interval job, never piggybacked here — a step of the scrape would
        fire N recomputes per market-open wave.
        """
        if not self.facade.shares:
            app_logger.warning("No shares configured, skipping scrape")
            return

        self.facade.scrape_held()

    # ------------------------------------------------------------------ #
    # The population, and the venues (issue #616, #699, #851)
    # ------------------------------------------------------------------ #

    def held_symbols(self) -> set:
        """The set of symbols currently held across all accounts.

        The filter on ``quantity`` is what finally makes this docstring true
        (issue #699, #672 D5). It used to be every symbol the configuration
        named, so a position sold four years ago went on being polled at Yahoo
        for as long as the process lived.

        **The filtering line is here and not in the timeline.** A sold position
        must stay in ``facade.shares``: the replay writes its realized gain and
        the page shows it. What departs is the scrape job — and the pair is
        free, because ``reconcile_jobs`` arms any held symbol without a live
        job, so a buy-back revives on the next replay with nothing to remember.
        """
        return {s['symbol'] for s in self.facade.shares
                if s.get('symbol') and s.get('quantity')}

    def read_exchange_of(self) -> Dict[str, Optional[str]]:
        """Map each held symbol to its venue for auto pool sizing (#851, #619).

        Same-exchange cohorts drive ``scheduling.compute_pool_size``, and this is
        the **read** that supplies them: one query on ``symbol_quote``, through
        :func:`quotes.quote_exchanges`, and no network at all.

        It was a *capture* until #851 — the design's "pre-scheduler scrape"
        (#611), one yfinance fetch per uncached symbol behind a 30-second
        deadline, run from :func:`main.start_runtime` and therefore **before the
        socket is bound**, so every second of it was a second the container
        answered neither the page nor ``/health``. What it bought was an integer
        between 4 and 10, whose fallback on failure or timeout was already 4;
        what it cost was paid at every boot since #701 deleted the flag that used
        to gate it — and the very same fetches were re-emitted, non-blocking, a
        few seconds later, ``ingest()`` arming each scrape job to fire at once.

        The store already knew. It is the same move #773 made for the currency:
        the venue is read from ``symbol_quote`` and not from the ``info`` cache,
        which is empty for the whole first cycle after every boot. The one gap
        that leaves is a symbol declared and not yet scraped successfully — and
        it answers ``None``, a **solo market**, which is precisely what the
        capture's own fallback made of it.

        Nothing held means nothing to look up: the store is not even asked.
        """
        held = self.facade._held_symbols()
        if not held:
            return {}
        return quotes.quote_exchanges(self.facade.config_manager.store, held)

    def scheduled_symbols(self) -> set:
        """Symbols that currently have a live per-symbol scrape job."""
        out = set()
        for job in (self.facade.scheduler.get_jobs() or []):
            jid = getattr(job, 'id', '') or ''
            if jid.startswith(SCRAPE_JOB_PREFIX):
                out.add(jid[len(SCRAPE_JOB_PREFIX):])
        return out

    # ------------------------------------------------------------------ #
    # Arming, re-arming, reconciling (issue #616, #619, #701)
    # ------------------------------------------------------------------ #

    def arm_symbol(self, symbol: str, delay: float, now: datetime) -> None:
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
        job *is* its own scheduler (it re-arms inside ``scrape_symbol``), so a
        misfired-and-skipped run would permanently kill the symbol and ingest()'s
        set-diff wouldn't revive it. Running late is safe — the on-wake
        ``marketState`` re-read (#608/#616) self-corrects. ``max_instances=1``
        (no overlap; ``coalesce`` is moot with one pending run per job).
        """
        jitter = random.uniform(0, scheduling.JITTER_SECONDS)
        run_date = now + timedelta(seconds=delay + jitter)
        self.facade.scheduler.add_job(
            self.facade._scrape_symbol, 'date', run_date=run_date,
            args=[symbol], id=_scrape_job_id(symbol),
            name=f'Scrape {symbol}', replace_existing=True,
            misfire_grace_time=None, max_instances=1)

    def rearm_regular_scrapes(self) -> Tuple[int, int]:
        """Re-arm the symbols a new ``regular_interval`` reaches (issue #701).

        Returns ``(reached, at_market_open)`` — the two figures the API
        publishes, and they **add up to the held portfolio**, because a
        portfolio-wide dial that reaches three symbols out of eleven has to say
        so rather than let the reader assume the other eight are broken.

        The classification is :func:`scheduling.rearm_split`'s, off the
        scheduler's own last-pass records; the re-arm is the ordinary
        :meth:`arm_symbol`, so the anti-herd jitter (#619) applies here as it
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
        if self.facade.scheduler is None:
            return 0, 0
        try:
            now = datetime.now(timezone.utc)
            held = self.facade._held_symbols()
            armed = set(scrape_next_runs(self.facade.scheduler))
            closed = {symbol: self.facade._last_pass_closed(symbol)
                      for symbol in held}
            split = scheduling.rearm_split(held, closed, armed)
        except Exception as e:
            app_logger.error(f"Failed to read the scrape jobs to re-arm: {e}")
            return 0, 0

        reached = len(split.self_arming)
        for symbol in split.rearm:
            try:
                with self.failure_counts_lock:
                    failures = self.failure_counts.get(symbol, 0)
                self.facade._arm_symbol(
                    symbol,
                    scheduling.backoff_delay(
                        self.facade.regular_interval, failures),
                    now)
                reached += 1
            except Exception as e:
                app_logger.error(f"Failed to re-arm scrape job for {symbol}: {e}")

        app_logger.info(
            f"Poll cadence is now {self.facade.regular_interval}s: {reached} "
            f"symbol(s) reached, {len(split.asleep)} waiting for their market "
            f"to open")
        return reached, len(split.asleep)

    def last_pass_closed(self, symbol: str) -> Optional[bool]:
        """Was this symbol's market shut on its last pass? ``None`` if it has none.

        One ``get`` per key, never an iteration: the records are written by the
        scrape threads, and copying the dict they are writing raises
        ``RuntimeError: dictionary changed size during iteration`` — with forty
        symbols, and only in production (#668).
        """
        record = self.facade.recorder.scrape_of(symbol)
        return None if record is None else record.closed

    def reconcile_jobs(self) -> None:
        """Diff the held-symbol set against the scheduled jobs (design #604).

        New **and** revived (missing) symbols are armed to fire immediately (the
        first fire is the bootstrap); departed symbols are ``remove_job``'d;
        unchanged symbols keep their existing timers untouched. Guarded so a
        scheduler hiccup never aborts ingestion.
        """
        if self.facade.scheduler is None:
            return
        try:
            now = datetime.now(timezone.utc)
            held = self.facade._held_symbols()
            scheduled = self.facade._scheduled_symbols()
        except Exception as e:
            app_logger.error(f"Failed to reconcile per-symbol jobs: {e}")
            return
        # Add new + revive missing in one pass: any held symbol without a live
        # job fires immediately. Remove departed symbols' idle jobs (belt-and-
        # braces with the in-flight membership re-check in scrape_symbol).
        # Each op is guarded on its own so one failure — e.g. a JobLookupError
        # from a self-re-arming date job that just fired and vanished — never
        # aborts the rest of the reconcile pass.
        for symbol in held - scheduled:
            try:
                self.facade._arm_symbol(symbol, 0, now)
            except Exception as e:
                app_logger.error(f"Failed to arm scrape job for {symbol}: {e}")
        for symbol in scheduled - held:
            try:
                self.facade.scheduler.remove_job(_scrape_job_id(symbol))
            except Exception as e:
                app_logger.debug(f"Job for {symbol} already gone, skipping: {e}")
            finally:
                # Failure-backoff state is per-job (issue #617): drop it when the
                # symbol departs so a later revival starts fresh at base_interval
                # rather than inheriting a stale dead-ticker backoff. Under the
                # shared lock so a concurrent in-flight scrape (which re-checks
                # membership under the same lock) can't write the entry back.
                with self.failure_counts_lock:
                    self.failure_counts.pop(symbol, None)
                # Same cleanup, one storey up (issue #668) — but the **scrape**
                # record only since #703. Leaving this job is no longer leaving
                # the ledger: the backward pass goes on reconstructing the
                # history of a line the owner has sold, and taking its records
                # away here would blank the progress of a pass still running,
                # permanently. What drops a backfill record is the symbol
                # leaving the ledger, and that is `recorder.retain` in `ingest`.
                self.facade.recorder.forget_scrape(symbol)

    # ------------------------------------------------------------------ #
    # The freshness sonde (issue #628, design #626)
    # ------------------------------------------------------------------ #

    def check_price_freshness(self, symbol: str,
                              live_price, now: datetime) -> bool:
        """Price-freshness liveness sonde (issue #628, design #626).

        Runs only on the ``REGULAR`` write path (the caller's ``should_write``
        gate): read the newest stored price and advance the pure
        ``scheduling.price_freshness_step`` against this symbol's remembered
        state. When the stored price has stayed frozen across consecutive
        ``REGULAR`` cycles for at least ``staleness_horizon`` while the live
        quote has moved, the writer is silently stale — emit a WARNING and hand
        the flag back for the scrape record. Measuring over consecutive polling
        (not the stored point's raw age) is what keeps the first tick after an
        overnight/weekend close — legitimately hours old — from firing a false
        positive.

        **Per symbol since #700**, where it was per ``(symbol, account)``: the
        series it watches has no account dimension left, so the same value would
        have been compared against the same memory once per holding. The
        holdings themselves left the signature with the gauge that was labelled
        by account (ADR-0033): the two surfaces this sonde reaches now — the
        ``WARNING`` and the record's *stale* field — are both per symbol.

        **The record is where the signal is read from now, and it is the whole
        of it** (issue #818). The gauge was the surface an install with no
        interface watched, and it left with the exporter; the flag it hands back
        is rendered as the ``frozen`` pill on ``/api/runtime`` *and* folded into
        ``/health``'s body, where a ``curl`` finds it without a dashboard. So
        this method keeps filling the record for the same reason it always did,
        with one more reader downstream — and the amber it produces there is
        deliberately not a failing status code (ADR-0036).

        **It reads ``price_native``**, and that is a rule rather than an
        implementation detail (spec #695 § 7). The question is whether the
        *writer* has gone silently stale; a converted price moves whenever the
        exchange rate does, so watching one would let a currency tick pass for a
        price that is still being refreshed — the sonde would answer "fresh"
        about a symbol frozen since Tuesday.

        **Diagnostic only** — never changes scrape cadence, write gating, or the
        #617 dead-ticker backoff. Fully guarded: a read error here must never
        disturb the surrounding scrape cycle. Called *before* this cycle's
        write so it reads the coverage as it stood, not the point the write is
        about to refresh.

        Returns whether it flagged the symbol, so the caller can carry it into
        the scrape record (issue #668). The signal was already computed here, by
        the one thread that holds this series' sonde memory — a reader
        recomputing it would need that memory *and* a fresh price, at a second
        instant, which is the composed read #656 déc. 4 exists to forbid.
        """
        if self.facade.staleness_horizon <= 0:
            return False
        stale = False
        try:
            stored_price = quotes.last_price(
                self.facade.config_manager.store, symbol)
            with self.sonde_lock:
                new_state, stale = scheduling.price_freshness_step(
                    self.sonde_state.get(symbol), live_price, stored_price,
                    now, self.facade.staleness_horizon)
                if new_state is None:
                    self.sonde_state.pop(symbol, None)
                else:
                    self.sonde_state[symbol] = new_state

            if stale:
                app_logger.warning(
                    f"Price-freshness sonde: the stored price for {symbol} is "
                    f"frozen at {stored_price} across REGULAR polling while the "
                    f"live quote is {live_price} — the writer may be silently "
                    f"stale")
        except Exception as e:
            app_logger.debug(f"Price-freshness sonde failed for {symbol}: {e}")
        return stale

    # ------------------------------------------------------------------ #
    # The pass itself — the workload's entry point (design #602)
    # ------------------------------------------------------------------ #

    def scrape_symbol(self, symbol: str, now: Optional[datetime] = None) -> None:
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
        # A pass that raises must not take the symbol out of the rotation.
        # The job is a one-shot ``date`` trigger: APScheduler drops it from the
        # store as it dispatches, so the re-arm below is the *only* thing that
        # puts the symbol back, and a body that raises before reaching it ends
        # the self-reschedule chain for the life of the process. Only three
        # exception types are caught inside the fetch; anything else — a
        # transport error, a shape yfinance changed — used to be terminal.
        # The delay therefore starts at the ordinary cadence and ``decide``
        # narrows it only if it got to run.
        next_delay = self.facade.regular_interval
        try:
            last_quote, info = self.facade._fetch_ticker_data(symbol)
            price_present = last_quote is not None and info is not None

            # The conversion, computed **once** for this pass (issue #702): two
            # calls would be two rates for one observation the moment a TTL
            # expired between them, and the row would then say a price was
            # produced by a rate it was not.
            converted, rate = self.facade._convert(
                last_quote, market_info.currency_of(info))

            # The holdings this symbol has, which since #700 decide **whether** to
            # write and no longer **how many times**: the price series carries no
            # account, so a symbol held in three accounts is one point. What the
            # list is still needed for is the "is anyone still holding this"
            # question the write gate asks (issue #699) — the per-account gauges
            # that were its other reader left with the exporter (ADR-0033).
            holdings = [s for s in self.facade.shares
                        if s.get('symbol') == symbol and s.get('quantity')]

            if info is not None:
                state, next_open = scheduling.extract_market_context(
                    info, market_info.history_metadata_of(info), now)
            else:
                # Fetch failed outright: no state to read, fail-open as REGULAR so a
                # transient failure keeps the job polling rather than sleeping it.
                state, next_open = None, None

            with self.failure_counts_lock:
                should_write, next_delay, new_failure_count = scheduling.decide(
                    state, price_present, next_open, now,
                    self.failure_counts.get(symbol, 0),
                    self.facade.regular_interval)
                # Persist the backoff counter only while the symbol is still held. A
                # concurrent ingest() reconcile may have removed it (and popped its
                # entry) between this cycle's fetch and here; the held-recheck under
                # the shared lock stops this write from resurrecting a departed
                # symbol's counter after cleanup (issue #617 race). Both branches run
                # under the lock so the reconcile pop can't interleave mid-decision.
                if symbol in self.facade._held_symbols():
                    self.failure_counts[symbol] = new_failure_count
                else:
                    self.failure_counts.pop(symbol, None)

            stale = False
            if should_write:
                # Price-freshness liveness sonde (issue #628): read the stored price
                # *before* this cycle's write refreshes it, so a silently stale writer
                # is caught. Purely diagnostic — never gates the write below.
                stale = self.facade._check_price_freshness(
                    symbol, last_quote, now)

                # One write, and only while something is held: a symbol whose last
                # holding was sold between this cycle's fetch and here has nothing
                # to record, and nothing wrong with it either.
                wrote_live_data = bool(holdings) and self.facade._write_quote(
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
            # Neither `state` nor the coercion is read from the ``info`` cache
            # (traps 2 and 3): `decide` fail-opens an unrecognised state to REGULAR
            # while the cache keeps yfinance's raw string, and the cache is written
            # only on a *successful* fetch — so a failing symbol's cache entry
            # reports the market state from before its failure, which is the very
            # case a pill exists to show. `state` here is what this cycle read, and
            # `closed` is what the scheduler acted on.
            self.facade.recorder.record_scrape(runtime_state.ScrapeRecord(
                symbol=symbol,
                at=now,
                market_state=state,
                closed=scheduling.is_closed(state),
                price_present=price_present,
                verdict=scrape_verdict(
                    should_write, state, wrote_live_data, bool(holdings)),
                failure_count=new_failure_count,
                next_delay=next_delay,
                wrote=wrote_live_data,
                stale=stale,
                error=(
                    f"No point persisted for {symbol}: the store refused the write"
                    if should_write and not wrote_live_data and holdings else None),
            ))
        except Exception as exc:
            # Recorded rather than only logged: a symbol that stops answering
            # is exactly what ``/api/runtime`` exists to show, and a pass that
            # left no record reads there as one still in flight.
            app_logger.error(
                f"Scrape pass for {symbol} failed", exc_info=True)
            self.facade.recorder.record_scrape(runtime_state.ScrapeRecord(
                symbol=symbol,
                at=now,
                market_state=None,
                closed=False,
                price_present=False,
                verdict=runtime_state.SCRAPE_NO_PRICE,
                failure_count=self.failure_counts.get(symbol, 0),
                next_delay=next_delay,
                wrote=False,
                stale=False,
                error=f"{type(exc).__name__}: {exc}",
            ))
        finally:
            # Re-arm only if still held — the in-flight guard against a job that was
            # removed mid-cycle re-adding itself after reconcile's remove_job.
            if self.facade.scheduler is not None and \
                    symbol in self.facade._held_symbols():
                # Schedule from a fresh wall-clock, not the decision `now` captured
                # before the fetch: _fetch_ticker_data can sleep on rate-limit
                # retries, which for a small next_delay would otherwise put run_date
                # in the past and let APScheduler drop the job, breaking the
                # self-reschedule chain. Tests inject `now` to keep run_date
                # deterministic; production recomputes it here.
                arm_now = now if injected_now else datetime.now(timezone.utc)
                self.facade._arm_symbol(symbol, next_delay, arm_now)
