"""The performance workload: the ledger replayed, the series rewritten (#849).

The fourth of the four workloads #842 breaks the runtime class into, and the
one whose parts were already elsewhere: :mod:`performance` — pure, no store, no
clock — holds the arithmetic, and :mod:`perf_series` is the single writer of
``account_metrics`` and ``portfolio_totals`` (ADR-0006). What stood in the class
was the **orchestration** between the two: read the ledger, call the pure, hand
the points to the writer.

It is its own module rather than the writer's tail, and the rule the parent
ticket left open is settled by what the orchestration does — *it writes
nothing*. The four statements of a cycle are :mod:`perf_series`' and stay there,
in one transaction; this file passes it lists of points and bounds. Two facts
make the separation load-bearing rather than tidy:

* :mod:`accounts` imports :mod:`perf_series` at module level for
  ``forget_account``, while a pass needs ``accounts.read_accounts``. Housing the
  orchestration in the writer is an **import cycle**, and it would make deleting
  an account depend on the whole replay — :mod:`performance`, :mod:`quotes`,
  :mod:`ledger`, the aggregator.
* :mod:`perf_series` has no clock, no lock and no state. Giving it any would
  turn a writer of two tables into an object with a lifecycle.

Two entry points, and they are the same pass seen from two distances:

* :meth:`PerfJob.recompute` is what the ``perf`` interval job is armed on and
  what ``replay_after_write`` calls: it catches, logs, verdicts
  ``PERF_RAN``/``PERF_FAILED`` and publishes the :class:`runtime_state.PerfRecord`
  carrying the horizons. A rebuild that fails is a record and never a ``500``
  on a write the store has already accepted.
* :meth:`PerfJob.update_account_metrics` is the serialized one: it holds the
  pass lock across read, compute **and** write, and returns ``{account:
  horizon}``.

**There is one pass lock per runtime, and it lives on the façade** — the job
borrows it rather than building one. That is not a detail: the prune each cycle
runs is bounded by *that pass's own spans*, so two passes overlapping let the
one that commits second delete the years the first had just written. One object
is constructed once and held by the façade, and it takes ``_perf_lock`` before
``config_manager.writing()``, never the other way round.

**The reporting currency is read at every pass**, off the façade's mutable
attribute, and never captured here at construction: an install whose first
gesture is an import assigns that attribute mid-life, and a captured ``None``
would leave it with no series at all until a restart.

**The workload calls its collaborators through the façade that carries it**,
for the reason :mod:`scrape` and :mod:`backfill` give: the suite replaces
methods *on the instance* — the rebuild above all — and a pass holding
references captured at construction would step over the replacement.

What it is **handed** is :func:`main.holding_windows`, the free function that
answers *when did this position start*. It has two callers — this pass and the
backfill window the snapshot publishes — and exactly one spelling: a second one
would put the two a day apart, which is one chunk of disagreement about whether
a symbol is terminal. It is passed in rather than imported because importing it
means importing :mod:`main`, which imports this file.
"""
import logging
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import accounts as accounts_module
import ledger
import perf_series
import performance
import quotes
import runtime_state
import store_reads
from events import EventAggregator, AccountMetricPoint, PortfolioTotalPoint

#: The application's own logger, by name rather than by import: :mod:`main`
#: builds it (level, handler, formatter) and this module writes to the same
#: object, so a line a perf pass emits is the line it always was.
app_logger = logging.getLogger("suivi_bourse")


def value_kwargs(dp, last: bool, perf) -> dict:
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


def account_holding_windows(timeline, account_id: str, symbols,
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


def spans(points, key) -> Dict[Any, Tuple[date, date]]:
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


class PerfJob:
    """One perf recompute, whole: its guard, its lock, its replay and its write.

    ``facade`` is the object that carries the workloads — the store manager, the
    dials, the recorder, the pass lock — and every collaborator is reached
    through it (see this module's docstring). It is
    :class:`main.SuiviBourseMetrics` today, and #850 owns what it is called.
    ``holding_windows`` is handed in and never re-spelled here: it is the one
    answer to *when did this position start*, shared with the backfill's window.
    It is the one collaborator bound at construction rather than reached through
    the façade, and it may be: the façade rule exists because the suite replaces
    *methods on the instance*, and this is a pure module-level function with no
    instance to replace — both callers run the same code object either way.
    """

    def __init__(self, facade, holding_windows):
        self.facade = facade
        self.holding_windows = holding_windows

    def recompute(self) -> None:
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
        with self.facade._perf_lock:
            try:
                horizons = self.facade.update_account_metrics()
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
            self.facade.recorder.record_perf(runtime_state.PerfRecord(
                at=datetime.now(timezone.utc), verdict=verdict, error=error,
                horizons=horizons))

    def update_account_metrics(self) -> Dict[str, Optional[date]]:
        """Rebuild the perf cache — **one pass at a time** (issue #812).

        A thin wrapper, and the lock is the whole of it. :meth:`rebuild_series`
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
        while :meth:`rebuild_series` takes ``config_manager.writing()`` — that
        is its ordinary path, not an exception — so what keeps the pair safe is
        the single ordering: ``_perf_lock`` then ``writing()``, and no path takes
        them the other way round. Every ``replay_after_write`` call site sits
        outside its own ``with writing()`` block, which is what makes that true
        by inspection.
        """
        with self.facade._perf_lock:
            return self.facade._rebuild_series()

    def rebuild_series(self) -> Dict[str, Optional[date]]:
        """Rebuild the daily ``account_metrics`` + ``portfolio_totals`` cache.

        **Not an entry point: it is only ever run under the pass lock.** The two
        above are the ways in. This one reads and computes outside the writers'
        mutex and its prune is bounded by *its own* spans, so a second copy
        running unlocked commits last with a staler ledger and deletes the days
        the first had just written — which is the whole of #812.

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
        if not self.facade.base_currency:
            app_logger.debug(
                "No base currency answered yet: no performance series is written")
            return {}

        store_handle = self.facade.config_manager.store
        events = ledger.read_events(store_handle)
        # **The opt-in guard is gone** (issue #708). It read
        # ``accounts.declared_portfolio``, whose ``None`` means *"nothing was
        # declared beyond the seed"* — and ADR-0013 seeds a ``default`` row at
        # the creation of the schema and never removes it, so the condition had
        # lost its subject: a single-account install, the ordinary shape of a v4
        # coming over, had **no performance series written at all** while the
        # guard read as a deliberate opt-in. Every account row is computed now,
        # and what replaces the guard is the per-field rule
        # (:func:`performance.writable_fields`), applied in :func:`value_kwargs`.
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
                store_handle, self.holding_windows(events, held), now)
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
                    self.facade._holding_windows(timeline, account.id, symbols, today),
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
                        **self.facade._value_kwargs(dp, last, perf),
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
                        **self.facade._value_kwargs(dp, i == len(total.daily) - 1, total),
                    )
                    for i, dp in enumerate(total.daily)
                ]

        # What this cycle produced, per entity, is what the prune keeps. Read off
        # the points themselves rather than off ``[start, today]``: accounts
        # begin on different days, and a global window would leave one account's
        # orphaned early days standing inside another's span.
        acc_spans = self.facade._spans(acc_points, lambda pt: pt.account)
        total_span = self.facade._spans(total_points, lambda _: None).get(None)

        with self.facade.config_manager.writing() as opened:
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
