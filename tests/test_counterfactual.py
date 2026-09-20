"""The replay of #760: the same money, in one fund instead.

Every test here is about a branch whose failure is **silent**. The replay
produces a number in euros whatever happens to it — a split it cannot see, a
withdrawal it cannot fund, a day it cannot convert all leave a plausible figure
standing beside the real portfolio's, and nothing on the screen says which of
the two is wrong.
"""

from datetime import date

import pytest

from application import counterfactual


def _days(first: str, last: str, price: float) -> dict:
    """A flat quoted series over ``[first, last]`` — weekends and all."""
    day = date.fromisoformat(first)
    end = date.fromisoformat(last)
    series = {}
    while day <= end:
        series[day] = price
        day += counterfactual.ONE_DAY
    return series


def _window(first: str, last: str):
    return date.fromisoformat(first), date.fromisoformat(last)


# --------------------------------------------------------------------------- #
# The seed
# --------------------------------------------------------------------------- #

def test_the_money_goes_in_on_the_window_s_first_day_and_buys_at_its_price():
    """The plainest shape: a thousand euros, a fund at twenty, nothing after."""
    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'),
        _days('2024-01-01', '2024-01-31', 20.0), {}, {}, 1000.0)

    assert result.units == pytest.approx(50.0)
    assert result.cost_basis == pytest.approx(1000.0)
    assert result.value == pytest.approx(1000.0)
    assert result.first_day == date(2024, 1, 1)
    assert result.last_day == date(2024, 1, 31)
    assert result.ended is None


def test_the_seed_waits_for_the_first_quoted_day_and_takes_the_flows_with_it():
    """The window opens on a Saturday, which is the ordinary case.

    The account's first written day is a calendar day — `perf_job` writes one
    per day — and the fund's first quoted day is a trading day. A contribution
    landing in between is money the real portfolio has and the reference must
    not lose, so it goes in with the seed rather than being skipped.
    """
    prices = {date(2024, 1, 3): 20.0, date(2024, 1, 4): 20.0}

    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-04'), prices, {},
        {date(2024, 1, 1): 999.0,    # the seed's own day: already inside it
         date(2024, 1, 2): 500.0},   # before the first quote: carried in
        1000.0)

    assert result.first_day == date(2024, 1, 3)
    assert result.cost_basis == pytest.approx(1500.0)
    assert result.units == pytest.approx(75.0)


def test_a_reference_never_quoted_in_the_window_never_started():
    """Not an early end — a comparison with nothing to compare against."""
    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'), {}, {}, {}, 1000.0)

    assert result.ended == counterfactual.NEVER_QUOTED
    assert (result.units, result.value, result.first_day) == (0.0, 0.0, None)


# --------------------------------------------------------------------------- #
# Splits — the critical gap
# --------------------------------------------------------------------------- #

def test_a_split_mid_history_does_not_move_the_head_figure():
    """A four-for-one, and the holding is worth exactly what it was.

    #988 stores the close of the split day in the **new** share, so the units
    have to be in the new share to meet it. This is the whole reason `#760`
    made the ratios worth persisting: the price alone no longer carries them.
    """
    prices = _days('2024-01-01', '2024-01-31', 500.0)
    for day in _days('2024-01-16', '2024-01-31', 0.0):
        prices[day] = 125.0

    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'), prices,
        {date(2024, 1, 16): 4.0}, {}, 1000.0)

    assert result.units == pytest.approx(8.0)      # 2 shares, then 8
    assert result.value == pytest.approx(1000.0)


def test_a_split_the_replay_cannot_see_divides_the_holding_by_the_ratio():
    """The defect, stated as a test so nobody has to take it on trust.

    The same series with an empty split history: the price drops to a quarter
    and the units stay put, so the reference loses three quarters of its value
    on a day nothing happened. No error, no warning — a number 75 % too low,
    beside a real portfolio that is right.
    """
    prices = _days('2024-01-01', '2024-01-31', 500.0)
    for day in _days('2024-01-16', '2024-01-31', 0.0):
        prices[day] = 125.0

    blind = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'), prices, {}, {}, 1000.0)

    assert blind.value == pytest.approx(250.0)
    assert blind.ended is None


def test_the_split_of_the_seed_s_own_day_is_not_applied_twice():
    """The seed buys at the day's close, which already stands in the new share."""
    result = counterfactual.replay(
        _window('2024-01-16', '2024-01-31'),
        _days('2024-01-16', '2024-01-31', 125.0),
        {date(2024, 1, 16): 4.0}, {}, 1000.0)

    assert result.units == pytest.approx(8.0)
    assert result.value == pytest.approx(1000.0)


# --------------------------------------------------------------------------- #
# Flows, and the exhaustion — the other critical gap
# --------------------------------------------------------------------------- #

def test_a_contribution_buys_at_the_day_s_price_and_adds_to_the_basis():
    prices = _days('2024-01-01', '2024-01-31', 20.0)
    for day in _days('2024-01-10', '2024-01-31', 0.0):
        prices[day] = 40.0

    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'), prices, {},
        {date(2024, 1, 10): 400.0}, 1000.0)

    assert result.units == pytest.approx(60.0)     # 50, then 10 more at 40
    assert result.cost_basis == pytest.approx(1400.0)
    assert result.value == pytest.approx(2400.0)
    assert result.latent_gain == pytest.approx(1000.0)


def test_a_withdrawal_takes_its_share_of_the_cost_basis_with_it():
    """Average cost: half the units out takes half of what was paid for them.

    The basis left is what the tax is projected on, so a withdrawal that took
    none of it would leave the whole purchase price against a half position and
    understate the gain for the rest of the replay.
    """
    prices = _days('2024-01-01', '2024-01-31', 20.0)
    for day in _days('2024-01-10', '2024-01-31', 0.0):
        prices[day] = 40.0

    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'), prices, {},
        {date(2024, 1, 10): -1000.0}, 1000.0)

    assert result.units == pytest.approx(25.0)     # 50 held, 25 sold at 40
    assert result.cost_basis == pytest.approx(500.0)
    assert result.value == pytest.approx(1000.0)
    assert result.ended is None


def test_a_withdrawal_the_reference_could_not_have_funded_ends_the_period():
    """The PME / Long-Nickels defect, named and stopped.

    The ledger's withdrawal happened — the real portfolio had the money. The
    reference, having fallen, does not. Selling anyway takes the units negative,
    and a negative holding compounds into a figure that still looks like an
    answer. The comparison ends on that day instead.
    """
    prices = _days('2024-01-01', '2024-01-31', 20.0)
    for day in _days('2024-01-10', '2024-01-31', 0.0):
        prices[day] = 2.0

    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'), prices, {},
        {date(2024, 1, 10): -500.0}, 1000.0)

    assert result.ended == counterfactual.EXHAUSTED
    assert result.last_day == date(2024, 1, 10)
    assert result.units == pytest.approx(50.0)     # untouched: the sale did not happen
    assert result.value == pytest.approx(100.0)


def test_a_withdrawal_on_the_window_s_first_day_ends_it_there():
    """The gap that would otherwise ship as a blank chart beside a head of 0.

    Nothing about a window's first day protects it: an account whose reference
    is seeded small and whose first move is a large withdrawal exhausts it
    immediately, and the period is one day long.
    """
    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'),
        _days('2024-01-01', '2024-01-31', 20.0), {},
        {date(2024, 1, 2): -5000.0}, 1000.0)

    assert result.ended == counterfactual.EXHAUSTED
    assert result.first_day == date(2024, 1, 1)
    assert result.last_day == date(2024, 1, 2)


def test_a_withdrawal_of_exactly_what_is_there_is_funded_and_leaves_nothing():
    """The boundary is inclusive: the reference could fund it, to the cent."""
    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'),
        _days('2024-01-01', '2024-01-31', 20.0), {},
        {date(2024, 1, 10): -1000.0}, 1000.0)

    assert result.ended is None
    assert result.units == pytest.approx(0.0)
    assert result.cost_basis == pytest.approx(0.0)


def test_an_opening_position_of_nothing_never_starts():
    """A seed cancelled out by what flowed before the first quote."""
    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'),
        {date(2024, 1, 3): 20.0}, {},
        {date(2024, 1, 2): -1000.0}, 1000.0)

    assert result.ended == counterfactual.EXHAUSTED
    assert result.units == 0.0


# --------------------------------------------------------------------------- #
# A day with no price: closed market, or no rate
# --------------------------------------------------------------------------- #

def test_a_closed_market_carries_yesterday_s_price_and_changes_nothing():
    """A weekend is not an event. A contribution on one buys at Friday's close."""
    prices = {date(2024, 1, 5): 20.0, date(2024, 1, 8): 25.0}

    result = counterfactual.replay(
        _window('2024-01-05', '2024-01-08'), prices, {},
        {date(2024, 1, 6): 200.0}, 1000.0)

    assert result.units == pytest.approx(60.0)     # 50, then 10 at Friday's 20
    assert result.value == pytest.approx(1500.0)
    assert result.ended is None


def test_a_day_whose_close_has_no_rate_ends_the_period_the_evening_before():
    """Missing FX is not a closed market, and must not be replayed as one.

    Carrying yesterday's *converted* price across a day whose rate is simply
    absent prices the holding at a rate nobody quoted. The period stops instead,
    and the caption on the screen reads the computed period rather than the
    fund's.
    """
    prices = _days('2024-01-01', '2024-01-31', 20.0)
    del prices[date(2024, 1, 10)]

    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'), prices, {},
        {}, 1000.0, unconverted=[date(2024, 1, 10)])

    assert result.ended == counterfactual.AWAITING_RATE
    assert result.last_day == date(2024, 1, 9)
    assert result.value == pytest.approx(1000.0)


def test_a_missing_rate_on_the_first_day_leaves_the_comparison_unstarted():
    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'),
        {date(2024, 1, 2): 20.0}, {}, {}, 1000.0,
        unconverted=[date(2024, 1, 1)])

    assert result.ended == counterfactual.AWAITING_RATE
    assert result.first_day is None
    assert result.units == 0.0


def test_the_split_of_a_day_with_no_rate_is_not_applied_before_stopping():
    """The stop comes first, so the units are the ones the last priced day left.

    Applied the other way round the holding would be multiplied by the ratio and
    then valued at the pre-split price, which is the ratio-sized spike this
    module exists to keep out.
    """
    prices = _days('2024-01-01', '2024-01-31', 500.0)
    del prices[date(2024, 1, 16)]

    result = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'), prices,
        {date(2024, 1, 16): 4.0}, {}, 1000.0,
        unconverted=[date(2024, 1, 16)])

    assert result.ended == counterfactual.AWAITING_RATE
    assert result.units == pytest.approx(2.0)
    assert result.value == pytest.approx(1000.0)


# --------------------------------------------------------------------------- #
# The curve
# --------------------------------------------------------------------------- #

def test_the_series_carries_every_calendar_day_of_the_covered_period():
    """One point per calendar day, not per quoted day.

    The chart reads the area between the two curves as the gap, and the
    portfolio's own curve is written one row per day by `perf_job`. A reference
    that skipped weekends would put the two on different day axes and draw that
    area wrong — the shape wrong, which is worse than one value wrong.
    """
    prices = {date(2024, 1, 5): 20.0, date(2024, 1, 8): 25.0}

    result = counterfactual.replay(
        _window('2024-01-05', '2024-01-08'), prices, {}, {}, 1000.0)

    assert [day for day, _ in result.series] == [
        date(2024, 1, 5), date(2024, 1, 6), date(2024, 1, 7), date(2024, 1, 8)]
    assert [round(value) for _, value in result.series] == [
        1000, 1000, 1000, 1250]


def test_a_period_that_ended_early_draws_no_day_past_its_end():
    """The curve stops where the period stops, both ways it can stop."""
    prices = _days('2024-01-01', '2024-01-31', 20.0)
    del prices[date(2024, 1, 10)]

    stopped = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'), prices, {}, {}, 1000.0,
        unconverted=[date(2024, 1, 10)])
    emptied = counterfactual.replay(
        _window('2024-01-01', '2024-01-31'),
        _days('2024-01-01', '2024-01-31', 20.0), {},
        {date(2024, 1, 10): -5000.0}, 1000.0)

    assert stopped.series[-1][0] == stopped.last_day == date(2024, 1, 9)
    assert emptied.series[-1][0] == emptied.last_day == date(2024, 1, 10)


def test_a_comparison_that_never_started_draws_nothing():
    assert counterfactual.replay(
        _window('2024-01-01', '2024-01-31'), {}, {}, {}, 1000.0).series == []
