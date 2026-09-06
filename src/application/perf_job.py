"""The performance workload: the ledger replayed, the series rewritten (#849)."""
import logging
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from application import accounts as accounts_module
from application import carrying
from application import perf_series
from application import performance
from application import quotes
from application import runtime_state
from application import store_reads
from application.events.aggregator import EventAggregator
from application.events.schemas import AccountMetricPoint, PortfolioTotalPoint

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


def account_holding_windows(timeline, account_id: str, symbols,
                            today: date) -> Dict[str, Tuple[date, date]]:
    """``{symbol: (first, last) day this account held it}`` — the horizon's bound (issue #708)."""
    windows = {}
    for symbol in symbols:
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


class PerfJob:
    """One perf recompute, whole: its guard, its lock, its replay and its write."""

    def __init__(self, facade):
        self.facade = facade

    def recompute(self) -> None:
        """Rebuild the perf cache, in full, every cycle (issue #707, ADR-0011)."""
        horizons: Dict[str, Optional[date]] = {}
        with self.facade._perf_lock:
            try:
                horizons = self.facade.update_account_metrics()
                verdict, error = runtime_state.PERF_RAN, None
            except Exception as e:
                app_logger.error(f"Failed to update account metrics: {e}")
                verdict, error = runtime_state.PERF_FAILED, str(e)
            self.facade.recorder.record_perf(runtime_state.PerfRecord(
                at=datetime.now(timezone.utc), verdict=verdict, error=error,
                horizons=horizons))

    def update_account_metrics(self) -> Dict[str, Optional[date]]:
        """Rebuild the perf cache — **one pass at a time** (issue #812)."""
        with self.facade._perf_lock:
            return self.facade._rebuild_series()

    def rebuild_series(self) -> Dict[str, Optional[date]]:
        """Rebuild the daily ``account_metrics`` + ``portfolio_totals`` cache."""
        if not self.facade.base_currency:
            app_logger.debug(
                "No base currency answered yet: no performance series is written")
            return {}

        store_handle = self.facade.config_manager.store
        # **The published snapshot, not a second read of the ledger** (#861).
        # A write reaches here through `main.replay_after_write`, which has just
        # ingested — read, aggregated and validated the whole ledger — and
        # published it; reading `event` again produced the same rows at the cost
        # of a second full pass on every write. The **replay** below stays: a
        # `position` row is a current state and performance needs every day's,
        # which is what `Timeline` is for.
        events = self.facade.config_manager.current().events or []
        declared = accounts_module.read_accounts(store_handle)

        now = datetime.now(timezone.utc)
        today = now.date()
        acc_points: List[AccountMetricPoint] = []
        total_points: List[PortfolioTotalPoint] = []
        latest_by_account: Dict[str, AccountMetricPoint] = {}
        horizons: Dict[str, Optional[date]] = {}
        total = None

        if declared and events:
            timeline = EventAggregator().replay(events)

            symbols = {e.symbol for e in events if e.symbol}
            price_pairs: Dict[str, List[Tuple[date, float]]] = {}
            for close in store_reads.PortfolioReader(store_handle).daily_closes():
                if close['symbol'] in symbols:
                    price_pairs.setdefault(close['symbol'], []).append(
                        (close['day'], float(close['price'])))

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
            settled = {symbol for symbol in carried
                       if symbol not in first_quoted}
            writable = {
                account.id: performance.account_horizon(
                    account_holding_windows(timeline, account.id, symbols, today),
                    oldest_priced, settled, start=start, ceiling=today)
                for account in declared
            }
            named = {event.account for event in events if event.account}
            horizons = {account_id: span.first
                        for account_id, span in writable.items()
                        if account_id in named}

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
                    _to(account.id), carried, first_quoted)
                for account in declared
            }
            bounds = [span.first for span in writable.values()
                      if span.first is not None]
            caps = [span.last for span in writable.values()
                    if span.last is not None]
            total = performance.compute_portfolio_total(
                timeline, declared, symbols, price_at,
                max([start] + bounds), min([today] + caps), per_account)

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

        acc_spans = spans(acc_points, lambda pt: pt.account)
        total_span = spans(total_points, lambda _: None).get(None)

        with self.facade.config_manager.writing() as opened:
            with opened.transaction():
                perf_series.write_account_metrics(opened, acc_points)
                perf_series.write_portfolio_totals(opened, total_points)
                perf_series.prune_account_metrics(opened, acc_spans)
                perf_series.prune_portfolio_totals(opened, total_span)

        for acc, p in latest_by_account.items():
            if p.cash_balance is not None and p.cash_balance < 0:
                app_logger.warning(
                    f"Account '{acc}' has a negative cash balance "
                    f"({p.cash_balance:.2f}) — insufficient recorded cash")

        return horizons
