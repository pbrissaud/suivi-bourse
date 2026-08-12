"""
Money-weighted performance: XIRR (annualized) and TWR (time-weighted, base 100).

Pure domain module: ``Timeline`` × an injected price callable → performance
results. It knows nothing about the store or yfinance — the only dependency on the
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
from typing import (
    Callable, Collection, Dict, FrozenSet, List, Mapping, Optional, Tuple,
)

from carrying import carrying_price, was_quoted
from events.schemas import (
    CashFlow, InKindFlow, Timeline, Account, declared_value,
)


PriceAt = Callable[[str, date], Optional[float]]


# --------------------------------------------------------------------------- #
# The per-field rule (issue #708, spec #695 § 11, ADR-0018)
#
# It replaces the opt-in guard, which had lost its subject without anybody
# noticing: an ``account`` row named ``default`` is seeded at the creation of the
# schema (ADR-0013), so *"no account is declared"* is structurally false and the
# guard gated on a condition nothing can reach.
#
# Removing it alone would have been wrong, and that is the whole reason the rule
# is **by field and never by account**: the replay debits the cash ledger on
# every purchase without touching the contributions, so an owner who never wrote
# a ``DEPOSIT`` carries ``cash_balance = −invested`` and ``net_contributed = 0``
# — and their **latent gain gets published under the label "total value"**. What
# has no meaning there is the cash-derived half, not the account.
# --------------------------------------------------------------------------- #

#: Written for every account, whatever its ledger says.
#:
#: ``gain_absolu`` is here on ADR-0018's amendment and it is the one that looks
#: surprising: with no ``DEPOSIT`` at all, ``cash = −invested`` and
#: ``net_contributed = 0``, so ``gain_absolu = holdings − invested`` is **exact**.
#: What genuinely has no meaning without an external flow is ``xirr`` — there is
#: nothing to weight — and the guard had travelled with it by accident.
ALWAYS_WRITTEN = ('holdings_value', 'gain_absolu')

#: Written only where the account has at least one cash event
#: (``DEPOSIT``/``WITHDRAWAL``). ``twr_index`` follows ``total_value`` because it
#: is chained *from* it: an index computed over a value that is the negative of
#: what was invested is a return on a quantity nobody contributed.
CASH_LEDGER_FIELDS = ('cash_balance', 'total_value', 'net_contributed',
                      'twr_index')

#: Written only where the account has an external flow — cash **or** an in-kind
#: grant. One field, and it is the only one the retired guard was ever right
#: about.
EXTERNAL_FLOW_FIELDS = ('xirr',)


def writable_fields(has_cash_ledger: bool,
                    has_external_flow: bool) -> FrozenSet[str]:
    """Which of the seven figures this entity may publish.

    One function, read by the per-account points and by the global ones alike, so
    the rule cannot be spelled twice and drift on one of the two tables. A field
    outside the answer is written as ``NULL`` — never as a zero, which would make
    *"no ledger"* and *"a ledger at zero"* the same row, and never skipped, since
    in the store a declared column that was never written reads as ``NULL``
    (ADR-0001).
    """
    fields = set(ALWAYS_WRITTEN)
    if has_cash_ledger:
        fields.update(CASH_LEDGER_FIELDS)
    if has_external_flow:
        fields.update(EXTERNAL_FLOW_FIELDS)
    return frozenset(fields)


# --------------------------------------------------------------------------- #
# The sliding horizon (issue #708, spec #695 § 11)
# --------------------------------------------------------------------------- #

def account_horizon(windows: Mapping[str, Tuple[date, date]],
                    oldest_priced: Mapping[str, date],
                    settled: Collection[str] = ()) -> Optional[date]:
    """The first day this account's figures may be written.

    ::

        horizon(account) = 1 + max over s of min( oldest_price(s) − 1,
                                                 last_held_day(s) )

    The perf series is written on a **sliding horizon** and never behind a door:
    today's figures are right from the first cycle, and a page filling in towards
    the left is the best progress bar available. What the horizon bounds is the
    day a held position has **no price yet** — a day where ``holdings_value``
    would count that position as nothing while the cash ledger has already paid
    for it, which digs a crater in the value curve and, because a time-weighted
    index *chains*, leaves a scar for the whole cycle (measured on the real
    portfolio: three purchases on 2020-09-28, ``twr_index`` 0,057, the head
    reading **−100,00 %** on a portfolio worth eleven thousand euros).

    Four things about the formula are decisions:

    * **It is bounded by each symbol's holding window.** Taken literally as *"the
      most recent of the oldest available prices"*, a line sold in 2022 whose
      backfill is only starting has its oldest available price dated *this year*
      and would hold the **whole account** at today — while it constrains no day
      after 2022. ADR-0009 driving the backfill from the replay is exactly what
      made that case ordinary.
    * **By the window's *two* ends.** Spec #695 § 11 writes the upper one; the
      lower one is the same decision on the other side, and without it the
      formula says something nobody meant. A symbol never overshoots its first
      acquisition — the backward pass stops there on purpose (ADR-0004) — so its
      oldest price *is* its acquisition day once the reconstruction concludes,
      and a portfolio that bought a new line this morning would take a horizon of
      *this morning* and lose every year it has. A day before a position was
      acquired holds nothing of it: there is no crater to avoid, and the term is
      simply not about that day.
    * **A settled symbol does not contribute at all** — see ``settled`` below.
    * **A per-day mask was refused** although it is almost free: it produces holes
      **in the middle** as soon as a symbol is imported late, which breaks the
      chaining of the time-weighted return *and* contradicts the series' calendar
      density.

    ``windows`` is ``{symbol: (first day held, last day held)}`` for **this
    account** (:meth:`events.schemas.Timeline.holding_window`) — the last being
    *today* while the line stands. ``oldest_priced`` is ``{symbol: oldest day
    carrying a usable price}``, over the whole store since a price belongs to no
    account (#700). A symbol absent from it has no usable price **at all**, and
    blocks every day it was held — which is the reconstruction's first minutes,
    seen from here.

    ``settled`` is the set of symbols whose absence of a price is **permanent**
    rather than transitory: a terminal backfill (:func:`quotes.terminal_symbols`)
    and the symbol quoted in a currency that does not resolve. They are excluded
    rather than blocking, and for two reasons that are one: taken at their word
    they would pin the horizon at today **for ever**, and their priceless days are
    precisely :func:`carrying.carrying_price`'s domain — *terminal symbol, any
    day* — which nothing below the horizon could ever reach, since below it
    nothing is written at all.

    ``None`` when nothing constrains the account: it holds no symbol, or every one
    of its symbols is settled or priced from the first day it was held.
    """
    blocked: Optional[date] = None
    for symbol, (acquired, last_held) in windows.items():
        if symbol in settled:
            continue
        oldest = oldest_priced.get(symbol)
        if oldest is not None and oldest <= acquired:
            continue  # priced from the day it was acquired: nothing is waiting
        unpriced = (last_held if oldest is None
                    else min(oldest - timedelta(days=1), last_held))
        if blocked is None or unpriced > blocked:
            blocked = unpriced
    return None if blocked is None else blocked + timedelta(days=1)


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
    """Performance of one entity (an account, or the global portfolio).

    No ``currency`` field since #702. It carried ``Account.currency``, which is
    deleted: there is one reporting currency for the whole install, every figure
    in here is already in it, and a copy on each entity was only ever read to ask
    whether two of them disagreed — a question ADR-0002 removes rather than
    answers.
    """
    daily: List[DailyPerf] = field(default_factory=list)
    xirr: Optional[float] = None
    gain_absolu: Optional[float] = None
    #: The two conditions of the per-field rule (issue #708), carried on the
    #: result rather than re-derived by the writer: they are answers about the
    #: *flows this computation ran on*, and a caller re-asking them of the ledger
    #: would eventually ask a slightly different question. See
    #: :func:`writable_fields`.
    has_cash_ledger: bool = False
    has_external_flow: bool = False


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
                    price_at: PriceAt, day: date,
                    carried: Collection[str] = (),
                    first_quoted: Optional[Mapping[str, date]] = None
                    ) -> Tuple[float, bool]:
    """Σ(quantity × forward-filled price) for the account on ``day``.

    Returns (value, has_position) — has_position is True as soon as the account
    holds anything (even a symbol without a price yet).

    ``carried`` is the set of symbols whose backfill is **terminal** (issue #706,
    ADR-0004), and the lines below are the carrying predicate's two terms,
    written where they can be read together: membership of that set, and
    :func:`carrying.carrying_price` returning the position's own unit cost when
    the day has no observed price. A symbol still being reconstructed is not in
    the set, so its priceless days go on contributing nothing — which is the
    whole point: a portfolio flat-at-cost for four years that then takes off and
    corrects itself is *"not yet"* rendered as *"never"*.

    ``first_quoted`` is what keeps the first term about the **quote** rather than
    about its conversion. ``price_at`` reads ``price_converted`` — every figure
    here is money in the reporting currency — so a symbol whose pair does not
    resolve looks priceless to it while its quote is perfectly well known. That is
    *waiting for a rate*, and carrying it at cost would publish a valuation the
    app does not have. ``{symbol: first day quoted at all}`` separates the two,
    and :func:`carrying.was_quoted` forward-fills it exactly as ``price_at``
    forward-fills the close beside it.

    Below the perf horizon nothing is written at all, so this is never reached
    with a day the recompute would refuse to publish (spec #695 § 9).
    """
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
                    price_at: PriceAt, start: date, today: date,
                    carried: Collection[str] = (),
                    first_quoted: Optional[Mapping[str, date]] = None
                    ) -> Performance:
    """Compute one account's daily valuation series, TWR, XIRR and absolute gain.

    ``carried`` is the terminal-backfill set (issue #706) and it defaults to
    empty, which is the pre-#706 behaviour: no symbol is carried unless the
    caller has established that its history has stopped coming. ``first_quoted``
    is the day each symbol was **first quoted at all** and it defaults to empty
    for the opposite reason: with nothing known about the quotes, no day is
    treated as observed, so the fallback stays available to a caller that has
    only established terminality. It is :func:`_holdings_value` that explains why
    the two are separate questions.

    ``start`` is where the caller has already raised the earliest event date to
    the account's **horizon** (issue #708, :func:`account_horizon`): below it
    nothing is written at all, so nothing is computed either — which is what
    keeps :func:`carrying.carrying_price`'s domain exactly *terminal symbol, any
    day* rather than *any symbol whose history has not arrived yet*.
    """
    acc = account.id
    cash_flows, grant_flows = _account_flows(timeline, acc)
    flow_by_date = _external_flow_by_date(cash_flows, grant_flows)

    daily: List[DailyPerf] = []
    started = False
    for day in _daily_range(start, today):
        cash = timeline.cash_at(acc, day)
        holdings, has_position = _holdings_value(
            timeline, acc, symbols, price_at, day, carried, first_quoted)

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

    perf = Performance(
        daily=daily,
        # A cash event is a ``DEPOSIT``/``WITHDRAWAL`` and nothing else: a
        # purchase moves the balance too, and counting it here would put the rule
        # back exactly where the defect is (a ledger of purchases alone is the
        # case the per-field rule exists for).
        has_cash_ledger=bool(cash_flows),
        has_external_flow=bool(cash_flows or grant_flows),
    )
    if daily:
        terminal = daily[-1].total_value
        # ``gain_absolu`` **always** (ADR-0018): with no external flow at all,
        # ``_base_contributed`` is zero and the figure is ``holdings − invested``
        # — exact, and the one thing an owner who never recorded a deposit can
        # still be told. ``xirr`` keeps the condition, because an internal rate
        # of return with no flow to weight is not a degraded figure, it is not a
        # figure.
        perf.gain_absolu = terminal - _base_contributed(cash_flows, grant_flows)
        if perf.has_external_flow:
            perf.xirr = xirr(
                _xirr_cashflows(cash_flows, grant_flows, terminal, today))
    return perf


def compute_portfolio_total(timeline: Timeline, accounts: List[Account], symbols,
                            price_at: PriceAt, start: date, today: date,
                            per_account: Dict[str, Performance]) -> Optional[Performance]:
    """Aggregate all accounts into a global performance (no tag).

    Returns None when there are no accounts. The **single-currency condition is
    gone** (issue #702, ADR-0002): it refused to pool accounts whose currencies
    disagreed, and an account has no currency any more — everything here is in
    the one reporting currency, already converted at the point it was written.
    What can still make this unwritable is that currency being unanswered, and
    that is decided one storey up, on the whole recompute, because it is true of
    every figure at once rather than of the pooling.

    ``start`` is the **max of the per-account horizons** (issue #708) and it is
    where the argument for a global table is paid for: the global is written only
    where **every** account is. Summing the accounts that happen to be available
    on a day, or completing the missing ones with zeros, would draw **a step
    nothing caused** — an account joining the sum as its own reconstruction
    reaches back far enough, on the one page the product opens on. The consequence
    is accepted rather than worked around: one slow account delays the whole home
    page. It is also ADR-0018's rule seen from the other side — *a global figure
    is written only where it is writable for every account* — which is why
    :attr:`Performance.has_cash_ledger` is folded with ``all`` below.
    """
    if not accounts:
        return None

    # Sum the per-account daily series by date (accounts start on different days).
    by_date: Dict[date, DailyPerf] = {}
    for perf in per_account.values():
        for dp in perf.daily:
            if dp.date < start:
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

    daily = [by_date[d] for d in sorted(by_date)]
    _fill_twr(daily)

    # Global XIRR / gain from all accounts' flows combined + one global terminal.
    all_cash, all_grant = [], []
    for account in accounts:
        cf, gf = _account_flows(timeline, account.id)
        all_cash.extend(cf)
        all_grant.extend(gf)

    total = Performance(
        daily=daily,
        # ``all``, and over the accounts that **produce a series** — an account
        # declared and never used contributes nothing to the sum, so it has no
        # figure to make unwritable. One account with no cash ledger is enough to
        # take the global's cash-derived half away, because its
        # ``cash_balance = −invested`` is inside the sum: a global ``total_value``
        # holding it is the very figure the per-field rule exists to remove, at
        # the level of the whole portfolio.
        has_cash_ledger=all(perf.has_cash_ledger
                            for perf in per_account.values() if perf.daily),
        has_external_flow=bool(all_cash or all_grant),
    )
    if daily:
        terminal = daily[-1].total_value
        total.gain_absolu = terminal - _base_contributed(all_cash, all_grant)
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
