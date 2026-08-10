"""
Unit tests for the money-weighted performance module (issue #577).

Covers: XIRR bisection (known-rate reference), external vs internal flow
classification, no-external-flow => no xirr/gain, daily valuation, TWR base 100,
GRANT valued at the day's price, and portfolio-total currency gating.
"""

from datetime import date

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
def test_no_external_flow_no_xirr_no_gain():
    """Only internal flows (BUY) => no external flow => no xirr, no gain_absolu."""
    events = [
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=1,
              unit_price=100.0, account="PEA"),
    ]
    tl = EventAggregator().replay(events)
    price_at = _price_at({"AAPL": {date(2024, 1, 1): 100.0}})
    perf = compute_account(tl, PEA, {"AAPL"}, price_at,
                           start=date(2024, 1, 1), today=date(2024, 1, 1))
    assert perf.xirr is None
    assert perf.gain_absolu is None


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


def test_performance_module_has_no_infra_imports():
    import inspect
    src = inspect.getsource(performance)
    import_lines = "\n".join(
        line for line in src.splitlines()
        if line.strip().startswith(("import ", "from "))
    ).lower()
    assert "influxdb" not in import_lines
    assert "yfinance" not in import_lines
