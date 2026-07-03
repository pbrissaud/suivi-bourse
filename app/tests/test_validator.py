"""
Tests for events.validator.EventValidator.

Every assertion is grounded in the actual behavior of
``app/src/events/validator.py``. Event objects are constructed directly.
"""

from datetime import date

import pytest

from events.schemas import Event, EventType
from events.validator import EventValidator, EventValidationError


@pytest.fixture
def validator():
    return EventValidator()


# ---------------------------------------------------------------------------
# Small constructors so each test states exactly the field under test.
# ---------------------------------------------------------------------------

def _buy(quantity=10, unit_price=150.0, fee=2.5):
    return Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
                 quantity=quantity, unit_price=unit_price, fee=fee)


def _sell(quantity=3, unit_price=190.0, fee=2.0):
    return Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
                 quantity=quantity, unit_price=unit_price, fee=fee)


def _grant(quantity=1):
    return Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
                 quantity=quantity)


def _dividend(amount=2.40):
    return Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple Inc",
                 amount=amount)


# ---------------------------------------------------------------------------
# All-valid input
# ---------------------------------------------------------------------------

def test_validate_empty_list_is_valid(validator):
    is_valid, errors = validator.validate([])
    assert is_valid is True
    assert errors == []


def test_validate_all_valid_returns_true_and_empty_list(validator, sample_events):
    is_valid, errors = validator.validate(sample_events)
    assert is_valid is True
    assert errors == []


def test_validate_valid_one_of_each_type(validator):
    is_valid, errors = validator.validate([_buy(), _sell(), _grant(), _dividend()])
    assert is_valid is True
    assert errors == []


def test_valid_buy_with_no_fee_is_ok(validator):
    # fee is optional: None must not produce an error.
    is_valid, errors = validator.validate([_buy(fee=None)])
    assert is_valid is True
    assert errors == []


def test_valid_buy_with_zero_fee_is_ok(validator):
    # fee == 0 is not negative -> allowed.
    is_valid, errors = validator.validate([_buy(fee=0)])
    assert is_valid is True
    assert errors == []


# ---------------------------------------------------------------------------
# BUY rules
# ---------------------------------------------------------------------------

def test_buy_missing_quantity(validator):
    is_valid, errors = validator.validate([_buy(quantity=None)])
    assert is_valid is False
    assert len(errors) == 1
    assert "quantity is required for BUY" in errors[0]


def test_buy_zero_quantity(validator):
    is_valid, errors = validator.validate([_buy(quantity=0)])
    assert is_valid is False
    assert len(errors) == 1
    assert "quantity must be positive for BUY" in errors[0]


def test_buy_negative_quantity(validator):
    is_valid, errors = validator.validate([_buy(quantity=-5)])
    assert is_valid is False
    assert len(errors) == 1
    assert "quantity must be positive for BUY" in errors[0]


def test_buy_missing_unit_price(validator):
    is_valid, errors = validator.validate([_buy(unit_price=None)])
    assert is_valid is False
    assert len(errors) == 1
    assert "unit_price is required for BUY" in errors[0]


def test_buy_zero_unit_price(validator):
    is_valid, errors = validator.validate([_buy(unit_price=0)])
    assert is_valid is False
    assert len(errors) == 1
    assert "unit_price must be positive for BUY" in errors[0]


def test_buy_negative_unit_price(validator):
    is_valid, errors = validator.validate([_buy(unit_price=-1.0)])
    assert is_valid is False
    assert len(errors) == 1
    assert "unit_price must be positive for BUY" in errors[0]


def test_buy_negative_fee(validator):
    is_valid, errors = validator.validate([_buy(fee=-0.01)])
    assert is_valid is False
    assert len(errors) == 1
    assert "fee cannot be negative" in errors[0]


def test_buy_multiple_problems_accumulate_within_one_event(validator):
    # Missing quantity + missing unit_price + negative fee => three errors.
    is_valid, errors = validator.validate(
        [_buy(quantity=None, unit_price=None, fee=-1)])
    assert is_valid is False
    assert len(errors) == 3
    assert any("quantity is required for BUY" in e for e in errors)
    assert any("unit_price is required for BUY" in e for e in errors)
    assert any("fee cannot be negative" in e for e in errors)


# ---------------------------------------------------------------------------
# SELL rules (same quantity/unit_price/fee rules as BUY)
# ---------------------------------------------------------------------------

def test_sell_missing_quantity(validator):
    is_valid, errors = validator.validate([_sell(quantity=None)])
    assert is_valid is False
    assert len(errors) == 1
    assert "quantity is required for SELL" in errors[0]


def test_sell_zero_quantity(validator):
    is_valid, errors = validator.validate([_sell(quantity=0)])
    assert is_valid is False
    assert len(errors) == 1
    assert "quantity must be positive for SELL" in errors[0]


def test_sell_negative_quantity(validator):
    is_valid, errors = validator.validate([_sell(quantity=-2)])
    assert is_valid is False
    assert len(errors) == 1
    assert "quantity must be positive for SELL" in errors[0]


def test_sell_missing_unit_price(validator):
    is_valid, errors = validator.validate([_sell(unit_price=None)])
    assert is_valid is False
    assert len(errors) == 1
    assert "unit_price is required for SELL" in errors[0]


def test_sell_zero_unit_price(validator):
    is_valid, errors = validator.validate([_sell(unit_price=0)])
    assert is_valid is False
    assert len(errors) == 1
    assert "unit_price must be positive for SELL" in errors[0]


def test_sell_negative_unit_price(validator):
    is_valid, errors = validator.validate([_sell(unit_price=-100.0)])
    assert is_valid is False
    assert len(errors) == 1
    assert "unit_price must be positive for SELL" in errors[0]


def test_sell_negative_fee(validator):
    is_valid, errors = validator.validate([_sell(fee=-5)])
    assert is_valid is False
    assert len(errors) == 1
    assert "fee cannot be negative" in errors[0]


def test_sell_zero_fee_is_ok(validator):
    is_valid, errors = validator.validate([_sell(fee=0)])
    assert is_valid is True
    assert errors == []


# ---------------------------------------------------------------------------
# GRANT rules (positive quantity only)
# ---------------------------------------------------------------------------

def test_grant_valid(validator):
    is_valid, errors = validator.validate([_grant(quantity=2)])
    assert is_valid is True
    assert errors == []


def test_grant_missing_quantity(validator):
    is_valid, errors = validator.validate([_grant(quantity=None)])
    assert is_valid is False
    assert len(errors) == 1
    assert "quantity is required for GRANT" in errors[0]


def test_grant_zero_quantity(validator):
    is_valid, errors = validator.validate([_grant(quantity=0)])
    assert is_valid is False
    assert len(errors) == 1
    assert "quantity must be positive for GRANT" in errors[0]


def test_grant_negative_quantity(validator):
    is_valid, errors = validator.validate([_grant(quantity=-1)])
    assert is_valid is False
    assert len(errors) == 1
    assert "quantity must be positive for GRANT" in errors[0]


def test_grant_ignores_unit_price_and_fee(validator):
    # GRANT validation only checks quantity; a negative fee here is not flagged.
    ev = Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
               quantity=1, unit_price=-999.0, fee=-999.0)
    is_valid, errors = validator.validate([ev])
    assert is_valid is True
    assert errors == []


# ---------------------------------------------------------------------------
# DIVIDEND rules (positive amount only)
# ---------------------------------------------------------------------------

def test_dividend_valid(validator):
    is_valid, errors = validator.validate([_dividend(amount=3.14)])
    assert is_valid is True
    assert errors == []


def test_dividend_missing_amount(validator):
    is_valid, errors = validator.validate([_dividend(amount=None)])
    assert is_valid is False
    assert len(errors) == 1
    assert "amount is required for DIVIDEND" in errors[0]


def test_dividend_zero_amount(validator):
    is_valid, errors = validator.validate([_dividend(amount=0)])
    assert is_valid is False
    assert len(errors) == 1
    assert "amount must be positive for DIVIDEND" in errors[0]


def test_dividend_negative_amount(validator):
    is_valid, errors = validator.validate([_dividend(amount=-1.0)])
    assert is_valid is False
    assert len(errors) == 1
    assert "amount must be positive for DIVIDEND" in errors[0]


# ---------------------------------------------------------------------------
# Cross-event accumulation
# ---------------------------------------------------------------------------

def test_errors_accumulate_across_multiple_events(validator):
    events = [
        _buy(quantity=None),       # 1 error
        _sell(unit_price=-1.0),    # 1 error
        _grant(quantity=0),        # 1 error
        _dividend(amount=None),    # 1 error
        _buy(),                    # valid, no error
    ]
    is_valid, errors = validator.validate(events)
    assert is_valid is False
    assert len(errors) == 4


def test_error_prefix_uses_1_based_event_numbering(validator):
    # The second event is the invalid one; its message must say "Event #2".
    events = [_buy(), _dividend(amount=None)]
    is_valid, errors = validator.validate(events)
    assert is_valid is False
    assert len(errors) == 1
    assert "Event #2" in errors[0]


def test_error_prefix_includes_date_type_and_symbol(validator):
    is_valid, errors = validator.validate([_buy(quantity=None)])
    assert is_valid is False
    msg = errors[0]
    assert "2024-01-15" in msg
    assert "BUY" in msg
    assert "AAPL" in msg


# ---------------------------------------------------------------------------
# validate_or_raise
# ---------------------------------------------------------------------------

def test_validate_or_raise_silent_on_valid(validator, sample_events):
    # Must not raise and returns None.
    assert validator.validate_or_raise(sample_events) is None


def test_validate_or_raise_silent_on_empty(validator):
    assert validator.validate_or_raise([]) is None


def test_validate_or_raise_raises_on_invalid(validator):
    with pytest.raises(EventValidationError):
        validator.validate_or_raise([_buy(quantity=None)])


def test_validate_or_raise_message_includes_count_and_each_message(validator):
    events = [
        _buy(quantity=None, unit_price=None),  # 2 errors
        _dividend(amount=-1.0),                # 1 error
    ]
    # Cross-check against validate() so the expected messages come from source.
    _, errors = validator.validate(events)
    assert len(errors) == 3

    with pytest.raises(EventValidationError) as excinfo:
        validator.validate_or_raise(events)

    message = str(excinfo.value)
    # Count is embedded in the header: "... failed with 3 error(s):".
    assert "3 error(s)" in message
    # Every individual error message is present in the raised text.
    for e in errors:
        assert e in message
