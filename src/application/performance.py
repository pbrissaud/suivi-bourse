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
    Callable, Collection, Dict, FrozenSet, List, Mapping, NamedTuple, Optional,
    Tuple,
)

from application.carrying import carrying_price, was_quoted
from application.events.schemas import (
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
#:
#: **And *written* means on every day since #782**, which is what this name
#: always claimed. It was computed once, at the terminal day, and laid down on
#: the last point of the series alone — like ``xirr``, which is annualised over
#: the whole history and genuinely has one value. ``gain_absolu`` has no such
#: excuse: it is ``total_value − contributions`` and both terms are known on
#: every day the series carries. The cost of the old spelling was not a missing
#: column but a **figure nobody could ever read**: ``portfolio_view._ytd``
#: counts the movement of this field between the base day and the latest, the
#: base day is by construction never the last point, so the year-to-date gain
#: was ``null`` on every real install — and ``perf_series._upsert`` reassigns
#: every non-key column each cycle, so yesterday's value was set back to
#: ``NULL`` today rather than accumulating.
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
# The sliding horizon (issue #708, spec #695 § 11) — its cap (issue #765), and
# the question of whether it may be more than one interval (issue #766: no)
# --------------------------------------------------------------------------- #

class Horizon(NamedTuple):
    """The days an account's figures may be written on: ``[first, last]``.

    **Two ends of one axis, and one rule** (issue #765). #708 published a single
    left bound, which is right for the block a reconstruction leaves — the oldest
    days of a symbol's window, walking left to right as the backward pass
    advances. It is wrong for a block sitting at the **other** end, and there is
    an ordinary gesture that produces one: buying a line of a security the
    portfolio did not hold yet. That symbol has no price at all for one backfill
    cycle, its block is ``[today, today]``, and a left bound placed the day after
    it lands on *tomorrow* — so the whole series falls under the horizon, the
    cycle produces no point for anybody, and :func:`perf_series.
    prune_account_metrics` correctly empties the table. **Years of history
    deleted by a purchase**, until the next backfill chunk lands.

    ``first`` is ``None`` when nothing bounds the series on the left, ``last``
    when nothing caps it on the right — the caller's own ceiling then stands.

    **Two ends, and never more than two** (issue #766). The question #765 raised
    and left open — *may a horizon be more than one interval?* — is answered here
    by the shape: it is a pair, not a list of runs. The argument is in
    :func:`account_horizon`, and it is the TWR's, which chains over consecutive
    elements of a list rather than over consecutive calendar days.
    """
    first: Optional[date]
    last: Optional[date]


def account_horizon(windows: Mapping[str, Tuple[date, date]],
                    oldest_priced: Mapping[str, date],
                    settled: Collection[str] = (), *,
                    start: date, ceiling: date) -> Horizon:
    """The days this account's figures may be written on.

    Every symbol blocks the closed interval ``[acquired(s), unpriced(s)]``, with
    ::

        unpriced(s) = min( oldest_price(s) − 1, last_held_day(s) )

    and the series is **the latest run of days no block covers**, inside
    ``[start, ceiling]``.

    The perf series is written on a **sliding horizon** and never behind a door:
    today's figures are right from the first cycle, and a page filling in towards
    the left is the best progress bar available. What a block bounds is the day a
    held position has **no price yet** — a day where ``holdings_value`` would
    count that position as nothing while the cash ledger has already paid for it,
    which digs a crater in the value curve and, because a time-weighted index
    *chains*, leaves a scar for the whole cycle (measured on the real portfolio:
    three purchases on 2020-09-28, ``twr_index`` 0,057, the head reading
    **−100,00 %** on a portfolio worth eleven thousand euros).

    Eight things about it are decisions:

    * **It is bounded by each symbol's holding window.** Taken literally as *"the
      most recent of the oldest available prices"*, a line sold in 2022 whose
      backfill is only starting has its oldest available price dated *this year*
      and would hold the **whole account** at today — while it constrains no day
      after 2022. ADR-0009 driving the backfill from the replay is exactly what
      made that case ordinary.
    * **By the window's *two* ends**, which is the same rule seen from the other
      side: a day before a position was acquired holds nothing of it, so there is
      no crater to avoid and the term is simply not about that day. That is a
      statement about the **block**, and about nothing beyond it: ``[acquired,
      unpriced]`` never covers a day the line was not held.
      ``unpriced < acquired`` is #708's ``oldest ≤ acquired`` **or the window is
      degenerate**, and the second half is a real difference rather than a
      re-spelling: :meth:`events.schemas.Timeline.holding_window` used to answer
      ``acquired, (today if holding else emptied)`` with **no clamp**, and
      ``events/validator.py`` forbids no event dated in the future — so a single
      row dated next year gave a last day *before* its first. #708 did not skip
      it, built a block ending before it began, and put the left bound past every
      real day: the cycle wrote nothing and the prune emptied the table. Answering
      *nothing constrains this account* is the truth about a window holding no
      day. **Since #766 no caller produces that shape** — the window answers
      ``None`` for a position that has held nothing yet, so the truth is told
      where the window is built instead of recognised here — and the guard stays
      all the same: this is a pure function over two mappings, and the property
      is its own rather than the one caller's. What this line is still **not** is
      the repair of #765 — on a held
      symbol quoted nowhere the window is ordinary and the branch is not taken;
      the cap below is what treats that one. What it buys there is that the block
      is built before it is judged, which is what the cap needs to walk over.
    * **A block that reaches the ceiling caps the series instead of bounding
      it** — the repair itself (issue #765). The block is treated *where it is*:
      the series stops the day before it rather than starting the day after,
      so the dashboard keeps its history, its last point is a day old, and the
      next cycle catches up. The right edge walks left past every block covering
      it, repeatedly, since stepping over one block can land inside another.
    * **A horizon is one interval, and that is now a decision rather than a
      shape** (issue #766). #765 left the question open: a block sitting *wholly
      in the past* cuts the timeline into two runs of computable days, and only
      the one holding today survives — so the days before that symbol's own
      acquisition fall with it, not because the block covers them, it does not,
      but because there is one interval to render. A line acquired 2020-03-02,
      sold 2022-05-04 and quoted nowhere pins a ledger opened in 2019 at
      2022-05-05, 2019 included. **The answer is no, and the TWR is what
      settles it.** :func:`_fill_twr` chains ``twr × (V − F) / V_prev`` over
      consecutive **elements of the list**, never over consecutive calendar days,
      so a series with a hole chains the day after the gap against the day before
      it: an external flow landing inside the gap is never divided out and the
      owner's own deposit is reported as performance — measured in
      ``test_a_horizon_is_one_interval_and_the_twr_is_what_decides_it``, +10 %
      of real return read as +120 %, on a column in which nothing says the days
      are missing. That is #708's refusal of the per-day mask, restated on
      #766's exact input, and the two ways round it go with it: re-anchoring at
      the gap makes ``twr_index`` two incomparable series in one column, which
      ADR-0019's rebasing then draws as a discontinuity, and keeping the *left*
      run instead abandons today's figures, which is the whole of the sliding
      horizon. Answering *yes* would also have had to reopen #708's calendar
      density, split the prune's ``spans`` per account, give ``main`` a ``max``
      over two runs and publish a member on ``/api/runtime`` for a front to tell
      *capped* from *up to date* — three propagations bought for a figure that
      would be wrong.
    * **And the residue is measured rather than assumed** (issue #766). On the
      real staging ledger — 285 events, 19 symbols, 2 accounts, 2019-10-30 →
      2026-08-20 — **fully reconstructed no account carries a blocking window at
      all**: ``/api/runtime`` answers ``horizon: null`` for the three of them and
      the residue costs zero days. During a reconstruction seven of the nineteen
      symbols carry a wholly-past window and **both** accounts carry one, and
      their marginal cost is still **0 days at every cycle** — 907/907 for CTO
      and 2 487/2 487 for PEA, whether the past blocks are counted or dropped.
      The reason is structural: a sold line's backward pass starts from **its own
      exit** (:func:`carrying.holding_bounds`), not from today, so it is
      reconstructed past its acquisition at least as fast as a line of the same
      age still held, and while any held line is still walking left that held
      line bounds the series further left than the sold one can. The shape where
      the residue does cost days is therefore nameable rather than common: a line
      held for years and sold long ago, beside holdings all bought recently. It
      is transitory there too, by the same mechanism as every other block — the
      symbol leaves the blocking population as soon as its backward pass reaches
      its acquisition, or concludes (``settled``).
    * **When no run survives, the reading falls back to the left bound.** The
      blocks then cover the ledger from its first day to the ceiling — the
      ordinary shape of a fresh install whose first purchase has no price yet —
      and there is no history to save: the series is empty either way, and
      ``first`` names the first day it could resume rather than claiming nothing
      constrains this account. That distinction is not cosmetic: ``first`` is
      what ``/api/runtime`` publishes (issue #708), where ``null`` means *nothing
      constrains this account*.
    * **A settled symbol does not contribute at all** — see ``settled`` below.
    * **A per-day mask was refused** although it is almost free: it produces holes
      **in the middle** as soon as a symbol is imported late, which breaks the
      chaining of the time-weighted return *and* contradicts the series' calendar
      density. The cap is not a mask: it moves an **end** of the interval, so the
      series stays one contiguous run of calendar days.

    Three other exits were instructed and refused (issue #765):

    * **Assuming the blank page.** It is the failure mode the product refuses
      everywhere else — #718 mounted ``Band`` in the content column exactly so
      that *"the store is unreadable"* and *"you own nothing"* stop being one
      white screen — and here no band names it: nothing failed, the computation
      concluded there was nothing to write.
    * **Never letting the horizon rise above what a previous cycle wrote.** It
      contradicts ADR-0011 head on: the two tables are a *cache, a pure function
      of the ledger, the prices and the declared accounts*, and reading what one
      wrote to decide what to write next destroys the property the integral
      unconditional recompute bought by deleting ``perf_should_run`` and its four
      state variables. It also repairs nothing on a fresh install, which has no
      previous cycle.
    * **Treating "held, never quoted, backfill not yet run" as settled**, hence
      carried at cost. It contradicts #706's two-term predicate, whose whole
      argument is that carrying at cost requires a **permanent** absence: applied
      to a transitory one it replays a portfolio flat-at-cost that then takes off
      and corrects itself with the owner having done nothing.

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
    day* — which nothing outside the horizon could ever reach, since outside it
    nothing is written at all. **That domain is unchanged by this repair**: the
    cap removes days from the series, it never hands a transitory absence to the
    carrying convention.

    ``Horizon(None, None)`` when nothing constrains the account: it holds no
    symbol, or every one of its symbols is settled or priced from the first day
    it was held.
    """
    day = timedelta(days=1)
    blocked: List[Tuple[date, date]] = []
    for symbol, (acquired, last_held) in windows.items():
        if symbol in settled:
            continue
        oldest = oldest_priced.get(symbol)
        unpriced = (last_held if oldest is None
                    else min(oldest - day, last_held))
        if unpriced < acquired:
            # An empty block: the symbol is priced from the day it was acquired,
            # so nothing of it is waiting. Reachable only when ``oldest`` exists
            # — with no price at all ``unpriced`` is ``last_held``, never before
            # ``acquired`` — which is why the never-quoted symbol is the cap's
            # business and not this line's.
            continue
        blocked.append((acquired, unpriced))

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
        # No run of days survives the blocks. The series is empty whichever end
        # one reads it from, and the honest ``first`` is the day it could resume.
        return Horizon(max(unpriced for _, unpriced in blocked) + day, None)

    left = [unpriced for acquired, unpriced in blocked if unpriced <= last]
    return Horizon(max(left) + day if left else None,
                   None if last >= ceiling else last)


@dataclass
class DailyPerf:
    """One day of an entity's (account or global) valuation, gain and TWR.

    ``gain_absolu`` is a **per-day** figure since #782 — ``total_value`` minus
    everything contributed on or before this day. It is not optional and it
    carries no ``None``: it is one of :data:`ALWAYS_WRITTEN`, and what the
    per-field rule may withhold is withheld at the *write*, once, in
    ``perf_job.value_kwargs``.
    """
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
    """Performance of one entity (an account, or the global portfolio).

    No ``currency`` field since #702. It carried ``Account.currency``, which is
    deleted: there is one reporting currency for the whole install, every figure
    in here is already in it, and a copy on each entity was only ever read to ask
    whether two of them disagreed — a question ADR-0002 removes rather than
    answers.
    """
    daily: List[DailyPerf] = field(default_factory=list)
    xirr: Optional[float] = None
    #: The two conditions of the per-field rule (issue #708), carried on the
    #: result rather than re-derived by the writer: they are answers about the
    #: *flows this computation ran on*, and a caller re-asking them of the ledger
    #: would eventually ask a slightly different question. See
    #: :func:`writable_fields`.
    has_cash_ledger: bool = False
    has_external_flow: bool = False

    @property
    def gain_absolu(self) -> Optional[float]:
        """This entity's absolute gain: the **last day of its own series**.

        A property and not a field since #782, which is the whole of what keeps
        the figure one arithmetic. ``gain_absolu`` used to be computed here,
        from the ledger's whole contribution against the terminal value, and
        separately written on the last point of the series alone — two
        spellings of one number, which is how it came to differ from the series
        beneath it by every flow dated past ``today`` (#766). Read rather than
        assigned, a caller quoting the entity's gain and a caller reading the
        last row it wrote cannot disagree, and there is no setter to reopen the
        question.

        ``None`` on an empty series, exactly as ``xirr`` is: nothing was
        computed, so there is nothing to state. ``xirr`` stays a field because
        it is genuinely not a series — annualised over the whole history
        against one terminal value.
        """
        return self.daily[-1].gain_absolu if self.daily else None


#: The bracket the bisection searches, and when it stops. Constants and not
#: parameters: no caller has ever passed one, and a solver whose tolerance is a
#: per-call argument invites two figures for one portfolio — the annualised rate
#: is the product's, not the caller's.
_XIRR_LOW = -0.9999
#: 100 000 % a year, and the ceiling is chosen by the **arithmetic** rather
#: than by what a rate could plausibly be: ``npv`` raises ``1 + rate`` to the
#: power of the horizon in years, so a high bound of ``1e9`` — what this was —
#: left the float range after **thirty-four** of them and the solver raised
#: ``OverflowError`` instead of answering. At ``1e3`` that end holds for 103
#: years, past the point where the *low* end underflows to zero (81), so the
#: bracket has one limit rather than two and it is beyond any real ledger.
#: Nothing plausible is lost: a rate between ``1e3`` and ``1e9`` is an
#: ultra-short horizon annualised, which the docstring below already declines.
_XIRR_HIGH = 1e3
_XIRR_TOL = 1e-8
_XIRR_MAX_ITER = 200


def xirr(cashflows: List[Tuple[date, float]]) -> Optional[float]:
    """Annualized internal rate of return by bisection (no external dependency).

    ``cashflows`` are (date, amount) from the investor's perspective: money put
    in is negative, money/received value taken out is positive. Returns None when
    the flows span no time (nothing to annualize) or don't bracket a root within
    ``[_XIRR_LOW, _XIRR_HIGH]`` — including an ultra-short horizon whose
    annualized rate would blow past the bracket (gain_absolu guards that case).

    **And None where the arithmetic itself gives out.** ``npv`` raises
    ``1 + rate`` to the power of the horizon in years, and past a lifetime of
    them neither end of the bracket survives a float: the high one overflows,
    the low one underflows to zero and is divided by. Nothing bounds a date —
    ``events/validator.py`` forbids no year, and ``_xirr_cashflows`` keeps every
    flow dated at or before today — so a single mistyped ``1902`` for ``2002``
    reached it. What that cost was **not** the rate: the raise travelled out of
    :func:`compute_account`, past ``perf_job``'s transaction, and was recorded
    as one ``PERF_FAILED`` — no curve, no TWR, no gain, for any account, replayed
    at every tick. An absence is the answer this function already gives to every
    other flow series no rate explains, and an unsolvable one is not a different
    kind of question.
    """
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
    """Fill twr_index in place: base 100 anchored at the first day with value,
    then compounded by r_D = (V_D - F_D) / V_{D-1} (flows land end-of-day).

    **A day worth nothing suspends the chain; it never enters it** — on either
    side of the ratio, which is the whole of the guard. ``prev_v`` was already
    read for its truth, so a zero *denominator* skipped the day; a zero
    *numerator* was multiplied straight in, and it is an **absorbing** state:
    ``twr`` goes to 0, the next day is skipped because ``prev_v`` is now 0, and
    ``0 × x`` is 0 for every day after that, on a portfolio that has recovered.
    ADR-0019 rebases the visible window on this column, so what the page draws
    is **−100 %**.

    That day is not exotic: it is the ordinary shape of the hours between a
    purchase reaching the ledger and the first price reaching the store —
    holdings valued at nothing while the cash has already been debited, so
    ``V = 0`` with no external flow — which is to say the **first launch**.

    Suspending is the same conservatism the ``prev_v`` half has always applied:
    the index holds, and the chain resumes on the first pair of days that both
    carry a value. The move across the hole is not recovered, and it is not
    meant to be — chaining over a gap is what :func:`account_horizon` refuses at
    length (#766), an external flow landing inside it being published as
    performance.
    """
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
    terminal value positive.

    **Nothing dated after ``today``**, which is the same rule
    :func:`_running_contribution` keeps and for the same reason (#766): a row
    dated next year is not money the portfolio has received. Here the cost of
    breaking it is worse than a wrong total — the terminal value is stamped at
    ``today``, so a later flow lands *after* the closing position and the solver
    is handed a series that no rate explains. A single mistyped year therefore
    took ``xirr`` off the page entirely, with every other column unmoved and
    nothing on screen naming the cause; a nearer one simply made it wrong.
    """
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
    """A callable answering *everything contributed on or before this day*.

    It replaces ``_base_contributed``, which summed the whole ledger's deposits,
    withdrawals and declared grants and was read **once**, at the terminal day
    (#782). There is one decomposition of that total by date and it already
    existed — ``flow_by_date``, which the TWR reads for its own ``F_D`` — so the
    per-day contribution and the per-day external flow cannot state a cash
    movement differently.

    It is a **running** sum and it must be called on a non-decreasing sequence
    of days, which is what the daily loop hands it. Two properties come from
    that rather than from arithmetic: flows dated before the first day of the
    series — an account whose horizon starts after its own opening deposit
    (#708) — are folded into that first day rather than lost, and a flow dated
    **after** the last day is never counted, which is the one place this parts
    company with the old spelling. A row dated next year is not a contribution
    the portfolio has received (#766), and summing the whole ledger counted it
    from the first day of the series.
    """
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
    day* rather than *any symbol whose history has not arrived yet*. ``today`` is
    the other end of that same interval and it is **not always the current day**
    since #765: a block sitting at the ceiling caps the series below itself, so
    the caller passes :attr:`Horizon.last` when there is one. It is the terminal
    date of the money-weighted return too, which is the point — every figure the
    series carries is measured at the day it stops on.
    """
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
        # Advanced on **every** day of the range, including the ones skipped
        # below: a deposit made before the account's first valued day is still a
        # contribution, and reading the running sum only where a point is
        # produced would leave it behind.
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
        # A cash event is a ``DEPOSIT``/``WITHDRAWAL`` and nothing else: a
        # purchase moves the balance too, and counting it here would put the rule
        # back exactly where the defect is (a ledger of purchases alone is the
        # case the per-field rule exists for).
        has_cash_ledger=bool(cash_flows),
        has_external_flow=bool(cash_flows or grant_flows),
    )
    if daily:
        terminal = daily[-1].total_value
        # ``gain_absolu`` is not assigned here and there is nothing missing
        # (#782): it is a property over ``daily[-1]``, written on every day of
        # the series by the loop above. ``xirr`` keeps its condition, because an
        # internal rate of return with no flow to weight is not a degraded
        # figure, it is not a figure.
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

    ``today`` is the **min** of the per-account caps (issue #765), and it is the
    same argument on the other end of the axis: an account whose series stops
    two days ago simply stops contributing to the sum, so a global point written
    past it would draw the very step the max of the horizons exists to prevent —
    downwards this time, by the whole of that account.
    """
    if not accounts:
        return None

    # Sum the per-account daily series by date (accounts start on different days,
    # and since #765 they do not all stop on the same one either).
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
            # The gain is **summed like the value it is made of** (#782), not
            # recomputed from the whole portfolio's flows: the accounts entering
            # this sum on a given day are the accounts whose ``total_value`` is
            # in it, and subtracting a contribution made to an account the day
            # does not carry — one whose series is capped in the past (#765) —
            # would state a gain against a value nobody added.
            agg.gain_absolu += dp.gain_absolu

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
        # ``any(...) and all(...)`` rather than ``all(...)`` alone: over an
        # empty selection ``all`` answers **True**, so a portfolio where no
        # account produced a single day declared itself *with a cash ledger* on
        # the strength of nothing. No point is written in that state, so it
        # costs nothing today — and it is exactly the shape of default that the
        # per-field rule exists to refuse, waiting for the first caller to read
        # the flag without looking at ``daily`` first.
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
