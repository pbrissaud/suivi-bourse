"""Money-weighted performance: XIRR (annualized) and TWR (time-weighted, base 100)."""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import (
    Callable, Collection, Dict, FrozenSet, List, Mapping, NamedTuple, Optional,
    Tuple,
)

from application.carrying import carrying_price, was_quoted
from application.events.schemas import (
    CashFlow, InKindFlow, Timeline, Account, declared_value,
)


PriceAt = Callable[[str, date], Optional[float]]


ALWAYS_WRITTEN = ('holdings_value', 'gain_absolu')

CASH_LEDGER_FIELDS = ('cash_balance', 'total_value', 'net_contributed',
                      'twr_index')

EXTERNAL_FLOW_FIELDS = ('xirr',)


def writable_fields(has_cash_ledger: bool,
                    has_external_flow: bool) -> FrozenSet[str]:
    """Which of the seven figures this entity may publish."""
    fields = set(ALWAYS_WRITTEN)
    if has_cash_ledger:
        fields.update(CASH_LEDGER_FIELDS)
    if has_external_flow:
        fields.update(EXTERNAL_FLOW_FIELDS)
    return frozenset(fields)


class Horizon(NamedTuple):
    """The days an account's figures may be written on: ``[first, last]``."""
    first: Optional[date]
    last: Optional[date]


def account_horizon(windows: Mapping[str, Tuple[date, date]],
                    oldest_priced: Mapping[str, date],
                    settled: Collection[str] = (), *,
                    carried_from: Optional[Mapping[str, date]] = None,
                    start: date, ceiling: date) -> Horizon:
    """The days this account's figures may be written on.

    ``settled`` names the symbols that block nothing at all: their backfill is
    terminal and no quote of them was ever observed, so every day they were held
    is carried at cost (ADR-0004) and none of them is a hole.

    ``carried_from`` is the same rule applied to the **other half** of that set
    — a terminal symbol whose first quote is *later* than its acquisition
    (issue #861). Those first days will never have a price either, and
    :func:`compute_account` already values them at the carrying price; only the
    horizon refused them, blocking from the acquisition. It now blocks from the
    symbol's first quoted day, which leaves the *waiting* case untouched: a
    symbol quoted from one day and converted only from a later one still blocks
    the range between the two, because a quote was observed there and its
    conversion is coming.
    """
    day = timedelta(days=1)
    quoted_from = carried_from or {}
    blocked: List[Tuple[date, date]] = []
    for symbol, (acquired, last_held) in windows.items():
        if symbol in settled:
            continue
        first = max(acquired, quoted_from.get(symbol, acquired))
        oldest = oldest_priced.get(symbol)
        unpriced = (last_held if oldest is None
                    else min(oldest - day, last_held))
        if unpriced < first:
            continue
        blocked.append((first, unpriced))

    if not blocked:
        return Horizon(None, None)

    last = ceiling
    moved = True
    while moved:
        moved = False
        for acquired, unpriced in blocked:
            if acquired <= last <= unpriced:
                last = acquired - day
                moved = True

    if last < start:
        return Horizon(max(unpriced for _, unpriced in blocked) + day, None)

    left = [unpriced for acquired, unpriced in blocked if unpriced <= last]
    return Horizon(max(left) + day if left else None,
                   None if last >= ceiling else last)


@dataclass
class DailyPerf:
    """One day of an entity's (account or global) valuation, gain and TWR."""
    date: date
    cash_balance: float
    holdings_value: float
    total_value: float
    net_contributed: float
    external_flow: float          # F_D: net external inflow value on this day
    gain_absolu: float = 0.0
    twr_index: Optional[float] = None


@dataclass
class Performance:
    """Performance of one entity (an account, or the global portfolio)."""
    daily: List[DailyPerf] = field(default_factory=list)
    xirr: Optional[float] = None
    has_cash_ledger: bool = False
    has_external_flow: bool = False

    @property
    def gain_absolu(self) -> Optional[float]:
        """This entity's absolute gain: the **last day of its own series**."""
        return self.daily[-1].gain_absolu if self.daily else None


_XIRR_LOW = -0.9999
_XIRR_HIGH = 1e3
_XIRR_TOL = 1e-8
_XIRR_MAX_ITER = 200


def xirr(cashflows: List[Tuple[date, float]]) -> Optional[float]:
    """Annualized internal rate of return by bisection (no external dependency)."""
    if not cashflows:
        return None

    low, high = _XIRR_LOW, _XIRR_HIGH

    dates = [d for d, _ in cashflows]
    t0 = min(dates)
    if max(dates) == t0:
        return None  # zero horizon — an annualized rate is undefined

    def npv(rate: float) -> float:
        return sum(amt / (1.0 + rate) ** ((d - t0).days / 365.0)
                   for d, amt in cashflows)

    try:
        f_low, f_high = npv(low), npv(high)
        if f_low == 0:
            return low
        if f_low * f_high > 0:
            return None  # not bracketed -> undefined

        for _ in range(_XIRR_MAX_ITER):
            mid = (low + high) / 2.0
            f_mid = npv(mid)
            if abs(f_mid) < _XIRR_TOL or (high - low) < _XIRR_TOL:
                return mid
            if f_low * f_mid < 0:
                high, f_high = mid, f_mid
            else:
                low, f_low = mid, f_mid
    except (OverflowError, ZeroDivisionError):
        return None  # no float carries this horizon -> undefined
    return (low + high) / 2.0


def _fill_twr(daily: List[DailyPerf]) -> None:
    """Fill twr_index in place: base 100 anchored at the first day with value, then compounded by r_D = (V_D - F_D) / V_{D-1} (flows land end-of-day)."""
    prev_v: Optional[float] = None
    twr: Optional[float] = None
    for dp in daily:
        v = dp.total_value
        if twr is None:
            if v != 0:
                twr = 100.0  # anchor
        elif prev_v and v:
            twr = twr * (v - dp.external_flow) / prev_v
        dp.twr_index = twr
        prev_v = v


def _holdings_value(timeline: Timeline, account: str, symbols,
                    price_at: PriceAt, day: date,
                    carried: Collection[str] = (),
                    first_quoted: Optional[Mapping[str, date]] = None
                    ) -> Tuple[float, bool]:
    """Σ(quantity × forward-filled price) for the account on ``day``."""
    quoted_from = first_quoted or {}
    total = 0.0
    has_position = False
    for sym in symbols:
        pos = timeline.position_at(account, sym, day)
        if not pos:
            continue
        has_position = True
        qty = pos['quantity']
        if not qty:
            continue
        price = price_at(sym, day)
        if sym in carried:
            price = carrying_price(price, was_quoted(quoted_from.get(sym), day),
                                   qty, pos.get('cost_basis'))
        if price is not None:
            total += qty * price
    return total, has_position


def _account_flows(timeline: Timeline, account: str):
    """Return (cash_flows, grant_flows) for one account."""
    cash_flows, grant_flows = [], []
    for flow in timeline.flows:
        if isinstance(flow, CashFlow) and flow.account == account:
            cash_flows.append((flow.date, flow.amount))
        elif isinstance(flow, InKindFlow) and flow.account == account:
            grant_flows.append((flow.date, _grant_value(flow)))
    return cash_flows, grant_flows


def _grant_value(flow: InKindFlow) -> float:
    """What a grant contributed: its declared value, or nothing."""
    return declared_value(flow.quantity, flow.unit_price)


def _external_flow_by_date(cash_flows, grant_flows) -> Dict[date, float]:
    """Net external inflow value per date (deposits +, withdrawals -, grants at their declared value)."""
    by_date: Dict[date, float] = defaultdict(float)
    for d, amount in cash_flows:
        by_date[d] += amount
    for d, value in grant_flows:
        by_date[d] += value
    return by_date


def _xirr_cashflows(cash_flows, grant_flows,
                    terminal_value: float, today: date) -> List[Tuple[date, float]]:
    """Build the investor-perspective cashflows for XIRR: contributions negative, terminal value positive."""
    cfs: List[Tuple[date, float]] = []
    for d, amount in cash_flows:
        if d <= today:
            cfs.append((d, -amount))           # deposit(+)→pay in(-); withdrawal(-)→receive(+)
    for d, value in grant_flows:
        if value and d <= today:
            cfs.append((d, -value))            # in-kind contribution
    cfs.append((today, terminal_value))
    return cfs


def _running_contribution(flow_by_date: Mapping[date, float]):
    """A callable answering *everything contributed on or before this day*."""
    days = sorted(flow_by_date)
    index, total = 0, 0.0

    def contributed(day: date) -> float:
        nonlocal index, total
        while index < len(days) and days[index] <= day:
            total += flow_by_date[days[index]]
            index += 1
        return total

    return contributed


def _daily_range(start: date, today: date):
    day = start
    while day <= today:
        yield day
        day += timedelta(days=1)


def compute_account(timeline: Timeline, account: Account, symbols,
                    price_at: PriceAt, start: date, today: date,
                    carried: Collection[str] = (),
                    first_quoted: Optional[Mapping[str, date]] = None
                    ) -> Performance:
    """Compute one account's daily valuation series, TWR, XIRR and absolute gain."""
    acc = account.id
    cash_flows, grant_flows = _account_flows(timeline, acc)
    flow_by_date = _external_flow_by_date(cash_flows, grant_flows)
    contributed_by = _running_contribution(flow_by_date)

    daily: List[DailyPerf] = []
    started = False
    for day in _daily_range(start, today):
        cash = timeline.cash_at(acc, day)
        holdings, has_position = _holdings_value(
            timeline, acc, symbols, price_at, day, carried, first_quoted)
        contributed = contributed_by(day)

        if not started and cash is None and not has_position:
            continue  # skip days before the account has any activity
        started = True

        cash_balance = cash.cash_balance if cash else 0.0
        net_contributed = cash.net_contributed if cash else 0.0
        total_value = cash_balance + holdings
        daily.append(DailyPerf(
            date=day,
            cash_balance=cash_balance,
            holdings_value=holdings,
            total_value=total_value,
            net_contributed=net_contributed,
            external_flow=flow_by_date.get(day, 0.0),
            gain_absolu=total_value - contributed,
        ))

    _fill_twr(daily)

    perf = Performance(
        daily=daily,
        has_cash_ledger=bool(cash_flows),
        has_external_flow=bool(cash_flows or grant_flows),
    )
    if daily:
        terminal = daily[-1].total_value
        if perf.has_external_flow:
            perf.xirr = xirr(
                _xirr_cashflows(cash_flows, grant_flows, terminal, today))
    return perf


def compute_portfolio_total(timeline: Timeline, accounts: List[Account], symbols,
                            price_at: PriceAt, start: date, today: date,
                            per_account: Dict[str, Performance]) -> Optional[Performance]:
    """Aggregate all accounts into a global performance (no tag)."""
    if not accounts:
        return None

    by_date: Dict[date, DailyPerf] = {}
    for perf in per_account.values():
        for dp in perf.daily:
            if dp.date < start or dp.date > today:
                continue
            agg = by_date.get(dp.date)
            if agg is None:
                agg = DailyPerf(dp.date, 0.0, 0.0, 0.0, 0.0, 0.0)
                by_date[dp.date] = agg
            agg.cash_balance += dp.cash_balance
            agg.holdings_value += dp.holdings_value
            agg.total_value += dp.total_value
            agg.net_contributed += dp.net_contributed
            agg.external_flow += dp.external_flow
            agg.gain_absolu += dp.gain_absolu

    daily = [by_date[d] for d in sorted(by_date)]
    _fill_twr(daily)

    all_cash, all_grant = [], []
    for account in accounts:
        cf, gf = _account_flows(timeline, account.id)
        all_cash.extend(cf)
        all_grant.extend(gf)

    total = Performance(
        daily=daily,
        has_cash_ledger=any(perf.daily for perf in per_account.values()) and all(
            perf.has_cash_ledger
            for perf in per_account.values() if perf.daily),
        has_external_flow=bool(all_cash or all_grant),
    )
    if daily:
        terminal = daily[-1].total_value
        if total.has_external_flow:
            total.xirr = xirr(
                _xirr_cashflows(all_cash, all_grant, terminal, today))
    return total


__all__ = [
    'PriceAt', 'DailyPerf', 'Performance', 'xirr',
    'ALWAYS_WRITTEN', 'CASH_LEDGER_FIELDS', 'EXTERNAL_FLOW_FIELDS',
    'writable_fields', 'account_horizon',
    'compute_account', 'compute_portfolio_total',
]
