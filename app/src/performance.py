"""
Money-weighted performance: XIRR (annualized) and TWR (time-weighted, base 100).

Pure domain module: ``Timeline`` × an injected price callable → performance
results. It knows nothing about InfluxDB or yfinance — the only dependency on the
outside world is the ``price_at(symbol, date) -> Optional[float]`` callable.

Definitions (see issue #563):
  * External flows (the *contribution*, NOT performance): DEPOSIT, WITHDRAWAL,
    GRANT (in-kind, valued at **the price its event declares**, or not at all).
  * Internal flows (they ARE performance): BUY, SELL, DIVIDEND and every fee.
    A sale is internal, which is why a realized gain needs nothing here: the
    proceeds land in cash and ``total_value`` is continuous across it.
  * Daily valuation: V = cash + Σ(quantity × price), prices forward-filled.
  * TWR return convention: flows land end-of-day, r_D = (V_D - F_D) / V_{D-1}.

A grant used to be valued through ``price_at`` (issue #699 / #672 D7). Two
defects went with it: a grant-only position has no BUY, so no point existed at
its date and the guard for that was *"skip unvalued grants"*; and the valuation
was **asynchronous** — the same grant counted as nothing until the backfill
reached its date and as something afterwards, so an account's ``gain_absolu``
moved with the reconstruction while no event had changed. The declared
``unit_price`` is the same number the cost basis takes, which is what makes
``latent + realized + dividends`` a decomposition of the absolute gain instead
of three figures that nearly add up.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Callable, Dict, List, Optional, Tuple

from events.schemas import (
    CashFlow, InKindFlow, Timeline, Account, declared_value,
)


PriceAt = Callable[[str, date], Optional[float]]


@dataclass
class DailyPerf:
    """One day of an entity's (account or global) valuation and TWR."""
    date: date
    cash_balance: float
    holdings_value: float
    total_value: float
    net_contributed: float
    external_flow: float          # F_D: net external inflow value on this day
    twr_index: Optional[float] = None


@dataclass
class Performance:
    """Performance of one entity (an account, or the global portfolio)."""
    daily: List[DailyPerf] = field(default_factory=list)
    xirr: Optional[float] = None
    gain_absolu: Optional[float] = None
    currency: Optional[str] = None


def xirr(cashflows: List[Tuple[date, float]],
         low: float = -0.9999, high: float = 1e9,
         tol: float = 1e-8, max_iter: int = 200) -> Optional[float]:
    """Annualized internal rate of return by bisection (no external dependency).

    ``cashflows`` are (date, amount) from the investor's perspective: money put
    in is negative, money/received value taken out is positive. Returns None when
    the flows span no time (nothing to annualize) or don't bracket a root within
    ``[low, high]`` — including an ultra-short horizon whose annualized rate would
    blow past the bracket (gain_absolu is the guard for that case).
    """
    if not cashflows:
        return None

    dates = [d for d, _ in cashflows]
    t0 = min(dates)
    if max(dates) == t0:
        return None  # zero horizon — an annualized rate is undefined

    def npv(rate: float) -> float:
        return sum(amt / (1.0 + rate) ** ((d - t0).days / 365.0)
                   for d, amt in cashflows)

    f_low, f_high = npv(low), npv(high)
    if f_low == 0:
        return low
    if f_low * f_high > 0:
        return None  # not bracketed -> undefined

    for _ in range(max_iter):
        mid = (low + high) / 2.0
        f_mid = npv(mid)
        if abs(f_mid) < tol or (high - low) < tol:
            return mid
        if f_low * f_mid < 0:
            high, f_high = mid, f_mid
        else:
            low, f_low = mid, f_mid
    return (low + high) / 2.0


def _fill_twr(daily: List[DailyPerf]) -> None:
    """Fill twr_index in place: base 100 anchored at the first day with value,
    then compounded by r_D = (V_D - F_D) / V_{D-1} (flows land end-of-day)."""
    prev_v: Optional[float] = None
    twr: Optional[float] = None
    for dp in daily:
        v = dp.total_value
        if twr is None:
            if v != 0:
                twr = 100.0  # anchor
        elif prev_v:
            twr = twr * (v - dp.external_flow) / prev_v
        dp.twr_index = twr
        prev_v = v


def _holdings_value(timeline: Timeline, account: str, symbols,
                    price_at: PriceAt, day: date) -> Tuple[float, bool]:
    """Σ(quantity × forward-filled price) for the account on ``day``.

    Returns (value, has_position) — has_position is True as soon as the account
    holds anything (even a symbol without a price yet).
    """
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
        if price is not None:
            total += qty * price
    return total, has_position


def _account_flows(timeline: Timeline, account: str):
    """Return (cash_flows, grant_flows) for one account.

    cash_flows: list of (date, amount) with amount signed (+deposit, -withdrawal).
    grant_flows: list of (date, value) — the value the grant's own event
    declared, already ``quantity × unit_price``. A grant with no declared price
    contributes ``0.0``, which is the dilution case and not an absence to fill
    in later.
    """
    cash_flows, grant_flows = [], []
    for flow in timeline.flows:
        if isinstance(flow, CashFlow) and flow.account == account:
            cash_flows.append((flow.date, flow.amount))
        elif isinstance(flow, InKindFlow) and flow.account == account:
            grant_flows.append((flow.date, _grant_value(flow)))
    return cash_flows, grant_flows


def _grant_value(flow: InKindFlow) -> float:
    """What a grant contributed: its declared value, or nothing.

    The same :func:`~events.schemas.declared_value` the cost basis reads, on
    purpose: the two terms feed together or neither, and two spellings of "was
    a price declared?" would eventually disagree — silently, since the symptom
    is an identity that stops holding by a few euros.
    """
    return declared_value(flow.quantity, flow.unit_price)


def _external_flow_by_date(cash_flows, grant_flows) -> Dict[date, float]:
    """Net external inflow value per date (deposits +, withdrawals -, grants at
    their declared value)."""
    by_date: Dict[date, float] = defaultdict(float)
    for d, amount in cash_flows:
        by_date[d] += amount
    for d, value in grant_flows:
        by_date[d] += value
    return by_date


def _xirr_cashflows(cash_flows, grant_flows,
                    terminal_value: float, today: date) -> List[Tuple[date, float]]:
    """Build the investor-perspective cashflows for XIRR: contributions negative,
    terminal value positive."""
    cfs: List[Tuple[date, float]] = []
    for d, amount in cash_flows:
        cfs.append((d, -amount))               # deposit(+)→pay in(-); withdrawal(-)→receive(+)
    for d, value in grant_flows:
        if value:
            cfs.append((d, -value))            # in-kind contribution
    cfs.append((today, terminal_value))
    return cfs


def _base_contributed(cash_flows, grant_flows) -> float:
    """Total external contribution (deposits - withdrawals + declared grants)."""
    cash = sum(amount for _, amount in cash_flows)
    return cash + sum(value for _, value in grant_flows)


def _daily_range(start: date, today: date):
    day = start
    while day <= today:
        yield day
        day += timedelta(days=1)


def compute_account(timeline: Timeline, account: Account, symbols,
                    price_at: PriceAt, start: date, today: date) -> Performance:
    """Compute one account's daily valuation series, TWR, XIRR and absolute gain."""
    acc = account.id
    cash_flows, grant_flows = _account_flows(timeline, acc)
    flow_by_date = _external_flow_by_date(cash_flows, grant_flows)

    daily: List[DailyPerf] = []
    started = False
    for day in _daily_range(start, today):
        cash = timeline.cash_at(acc, day)
        holdings, has_position = _holdings_value(timeline, acc, symbols, price_at, day)

        if not started and cash is None and not has_position:
            continue  # skip days before the account has any activity
        started = True

        cash_balance = cash.cash_balance if cash else 0.0
        net_contributed = cash.net_contributed if cash else 0.0
        daily.append(DailyPerf(
            date=day,
            cash_balance=cash_balance,
            holdings_value=holdings,
            total_value=cash_balance + holdings,
            net_contributed=net_contributed,
            external_flow=flow_by_date.get(day, 0.0),
        ))

    _fill_twr(daily)

    perf = Performance(daily=daily, currency=account.currency)
    has_external = bool(cash_flows or grant_flows)
    if has_external and daily:
        terminal = daily[-1].total_value
        perf.xirr = xirr(_xirr_cashflows(cash_flows, grant_flows, terminal, today))
        perf.gain_absolu = terminal - _base_contributed(cash_flows, grant_flows)
    return perf


def compute_portfolio_total(timeline: Timeline, accounts: List[Account], symbols,
                            price_at: PriceAt, start: date, today: date,
                            per_account: Dict[str, Performance]) -> Optional[Performance]:
    """Aggregate all accounts into a global performance (no tag).

    Returns None when there are no accounts or they don't all share the same
    currency — pooling different currencies would need FX (out of scope).
    """
    if not accounts:
        return None
    currencies = {a.currency for a in accounts}
    if len(currencies) > 1:
        return None

    # Sum the per-account daily series by date (accounts start on different days).
    by_date: Dict[date, DailyPerf] = {}
    for perf in per_account.values():
        for dp in perf.daily:
            agg = by_date.get(dp.date)
            if agg is None:
                agg = DailyPerf(dp.date, 0.0, 0.0, 0.0, 0.0, 0.0)
                by_date[dp.date] = agg
            agg.cash_balance += dp.cash_balance
            agg.holdings_value += dp.holdings_value
            agg.total_value += dp.total_value
            agg.net_contributed += dp.net_contributed
            agg.external_flow += dp.external_flow

    daily = [by_date[d] for d in sorted(by_date)]
    _fill_twr(daily)

    # Global XIRR / gain from all accounts' flows combined + one global terminal.
    all_cash, all_grant = [], []
    for account in accounts:
        cf, gf = _account_flows(timeline, account.id)
        all_cash.extend(cf)
        all_grant.extend(gf)

    total = Performance(daily=daily, currency=currencies.pop())
    has_external = bool(all_cash or all_grant)
    if has_external and daily:
        terminal = daily[-1].total_value
        total.xirr = xirr(_xirr_cashflows(all_cash, all_grant, terminal, today))
        total.gain_absolu = terminal - _base_contributed(all_cash, all_grant)
    return total
