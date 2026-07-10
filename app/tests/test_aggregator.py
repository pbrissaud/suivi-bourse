"""
Unit tests for events.aggregator.EventAggregator.

These tests build Event objects directly from events.schemas and exercise the
pure aggregation logic. No network, no InfluxDB, no filesystem: EventAggregator
is a pure function of its input list.
"""

from datetime import date

import pytest

from events import EventAggregator
from events.schemas import Event, EventType
from events.aggregator import AggregationError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find(shares, symbol):
    """Return the aggregated dict for `symbol` from a to_dict() list."""
    for s in shares:
        if s["symbol"] == symbol:
            return s
    raise AssertionError(f"symbol {symbol!r} not found in {shares!r}")


@pytest.fixture
def aggregator():
    return EventAggregator()


# ---------------------------------------------------------------------------
# aggregate(): single BUY
# ---------------------------------------------------------------------------

def test_single_buy_sets_purchase_estate_costprice_and_fee(aggregator):
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5),
    ]

    result = aggregator.aggregate(events)

    assert len(result) == 1
    share = result[0]
    assert share["symbol"] == "AAPL"
    assert share["name"] == "Apple Inc"
    # A single BUY: cost_price equals the unit_price paid.
    assert share["purchase"]["quantity"] == 10
    assert share["purchase"]["cost_price"] == 150.0
    assert share["purchase"]["fee"] == 2.5
    # Estate quantity mirrors the purchased quantity; no dividends yet.
    assert share["estate"]["quantity"] == 10
    assert share["estate"]["received_dividend"] == 0.0


def test_single_buy_missing_fee_defaults_to_zero(aggregator):
    # fee is Optional; _process_buy does `fee = event.fee or 0.0`.
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=4, unit_price=100.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["purchase"]["fee"] == 0.0
    assert share["purchase"]["quantity"] == 4
    assert share["purchase"]["cost_price"] == 100.0


# ---------------------------------------------------------------------------
# aggregate(): two BUYs -> weighted average
# ---------------------------------------------------------------------------

def test_two_buys_weighted_average_cost_and_summed_fees(aggregator):
    q1, p1, f1 = 10, 150.0, 2.5
    q2, p2, f2 = 5, 175.0, 2.0
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=q1, unit_price=p1, fee=f1),
        Event(date(2024, 6, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=q2, unit_price=p2, fee=f2),
    ]

    share = aggregator.aggregate(events)[0]

    expected_cost = (q1 * p1 + q2 * p2) / (q1 + q2)
    assert share["purchase"]["quantity"] == q1 + q2
    assert share["purchase"]["cost_price"] == pytest.approx(expected_cost)
    # Fees are summed across the two buys.
    assert share["purchase"]["fee"] == pytest.approx(f1 + f2)
    # Estate quantity reflects both purchases.
    assert share["estate"]["quantity"] == q1 + q2


# ---------------------------------------------------------------------------
# aggregate(): GRANT
# ---------------------------------------------------------------------------

def test_grant_increases_only_estate_quantity(aggregator):
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5),
        Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
              quantity=3),
    ]

    share = aggregator.aggregate(events)[0]

    # Estate quantity grows by the grant.
    assert share["estate"]["quantity"] == 13
    # Purchase side is untouched by a grant.
    assert share["purchase"]["quantity"] == 10
    assert share["purchase"]["cost_price"] == 150.0
    assert share["purchase"]["fee"] == 2.5


# ---------------------------------------------------------------------------
# aggregate(): DIVIDEND
# ---------------------------------------------------------------------------

def test_dividend_increases_only_received_dividend(aggregator):
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5),
        Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple Inc",
              amount=2.40),
        Event(date(2024, 9, 1), EventType.DIVIDEND, "AAPL", "Apple Inc",
              amount=3.60),
    ]

    share = aggregator.aggregate(events)[0]

    # Dividends accumulate.
    assert share["estate"]["received_dividend"] == pytest.approx(6.0)
    # Nothing else moves.
    assert share["estate"]["quantity"] == 10
    assert share["purchase"]["quantity"] == 10
    assert share["purchase"]["cost_price"] == 150.0
    assert share["purchase"]["fee"] == 2.5


# ---------------------------------------------------------------------------
# aggregate(): SELL
# ---------------------------------------------------------------------------

def test_sell_decreases_estate_and_adds_fee_but_keeps_purchase(aggregator):
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5),
        Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
              quantity=3, unit_price=190.0, fee=2.0),
    ]

    share = aggregator.aggregate(events)[0]

    # Estate quantity drops by the sold amount.
    assert share["estate"]["quantity"] == 7
    # Sell fee is added to the accumulated purchase fee.
    assert share["purchase"]["fee"] == pytest.approx(4.5)
    # Purchase quantity and cost_price are NOT changed by a sell.
    assert share["purchase"]["quantity"] == 10
    assert share["purchase"]["cost_price"] == 150.0


def test_sell_more_than_owned_raises_aggregation_error(aggregator):
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=2, unit_price=150.0, fee=2.5),
        Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
              quantity=5, unit_price=190.0, fee=2.0),
    ]

    with pytest.raises(AggregationError):
        aggregator.aggregate(events)


def test_sell_exactly_owned_is_allowed(aggregator):
    # Boundary: selling exactly what is owned must NOT raise (uses `>` not `>=`).
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=5, unit_price=150.0, fee=2.5),
        Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
              quantity=5, unit_price=190.0, fee=2.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["estate"]["quantity"] == 0
    assert share["purchase"]["quantity"] == 5
    assert share["purchase"]["cost_price"] == 150.0


# ---------------------------------------------------------------------------
# aggregate(): multi-symbol ordering and name resolution
# ---------------------------------------------------------------------------

def test_symbol_order_preserves_first_appearance(aggregator):
    # First appearances: MSFT, then AAPL, then GOOG. Later events for existing
    # symbols must NOT reorder the output.
    events = [
        Event(date(2024, 1, 1), EventType.BUY, "MSFT", "Microsoft",
              quantity=1, unit_price=380.0, fee=1.0),
        Event(date(2024, 1, 2), EventType.BUY, "AAPL", "Apple Inc",
              quantity=1, unit_price=150.0, fee=1.0),
        Event(date(2024, 1, 3), EventType.BUY, "GOOG", "Alphabet",
              quantity=1, unit_price=140.0, fee=1.0),
        Event(date(2024, 2, 1), EventType.BUY, "MSFT", "Microsoft",
              quantity=1, unit_price=390.0, fee=1.0),
        Event(date(2024, 2, 2), EventType.BUY, "AAPL", "Apple Inc",
              quantity=1, unit_price=160.0, fee=1.0),
    ]

    result = aggregator.aggregate(events)

    symbols = [s["symbol"] for s in result]
    assert symbols == ["MSFT", "AAPL", "GOOG"]


def test_latest_non_empty_name_wins(aggregator):
    # The name from a later event overrides an earlier one; an empty name is
    # ignored (falsy) and must not clobber the previously stored name.
    events = [
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple",
              quantity=1, unit_price=150.0, fee=1.0),
        Event(date(2024, 2, 1), EventType.DIVIDEND, "AAPL", "",
              amount=1.0),
        Event(date(2024, 3, 1), EventType.BUY, "AAPL", "Apple Inc.",
              quantity=1, unit_price=160.0, fee=1.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["name"] == "Apple Inc."


def test_empty_name_does_not_overwrite_existing(aggregator):
    events = [
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple Inc",
              quantity=1, unit_price=150.0, fee=1.0),
        Event(date(2024, 2, 1), EventType.DIVIDEND, "AAPL", "",
              amount=1.0),
    ]

    share = aggregator.aggregate(events)[0]

    # The falsy empty name from the dividend event is ignored.
    assert share["name"] == "Apple Inc"


def test_empty_events_returns_empty_list(aggregator):
    assert aggregator.aggregate([]) == []


def test_full_pipeline_matches_expected_state(aggregator):
    # A complete scenario mirroring the conftest sample data (AAPL then MSFT).
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5),
        Event(date(2024, 2, 1), EventType.BUY, "MSFT", "Microsoft",
              quantity=5, unit_price=380.0, fee=2.5),
        Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple Inc",
              amount=2.40),
        Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
              quantity=1),
        Event(date(2024, 6, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=5, unit_price=175.0, fee=2.0),
        Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
              quantity=3, unit_price=190.0, fee=2.0),
        Event(date(2025, 1, 30), EventType.DIVIDEND, "MSFT", "Microsoft",
              amount=5.0),
    ]

    result = aggregator.aggregate(events)

    assert [s["symbol"] for s in result] == ["AAPL", "MSFT"]

    aapl = _find(result, "AAPL")
    # Purchases: 10 @150 then 5 @175 -> qty 15, weighted cost.
    assert aapl["purchase"]["quantity"] == 15
    assert aapl["purchase"]["cost_price"] == pytest.approx(
        (10 * 150.0 + 5 * 175.0) / 15)
    # Fees: 2.5 (buy) + 2.0 (buy) + 2.0 (sell) = 6.5.
    assert aapl["purchase"]["fee"] == pytest.approx(6.5)
    # Estate: +10 buy, +1 grant, +5 buy, -3 sell = 13.
    assert aapl["estate"]["quantity"] == 13
    assert aapl["estate"]["received_dividend"] == pytest.approx(2.40)

    msft = _find(result, "MSFT")
    assert msft["purchase"]["quantity"] == 5
    assert msft["purchase"]["cost_price"] == 380.0
    assert msft["purchase"]["fee"] == 2.5
    assert msft["estate"]["quantity"] == 5
    assert msft["estate"]["received_dividend"] == pytest.approx(5.0)


# ---------------------------------------------------------------------------
# aggregate_until_date()
# ---------------------------------------------------------------------------

def _timeline():
    return [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5),
        Event(date(2024, 2, 1), EventType.BUY, "MSFT", "Microsoft",
              quantity=5, unit_price=380.0, fee=2.5),
        Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple Inc",
              amount=2.40),
        Event(date(2024, 6, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=5, unit_price=175.0, fee=2.0),
        Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
              quantity=3, unit_price=190.0, fee=2.0),
    ]


def test_until_date_returns_none_when_no_matching_events(aggregator):
    # Symbol not present at all.
    assert aggregator.aggregate_until_date(_timeline(), date(2024, 12, 31), "TSLA") is None
    # Symbol present but every event is after the target date.
    assert aggregator.aggregate_until_date(_timeline(), date(2024, 1, 1), "AAPL") is None


def test_until_date_boundary_is_inclusive(aggregator):
    # target_date exactly equals the first AAPL event date -> that event counts.
    result = aggregator.aggregate_until_date(_timeline(), date(2024, 1, 15), "AAPL")

    assert result is not None
    assert result["symbol"] == "AAPL"
    assert result["purchase"]["quantity"] == 10
    assert result["estate"]["quantity"] == 10
    assert result["purchase"]["cost_price"] == 150.0
    assert result["estate"]["received_dividend"] == 0.0


def test_until_date_intermediate_state_differs_from_final(aggregator):
    events = _timeline()

    # Intermediate date: after the first BUY + dividend, but BEFORE the second
    # AAPL BUY (2024-06-15) and BEFORE the SELL (2024-09-15).
    mid = aggregator.aggregate_until_date(events, date(2024, 5, 1), "AAPL")
    assert mid is not None
    assert mid["purchase"]["quantity"] == 10
    assert mid["purchase"]["cost_price"] == 150.0
    assert mid["purchase"]["fee"] == 2.5
    assert mid["estate"]["quantity"] == 10
    assert mid["estate"]["received_dividend"] == pytest.approx(2.40)

    # Final date: includes the second BUY and the SELL, so it must differ.
    final = aggregator.aggregate_until_date(events, date(2024, 12, 31), "AAPL")
    assert final is not None
    assert final["purchase"]["quantity"] == 15
    assert final["purchase"]["cost_price"] == pytest.approx(
        (10 * 150.0 + 5 * 175.0) / 15)
    assert final["purchase"]["fee"] == pytest.approx(6.5)  # 2.5 + 2.0 + 2.0
    assert final["estate"]["quantity"] == 12  # 10 + 5 - 3

    # Sanity: the intermediate state is genuinely different from the final.
    assert mid["purchase"]["quantity"] != final["purchase"]["quantity"]
    assert mid["purchase"]["cost_price"] != final["purchase"]["cost_price"]


def test_until_date_filters_by_symbol(aggregator):
    # Only MSFT events should be considered; AAPL activity must not leak in.
    result = aggregator.aggregate_until_date(_timeline(), date(2024, 12, 31), "MSFT")

    assert result is not None
    assert result["symbol"] == "MSFT"
    assert result["purchase"]["quantity"] == 5
    assert result["purchase"]["cost_price"] == 380.0
    assert result["estate"]["quantity"] == 5
