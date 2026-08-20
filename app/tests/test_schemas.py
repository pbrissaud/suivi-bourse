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


# ---------------------------------------------------------------------------
# Timeline.holding_window — what bounds the perf horizon (issue #708)
# ---------------------------------------------------------------------------
TODAY = date(2026, 8, 12)


def _replayed(events):
    from events import EventAggregator
    return EventAggregator().replay(events)


def test_a_standing_position_is_held_through_today():
    tl = _replayed([
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=100.0, account="PEA"),
    ])
    assert tl.holding_window("PEA", "AAPL", TODAY) == (date(2024, 1, 15), TODAY)


def test_a_sold_position_is_held_through_the_day_it_emptied():
    """The day of the sale **counts as held**: the price of the day one sells is
    part of the history one held, which is the reading ``holding_bounds`` makes
    of an exit on the backfill's side."""
    tl = _replayed([
        Event(date(2020, 3, 2), EventType.BUY, "ALO", "Alstom", quantity=10,
              unit_price=100.0, account="PEA"),
        Event(date(2022, 5, 4), EventType.SELL, "ALO", "Alstom", quantity=10,
              unit_price=120.0, account="PEA"),
    ])
    assert tl.holding_window("PEA", "ALO", TODAY) == (date(2020, 3, 2),
                                                      date(2022, 5, 4))


def test_a_bought_back_position_is_held_through_today_again():
    """The last emptying is forgotten once the line stands again — the same
    simplification the backfill window makes, and the conservative one here."""
    tl = _replayed([
        Event(date(2020, 3, 2), EventType.BUY, "ALO", "Alstom", quantity=10,
              unit_price=100.0, account="PEA"),
        Event(date(2022, 5, 4), EventType.SELL, "ALO", "Alstom", quantity=10,
              unit_price=120.0, account="PEA"),
        Event(date(2024, 9, 9), EventType.BUY, "ALO", "Alstom", quantity=4,
              unit_price=130.0, account="PEA"),
    ])
    assert tl.holding_window("PEA", "ALO", TODAY) == (date(2020, 3, 2), TODAY)


def test_a_window_is_per_account_and_absent_where_nothing_was_held():
    """A line held on another account constrains nothing here."""
    tl = _replayed([
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=100.0, account="PEA"),
    ])
    assert tl.holding_window("CTO", "AAPL", TODAY) is None
    assert tl.holding_window("PEA", "MSFT", TODAY) is None


def test_a_dividend_only_row_never_carried_a_quantity():
    """``None`` rather than a window of one day: nothing was ever held, so
    nothing about it can be waiting for a price."""
    tl = _replayed([
        Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple",
              amount=12.0, account="PEA"),
    ])
    assert tl.holding_window("PEA", "AAPL", TODAY) is None


def test_an_acquisition_dated_in_the_future_has_held_nothing_yet():
    """Issue #766, and the same answer as the dividend-only row above.

    Nothing refuses an event dated next year — ``events/validator.py`` weighs
    that refusal and declines it, because it judges the *whole stored ledger* on
    every build and a rule added there would stop the boot of every install
    already carrying such a row. So the window is what has to be truthful, and
    the truthful answer is that **as of ``today`` no day was held**: the position
    carries a quantity on no day between the ledger's first and this one.

    Written the other way — ``acquired, (today if holding else emptied)`` with no
    clamp — it answered ``(2027-05-03, 2026-08-12)``, a last day *before* its
    first. That is not a window, and every consumer had to recognise it
    downstream: :func:`performance.account_horizon` caught it in its empty-block
    guard, which is a catch and not an answer. #766 declines to leave it there.

    A clamp to ``(acquired, acquired)`` is the third exit and is refused: it
    asserts a day of holding that has not happened.
    """
    tl = _replayed([
        Event(date(2027, 5, 3), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=100.0, account="PEA"),
    ])
    assert tl.holding_window("PEA", "AAPL", TODAY) is None


def test_a_future_acquisition_after_a_real_one_does_not_move_the_window():
    """The clamp is on the window's **end**, never on the days already held.

    A line bought in 2024 and bought again on a date that has not arrived is
    held from 2024 through today — the future row adds nothing, and above all
    takes nothing away.
    """
    tl = _replayed([
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=100.0, account="PEA"),
        Event(date(2027, 5, 3), EventType.BUY, "AAPL", "Apple", quantity=5,
              unit_price=120.0, account="PEA"),
    ])
    assert tl.holding_window("PEA", "AAPL", TODAY) == (date(2024, 1, 15), TODAY)


def test_a_future_buy_back_does_not_make_a_sold_line_look_held():
    """The clamp's own defect, found by settling #766 rather than by looking.

    A line bought in 2020, sold in 2022, and bought again on a date that has not
    arrived: the scan ran to the end of the snapshots, saw the future
    acquisition standing, and answered ``(2020-03-02, today)`` — *held through
    today*, on a position the account has not owned for four years. What that
    costs is the horizon: the block of a symbol with no price ran to today
    instead of stopping at the exit, so it reached the ceiling, and the cap
    (#765) walked the series back past four years the account held none of it.
    """
    tl = _replayed([
        Event(date(2020, 3, 2), EventType.BUY, "ALO", "Alstom", quantity=10,
              unit_price=100.0, account="PEA"),
        Event(date(2022, 5, 4), EventType.SELL, "ALO", "Alstom", quantity=10,
              unit_price=120.0, account="PEA"),
        Event(date(2027, 9, 9), EventType.BUY, "ALO", "Alstom", quantity=4,
              unit_price=130.0, account="PEA"),
    ])
    assert tl.holding_window("PEA", "ALO", TODAY) == (date(2020, 3, 2),
                                                      date(2022, 5, 4))


def test_a_future_row_is_still_a_position_to_current_and_that_is_named():
    """The half of the future date #766 settles **on purpose** and does not move.

    ``holding_window``, ``at`` and ``cash_at`` are date-bounded and all three say
    nothing is held; :meth:`Timeline.current` and :meth:`Timeline.current_cash`
    answer *the last snapshot whatever its date* and both read the future row as
    now. The divergence is asserted here so it is a known state with an argument
    rather than something a later reader discovers on a screen.

    What it costs is real and bounded: ``positions.write_state`` lays down a
    ``position`` row from ``current()``, so ``/api/positions`` serves the line and
    the dashboard sums its latent gain, ``main._held_symbols`` arms a live scrape
    job, and the position gauges publish it — while ``account_metrics``, which
    values through ``position_at(day)``, excludes it. It is **not a regression**:
    that reading predates #766, and the perf horizon answered this case correctly
    before the settlement as well as after.

    It is left standing because widening the clamp to ``current`` answers a
    different question — *is a purchase recorded for next month a position?* —
    which has a legitimate *yes*, and answering *no* in passing would silently
    stop polling a line its owner deliberately recorded. #766 asks that the date
    stop being caught downstream, not what a planned trade is.
    """
    tl = _replayed([
        Event(date(2020, 1, 1), EventType.DEPOSIT, amount=10_000.0,
              account="PEA"),
        Event(date(2027, 5, 3), EventType.BUY, "LATER", "Later", quantity=5,
              unit_price=50.0, account="PEA"),
    ])

    # Date-bounded, and unanimous: nothing is held today.
    assert tl.holding_window("PEA", "LATER", TODAY) is None
    assert tl.at(TODAY) == []
    assert tl.cash_at("PEA", TODAY).cash_balance == 10_000.0

    # "The last snapshot, whatever its date" — and the two figures it moves.
    assert [(p['symbol'], p['quantity']) for p in tl.current()] == [
        ("LATER", 5.0)]
    assert tl.current_cash()["PEA"].cash_balance == 9_750.0
