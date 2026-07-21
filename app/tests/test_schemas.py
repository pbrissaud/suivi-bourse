"""Unit tests for events.schemas."""

from datetime import date

import pytest

from events.schemas import (
    Event,
    EventType,
    ShareState,
    PurchaseState,
    EstateState,
)


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
# PurchaseState / EstateState numeric defaults are 0.0
# ---------------------------------------------------------------------------

def test_purchase_state_defaults_are_zero():
    ps = PurchaseState()
    assert ps.quantity == 0.0
    assert ps.cost_price == 0.0
    assert ps.fee == 0.0


def test_estate_state_defaults_are_zero():
    es = EstateState()
    assert es.quantity == 0.0
    assert es.received_dividend == 0.0


def test_purchase_state_accepts_overrides():
    ps = PurchaseState(quantity=5.0, cost_price=100.0, fee=1.0)
    assert (ps.quantity, ps.cost_price, ps.fee) == (5.0, 100.0, 1.0)


def test_estate_state_accepts_overrides():
    es = EstateState(quantity=3.0, received_dividend=8.5)
    assert (es.quantity, es.received_dividend) == (3.0, 8.5)


# ---------------------------------------------------------------------------
# ShareState default_factory -> independent nested state
# ---------------------------------------------------------------------------

def test_share_state_default_nested_states_are_zero():
    s = ShareState(name="Apple", symbol="AAPL")
    assert isinstance(s.purchase, PurchaseState)
    assert isinstance(s.estate, EstateState)
    assert s.purchase.quantity == 0.0
    assert s.estate.quantity == 0.0


def test_two_share_states_have_independent_purchase_objects():
    a = ShareState(name="Apple", symbol="AAPL")
    b = ShareState(name="Microsoft", symbol="MSFT")
    assert a.purchase is not b.purchase
    assert a.estate is not b.estate


def test_mutating_one_share_state_does_not_affect_another():
    a = ShareState(name="Apple", symbol="AAPL")
    b = ShareState(name="Microsoft", symbol="MSFT")

    a.purchase.quantity = 42.0
    a.purchase.cost_price = 100.0
    a.purchase.fee = 5.0
    a.estate.quantity = 7.0
    a.estate.received_dividend = 3.5

    # b must remain at its own independent defaults
    assert b.purchase.quantity == 0.0
    assert b.purchase.cost_price == 0.0
    assert b.purchase.fee == 0.0
    assert b.estate.quantity == 0.0
    assert b.estate.received_dividend == 0.0


def test_explicit_nested_state_is_used():
    ps = PurchaseState(quantity=1.0)
    es = EstateState(quantity=2.0)
    s = ShareState(name="Apple", symbol="AAPL", purchase=ps, estate=es)
    assert s.purchase is ps
    assert s.estate is es


# ---------------------------------------------------------------------------
# ShareState.to_dict()
# ---------------------------------------------------------------------------

def test_to_dict_default_structure():
    s = ShareState(name="Apple", symbol="AAPL")
    assert s.to_dict() == {
        'name': 'Apple',
        'symbol': 'AAPL',
        'account': 'default',
        'purchase': {
            'quantity': 0.0,
            'cost_price': 0.0,
            'fee': 0.0,
        },
        'estate': {
            'quantity': 0.0,
            'received_dividend': 0.0,
        },
    }


def test_to_dict_reflects_populated_values():
    s = ShareState(name="Microsoft", symbol="MSFT", account="PEA")
    s.purchase.quantity = 10.0
    s.purchase.cost_price = 250.0
    s.purchase.fee = 4.0
    s.estate.quantity = 12.0
    s.estate.received_dividend = 15.75

    assert s.to_dict() == {
        'name': 'Microsoft',
        'symbol': 'MSFT',
        'account': 'PEA',
        'purchase': {
            'quantity': 10.0,
            'cost_price': 250.0,
            'fee': 4.0,
        },
        'estate': {
            'quantity': 12.0,
            'received_dividend': 15.75,
        },
    }


def test_to_dict_exact_key_set():
    s = ShareState(name="Apple", symbol="AAPL")
    d = s.to_dict()
    assert set(d.keys()) == {'name', 'symbol', 'account', 'purchase', 'estate'}
    assert set(d['purchase'].keys()) == {'quantity', 'cost_price', 'fee'}
    assert set(d['estate'].keys()) == {'quantity', 'received_dividend'}


def test_to_dict_default_account_when_unset():
    """A ShareState built without an account defaults to 'default'."""
    s = ShareState(name="Apple", symbol="AAPL")
    assert s.account == 'default'
    assert s.to_dict()['account'] == 'default'
