"""
Unit tests for the money-weighted performance module (issue #577).

Covers: XIRR bisection (known-rate reference), external vs internal flow
classification, no-external-flow => no xirr/gain, daily valuation, TWR base 100,
GRANT valued at the day's price, and portfolio-total currency gating.
"""

import itertools
from datetime import date, timedelta

import pytest

import performance
from performance import xirr, compute_account, compute_portfolio_total
from events import EventAggregator, Event, EventType, Account


def _price_at(prices):
    """Build a forward-filling price_at from {symbol: {date: price}}."""
    sorted_by_symbol = {
        sym: sorted(series.items()) for sym, series in prices.items()
    }

    def price_at(symbol, day):
        pairs = sorted_by_symbol.get(symbol, [])
        result = None
        for d, p in pairs:
            if d <= day:
                result = p
            else:
                break
        return result
    return price_at


PEA = Account("PEA", "PEA", "Mon PEA")
CTO = Account("CTO", "CTO", "My CTO")


# --------------------------------------------------------------------------- #
# XIRR bisection
# --------------------------------------------------------------------------- #
def test_xirr_known_rate():
    # Invest 1000, worth 1100 exactly one year later -> 10% annualized.
    r = xirr([(date(2023, 1, 1), -1000.0), (date(2024, 1, 1), 1100.0)])
    assert r == pytest.approx(0.10, abs=1e-4)


def test_xirr_none_without_sign_change():
    # All contributions, no positive terminal -> undefined.
    assert xirr([(date(2023, 1, 1), -1000.0), (date(2024, 1, 1), -500.0)]) is None


def test_xirr_none_on_empty():
    assert xirr([]) is None


def test_xirr_none_on_zero_horizon():
    # Deposit and terminal on the same day -> nothing to annualize.
    assert xirr([(date(2024, 1, 1), -1000.0), (date(2024, 1, 1), 1000.0)]) is None


# --------------------------------------------------------------------------- #
# Daily valuation + TWR
# --------------------------------------------------------------------------- #
def test_daily_valuation_and_twr_base_100():
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=100.0, account="PEA"),
    ]
    tl = EventAggregator().replay(events)
    price_at = _price_at({"AAPL": {date(2024, 1, 1): 100.0, date(2024, 1, 2): 110.0}})

    perf = compute_account(tl, PEA, {"AAPL"}, price_at,
                           start=date(2024, 1, 1), today=date(2024, 1, 2))

    d0, d1 = perf.daily
    # Day 0: cash 0 (1000 - 10*100), holdings 1000, V 1000, TWR anchored at 100.
    assert d0.cash_balance == pytest.approx(0.0)
    assert d0.holdings_value == pytest.approx(1000.0)
    assert d0.total_value == pytest.approx(1000.0)
    assert d0.twr_index == pytest.approx(100.0)
    # Day 1: price 100 -> 110, holdings 1100, V 1100, TWR 100 * 1100/1000 = 110.
    assert d1.holdings_value == pytest.approx(1100.0)
    assert d1.twr_index == pytest.approx(110.0)

    # gain_absolu = terminal 1100 - contributed 1000 = 100.
    assert perf.gain_absolu == pytest.approx(100.0)


def test_xirr_computed_over_realistic_horizon():
    """A one-year 10% gain yields ~10% XIRR through compute_account."""
    events = [
        Event(date(2023, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2023, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=100.0, account="PEA"),
    ]
    tl = EventAggregator().replay(events)
    # Price 100 -> 110 over the year: terminal holdings 1100.
    price_at = _price_at({"AAPL": {date(2023, 1, 1): 100.0, date(2024, 1, 1): 110.0}})
    perf = compute_account(tl, PEA, {"AAPL"}, price_at,
                           start=date(2023, 1, 1), today=date(2024, 1, 1))
    assert perf.xirr == pytest.approx(0.10, abs=1e-3)
    assert perf.gain_absolu == pytest.approx(100.0)


def test_twr_neutral_to_external_flow():
    """A pure deposit (no price move) must not change the TWR index."""
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 2), EventType.DEPOSIT, amount=500.0, account="PEA"),
    ]
    tl = EventAggregator().replay(events)
    perf = compute_account(tl, PEA, set(), _price_at({}),
                           start=date(2024, 1, 1), today=date(2024, 1, 2))
    d0, d1 = perf.daily
    # V0=1000 (anchor 100). V1=1500 but F1=+500 -> (1500-500)/1000 = 1.0 -> still 100.
    assert d0.twr_index == pytest.approx(100.0)
    assert d1.twr_index == pytest.approx(100.0)


# --------------------------------------------------------------------------- #
# External vs internal classification
# --------------------------------------------------------------------------- #
def test_no_external_flow_takes_the_xirr_and_leaves_the_gain():
    """Only internal flows (BUY): no xirr, but a gain — ADR-0018, issue #708.

    The opt-in guard travelled with ``xirr`` by accident and took ``gain_absolu``
    with it. With no ``DEPOSIT`` at all, ``cash = −invested`` and
    ``net_contributed = 0``, so ``gain_absolu = holdings − invested`` is **exact**
    — here 120 − 100 — and it is the only figure an owner who never recorded a
    deposit can still be told. What genuinely has no meaning is the money-weighted
    return: there is no flow to weight.
    """
    events = [
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=1,
              unit_price=100.0, account="PEA"),
    ]
    tl = EventAggregator().replay(events)
    price_at = _price_at({"AAPL": {date(2024, 1, 1): 120.0}})
    perf = compute_account(tl, PEA, {"AAPL"}, price_at,
                           start=date(2024, 1, 1), today=date(2024, 1, 1))
    assert perf.xirr is None
    assert perf.gain_absolu == pytest.approx(20.0)
    # And the per-field rule reads the two conditions off the same result.
    assert perf.has_cash_ledger is False
    assert perf.has_external_flow is False
    assert performance.writable_fields(
        perf.has_cash_ledger, perf.has_external_flow) == frozenset(
            {'holdings_value', 'gain_absolu'})


def test_a_valued_grant_contributes_the_price_its_event_declares():
    """A valued award: contribution 10 × 50, terminal 10 × 50, gain nil (#672 D7)."""
    events = [
        Event(date(2024, 1, 1), EventType.GRANT, "AAPL", "Apple", quantity=10,
              unit_price=50.0, account="PEA"),
    ]
    tl = EventAggregator().replay(events)
    price_at = _price_at({"AAPL": {date(2024, 1, 1): 50.0}})
    perf = compute_account(tl, PEA, {"AAPL"}, price_at,
                           start=date(2024, 1, 1), today=date(2024, 1, 1))
    assert perf.gain_absolu == pytest.approx(0.0)


def test_a_grant_without_a_price_contributes_nothing():
    """Dilution: no contribution, so the whole value is the gain."""
    events = [
        Event(date(2024, 1, 1), EventType.GRANT, "AAPL", "Apple", quantity=10,
              account="PEA"),
    ]
    tl = EventAggregator().replay(events)
    price_at = _price_at({"AAPL": {date(2024, 1, 1): 50.0}})
    perf = compute_account(tl, PEA, {"AAPL"}, price_at,
                           start=date(2024, 1, 1), today=date(2024, 1, 1))
    assert perf.gain_absolu == pytest.approx(500.0)


def test_a_grants_contribution_does_not_move_with_the_backfill():
    """The declared price is read; no quote is, so nothing drifts (#672 D7).

    Valuing a grant through ``price_at`` made an account's absolute gain change
    as history was filled in, with no event having moved — the same portfolio
    reporting two different gains an hour apart.
    """
    events = [
        Event(date(2024, 1, 1), EventType.GRANT, "AAPL", "Apple", quantity=10,
              unit_price=50.0, account="PEA"),
    ]
    tl = EventAggregator().replay(events)
    quote = {"AAPL": {date(2024, 1, 1): 50.0}}

    def compute(prices):
        return compute_account(tl, PEA, {"AAPL"}, _price_at(prices),
                               start=date(2024, 1, 1),
                               today=date(2024, 1, 1)).gain_absolu

    # Before the backfill reaches the grant's date there is no price at all;
    # afterwards there is. The contribution is the same either way.
    assert compute({}) == pytest.approx(-500.0)
    assert compute(quote) == pytest.approx(0.0)


# --------------------------------------------------------------------------- #
# The three figures decompose the absolute gain — #672's worked example
# --------------------------------------------------------------------------- #
#
# One CTO, two positions, one of them sold out. Read this table against the
# resolution of #672: it is the same one, to the cent.
#
#   01/10/2021  DEPOSIT 3 000 €                cash 3 000,00
#   05/10/2021  BUY 50 ALO @ 18,50, fee 5      cash 2 070,00   basis 930,00
#   10/10/2021  BUY 10 AAPL @ 150, fee 3       cash   567,00   basis 1 503,00
#   15/03/2023  DIVIDEND ALO 20 €              cash   587,00
#   20/04/2025  SELL 50 ALO @ 11,93, fee 2,39  cash 1 181,11   realized −335,89
#
# AAPL quotes 200 € today, so holdings are 2 000,00 €.

WORKED_EXAMPLE_ACCOUNT = Account("CTO", "CTO", "Mon CTO", "EUR")
TODAY = date(2025, 4, 20)


def _worked_example():
    return EventAggregator().replay([
        Event(date(2021, 10, 1), EventType.DEPOSIT, amount=3000.0, account="CTO"),
        Event(date(2021, 10, 5), EventType.BUY, "ALO", "Alstom", quantity=50,
              unit_price=18.50, fee=5.0, account="CTO"),
        Event(date(2021, 10, 10), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=150.0, fee=3.0, account="CTO"),
        Event(date(2023, 3, 15), EventType.DIVIDEND, "ALO", "Alstom",
              amount=20.0, account="CTO"),
        Event(date(2025, 4, 20), EventType.SELL, "ALO", "Alstom", quantity=50,
              unit_price=11.93, fee=2.39, account="CTO"),
    ])


def _worked_example_figures():
    """(latent, realized, dividends, gain_absolu), each rounded to the cent."""
    timeline = _worked_example()
    price_at = _price_at({
        "AAPL": {date(2021, 10, 10): 150.0, TODAY: 200.0},
        "ALO": {date(2021, 10, 5): 18.50, TODAY: 11.93},
    })
    perf = compute_account(timeline, WORKED_EXAMPLE_ACCOUNT, {"ALO", "AAPL"},
                           price_at, start=date(2021, 10, 1), today=TODAY)

    positions = {p["symbol"]: p for p in timeline.current()}
    latent = sum(
        p["quantity"] * price_at(symbol, TODAY) - p["cost_basis"]
        for symbol, p in positions.items() if p["quantity"]
    )
    realized = sum(p["realized_gain"] for p in positions.values())
    dividends = sum(p["received_dividend"] for p in positions.values())
    return (round(latent, 2), round(realized, 2), round(dividends, 2),
            round(perf.gain_absolu, 2))


def test_the_three_figures_sum_to_the_absolute_gain():
    latent, realized, dividends, gain = _worked_example_figures()

    assert (latent, realized, dividends) == (497.00, -335.89, 20.00)
    assert gain == 181.11
    assert round(latent + realized + dividends, 2) == gain


def test_adding_the_realized_gain_is_the_forbidden_operation():
    """The rule a contributor will break, pinned so it breaks a test instead.

    The proceeds of the sale are already in the cash balance, so the realized
    gain is a **breakdown** of the absolute gain and never a term added to it.
    The result of adding it stays perfectly plausible — a winning account shown
    losing — which is why nothing but an assertion catches it.
    """
    _latent, realized, _dividends, gain = _worked_example_figures()

    assert round(gain + realized, 2) == -154.78


def test_the_sold_position_reports_no_investment_at_all():
    """The phantom −932 €: v4 read ``0 + 20 − 925 − 7,39`` on this very row."""
    alo = {p["symbol"]: p for p in _worked_example().current()}["ALO"]

    assert alo["quantity"] == 0.0
    assert alo["cost_basis"] == 0.0
    assert round(alo["realized_gain"], 2) == -335.89


# --------------------------------------------------------------------------- #
# Portfolio total: what gates it, now that a currency does not
# --------------------------------------------------------------------------- #
def test_two_accounts_pool_because_an_account_has_no_currency():
    """The mixed-currency refusal is deleted with `Account.currency` (#702).

    It answered `None` whenever two declared accounts named different
    currencies. They cannot: there is one reporting currency for the install and
    everything reaching this module is already in it. The only thing that still
    makes the global series absent is having no account at all.
    """
    tl = EventAggregator().replay([
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=500.0, account="CTO"),
    ])
    price_at = _price_at({})
    per_account = {
        "PEA": compute_account(tl, PEA, set(), price_at, date(2024, 1, 1), date(2024, 1, 1)),
        "CTO": compute_account(tl, CTO, set(), price_at, date(2024, 1, 1), date(2024, 1, 1)),
    }
    total = compute_portfolio_total(tl, [PEA, CTO], set(), price_at,
                                    date(2024, 1, 1), date(2024, 1, 1), per_account)

    assert total is not None
    assert total.daily[-1].total_value == pytest.approx(1500.0)
    assert compute_portfolio_total(tl, [], set(), price_at, date(2024, 1, 1),
                                   date(2024, 1, 1), {}) is None


def test_portfolio_total_aggregates_the_accounts_it_is_given():
    pea2 = Account("PEA2", "PEA", "PEA 2")
    tl = EventAggregator().replay([
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=500.0, account="PEA2"),
    ])
    price_at = _price_at({})
    per_account = {
        "PEA": compute_account(tl, PEA, set(), price_at, date(2024, 1, 1), date(2024, 1, 1)),
        "PEA2": compute_account(tl, pea2, set(), price_at, date(2024, 1, 1), date(2024, 1, 1)),
    }
    total = compute_portfolio_total(tl, [PEA, pea2], set(), price_at,
                                    date(2024, 1, 1), date(2024, 1, 1), per_account)
    assert total is not None
    assert total.daily[-1].total_value == pytest.approx(1500.0)
    assert total.gain_absolu == pytest.approx(0.0)  # 1500 terminal - 1500 contributed


# --------------------------------------------------------------------------- #
# The sliding horizon (issue #708, spec #695 § 11) — and its cap (issue #765)
#
#   block(s)  = [ acquired(s), min(oldest price(s) − 1, last held day(s)) ]
#   the series = the latest run of days no block covers, inside [start, ceiling]
#
# Pure: the inputs are a mapping each plus two days, so the whole of the rule is
# testable without a store, a clock or a backfill. A window is ``(first, last)``
# day held.
# --------------------------------------------------------------------------- #
TODAY = date(2026, 8, 12)
LEDGER_START = date(2019, 1, 1)
LONG_HELD = (LEDGER_START, TODAY)
#: A purchase of two days ago — the reproducing shape of #765. A line acquired
#: **today** is terminal from its first cycle (``carrying.is_terminal``: the
#: backward anchor is already at the target), so it is settled and blocks
#: nothing; any earlier acquisition with no price yet is what empties the table.
BOUGHT = date(2026, 8, 10)


def _horizon(windows, oldest_priced, settled=(), start=LEDGER_START):
    """The rule, on the ordinary caller's two days: the ledger's first, today."""
    return performance.account_horizon(windows, oldest_priced, settled,
                                       start=start, ceiling=TODAY)


def test_the_horizon_is_the_day_after_the_last_unpriced_held_day():
    """The formula itself, on one symbol still held.

    Bought in 2019, reconstructed as far back as 2021-06-03: every day from
    there on has a price, and the first writable day is that one — never
    2021-06-02, whose valuation would count the position as worth nothing beside
    a cash ledger that had already paid for it.
    """
    horizon = _horizon({"AAPL": LONG_HELD}, {"AAPL": date(2021, 6, 3)})

    assert horizon == (date(2021, 6, 3), None)


def test_a_symbol_priced_from_the_day_it_was_acquired_constrains_nothing():
    """The window's **lower** end, and the case that makes it load-bearing.

    A backward pass never overshoots the first acquisition (ADR-0004), so a
    symbol's oldest price *is* its acquisition day once its reconstruction has
    concluded. Without this end of the bound the formula would take the horizon
    of a portfolio that bought a new line this morning to *this morning* — every
    year it owns, gone, on the ordinary gesture of buying something.
    """
    assert _horizon({"NEW": (date(2026, 6, 1), TODAY)},
                    {"NEW": date(2026, 6, 1)}) == (None, None)
    # …and a line bought yesterday does not blank an old line's history either.
    assert _horizon({"OLD": LONG_HELD, "NEW": (date(2026, 6, 1), TODAY)},
                    {"OLD": LEDGER_START,
                     "NEW": date(2026, 6, 1)}) == (None, None)
    assert _horizon({}, {"AAPL": LEDGER_START}) == (None, None)


def test_the_empty_block_guard_is_708s_plus_the_degenerate_window():
    """What the guard does, and — as loudly — what it does not do.

    #708 wrote *"a day before a position was acquired holds nothing of it"* and
    coded it as ``oldest ≤ acquired``; the block form spells it
    ``unpriced < acquired``. The two are **not** the same guard, and the earlier
    claim that they were rested on a false premise:
    :meth:`events.schemas.Timeline.holding_window` used to return
    ``acquired, (today if holding else emptied)`` with **no clamp**, so an
    acquisition dated in the future — which ``events/validator.py`` forbids
    nowhere — answered a last day *before* its first.

    The exact relation is asserted below: the block form is #708's guard **or**
    the window is degenerate. That extra case is not a widening to regret, it is
    the one input on which #708 was wrong — a single event dated next year gave
    ``last_held < acquired``, no skip, a block ending *before* it began, and the
    left bound landed past every real day, so the cycle wrote nothing and the
    prune emptied the table. The block form answers "nothing constrains this
    account" instead, which is the truth about a window holding no day at all.

    **Since #766 no caller produces that shape**: ``holding_window`` answers
    ``None`` for a window holding no day, so the truth is told where the window
    is built rather than recognised here. The guard stays all the same, and not
    out of sentiment — this is a pure function over two mappings, and the
    property below is a property of *it*, not of the one caller that happens to
    feed it today. What changed is that the degenerate case is now a belt.

    What the guard is still **not** is the repair of #765: on a held symbol
    quoted nowhere the window is ordinary, the branch is not taken, and what
    keeps the history is the **cap**, asserted in the next test.
    """
    windows = {"NEW": (BOUGHT, TODAY)}

    # Priced from its acquisition: the block is empty and the guard drops it.
    assert _horizon(windows, {"NEW": BOUGHT}) == (None, None)
    # Priced from *before* its acquisition: same, the block is still empty.
    assert _horizon(windows, {"NEW": BOUGHT - timedelta(days=30)}) == (None, None)
    # Quoted nowhere: the guard is **not** reached, the block stands whole, and
    # what keeps the history is the cap moving the right edge left.
    assert _horizon(windows, {}) == (None, BOUGHT - timedelta(days=1))
    # A window that holds no day at all — the acquisition dated after the last
    # day held. `holding_window` answered it before #766 and answers `None` now,
    # so this is the pure rule standing on its own, not a caught caller.
    day = timedelta(days=1)
    degenerate = {"NEW": (BOUGHT, BOUGHT - 30 * day)}
    assert _horizon(degenerate, {}) == (None, None)

    # Both spellings, over the whole shape of the input — and `held_off` now
    # sweeps **negative** offsets, which is where they part company. Sweeping
    # only `last_held >= acquired` is what let the false equivalence stand: the
    # single counter-example was structurally outside the loop, so the test
    # attested a property it had never exercised.
    for acquired_off, held_off, oldest_off in itertools.product(
            range(0, 40, 7), range(-21, 40, 7), list(range(-10, 40, 7)) + [None]):
        acquired = LEDGER_START + acquired_off * day
        last_held = acquired + held_off * day
        oldest = None if oldest_off is None else acquired + oldest_off * day
        unpriced = (last_held if oldest is None
                    else min(oldest - day, last_held))
        assert (unpriced < acquired) == (
            (oldest is not None and oldest <= acquired) or last_held < acquired)


def test_a_new_line_caps_the_series_instead_of_deleting_its_history():
    """Criterion 3 of #765, and the whole subject of the ticket.

    Buying a security the portfolio did not hold yet gives a symbol with no price
    anywhere until the backward pass brings its first chunk back. #708's left
    bound landed the day after the last day it was held with no price — *tomorrow*
    on a line still standing — so the entire series fell outside the horizon, the
    cycle produced no point for anybody, and the prune, doing exactly what it is
    written for, emptied the table. Years of history, deleted by a purchase.

    Treated where it is, the block caps: the years stay, the last point is a day
    older than the purchase, and the next cycle catches up.
    """
    horizon = _horizon({"OLD": LONG_HELD, "NEW": (BOUGHT, TODAY)},
                       {"OLD": LEDGER_START})

    assert horizon == (None, BOUGHT - timedelta(days=1))
    # The left bound is untouched by the cap: an old line still being
    # reconstructed goes on bounding the series where it always did.
    assert _horizon({"OLD": LONG_HELD, "NEW": (BOUGHT, TODAY)},
                    {"OLD": date(2021, 6, 3)}) == (date(2021, 6, 3),
                                                   BOUGHT - timedelta(days=1))


def test_the_cap_walks_left_past_every_block_it_lands_in():
    """One rule and not two guards: the right edge steps over the blocks it
    meets, and stepping over one can land it inside another.

    ``NEW`` was bought this week and is quoted nowhere; ``OLD`` is quoted from
    the day after the edge ``NEW`` alone would leave. A single step would stop
    the series on a day ``OLD`` cannot value either, which is the crater again,
    one day wide — so the edge walks until it stands on a day no block covers.
    The ledger opened a year before the first purchase, so there is something
    left to keep.
    """
    horizon = _horizon({"OLD": (LEDGER_START, TODAY), "NEW": (BOUGHT, TODAY)},
                       {"OLD": BOUGHT}, start=date(2018, 1, 1))

    assert horizon == (None, LEDGER_START - timedelta(days=1))


def test_a_symbol_with_no_price_at_all_blocks_every_day_it_was_held():
    """The reconstruction's first minutes, seen from here.

    Absent from ``oldest_priced`` means *no usable price anywhere*, and the whole
    holding window is therefore unwritable. On a position held since the ledger's
    own first day there is no run of days left to keep, so the reading falls back
    to the left bound and it is tomorrow — the honest one: today's figures are
    the first ones the app can state, and it states them from the first cycle.
    """
    assert _horizon({"AAPL": LONG_HELD}, {}) == (date(2026, 8, 13), None)


def test_the_days_left_of_a_past_block_are_lost_with_it():
    """The residue #765's second criterion asks for and this rule does not give.

    ``SOLD`` was acquired 2020-03-02 and exited 2022-05-04; quoted nowhere, its
    block is that whole window and it does **not** reach the ceiling, so the cap
    has nothing to do and the left bound lands the day after it. 2019-01-01
    through 2020-03-01 go with it — days on which the account held no share of
    ``SOLD`` at all, so nothing of it is waiting there and no crater is being
    avoided.

    It is asserted rather than repaired, and the argument is
    :func:`performance.account_horizon`'s own: a horizon is one interval, so the
    only two ways to keep those days are to keep the *left* run instead —
    abandoning today's figures, which is the whole of the sliding horizon — or to
    return two runs with a hole between them, which is the per-day mask #708
    refused for breaking the TWR's chaining. The state is transitory by the same
    mechanism as every other block here: it ends when the backward pass reaches
    2020-03-02, or concludes and settles the symbol.
    """
    assert _horizon({"SOLD": (date(2020, 3, 2), date(2022, 5, 4))},
                    {}) == (date(2022, 5, 5), None)
    # And it ends by itself, both ways: reconstructed to its acquisition the
    # block is empty, settled it does not contribute.
    assert _horizon({"SOLD": (date(2020, 3, 2), date(2022, 5, 4))},
                    {"SOLD": date(2020, 3, 2)}) == (None, None)
    assert _horizon({"SOLD": (date(2020, 3, 2), date(2022, 5, 4))},
                    {}, settled={"SOLD"}) == (None, None)


def test_a_horizon_is_one_interval_and_the_twr_is_what_decides_it():
    """#766's question, answered **no**, and answered on the source.

    *May a horizon be more than one interval?* A block sitting wholly in the past
    cuts the timeline into two runs of computable days, and only the one holding
    today survives. Keeping both is the shape the ticket asks about, and what
    forbids it is not taste: :func:`performance._fill_twr` chains
    ``twr = twr × (V − F) / V_prev`` over **consecutive elements of the list**,
    not over consecutive calendar days. Hand it a series with a hole and the day
    after the hole is chained against the day before it, so the whole gap's move
    lands in a single day's return — silently, on the one figure the horizon
    exists to protect.

    That is #708's refusal of the per-day mask, restated on the exact input #766
    proposes, and nothing in #765 or here dissolves it. The two ways out are
    refused with it: re-anchoring at the gap makes ``twr_index`` two incomparable
    series in one column, which the accounts page then rebases on a visible
    window (ADR-0019) and draws as a discontinuity; and keeping the *left* run
    instead abandons today's figures, which is the whole of the sliding horizon.

    The assertion below is the defect itself, and it is a **wrong** figure and
    not merely a compressed one: with an external flow landing inside the gap,
    the dense chain divides that flow out on its own day while the holed chain
    never sees it and reads the owner's deposit as performance. Ten percent of
    gain becomes a hundred and twenty, on a series that looks perfectly ordinary.
    """
    def _series(values):
        return [performance.DailyPerf(
            date=day, cash_balance=0.0, holdings_value=value,
            total_value=value, net_contributed=0.0, external_flow=flow)
            for day, value, flow in values]

    days = [LEDGER_START + timedelta(days=i) for i in range(5)]
    # A 100 € deposit on day 2, and 10 % of real gain over the five days.
    moves = [(days[0], 100.0, 0.0), (days[1], 100.0, 0.0),
             (days[2], 200.0, 100.0), (days[3], 200.0, 0.0),
             (days[4], 220.0, 0.0)]
    dense = _series(moves)
    holed = _series([moves[0], moves[4]])   # the block swallowed days 1 to 3

    performance._fill_twr(dense)
    performance._fill_twr(holed)

    # Dense: the deposit is divided out on its own day, so the index is the
    # portfolio's return and nothing else.
    assert round(dense[-1].twr_index, 6) == 110.0
    # Holed: the flow day is not in the list, so it is never subtracted and the
    # owner's own money is reported as performance.
    assert round(holed[-1].twr_index, 6) == 220.0
    # And nothing in the column says so — which is what makes it undetectable.
    assert holed[0].twr_index == dense[0].twr_index


def test_a_past_block_costs_days_only_when_it_outlives_the_oldest_holding():
    """What the decision costs, measured before it was taken (#766, criterion 2).

    Measured on the real staging ledger (285 events, 19 symbols, 2 accounts,
    2019-10-30 → 2026-08-20): **fully reconstructed, no account carries a
    blocking window at all** — ``/api/runtime`` answers ``horizon: null`` for the
    three of them and the residue costs zero days. During a reconstruction seven
    of the nineteen symbols carry a wholly-past window and **both** accounts
    carry one, yet their marginal cost is **0 days at every cycle of the rebuild**
    — CTO 907/907 and PEA 2 487/2 487 days written whether the past blocks are
    counted or dropped.

    The reason is structural rather than lucky, and it is what this test pins. A
    sold line's backward pass starts from **its own exit**, not from today
    (:func:`carrying.holding_bounds`), so it is reconstructed past its
    acquisition at least as fast as a line of the same age still held — and while
    any held line is still walking left, that held line bounds the horizon
    further left than the sold one can. The sold line bounds only once **its own
    holding window is longer than the oldest current holding's age**, which is
    the shape named rather than measured: a line held for years and sold long
    ago, beside holdings all bought recently.
    """
    sold = (date(2019, 6, 1), date(2020, 6, 1))       # a year, ending long ago
    long_held = (date(2019, 6, 1), TODAY)             # same age, still held

    # The reconstruction's real state: the sold line is quoted nowhere yet, so
    # it blocks its whole window — and that window ends in 2020, far left of
    # where the held line of the same age still blocks. The held line bounds.
    assert _horizon({"SOLD": sold, "HELD": long_held},
                    {"HELD": date(2025, 8, 12)}) == (date(2025, 8, 12), None)
    # Drop the sold line and the bound does not move by one day: its marginal
    # cost is zero, which is what the real ledger measures at every cycle.
    assert _horizon({"HELD": long_held},
                    {"HELD": date(2025, 8, 12)}) == (date(2025, 8, 12), None)

    # The shape where it does cost, and the whole of the residue: the sold line
    # outlives the oldest current holding, so it alone bounds the series and the
    # days before its acquisition go with it.
    recent = (date(2026, 1, 1), TODAY)
    assert _horizon({"SOLD": sold, "HELD": recent},
                    {"HELD": date(2026, 1, 1)}) == (date(2020, 6, 2), None)
    assert _horizon({"HELD": recent}, {"HELD": date(2026, 1, 1)}) == (None, None)


def test_the_horizon_is_bounded_by_each_symbols_holding_window():
    """A line sold in 2022 whose backfill is only starting does not hold the
    account at today — #708's criterion 1, and the reason the bound exists.

    Read literally as *"the most recent of the oldest available prices"*, the
    sold symbol's oldest available price is dated this year and would pin the
    **whole account** at today, while it constrains no day after its last exit.
    ADR-0009 driving the backfill from the replay is what made the case ordinary:
    a position sold four years ago is reconstructed, and its reconstruction
    starts from the present.
    """
    horizon = _horizon(
        {"SOLD": (date(2020, 3, 2), date(2022, 5, 4)), "HELD": LONG_HELD},
        {"SOLD": date(2026, 1, 10), "HELD": LEDGER_START})

    # The day after the sold line's last held day, not the day after its oldest
    # price — which would have been 2026-01-10, i.e. nothing before today.
    assert horizon == (date(2022, 5, 5), None)


def test_a_settled_symbol_does_not_contribute_to_the_horizon():
    """Criterion 2 of #708, and it is the clause that keeps the horizon from
    freezing.

    A backfill that has concluded on zero point, and a symbol quoted in a
    currency that does not resolve, are absences no cycle will repair. Taken at
    their word they would pin the horizon at today **for ever**; excluded, their
    priceless days fall to :func:`carrying.carrying_price`, whose domain is
    exactly *terminal symbol, any day* — and #765 does not widen it: the cap
    removes days from the series, it never hands a transitory absence to the
    carrying convention.
    """
    blocked = _horizon({"DEAD": LONG_HELD}, {})
    settled = _horizon({"DEAD": LONG_HELD}, {}, settled={"DEAD"})

    assert blocked == (date(2026, 8, 13), None)
    assert settled == (None, None)


def test_a_settled_symbol_does_not_lift_another_symbols_bound():
    """Excluding one symbol says nothing about the next: the max is over the
    rest, so a live reconstruction still holds the account back."""
    assert _horizon({"DEAD": LONG_HELD, "AAPL": LONG_HELD},
                    {"AAPL": date(2021, 6, 3)},
                    settled={"DEAD"}) == (date(2021, 6, 3), None)


def test_the_horizon_takes_the_latest_of_the_symbols_it_keeps():
    """A *max*, not a min: the account is writable only where **every** symbol
    it holds is priced, since one unpriced line is enough to hollow the sum."""
    assert _horizon({"A": LONG_HELD, "B": LONG_HELD},
                    {"A": date(2021, 6, 3),
                     "B": date(2023, 2, 1)}) == (date(2023, 2, 1), None)


def test_the_horizon_bounds_where_the_series_starts():
    """Through :func:`compute_account`: the caller raises ``start`` to it, and
    below it nothing is computed — therefore nothing is written."""
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=100.0, account="PEA"),
    ]
    tl = EventAggregator().replay(events)
    price_at = _price_at({"AAPL": {date(2024, 1, 3): 110.0}})

    window = tl.holding_window("PEA", "AAPL", date(2024, 1, 4))
    horizon = performance.account_horizon(
        {"AAPL": window}, {"AAPL": date(2024, 1, 3)},
        start=date(2024, 1, 1), ceiling=date(2024, 1, 4))
    perf = compute_account(tl, PEA, {"AAPL"}, price_at, start=horizon.first,
                           today=date(2024, 1, 4))

    assert window == (date(2024, 1, 1), date(2024, 1, 4))

    assert horizon == (date(2024, 1, 3), None)
    assert [dp.date for dp in perf.daily] == [date(2024, 1, 3), date(2024, 1, 4)]
    # No crater: the two days that had no price are not written at all, so the
    # index is anchored on a day whose value is complete.
    assert perf.daily[0].total_value == pytest.approx(1100.0)
    assert perf.daily[0].twr_index == pytest.approx(100.0)


def test_the_global_is_written_only_where_every_account_is():
    """Criterion 4: ``portfolio_totals`` takes the **max** of the horizons.

    Summing the accounts available on a day would draw a step nothing caused —
    an account joining the sum as its own reconstruction reaches far enough
    back, on the one page the product opens on. The consequence is accepted
    rather than worked around: one slow account delays the whole home page.
    """
    cto = Account("CTO", "CTO", "My CTO")
    tl = EventAggregator().replay([
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=500.0, account="CTO"),
    ])
    price_at = _price_at({})
    per_account = {
        "PEA": compute_account(tl, PEA, set(), price_at, date(2024, 1, 1),
                               date(2024, 1, 3)),
        "CTO": compute_account(tl, cto, set(), price_at, date(2024, 1, 1),
                               date(2024, 1, 3)),
    }

    # PEA has no horizon, CTO's is 2024-01-03: the max is what the global takes.
    total = compute_portfolio_total(tl, [PEA, cto], set(), price_at,
                                    date(2024, 1, 3), date(2024, 1, 3),
                                    per_account)

    assert [dp.date for dp in total.daily] == [date(2024, 1, 3)]
    assert total.daily[0].total_value == pytest.approx(1500.0)


# --------------------------------------------------------------------------- #
# The per-field rule (issue #708, spec #695 § 11, ADR-0018)
# --------------------------------------------------------------------------- #

def test_the_rule_is_by_field_and_never_by_account():
    """The table of spec #695 § 11, spelled once and read by both writers."""
    assert performance.writable_fields(False, False) == frozenset(
        {'holdings_value', 'gain_absolu'})
    assert performance.writable_fields(True, False) == frozenset(
        {'holdings_value', 'gain_absolu', 'cash_balance', 'total_value',
         'net_contributed', 'twr_index'})
    assert performance.writable_fields(True, True) == frozenset(
        {'holdings_value', 'gain_absolu', 'cash_balance', 'total_value',
         'net_contributed', 'twr_index', 'xirr'})
    # An in-kind grant is an external flow with no cash event behind it: the
    # money-weighted return has something to weight, the cash ledger does not
    # exist.
    assert performance.writable_fields(False, True) == frozenset(
        {'holdings_value', 'gain_absolu', 'xirr'})


def test_a_purchase_is_not_a_cash_event():
    """The condition is a ``DEPOSIT``/``WITHDRAWAL``, never a debit.

    Counting a purchase would put the rule back exactly where the defect is: a
    ledger of purchases alone is the case it exists for, and it moves the balance
    on every line.
    """
    tl = EventAggregator().replay([
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=1,
              unit_price=100.0, account="PEA"),
    ])
    perf = compute_account(tl, PEA, {"AAPL"}, _price_at({}),
                           start=date(2024, 1, 1), today=date(2024, 1, 1))

    assert perf.has_cash_ledger is False
    # And the balance the replay computed is exactly the figure the rule keeps
    # off the wire: minus what was invested, which labelled "total value" is the
    # latent gain of somebody who never said where the money came from.
    assert perf.daily[-1].cash_balance == pytest.approx(-100.0)


def test_the_global_loses_its_cash_half_when_one_account_has_no_ledger():
    """ADR-0018 seen from the other side: *a global figure is written only where
    it is writable for every account*.

    One account's ``cash_balance = −invested`` is **inside** the global sum, so a
    global ``total_value`` carrying it is the very figure the per-field rule
    exists to remove, at the level of the whole portfolio.
    """
    cto = Account("CTO", "CTO", "My CTO")
    tl = EventAggregator().replay([
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=1,
              unit_price=100.0, account="CTO"),
    ])
    price_at = _price_at({"AAPL": {date(2024, 1, 1): 100.0}})
    per_account = {
        "PEA": compute_account(tl, PEA, {"AAPL"}, price_at, date(2024, 1, 1),
                               date(2024, 1, 1)),
        "CTO": compute_account(tl, cto, {"AAPL"}, price_at, date(2024, 1, 1),
                               date(2024, 1, 1)),
    }
    total = compute_portfolio_total(tl, [PEA, cto], {"AAPL"}, price_at,
                                    date(2024, 1, 1), date(2024, 1, 1),
                                    per_account)

    assert per_account["PEA"].has_cash_ledger is True
    assert per_account["CTO"].has_cash_ledger is False
    assert total.has_cash_ledger is False
    # What survives is the pair every entity publishes.
    assert total.daily[-1].holdings_value == pytest.approx(100.0)
    assert total.gain_absolu == pytest.approx(0.0)


def test_an_account_declared_and_never_used_does_not_veto_the_global():
    """``all`` is folded over the accounts that **produce a series**.

    An account with no event contributes nothing to the sum, so it has no figure
    to make unwritable — and ADR-0013's seeded row would otherwise take the cash
    half off every install that declared its accounts by hand.
    """
    cto = Account("CTO", "CTO", "My CTO")
    tl = EventAggregator().replay([
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
    ])
    price_at = _price_at({})
    per_account = {
        "PEA": compute_account(tl, PEA, set(), price_at, date(2024, 1, 1),
                               date(2024, 1, 1)),
        "CTO": compute_account(tl, cto, set(), price_at, date(2024, 1, 1),
                               date(2024, 1, 1)),
    }
    total = compute_portfolio_total(tl, [PEA, cto], set(), price_at,
                                    date(2024, 1, 1), date(2024, 1, 1),
                                    per_account)

    assert per_account["CTO"].daily == []
    assert total.has_cash_ledger is True


# --------------------------------------------------------------------------- #
# The gain's fourth term (issue #708, ADR-0018)
# --------------------------------------------------------------------------- #

def test_the_four_terms_sum_to_the_absolute_gain_closed_positions_included():
    """``Σ latent + Σ realized + Σ dividends + Σ transfer fees == gain_absolu``.

    Measured at 13,95 € on the dev's real portfolio, over six ``DEPOSIT`` rows
    carrying an *Apple Pay Top up* fee: the fee leaves the cash while
    ``net_contributed`` records the gross, so it lands inside ``gain_absolu`` and
    inside **none** of the three position terms. No position can carry it — it is
    not an acquisition cost, not a disposal cost, not a dividend, and it belongs
    to no security — so the shares page, whose header sums its rows, can never
    show it.

    On this ledger, with MSFT **sold out** and AAPL quoted at 100,00:

        latente +197,00 · réalisée +47,00 · dividendes +12,00 · frais −2,25
                                                       = gain_absolu 253,75
    """
    events = [
        Event(date(2024, 1, 10), EventType.DEPOSIT, amount=1000.0, fee=1.50,
              account="PEA"),
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=80.0, fee=3.0, account="PEA"),
        Event(date(2024, 2, 1), EventType.BUY, "MSFT", "Microsoft", quantity=5,
              unit_price=40.0, fee=1.0, account="PEA"),
        Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple",
              amount=12.0, account="PEA"),
        Event(date(2024, 4, 1), EventType.SELL, "MSFT", "Microsoft", quantity=5,
              unit_price=50.0, fee=2.0, account="PEA"),
        Event(date(2024, 6, 1), EventType.WITHDRAWAL, amount=200.0, fee=0.75,
              account="PEA"),
    ]
    tl = EventAggregator().replay(events)
    price_at = _price_at({"AAPL": {date(2024, 1, 15): 100.0}})

    perf = compute_account(tl, PEA, {"AAPL", "MSFT"}, price_at,
                           start=date(2024, 1, 10), today=date(2024, 6, 5))

    # The three position terms, over **every** position the replay holds — the
    # sold one included, which is where a header that folds its closed lines
    # rather than hiding them comes from (ADR-0017).
    positions = tl.current()
    latent = sum(p['quantity'] * (price_at(p['symbol'], date(2024, 6, 5)) or 0.0)
                 - p['cost_basis'] for p in positions)
    realized = sum(p['realized_gain'] for p in positions)
    dividends = sum(p['received_dividend'] for p in positions)
    # The fourth: the fees a broker takes out of a *transfer*, signed as they
    # enter the sum — negative, the money having left.
    transfer_fees = -sum(e.fee or 0.0 for e in events
                         if e.event_type in (EventType.DEPOSIT,
                                             EventType.WITHDRAWAL))

    assert latent == pytest.approx(197.0)
    assert realized == pytest.approx(47.0)
    assert dividends == pytest.approx(12.0)
    assert transfer_fees == pytest.approx(-2.25)
    assert perf.gain_absolu == pytest.approx(253.75)
    assert (latent + realized + dividends + transfer_fees
            == pytest.approx(perf.gain_absolu))


def test_a_transfer_fee_is_never_absorbed_into_the_contributions():
    """The refusal, pinned (issue #708, ADR-0018).

    Absorbing the fee into ``net_contributed`` restores three terms and makes the
    figure vanish from the product entirely. It is refused: the money left the
    owner's pocket, and ``gain_absolu`` was the only figure that knew. So the
    contribution stays the **gross** amount and the fee stays inside the gain.
    """
    tl = EventAggregator().replay([
        Event(date(2024, 1, 10), EventType.DEPOSIT, amount=1000.0, fee=1.50,
              account="PEA"),
    ])
    perf = compute_account(tl, PEA, set(), _price_at({}),
                           start=date(2024, 1, 10), today=date(2024, 1, 10))

    assert perf.daily[-1].net_contributed == pytest.approx(1000.0)
    assert perf.daily[-1].cash_balance == pytest.approx(998.50)
    # …and the gain is exactly minus the fee, which is the whole point.
    assert perf.gain_absolu == pytest.approx(-1.50)


def test_performance_module_has_no_infra_imports():
    import inspect
    src = inspect.getsource(performance)
    import_lines = "\n".join(
        line for line in src.splitlines()
        if line.strip().startswith(("import ", "from "))
    ).lower()
    assert "influxdb" not in import_lines
    assert "yfinance" not in import_lines
