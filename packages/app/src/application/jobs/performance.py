"""The performance job: the ledger replayed, the series rewritten (#849, #1253)."""
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from application import accounts as accounts_module
from application import carrying
from application import job_history
from application import perf_series
from application import performance
from application import quotes
from application import runtime_state
from application import runtime_view
from application import scheduling
from application import store_reads
from application.events.aggregator import EventAggregator
from application.events.schemas import AccountMetricPoint, PortfolioTotalPoint
from application.jobs import base

app_logger = logging.getLogger("suivi_bourse")


def value_kwargs(dp, last: bool, perf) -> dict:
    """Shared value + perf fields for a metric point built from a DailyPerf."""
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


def account_holding_windows(timeline, account_id: str,
                            today: date) -> Dict[str, Tuple[date, date]]:
    """``{symbol: (first, last) day this account held it}`` — the horizon's bound (issue #708).

    Over **this account's** symbols, which the timeline already knows: it was
    handed the whole ledger's set, so a portfolio of a dozen accounts paid a
    ``holding_window`` per (account × symbol) every cycle to be told ``None``
    for the ones it had never touched (issue #861). Same windows, and the
    absence a symbol is genuinely missing from is the same absence.
    """
    windows = {}
    for account, symbol in timeline.snapshots:
        if account != account_id:
            continue
        window = timeline.holding_window(account_id, symbol, today)
        if window is not None:
            windows[symbol] = window
    return windows


def spans(points, key) -> Dict[Any, Tuple[date, date]]:
    """``{key: (first_day, last_day)}`` over the points a cycle produced."""
    spans: Dict[Any, Tuple[date, date]] = {}
    for point in points:
        identity = key(point)
        first, last = spans.get(identity, (point.day, point.day))
        spans[identity] = (min(first, point.day), max(last, point.day))
    return spans


@dataclass
class _PassState:
    """What the last full pass read and wrote, held to continue it by one day (#1257).

    Owned by the perf pass and written by nobody else: it is the pass's memory
    of its **own** inputs, compared on the next tick against the store it reads
    again, never a signal a writer raises (#707).
    """

    today: date
    fingerprint: tuple
    #: :meth:`store_reads.PortfolioReader.series_fingerprint`, after the write.
    written: tuple
    events: list
    declared: list
    base_currency: Optional[str]
    horizons: Dict[str, Optional[date]]
    latest: Dict[str, AccountMetricPoint]
    #: ``False`` when only a full pass may follow: no series at all, or a
    #: symbol whose first point is today, the one day its horizon can move.
    continuable: bool = False
    timeline: Any = None
    symbols: Set[str] = field(default_factory=set)
    carried: Set[str] = field(default_factory=set)
    first_quoted: Dict[str, date] = field(default_factory=dict)
    #: Symbols with any point, and with any converted close, as the pass saw them.
    stored: Set[str] = field(default_factory=set)
    priced: Set[str] = field(default_factory=set)
    #: Each symbol's last close **before** today: what today forward-fills from.
    last_before: Dict[str, float] = field(default_factory=dict)
    #: ``{account: the point before today's}``, for the accounts whose series
    #: reaches today. ``None`` when today is the series' first point.
    seeds: Dict[str, Optional[performance.DailyPerf]] = field(default_factory=dict)
    total_start: Optional[date] = None
    total_reaches_today: bool = False
    total_seed: Optional[performance.DailyPerf] = None
    total_has_cash_ledger: bool = False
    #: ``quotes.given_up()`` as the pass saw it: a symbol given up on is carried
    #: at cost from then on, which moves the whole horizon.
    given_up: frozenset = frozenset()
    #: The day the newest price held lines rest on belongs to: the day the IRR's
    #: terminal value is dated at.
    valued_on: Optional[date] = None


def _midnight(day: date) -> datetime:
    """The UTC instant ``day`` begins — the store's own cut (``SET TimeZone='UTC'``)."""
    return datetime.combine(day, time.min, tzinfo=timezone.utc)


@dataclass
class _ClosesCache:
    """The daily closes behind a cut, kept between full passes (#1256).

    Only days before ``cut``: today's close moves with every scrape, so it is
    read again each pass. ``fingerprint`` is
    :meth:`store_reads.PortfolioReader.history_fingerprint` at ``cut``, read
    **before** the closes were: a writer landing between the two leaves newer
    closes under an older fingerprint, which the next pass no longer matches.
    So a backfill, a repair, the ladder, a forget or a split re-read is caught
    by the pass reading the store, not by a writer remembering to say so (#707).
    """

    cut: datetime
    fingerprint: tuple
    pairs: Dict[str, List[Tuple[date, float]]]


class _NotContinuable(Exception):
    """Today's point cannot be derived from the last pass: rebuild the series whole."""


class PerformanceJob(base.Job):
    """One perf recompute, whole: its guard, its lock, its replay and its write."""

    id = job_history.PERFORMANCE
    label_key = 'settings.jobs.performance'
    triggers = (base.Interval(scheduler_id=scheduling.PERF_JOB_ID,
                              name='Performance recompute',
                              seconds=scheduling.PERF_TICK,
                              first_run_now=True),
                # Whole, so a correction made in 2019 shows at once (#812, #1257).
                base.OnWrite(kwargs={'full': True}))
    in_health = True

    def __init__(self, ctx, jobs):
        super().__init__(ctx, jobs)
        self._last: Optional[_PassState] = None
        self._closes_cache: Optional[_ClosesCache] = None
        self.last_mode: Optional[str] = None

    def run(self, full: bool = False) -> None:
        """Bring the perf cache up to date, every cycle — **guarded**.

        ``full`` rebuilds the whole series whatever the store says moved: the
        replay that follows a write asks for it (#812, #1257).
        """
        if full:
            self.forget()
        self.recompute()

    def guard(self):
        # Under the pass's own lock, so a concurrent pass cannot publish its
        # verdict between this one and the read.
        return self.ctx.perf_lock

    def outcome(self, started: datetime) -> base.Outcome:
        return runtime_view.perf_outcome(self.ctx.recorder.perf())

    @classmethod
    def health(cls, view):
        return runtime_view.health_performance(view.perf)

    def forget(self) -> None:
        """Drop what the last pass read, so the next one rebuilds whole (#812, #1257)."""
        self._last = None

    def recompute(self) -> None:
        """Bring the perf cache up to date, every cycle (issues #707, #1257).

        Every cycle reads the store again. What it rewrites is the least that
        keeps the series exact: nothing when nothing it reads has moved, today's
        point alone when only today's quotes have, and the whole series
        otherwise.
        """
        horizons: Dict[str, Optional[date]] = {}
        with self.ctx.perf_lock:
            self.last_mode = None
            try:
                horizons = self.update_account_metrics()
                verdict, error = runtime_state.PERF_RAN, None
            except Exception as e:
                self._last = None
                self._closes_cache = None
                app_logger.error(f"Failed to update account metrics: {e}")
                verdict, error = runtime_state.PERF_FAILED, str(e)
            self.ctx.recorder.record_perf(runtime_state.PerfRecord(
                at=datetime.now(timezone.utc), verdict=verdict, error=error,
                horizons=horizons, mode=self.last_mode))

    def update_account_metrics(self) -> Dict[str, Optional[date]]:
        """Rebuild the perf cache — **one pass at a time** (issue #812)."""
        with self.ctx.perf_lock:
            return self.rebuild_series()

    def rebuild_series(self) -> Dict[str, Optional[date]]:
        """Bring the daily ``account_metrics`` + ``portfolio_totals`` cache up to date.

        Which of the three passes runs is read off the store (issue #1257):

        - **skipped** — the ledger, the accounts, the base currency, the UTC
          day and every price point are what the last pass read;
        - **today** — only today's points moved: today's point is recomputed
          from the point before it and upserted, for each account and the total;
        - **full** — anything else, and always after a write
          (``main.replay_after_write``), a failure, or a restart.
        """
        if not self.ctx.base_currency:
            self._last = None
            self._closes_cache = None
            app_logger.debug(
                "No base currency answered yet: no performance series is written")
            return {}

        store_handle = self.ctx.config_manager.store
        # **The rows the ingestion just published**, not a second read of them
        # (#861): a write reaches here through `main.replay_after_write`, which
        # has already read, validated and published the whole ledger. `reload`
        # and not `current` because `ingest` keeps the previous snapshot when
        # its own read fails, and this pass ends in a prune.
        events = self.ctx.config_manager.reload().events or []
        declared = accounts_module.read_accounts(store_handle)

        now = datetime.now(timezone.utc)
        today = now.date()
        # Read **before** the inputs: a write landing while this pass reads them
        # leaves a fingerprint the next tick no longer matches, so it rebuilds.
        fingerprint = store_reads.PortfolioReader(store_handle).perf_inputs(
            _midnight(today))

        last = self._last
        if last is not None and all((
                last.today == today,
                last.written == store_reads.PortfolioReader(
                    store_handle).series_fingerprint(),
                last.base_currency == self.ctx.base_currency,
                last.given_up == quotes.given_up(),
                last.events == events, last.declared == declared,
                last.fingerprint[0] == fingerprint[0],
                last.fingerprint[2:] == fingerprint[2:])):
            if last.fingerprint[1] == fingerprint[1]:
                self.last_mode = runtime_state.PERF_PASS_UNCHANGED
                self._warn_negative_cash(last.latest)
                return last.horizons
            if last.continuable:
                try:
                    return self._today_only(last, today, fingerprint)
                except _NotContinuable as reason:
                    app_logger.debug(f"Perf pass rebuilt whole: {reason}")
        return self._full(events, declared, now, today, fingerprint)

    def _full(self, events, declared, now: datetime, today: date,
              fingerprint: tuple) -> Dict[str, Optional[date]]:
        """The whole series, recomputed and rewritten, then pruned to its spans."""
        self._last = None
        store_handle = self.ctx.config_manager.store
        state = _PassState(
            today=today, fingerprint=fingerprint, written=(),
            events=list(events),
            declared=list(declared), base_currency=self.ctx.base_currency,
            horizons={}, latest={}, given_up=quotes.given_up())
        acc_points: List[AccountMetricPoint] = []
        total_points: List[PortfolioTotalPoint] = []
        latest_by_account: Dict[str, AccountMetricPoint] = {}
        horizons: Dict[str, Optional[date]] = {}
        total = None

        if declared and events:
            timeline = EventAggregator().replay(events)

            symbols = {e.symbol for e in events if e.symbol}
            closes = self._closes(store_handle, today, fingerprint)
            price_pairs = {symbol: pairs for symbol, pairs in closes.items()
                           if symbol in symbols}

            def price_at(symbol, day):
                pairs = price_pairs.get(symbol)
                return timeline.state_at(pairs, day) if pairs else None

            held = {position['symbol']
                    for position in timeline.current()
                    if position.get('symbol') and position.get('quantity')}
            carried = quotes.terminal_symbols(
                store_handle, carrying.holding_windows(events, held), now)
            first_quoted = quotes.first_quoted_days(store_handle)

            start = min(e.date for e in events)

            oldest_priced = {symbol: pairs[0][0]
                             for symbol, pairs in price_pairs.items() if pairs}
            # `compute_account` already values both at the carrying price — the
            # horizon is what refused them.
            settled = {symbol for symbol in carried
                       if symbol not in first_quoted}
            carried_from = {symbol: first_quoted[symbol] for symbol in carried
                            if symbol in first_quoted}
            writable = {
                account.id: performance.account_horizon(
                    account_holding_windows(timeline, account.id, today),
                    oldest_priced, settled, carried_from=carried_from,
                    start=start, ceiling=today)
                for account in declared
            }
            named = {event.account for event in events if event.account}
            horizons = {account_id: span.first
                        for account_id, span in writable.items()
                        if account_id in named}

            valued_on = max(
                (pairs[-1][0] for symbol, pairs in price_pairs.items()
                 if symbol in held and pairs and pairs[-1][0] <= today),
                default=None)
            state.valued_on = valued_on

            def _from(account_id: str) -> date:
                """Where this account's series begins: its horizon, never before the ledger's own first day."""
                horizon = writable[account_id].first
                return start if horizon is None else max(start, horizon)

            def _to(account_id: str) -> date:
                """Where it stops: its cap, and today when nothing caps it."""
                cap = writable[account_id].last
                return today if cap is None else cap

            per_account = {
                account.id: performance.compute_account(
                    timeline, account, symbols, price_at, _from(account.id),
                    _to(account.id), carried, first_quoted,
                    valued_on=valued_on)
                for account in declared
            }
            bounds = [span.first for span in writable.values()
                      if span.first is not None]
            caps = [span.last for span in writable.values()
                    if span.last is not None]
            total = performance.compute_portfolio_total(
                timeline, declared, symbols, price_at,
                max([start] + bounds), min([today] + caps), per_account,
                valued_on=valued_on)

            for account in declared:
                perf = per_account[account.id]
                for i, dp in enumerate(perf.daily):
                    last = i == len(perf.daily) - 1
                    pt = AccountMetricPoint(
                        account=account.id,
                        day=dp.date,
                        **value_kwargs(dp, last, perf),
                    )
                    acc_points.append(pt)
                    if last:
                        latest_by_account[account.id] = pt
            if total is not None:
                total_points = [
                    PortfolioTotalPoint(
                        day=dp.date,
                        **value_kwargs(dp, i == len(total.daily) - 1, total),
                    )
                    for i, dp in enumerate(total.daily)
                ]

            self._remember(state, timeline, symbols, carried, first_quoted,
                           price_pairs, today, per_account, total,
                           max([start] + bounds))

        acc_spans = spans(acc_points, lambda pt: pt.account)
        total_span = spans(total_points, lambda _: None).get(None)

        with self.ctx.config_manager.writing() as opened:
            with opened.transaction():
                perf_series.write_account_metrics(opened, acc_points)
                perf_series.write_portfolio_totals(opened, total_points)
                perf_series.prune_account_metrics(opened, acc_spans)
                perf_series.prune_portfolio_totals(opened, total_span)

        self._warn_negative_cash(latest_by_account)

        state.horizons = horizons
        state.latest = latest_by_account
        state.written = store_reads.PortfolioReader(
            store_handle).series_fingerprint()
        self._last = state
        self.last_mode = runtime_state.PERF_PASS_FULL
        return horizons

    def _closes(self, store_handle, today: date,
                fingerprint: tuple) -> Dict[str, List[Tuple[date, float]]]:
        """``{symbol: [(day, close), …]}``, every symbol, oldest day first (#1256).

        The days behind the kept cut come from the cache when the history
        behind it is the one it was read from, and only the days from the cut
        on are read again — today, and yesterday the day after. Anything else
        reads the whole history, as before. The lists returned are this pass's
        own: the cache is never handed out to be mutated.
        """
        reader = store_reads.PortfolioReader(store_handle)
        cut = _midnight(today)
        cache = self._closes_cache
        self._closes_cache = None
        if cache is not None:
            if cache.cut == cut:
                kept = cache.fingerprint == fingerprint[0]
            elif cache.cut < cut:
                kept = cache.fingerprint == reader.history_fingerprint(cache.cut)
            else:
                kept = False
            if not kept:
                cache = None

        rows = (reader.daily_closes() if cache is None
                else reader.daily_closes(start=cache.cut))
        history: Dict[str, List[Tuple[date, float]]] = (
            {} if cache is None else cache.pairs)
        recent: Dict[str, List[Tuple[date, float]]] = {}
        days: Dict[date, date] = {}
        for close in rows:
            # One `date` per day, shared by every symbol: the cache outlives
            # the pass, so 500 symbols do not keep 500 copies of each day.
            day = days.setdefault(close['day'], close['day'])
            pair = (day, float(close['price']))
            if day < today:
                history.setdefault(close['symbol'], []).append(pair)
            else:
                recent.setdefault(close['symbol'], []).append(pair)

        self._closes_cache = _ClosesCache(
            cut=cut, fingerprint=fingerprint[0], pairs=history)
        return {symbol: history.get(symbol, []) + recent.get(symbol, [])
                for symbol in history.keys() | recent.keys()}

    def _remember(self, state: _PassState, timeline, symbols, carried,
                  first_quoted, price_pairs, today: date, per_account, total,
                  total_start: date) -> None:
        """Keep what continuing this series by today's point alone needs."""
        store_handle = self.ctx.config_manager.store
        state.timeline = timeline
        state.symbols = symbols
        state.carried = set(carried)
        state.first_quoted = dict(first_quoted)
        state.stored = set(quotes.oldest_stored(store_handle))
        state.priced = set(price_pairs)
        for symbol, pairs in price_pairs.items():
            before = [price for day, price in pairs if day < today]
            if before:
                state.last_before[symbol] = before[-1]
        # The one day a symbol's horizon, its carrying or its oldest point can
        # move without the history behind today moving: the day it is first
        # seen. Rebuilt whole all that day.
        fresh = any(
            pairs and pairs[0][0] >= today for pairs in price_pairs.values())
        fresh = fresh or any(
            first_quoted[symbol] >= today
            for symbol in symbols if symbol in first_quoted)
        fresh = fresh or any(
            instant.date() >= today
            for symbol, instant in quotes.oldest_stored(store_handle).items()
            if symbol in symbols)
        for account_id, perf in per_account.items():
            if perf.daily and perf.daily[-1].date == today:
                state.seeds[account_id] = (
                    perf.daily[-2] if len(perf.daily) > 1 else None)
        state.total_start = total_start
        if total is not None and total.daily and total.daily[-1].date == today:
            state.total_reaches_today = True
            state.total_seed = total.daily[-2] if len(total.daily) > 1 else None
            state.total_has_cash_ledger = total.has_cash_ledger
        state.continuable = not fresh

    def _today_only(self, last: _PassState, today: date,
                    fingerprint: tuple) -> Dict[str, Optional[date]]:
        """Today's point alone, from the point before it and today's closes (#1257).

        Every figure is the one a full pass computes for today, through the same
        functions: the timeline forward-fills cash, positions and contributions,
        the index chains from the point before today's as the last full pass
        wrote it (read back unchanged, or this pass would not run), and XIRR is
        solved again over every flow. Nothing before today is written, and
        nothing is pruned: no span moves within a day the history did not.
        """
        store_handle = self.ctx.config_manager.store
        reader = store_reads.PortfolioReader(store_handle)
        start, stop = _midnight(today), _midnight(today + timedelta(days=1))
        for symbol, (converted, quoted) in reader.symbols_seen(start, stop).items():
            if symbol not in last.symbols:
                continue
            if any((symbol not in last.stored,
                    converted and symbol not in last.priced,
                    quoted and symbol not in last.first_quoted)):
                raise _NotContinuable(f"{symbol} is quoted for the first time")
        closes = reader.closes_of_day(start, stop)

        def price_at(symbol, day):
            if symbol in closes:
                return closes[symbol]
            return last.last_before.get(symbol)

        held_today = any(symbol in closes for symbol in last.symbols)
        valued_on = today if held_today else last.valued_on
        last.valued_on = valued_on
        acc_points: List[AccountMetricPoint] = []
        per_account: Dict[str, performance.Performance] = {}
        latest = dict(last.latest)
        for account in last.declared:
            if account.id not in last.seeds:
                per_account[account.id] = performance.Performance(daily=[])
                continue
            perf = performance.compute_account(
                last.timeline, account, last.symbols, price_at, today, today,
                last.carried, last.first_quoted, seed=last.seeds[account.id],
                valued_on=valued_on)
            if [dp.date for dp in perf.daily] != [today]:
                raise _NotContinuable(f"{account.id} has no point today")
            per_account[account.id] = perf
            point = AccountMetricPoint(
                account=account.id, day=today,
                **value_kwargs(perf.daily[0], True, perf))
            acc_points.append(point)
            latest[account.id] = point

        total_points: List[PortfolioTotalPoint] = []
        if last.total_reaches_today:
            total = performance.compute_portfolio_total(
                last.timeline, last.declared, last.symbols, price_at,
                last.total_start, today, per_account, seed=last.total_seed,
                valued_on=valued_on)
            if total is None or [dp.date for dp in total.daily] != [today]:
                raise _NotContinuable("the total has no point today")
            # Over the whole series, not today's slice of it: an account whose
            # series stopped before today still says whether the total has one.
            total.has_cash_ledger = last.total_has_cash_ledger
            total_points.append(PortfolioTotalPoint(
                day=today, **value_kwargs(total.daily[0], True, total)))

        with self.ctx.config_manager.writing() as opened:
            with opened.transaction():
                perf_series.write_account_metrics(opened, acc_points)
                perf_series.write_portfolio_totals(opened, total_points)

        self._warn_negative_cash(latest)
        last.latest = latest
        last.fingerprint = fingerprint
        last.written = reader.series_fingerprint()
        self.last_mode = runtime_state.PERF_PASS_TODAY
        return last.horizons

    @staticmethod
    def _warn_negative_cash(latest: Dict[str, AccountMetricPoint]) -> None:
        for acc, p in latest.items():
            if p.cash_balance is not None and p.cash_balance < 0:
                app_logger.warning(
                    f"Account '{acc}' has a negative cash balance "
                    f"({p.cash_balance:.2f}) — insufficient recorded cash")
