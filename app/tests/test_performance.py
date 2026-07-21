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


PEA = Account("PEA", "PEA", "EUR", "Mon PEA")
CTO = Account("CTO", "CTO", "USD", "My CTO")


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
    tl = EventAggregator().replay(events, accounts_declared=True)
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
    tl = EventAggregator().replay(events, accounts_declared=True)
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
    tl = EventAggregator().replay(events, accounts_declared=True)
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
    tl = EventAggregator().replay(events, accounts_declared=True)
    price_at = _price_at({"AAPL": {date(2024, 1, 1): 100.0}})
    perf = compute_account(tl, PEA, {"AAPL"}, price_at,
                           start=date(2024, 1, 1), today=date(2024, 1, 1))
    assert perf.xirr is None
    assert perf.gain_absolu is None


def test_grant_is_external_and_valued_at_day_price():
    """GRANT is an external in-kind contribution valued at the day's price."""
    events = [
        Event(date(2024, 1, 1), EventType.GRANT, "AAPL", "Apple", quantity=10,
              account="PEA"),
    ]
    tl = EventAggregator().replay(events, accounts_declared=True)
    price_at = _price_at({"AAPL": {date(2024, 1, 1): 50.0}})
    perf = compute_account(tl, PEA, {"AAPL"}, price_at,
                           start=date(2024, 1, 1), today=date(2024, 1, 1))
    # Contributed = 10 * 50 (in-kind); terminal = 10 * 50; gain = 0.
    assert perf.gain_absolu == pytest.approx(0.0)  # GRANT counts as an external flow


# --------------------------------------------------------------------------- #
# Portfolio total: currency gating
# --------------------------------------------------------------------------- #
def test_portfolio_total_none_on_mixed_currencies():
    tl = EventAggregator().replay([
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=500.0, account="CTO"),
    ], accounts_declared=True)
    price_at = _price_at({})
    per_account = {
        "PEA": compute_account(tl, PEA, set(), price_at, date(2024, 1, 1), date(2024, 1, 1)),
        "CTO": compute_account(tl, CTO, set(), price_at, date(2024, 1, 1), date(2024, 1, 1)),
    }
    total = compute_portfolio_total(tl, [PEA, CTO], set(), price_at,
                                    date(2024, 1, 1), date(2024, 1, 1), per_account)
    assert total is None  # EUR + USD -> no FX pooling


def test_portfolio_total_aggregates_same_currency():
    pea2 = Account("PEA2", "PEA", "EUR", "PEA 2")
    tl = EventAggregator().replay([
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=500.0, account="PEA2"),
    ], accounts_declared=True)
    price_at = _price_at({})
    per_account = {
        "PEA": compute_account(tl, PEA, set(), price_at, date(2024, 1, 1), date(2024, 1, 1)),
        "PEA2": compute_account(tl, pea2, set(), price_at, date(2024, 1, 1), date(2024, 1, 1)),
    }
    total = compute_portfolio_total(tl, [PEA, pea2], set(), price_at,
                                    date(2024, 1, 1), date(2024, 1, 1), per_account)
    assert total is not None
    assert total.currency == "EUR"
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
