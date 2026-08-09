"""Unit tests for events.schemas."""

from datetime import date

import pytest

from events.schemas import (
    Event,
    EventType,
    ShareState,
    unit_cost,
)
from positions import POSITION_COLUMNS


# ---------------------------------------------------------------------------
# EventType enum
# ---------------------------------------------------------------------------

def test_event_type_enum_values():
    assert EventType.BUY.value == "BUY"
    assert EventType.SELL.value == "SELL"
    assert EventType.GRANT.value == "GRANT"
    assert EventType.DIVIDEND.value == "DIVIDEND"


def test_event_type_membership_is_exhaustive():
    assert {e.value for e in EventType} == {
        "BUY", "SELL", "GRANT", "DIVIDEND", "DEPOSIT", "WITHDRAWAL"}


# ---------------------------------------------------------------------------
# Event.__post_init__ event_type coercion
# ---------------------------------------------------------------------------

def test_event_type_already_enum_is_preserved():
    ev = Event(date=date(2024, 1, 1), event_type=EventType.BUY,
               symbol="AAPL", name="Apple")
    assert ev.event_type is EventType.BUY


def test_event_type_string_uppercase_coerced():
    ev = Event(date=date(2024, 1, 1), event_type="BUY",
               symbol="AAPL", name="Apple")
    assert ev.event_type is EventType.BUY


def test_event_type_string_lowercase_coerced():
    ev = Event(date=date(2024, 1, 1), event_type="buy",
               symbol="AAPL", name="Apple")
    assert ev.event_type is EventType.BUY


def test_event_type_string_mixed_case_coerced():
    ev = Event(date=date(2024, 1, 1), event_type="DiViDeNd",
               symbol="AAPL", name="Apple")
    assert ev.event_type is EventType.DIVIDEND


@pytest.mark.parametrize("raw,expected", [
    ("buy", EventType.BUY),
    ("SELL", EventType.SELL),
    ("Grant", EventType.GRANT),
    ("dividend", EventType.DIVIDEND),
])
def test_event_type_coercion_all_values(raw, expected):
    ev = Event(date=date(2024, 1, 1), event_type=raw,
               symbol="AAPL", name="Apple")
    assert ev.event_type is expected


def test_event_type_unknown_string_raises_value_error():
    with pytest.raises(ValueError):
        Event(date=date(2024, 1, 1), event_type="SPLIT",
              symbol="AAPL", name="Apple")


def test_event_type_empty_string_raises_value_error():
    with pytest.raises(ValueError):
        Event(date=date(2024, 1, 1), event_type="",
              symbol="AAPL", name="Apple")


# ---------------------------------------------------------------------------
# Event optional fields default to None
# ---------------------------------------------------------------------------

def test_event_optional_fields_default_to_none():
    ev = Event(date=date(2024, 1, 1), event_type=EventType.GRANT,
               symbol="AAPL", name="Apple")
    assert ev.quantity is None
    assert ev.unit_price is None
    assert ev.fee is None
    assert ev.amount is None
    assert ev.notes is None


def test_event_required_fields_are_set():
    d = date(2024, 6, 15)
    ev = Event(date=d, event_type="BUY", symbol="MSFT", name="Microsoft")
    assert ev.date == d
    assert ev.symbol == "MSFT"
    assert ev.name == "Microsoft"


def test_event_optional_fields_accept_values():
    ev = Event(date=date(2024, 1, 1), event_type="BUY", symbol="AAPL",
               name="Apple", quantity=10, unit_price=150.0, fee=2.5,
               amount=None, notes="hello")
    assert ev.quantity == 10
    assert ev.unit_price == 150.0
    assert ev.fee == 2.5
    assert ev.notes == "hello"


# ---------------------------------------------------------------------------
# unit_cost — the one place the matching convention divides (ADR-0003)
# ---------------------------------------------------------------------------

def test_unit_cost_is_the_basis_divided_by_the_quantity():
    assert unit_cost(50.0, 930.0) == 18.6


def test_unit_cost_of_a_position_nobody_holds_is_undefined():
    """Not 0.0 — a sold position has no unit cost price, it has a realized gain."""
    assert unit_cost(0.0, 0.0) is None


# ---------------------------------------------------------------------------
# ShareState — one stock, and no closed flag
# ---------------------------------------------------------------------------

def test_share_state_numeric_defaults_are_zero():
    s = ShareState(name="Apple", symbol="AAPL")
    assert (s.quantity, s.cost_basis, s.realized_gain,
            s.received_dividend) == (0.0, 0.0, 0.0, 0.0)


def test_share_state_carries_no_closed_flag():
    """The predicate is ``quantity == 0``; no field is allowed to disagree."""
    assert not hasattr(ShareState(name="Apple", symbol="AAPL"), 'closed')


def test_share_state_has_no_purchase_or_estate_halves():
    s = ShareState(name="Apple", symbol="AAPL")
    assert not hasattr(s, 'purchase')
    assert not hasattr(s, 'estate')


def test_mutating_one_share_state_does_not_affect_another():
    a = ShareState(name="Apple", symbol="AAPL")
    b = ShareState(name="Microsoft", symbol="MSFT")

    a.quantity = 42.0
    a.cost_basis = 100.0
    a.realized_gain = 5.0
    a.received_dividend = 3.5

    assert (b.quantity, b.cost_basis, b.realized_gain,
            b.received_dividend) == (0.0, 0.0, 0.0, 0.0)


def test_share_state_unit_cost_is_derived():
    s = ShareState(name="Alstom", symbol="ALO", quantity=50.0, cost_basis=930.0)
    assert s.unit_cost == 18.6


def test_share_state_unit_cost_of_a_sold_position_is_undefined():
    s = ShareState(name="Alstom", symbol="ALO", quantity=0.0, cost_basis=0.0,
                   realized_gain=-335.89)
    assert s.unit_cost is None


# ---------------------------------------------------------------------------
# ShareState.to_dict()
# ---------------------------------------------------------------------------

def test_to_dict_default_structure():
    s = ShareState(name="Apple", symbol="AAPL")
    assert s.to_dict() == {
        'name': 'Apple',
        'symbol': 'AAPL',
        'account': 'default',
        'quantity': 0.0,
        'cost_basis': 0.0,
        'realized_gain': 0.0,
        'received_dividend': 0.0,
    }


def test_to_dict_reflects_populated_values():
    s = ShareState(name="Microsoft", symbol="MSFT", account="PEA",
                   quantity=12.0, cost_basis=2504.0, realized_gain=41.5,
                   received_dividend=15.75)
    assert s.to_dict() == {
        'name': 'Microsoft',
        'symbol': 'MSFT',
        'account': 'PEA',
        'quantity': 12.0,
        'cost_basis': 2504.0,
        'realized_gain': 41.5,
        'received_dividend': 15.75,
    }


def test_to_dict_keys_are_the_position_columns():
    """The dict the replay speaks and the table it writes are one shape."""
    s = ShareState(name="Apple", symbol="AAPL")
    assert set(s.to_dict()) == set(POSITION_COLUMNS)


def test_to_dict_default_account_when_unset():
    """A ShareState built without an account defaults to 'default'."""
    s = ShareState(name="Apple", symbol="AAPL")
    assert s.account == 'default'
    assert s.to_dict()['account'] == 'default'
