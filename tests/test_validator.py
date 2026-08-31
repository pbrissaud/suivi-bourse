"""
Tests for events.validator.EventValidator.

Every assertion is grounded in the actual behavior of
``src/application/events/validator.py``. Event objects are constructed directly.
"""

from datetime import date

import pytest

from application.events.schemas import Event, EventType
from application.events.validator import EventValidator, EventValidationError


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


def test_grant_accepts_a_fee_that_is_not_negative(validator):
    for fee in (None, 0.0, 7.50):
        ev = Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
                   quantity=1, fee=fee)
        assert validator.validate([ev]) == (True, [])


def test_grant_negative_fee(validator):
    """A GRANT's fee is read, so it is judged — like a BUY's and a SELL's.

    It used to be waved through on the premise that a cash-neutral event has no
    fee anyone reads. The replay reads it: ``aggregator._apply_share_cash``
    debits it and ``_process_grant`` absorbs it into the basis, so ``-1000``
    bought a negative cost basis — a negative PMP — and conjured a thousand of
    cash out of nothing. ``test_aggregator`` pins that reading; this pins the
    refusal that keeps it fed a number.
    """
    ev = Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
               quantity=1, fee=-999.0)
    is_valid, errors = validator.validate([ev])
    assert is_valid is False
    assert len(errors) == 1
    assert "fee cannot be negative" in errors[0]


def test_grant_accepts_an_optional_unit_price(validator):
    """Present it is a valued award, absent it is dilution — both are legal."""
    valued = Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
                   quantity=1, unit_price=100.0)
    diluted = Event(date(2024, 6, 2), EventType.GRANT, "AAPL", "Apple Inc",
                    quantity=1)
    is_valid, errors = validator.validate([valued, diluted])
    assert is_valid is True
    assert errors == []


def test_grant_does_not_refuse_a_nonsense_unit_price(validator):
    """It is normalised where it is read, never refused here (#699).

    This validator runs over the **whole stored ledger** on every build, not
    only over a file someone just dropped, and the column was parsed and
    discarded before v5 — so a refusal would be retroactive and would fail the
    boot on a row that was legal when it was imported, in an app the user then
    cannot reach to fix it. `test_aggregator` pins what the replay does with
    such a value instead.
    """
    for price in (-999.0, 0.0):
        ev = Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
                   quantity=1, unit_price=price)
        is_valid, errors = validator.validate([ev])
        assert (is_valid, errors) == (True, [])


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


def test_dividend_accepts_a_fee_that_is_not_negative(validator):
    for fee in (None, 0.0, 3.0):
        ev = Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple Inc",
                   amount=2.40, fee=fee)
        assert validator.validate([ev]) == (True, [])


def test_dividend_negative_fee(validator):
    """The withholding is a subtraction, and a subtraction of a negative is not.

    ``_process_dividend`` books ``amount - fee``, so ``-1000`` on a dividend of
    ten made ``received_dividend`` 1010 — one of ADR-0018's four named terms,
    inflated by a figure the owner never received.
    """
    ev = Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple Inc",
               amount=10.0, fee=-1000.0)
    is_valid, errors = validator.validate([ev])
    assert is_valid is False
    assert len(errors) == 1
    assert "fee cannot be negative" in errors[0]


# ---------------------------------------------------------------------------
# A number JSON cannot spell is not a number
# ---------------------------------------------------------------------------

#: NaN compares false against every bound, ``+inf`` against the two that matter
#: here (``<= 0`` and ``< 0``), so every guard below was written as a comparison
#: and every one of them let these through.
NOT_A_NUMBER = (float('nan'), float('inf'), float('-inf'))


def _refused(validator, event, field):
    """The messages one field of one event earned."""
    return [issue.message for issue in validator.issues([event])
            if issue.field == field]


def test_no_number_of_a_buy_may_be_nan_or_infinite(validator):
    for value in NOT_A_NUMBER:
        assert _refused(validator, _buy(quantity=value), 'quantity')
        assert _refused(validator, _buy(unit_price=value), 'unit_price')
        assert _refused(validator, _buy(fee=value), 'fee')


def test_no_number_of_a_sell_may_be_nan_or_infinite(validator):
    for value in NOT_A_NUMBER:
        assert _refused(validator, _sell(quantity=value), 'quantity')
        assert _refused(validator, _sell(unit_price=value), 'unit_price')
        assert _refused(validator, _sell(fee=value), 'fee')


def test_no_number_of_a_grant_may_be_nan_or_infinite(validator):
    """``unit_price`` included, and it is not the refusal #699 declined.

    That one is about a price that *is* a number and cannot be one — zero,
    negative — which the replay normalises to dilution. ``nan`` is not
    normalised anywhere: ``declared_value`` multiplies by it and the position's
    whole cost basis becomes ``nan``.
    """
    for value in NOT_A_NUMBER:
        assert _refused(validator, _grant(quantity=value), 'quantity')
        priced = Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
                       quantity=1, unit_price=value)
        assert _refused(validator, priced, 'unit_price')
        charged = Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
                        quantity=1, fee=value)
        assert _refused(validator, charged, 'fee')


def test_no_number_of_a_dividend_may_be_nan_or_infinite(validator):
    for value in NOT_A_NUMBER:
        assert _refused(validator, _dividend(amount=value), 'amount')
        charged = Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL",
                        "Apple Inc", amount=2.40, fee=value)
        assert _refused(validator, charged, 'fee')


def test_no_number_of_a_cash_event_may_be_nan_or_infinite(validator):
    for value in NOT_A_NUMBER:
        for event_type in (EventType.DEPOSIT, EventType.WITHDRAWAL):
            assert _refused(
                validator, Event(date(2024, 2, 1), event_type, amount=value),
                'amount')
            assert _refused(
                validator,
                Event(date(2024, 2, 1), event_type, amount=500.0, fee=value),
                'fee')


def test_a_non_finite_number_names_the_field_and_is_not_positive_or_negative(validator):
    """The refusal is about the *value*, not about its sign.

    ``inf`` is greater than zero and ``nan`` is neither, so the neighbouring
    *must be positive* would have been a sentence about an ordering that does
    not hold. The message says what is wrong with the cell.
    """
    (issue,) = validator.issues([_buy(quantity=float('inf'))])

    assert issue.field == 'quantity'
    assert "quantity must be a finite number" in issue.message
    assert "Event #1 (2024-01-15, BUY, AAPL)" in issue.message


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
# The structured form: one owner, and it names the field (issue #764)
# ---------------------------------------------------------------------------

def test_every_issue_names_the_field_it_is_about(validator):
    """A ``422`` marks the input it refused; a sentence over the panel does not.

    The field travels **with** the message rather than being re-derived by
    whoever renders it: a form parsing *"unit_price is required for BUY"* back
    into an input name would be a second copy of these rules, and the copy
    disagrees on the day one message is reworded.
    """
    issues = validator.issues([_buy(quantity=None, unit_price=None)])

    assert [issue.field for issue in issues] == ['quantity', 'unit_price']
    assert all(issue.message.startswith('Event #1 (') for issue in issues)


def test_the_two_entry_points_answer_the_same_thing(validator):
    """``validate`` is built out of ``issues``, never beside it.

    Two implementations of one validator are two answers, and the ledger is
    replayed whole on every build — so the road an event took would decide
    whether the app boots.
    """
    events = [_buy(quantity=None), _dividend(amount=-1.0)]

    ok, messages = validator.validate(events)

    assert ok is False
    assert messages == [issue.message for issue in validator.issues(events)]


def test_an_undeclared_account_names_the_account_column():
    """The one refusal a create form meets that no per-type rule covers."""
    strict = EventValidator(account_ids={'default', 'pea'})
    typed = Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
                  quantity=1, unit_price=1.0, account='nope')

    (issue,) = strict.issues([typed])

    assert issue.field == 'account'
    assert "'nope' is not declared" in issue.message


def test_the_undeclared_account_is_sent_to_the_app_and_nowhere_else():
    """An account is born in the app, and the refusal says only that (ADR-0034).

    This sentence reaches the owner both ways — as the ``detail`` of a ``422``
    on an uploaded file and under the create form's account field — so naming an
    accounts file in it would hand them a second road on one of the two, and a
    road the upload itself refuses, naming those very columns. The refusal would
    then be the app arguing with itself in front of them.
    """
    strict = EventValidator(account_ids={'default', 'pea'})
    typed = Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
                  quantity=1, unit_price=1.0, account='nope')

    (issue,) = strict.issues([typed])

    assert 'declare it in the app' in issue.message
    assert 'file' not in issue.message


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


# ---------------------------------------------------------------------------
# The date is not tested against today (issue #766)
# ---------------------------------------------------------------------------

def test_an_event_dated_in_the_future_is_not_refused_here(validator):
    """The question #766 asks, answered where it is *not* answered.

    A row dated next year is legal, and the refusal was weighed and declined
    rather than forgotten. This validator judges the **whole stored ledger** on
    every build, not only a file somebody has just dropped, and one of those
    builds is the boot's own — so a rule added here is
    **retroactive**: every install already carrying such a row would stop
    booting, in an app the owner then cannot reach to repair it, and an imported
    row has no row-level edit anyway (#764 refuses one by name; the repair is
    forgetting the whole import). That is #699's argument for the ``GRANT``
    unit_price, and the date has the same shape.

    What is settled instead is the one place the date produced a *wrong window* —
    :meth:`events.schemas.Timeline.holding_window`, which now answers ``None``
    rather than a window whose last day precedes its first.
    """
    future = Event(date(2027, 5, 3), EventType.BUY, "AAPL", "Apple Inc",
                   quantity=10, unit_price=150.0)

    assert validator.validate([future]) == (True, [])
    assert validator.issues([future]) == []
