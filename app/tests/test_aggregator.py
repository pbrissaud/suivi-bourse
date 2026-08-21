"""
Unit tests for events.aggregator.EventAggregator.

These tests build Event objects directly from events.schemas and exercise the
pure aggregation logic. No network, no InfluxDB, no filesystem: EventAggregator
is a pure function of its input list.

Since #699 a position is **one stock** — a ``quantity`` and a ``cost_basis``
stored as an amount — so what is asserted here is the amount, never a
reconstructed average: the unit price is derived and has exactly one
implementation (``events.schemas.unit_cost``).
"""

from datetime import date

import pytest

from events import EventAggregator
from events.schemas import Event, EventType, unit_cost
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

def test_single_buy_absorbs_its_fee_into_the_cost_basis(aggregator):
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5),
    ]

    result = aggregator.aggregate(events)

    assert len(result) == 1
    share = result[0]
    assert share["symbol"] == "AAPL"
    assert share["name"] == "Apple Inc"
    assert share["quantity"] == 10
    # The acquisition fee is *in* the basis, so it is also in the unit price.
    assert share["cost_basis"] == pytest.approx(1502.5)
    assert unit_cost(share["quantity"], share["cost_basis"]) == pytest.approx(150.25)
    assert share["realized_gain"] == 0.0
    assert share["received_dividend"] == 0.0


def test_single_buy_missing_fee_defaults_to_zero(aggregator):
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=4, unit_price=100.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == 4
    assert share["cost_basis"] == pytest.approx(400.0)


def test_a_position_carries_no_purchase_quantity_and_no_fee(aggregator):
    """Both names are gone — as state and as a key (#672 D2/D3)."""
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=4, unit_price=100.0, fee=1.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert set(share) == {'name', 'symbol', 'account', 'quantity', 'cost_basis',
                          'realized_gain', 'received_dividend'}


# ---------------------------------------------------------------------------
# aggregate(): two BUYs -> weighted average, derived
# ---------------------------------------------------------------------------

def test_two_buys_add_up_to_one_basis(aggregator):
    q1, p1, f1 = 10, 150.0, 2.5
    q2, p2, f2 = 5, 175.0, 2.0
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=q1, unit_price=p1, fee=f1),
        Event(date(2024, 6, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=q2, unit_price=p2, fee=f2),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == q1 + q2
    assert share["cost_basis"] == pytest.approx(q1 * p1 + f1 + q2 * p2 + f2)
    assert unit_cost(share["quantity"], share["cost_basis"]) == pytest.approx(
        (q1 * p1 + f1 + q2 * p2 + f2) / (q1 + q2))


# ---------------------------------------------------------------------------
# aggregate(): GRANT — the optional unit_price and its two tax cases (#672 D7)
# ---------------------------------------------------------------------------

def test_grant_without_a_price_is_dilution_and_costs_nothing(aggregator):
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5),
        Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
              quantity=3),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == 13
    assert share["cost_basis"] == pytest.approx(1502.5)


def test_grant_with_a_price_is_a_valued_award_and_enters_the_basis(aggregator):
    events = [
        Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
              quantity=10, unit_price=100.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == 10
    # Priced at 100 on the day: the latent gain is nil, not +1 000.
    assert share["cost_basis"] == pytest.approx(1000.0)


@pytest.mark.parametrize("price", [0.0, -999.0])
def test_a_grant_price_that_cannot_be_one_reads_as_dilution(aggregator, price):
    """Normalised where it is read, never refused — the column predates v5.

    The validator sees the **whole stored ledger** on every build, so refusing
    a value that was legal when it was imported would fail the boot on a store
    nobody can then reach to repair.
    """
    events = [
        Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
              quantity=10, unit_price=price),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == 10
    assert share["cost_basis"] == 0.0


def test_grant_flow_carries_the_declared_price(aggregator):
    from events import InKindFlow
    events = [
        Event(date(2024, 6, 1), EventType.GRANT, "AAPL", "Apple Inc",
              quantity=2, unit_price=50.0),
        Event(date(2024, 7, 1), EventType.GRANT, "MSFT", "Microsoft",
              quantity=4),
    ]

    tl = aggregator.replay(events)

    valued, diluted = tl.flows
    assert isinstance(valued, InKindFlow)
    assert (valued.date, valued.account, valued.symbol, valued.quantity,
            valued.unit_price) == (date(2024, 6, 1), "default", "AAPL", 2, 50.0)
    # Absent is the *other* case, not a hole to fill in from a quote later.
    assert diluted.unit_price is None


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

    assert share["received_dividend"] == pytest.approx(6.0)
    # A dividend is outside the profit-and-loss: nothing else moves.
    assert share["quantity"] == 10
    assert share["cost_basis"] == pytest.approx(1502.5)
    assert share["realized_gain"] == 0.0


def test_a_dividend_fee_is_absorbed_into_the_dividend(aggregator):
    """The fee comes off the named term, because it comes off the cash.

    A gross ``received_dividend`` beside a net cash balance puts the fee inside
    ``gain_absolu`` and inside none of ADR-0018's four terms — and the head
    *computes* the total from the four, so the two headline figures disagreed by
    exactly the withholding on the line. The fourth term cannot carry it: it is
    named for what a broker takes from a **transfer**, and ``store_reads`` sums
    it over ``DEPOSIT``/``WITHDRAWAL`` alone. So it is absorbed where its
    counterpart already goes, exactly as ADR-0003 absorbs an acquisition fee
    into the basis. The common case is a withholding tax typed into ``fee``.
    """
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5),
        Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple Inc",
              amount=20.0, fee=3.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["received_dividend"] == pytest.approx(17.0)
    # And nothing else moved: the fee is not an acquisition cost.
    assert share["cost_basis"] == pytest.approx(1502.5)
    assert share["realized_gain"] == 0.0


def test_a_grant_fee_is_debited_and_absorbed_into_the_basis(aggregator):
    """A grant is cash-neutral in its award, never in its fee.

    The validator accepts a `fee` on a `GRANT` row — unlike `symbol` on a cash
    event, which it refuses — the loader parses it, and it reached neither the
    cash, nor the basis, nor any of ADR-0018's four terms: the money simply did
    not exist anywhere in the product. It is an acquisition cost like a `BUY`'s,
    so ADR-0003 absorbs it into the basis, and the cash pays for it. That pairing
    is what keeps the identity closed — the cash falls by the fee and so does the
    latent gain — where crediting the basis alone would have moved one side only.
    """
    events = [
        Event(date(2024, 1, 15), EventType.DEPOSIT, amount=1000.0),
        Event(date(2024, 2, 1), EventType.GRANT, "AAPL", "Apple Inc",
              quantity=5, unit_price=10.0, fee=7.50),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == 5
    assert share["cost_basis"] == pytest.approx(57.50)


def test_a_grant_with_no_fee_stays_exactly_cash_neutral(aggregator):
    """The award itself moves no cash — the dilution case is unchanged."""
    events = [
        Event(date(2024, 2, 1), EventType.GRANT, "AAPL", "Apple Inc",
              quantity=5, unit_price=10.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["cost_basis"] == pytest.approx(50.0)


# ---------------------------------------------------------------------------
# aggregate(): SELL — a subtraction, and a realized gain
# ---------------------------------------------------------------------------

def test_sell_subtracts_the_basis_it_consumes_and_books_the_gain(aggregator):
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5),
        Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
              quantity=3, unit_price=190.0, fee=2.0),
    ]

    share = aggregator.aggregate(events)[0]

    unit = 1502.5 / 10
    assert share["quantity"] == 7
    # What is left is what the remaining shares cost: no average was rebuilt.
    assert share["cost_basis"] == pytest.approx(1502.5 - 3 * unit)
    assert unit_cost(share["quantity"], share["cost_basis"]) == pytest.approx(unit)
    # The disposal fee reduces the proceeds, so it lands inside the figure.
    assert share["realized_gain"] == pytest.approx(3 * 190.0 - 2.0 - 3 * unit)


def test_sell_more_than_owned_raises_aggregation_error(aggregator):
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=2, unit_price=150.0, fee=2.5),
        Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
              quantity=5, unit_price=190.0, fee=2.0),
    ]

    with pytest.raises(AggregationError):
        aggregator.aggregate(events)


def test_selling_everything_leaves_zero_invested_by_construction(aggregator):
    """The phantom −932 €: a sold line reporting its whole cost as a loss."""
    events = [
        Event(date(2021, 10, 5), EventType.BUY, "ALO", "Alstom",
              quantity=50, unit_price=18.50, fee=5.0),
        Event(date(2023, 3, 15), EventType.DIVIDEND, "ALO", "Alstom", amount=20.0),
        Event(date(2025, 4, 20), EventType.SELL, "ALO", "Alstom",
              quantity=50, unit_price=11.93, fee=2.39),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == 0.0
    assert share["cost_basis"] == 0.0
    assert unit_cost(share["quantity"], share["cost_basis"]) is None
    assert share["realized_gain"] == pytest.approx(-335.89)
    # The dividends stay their own figure, and never a positive "latent" gain.
    assert share["received_dividend"] == pytest.approx(20.0)


def test_a_position_sold_and_bought_back_comes_back_on_its_own(aggregator):
    """No flag was set, so nothing has to be unset (#672 D5)."""
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=5, unit_price=100.0),
        Event(date(2024, 3, 1), EventType.SELL, "AAPL", "Apple Inc",
              quantity=5, unit_price=120.0),
        Event(date(2024, 9, 1), EventType.BUY, "AAPL", "Apple Inc",
              quantity=2, unit_price=130.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == 2
    assert share["cost_basis"] == pytest.approx(260.0)
    # The gain booked while it was flat is kept — realized is permanent.
    assert share["realized_gain"] == pytest.approx(100.0)


def test_broker_dust_is_normalised_to_exact_zero(aggregator):
    """A real export: 0.348984 bought, 0.34898399999999996 sold (ADR-0017)."""
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "BTC", "Bitcoin",
              quantity=0.348984, unit_price=40000.0),
        Event(date(2024, 9, 15), EventType.SELL, "BTC", "Bitcoin",
              quantity=0.34898399999999996, unit_price=50000.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == 0.0
    assert share["cost_basis"] == 0.0


def test_broker_dust_the_other_way_round_does_not_refuse_the_file(aggregator):
    """The same file, the same last bit of a float, rounded the other way.

    A tolerance on the leftover and none on the guard would make the refusal a
    coin toss: this replay runs in the gunicorn master, so raising here takes
    the whole portfolio down over 4×10⁻¹⁷ of a share — and the ledger has no
    row-level edit to repair it with.
    """
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "BTC", "Bitcoin",
              quantity=0.348984, unit_price=40000.0),
        Event(date(2024, 9, 15), EventType.SELL, "BTC", "Bitcoin",
              quantity=0.34898400000000004, unit_price=50000.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == 0.0
    assert share["cost_basis"] == 0.0


def test_a_real_oversell_is_still_refused(aggregator):
    """The tolerance is the file's noise, never a licence to sell what is gone."""
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=2, unit_price=150.0),
        Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
              quantity=2.001, unit_price=190.0),
    ]

    with pytest.raises(AggregationError):
        aggregator.aggregate(events)


def test_a_genuinely_remaining_sliver_is_not_dust(aggregator):
    """The clamp is a threshold on the file's noise, not a rounding of holdings."""
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "BTC", "Bitcoin",
              quantity=1.0, unit_price=40000.0),
        Event(date(2024, 9, 15), EventType.SELL, "BTC", "Bitcoin",
              quantity=0.999999, unit_price=50000.0),
    ]

    share = aggregator.aggregate(events)[0]

    assert share["quantity"] == pytest.approx(1e-6)
    assert share["cost_basis"] == pytest.approx(0.04)


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
    # 10 @150 (+2,50) then a free share then 5 @175 (+2) = 16 shares for 2 379,50.
    basis_before_sale = 10 * 150.0 + 2.5 + 5 * 175.0 + 2.0
    unit = basis_before_sale / 16
    assert aapl["quantity"] == 13  # 10 + 1 grant + 5 − 3 sold
    assert aapl["cost_basis"] == pytest.approx(basis_before_sale - 3 * unit)
    assert aapl["realized_gain"] == pytest.approx(3 * 190.0 - 2.0 - 3 * unit)
    assert aapl["received_dividend"] == pytest.approx(2.40)

    msft = _find(result, "MSFT")
    assert msft["quantity"] == 5
    assert msft["cost_basis"] == pytest.approx(5 * 380.0 + 2.5)
    assert msft["realized_gain"] == 0.0
    assert msft["received_dividend"] == pytest.approx(5.0)


# ---------------------------------------------------------------------------
# replay() + Timeline.position_at() — point-in-time state (forward-fill)
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


def test_position_at_returns_none_when_no_matching_events(aggregator):
    tl = aggregator.replay(_timeline())
    # Symbol not present at all.
    assert tl.position_at("default", "TSLA", date(2024, 12, 31)) is None
    # Symbol present but every event is after the target date (empty, not error).
    assert tl.position_at("default", "AAPL", date(2024, 1, 1)) is None


def test_position_at_boundary_is_inclusive(aggregator):
    tl = aggregator.replay(_timeline())
    # target_date exactly equals the first AAPL event date -> that event counts.
    result = tl.position_at("default", "AAPL", date(2024, 1, 15))

    assert result is not None
    assert result["symbol"] == "AAPL"
    assert result["quantity"] == 10
    assert result["cost_basis"] == pytest.approx(1502.5)
    assert result["received_dividend"] == 0.0


def test_position_at_forward_fills_date_without_event(aggregator):
    tl = aggregator.replay(_timeline())

    # 2024-05-01 has no event: forward-fill from the 2024-03-01 dividend state,
    # after the first BUY but BEFORE the second AAPL BUY and the SELL.
    mid = tl.position_at("default", "AAPL", date(2024, 5, 1))
    assert mid is not None
    assert mid["quantity"] == 10
    assert mid["cost_basis"] == pytest.approx(1502.5)
    assert mid["received_dividend"] == pytest.approx(2.40)
    assert mid["realized_gain"] == 0.0

    # Final date: includes the second BUY and the SELL, so it must differ.
    basis_before_sale = 1502.5 + 5 * 175.0 + 2.0
    unit = basis_before_sale / 15
    final = tl.position_at("default", "AAPL", date(2024, 12, 31))
    assert final is not None
    assert final["quantity"] == 12  # 10 + 5 − 3
    assert final["cost_basis"] == pytest.approx(basis_before_sale - 3 * unit)
    assert final["realized_gain"] == pytest.approx(3 * 190.0 - 2.0 - 3 * unit)


def test_position_at_isolates_symbol(aggregator):
    tl = aggregator.replay(_timeline())
    # Only MSFT events should be considered; AAPL activity must not leak in.
    result = tl.position_at("default", "MSFT", date(2024, 12, 31))

    assert result is not None
    assert result["symbol"] == "MSFT"
    assert result["quantity"] == 5
    assert result["cost_basis"] == pytest.approx(5 * 380.0 + 2.5)


def test_replay_timeline_is_sparse(aggregator):
    """One snapshot per date the position changes, not per calendar day."""
    tl = aggregator.replay(_timeline())
    aapl_snaps = tl.snapshots[("default", "AAPL")]
    # AAPL changes on 4 dates: 01-15 BUY, 03-01 DIVIDEND, 06-15 BUY, 09-15 SELL.
    assert [d for d, _ in aapl_snaps] == [
        date(2024, 1, 15), date(2024, 3, 1), date(2024, 6, 15), date(2024, 9, 15)]
    assert len(tl.snapshots[("default", "MSFT")]) == 1


def test_replay_snapshots_are_immutable_copies(aggregator):
    """Later events must not mutate earlier snapshots (deep-copied)."""
    tl = aggregator.replay(_timeline())
    snaps = tl.snapshots[("default", "AAPL")]
    first_state = snaps[0][1]      # state as of 2024-01-15
    last_state = snaps[-1][1]      # state as of 2024-09-15
    assert first_state.quantity == 10
    assert last_state.quantity == 12
    assert first_state is not last_state


def test_aggregate_matches_timeline_current(aggregator):
    """Non-regression: aggregate() == replay().current() (same values/order)."""
    events = _timeline()
    assert aggregator.aggregate(events) == aggregator.replay(events).current()


def test_current_keeps_a_sold_position(aggregator):
    """The filter is on the scrape's symbol list, never on the timeline."""
    events = [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=5, unit_price=100.0),
        Event(date(2024, 3, 1), EventType.SELL, "AAPL", "Apple Inc",
              quantity=5, unit_price=120.0),
    ]

    current = aggregator.replay(events).current()

    assert [s["symbol"] for s in current] == ["AAPL"]
    assert current[0]["quantity"] == 0.0
    assert current[0]["realized_gain"] == pytest.approx(100.0)


def test_current_cash_is_the_latest_ledger_of_every_account(aggregator):
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, account="pea", amount=1000.0),
        Event(date(2024, 1, 2), EventType.DEPOSIT, account="cto", amount=500.0,
              fee=1.0),
        Event(date(2024, 2, 1), EventType.BUY, "AAPL", "Apple Inc", account="pea",
              quantity=2, unit_price=100.0, fee=1.0),
    ]

    cash = aggregator.replay(events).current_cash()

    assert set(cash) == {"pea", "cto"}
    assert cash["pea"].cash_balance == pytest.approx(799.0)
    assert cash["pea"].net_contributed == pytest.approx(1000.0)
    assert cash["cto"].cash_balance == pytest.approx(499.0)
    assert cash["cto"].net_contributed == pytest.approx(500.0)


def test_at_returns_all_positions_forward_filled(aggregator):
    tl = aggregator.replay(_timeline())

    # Before any event: empty portfolio, not an error.
    assert tl.at(date(2023, 12, 31)) == []

    # 2024-05-01: AAPL present (forward-filled from 03-01), MSFT present (02-01).
    mid = {s["symbol"]: s for s in tl.at(date(2024, 5, 1))}
    assert set(mid) == {"AAPL", "MSFT"}
    assert mid["AAPL"]["quantity"] == 10
    assert mid["MSFT"]["quantity"] == 5

    # 2024-01-20: only AAPL has appeared yet.
    early = tl.at(date(2024, 1, 20))
    assert [s["symbol"] for s in early] == ["AAPL"]
