"""The investment rhythm (issue #751, ADR-0041).

A **pure** module, so these tests are pure too: a list of events and an instant
in, four numbers out. There is no store here and nothing is faked — the seam the
suite fakes is yfinance, and this module has no edge at all. What the route and
the tool make of these figures is asserted where they live, over a real store.

The instant is fixed at 20 September 2026, so the twelve months the measure
answers for are October 2025 through September 2026 and every fixture below can
be read against that window by eye. The month of ``now`` is the one month a
fixture can reach into the future without leaving the window, and the days after
the 20th are what those fixtures use.
"""
from datetime import date, datetime, timezone

from application import rhythm
from application.events.schemas import Event, EventType


NOW = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)


def buy(day, amount, *, account=None, symbol='AAPL', fee=None):
    """One purchase worth ``amount``, written as a unit at that price.

    Quantity one and the whole amount on the unit price, so a fixture reads as
    the money it is about; the arithmetic over quantity is asserted on its own
    where the fee is.
    """
    return Event(day, EventType.BUY, symbol, 'A share',
                 quantity=1, unit_price=amount, fee=fee, account=account)


def months(count, amount, *, start=date(2025, 10, 15), account=None,
           symbol='AAPL'):
    """``count`` consecutive monthly purchases from ``start``, all the same size."""
    return [buy(_step(start, offset), amount, account=account, symbol=symbol)
            for offset in range(count)]


def _step(day, offset):
    """``day`` moved ``offset`` whole months forward, keeping the day-of-month."""
    index = day.year * 12 + (day.month - 1) + offset
    return date(index // 12, index % 12 + 1, day.day)


# --------------------------------------------------------------------- #
# The amount and its coverage — the pair that never travels alone
# --------------------------------------------------------------------- #

def test_a_purchase_every_month_is_that_amount_over_the_whole_window():
    """Twelve months of 500 € is 500 €, twelve of twelve."""
    figures = rhythm.measure(months(12, 500.0), NOW).portfolio

    assert figures.monthly_amount == 500.0
    assert figures.months_covered == 12
    assert figures.months_observed == 12
    # Twelve identical amounts do not vary, and that is a figure rather than an
    # absence: the reader learns the amount is held steady.
    assert figures.dispersion == 0.0


def test_half_a_year_of_purchases_is_the_amount_and_not_its_average():
    """500 € in six months of twelve is **500**, six of twelve.

    Not 250 — the mean over the window, and the median over it too, half its
    months being empty. The figure is the amount of the months that carried a
    purchase, and the coverage beside it is what keeps it from being read as a
    yearly total.
    """
    figures = rhythm.measure(months(6, 500.0), NOW).portfolio

    assert figures.monthly_amount == 500.0
    assert figures.months_covered == 6
    assert figures.months_observed == 12


def test_the_median_is_not_dragged_by_one_exceptional_month():
    """A bonus month sets no projection. Eleven at 500, one at 6 000."""
    events = months(11, 500.0) + [buy(date(2026, 9, 15), 6000.0)]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.monthly_amount == 500.0
    assert figures.months_covered == 12
    # And the exception is not lost: it is what the dispersion is about.
    assert figures.dispersion > 1.0


def test_the_dispersion_is_a_coefficient_of_variation():
    """Two months at 400 and 600: a mean of 500 and a spread of 100."""
    events = [buy(date(2026, 8, 10), 400.0), buy(date(2026, 9, 10), 600.0)]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.monthly_amount == 500.0
    assert figures.dispersion == 0.2


def test_several_purchases_in_one_month_are_that_month_once():
    """A month is a month, whatever it took to fill it."""
    events = [buy(date(2026, 9, 3), 200.0), buy(date(2026, 9, 20), 300.0)]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.monthly_amount == 500.0
    assert figures.months_covered == 1


def test_two_symbols_in_alternating_months_are_one_rhythm():
    """An ETF in one month and bitcoin in the next is one habit, not two.

    The grain is the portfolio (ADR-0041): per symbol these are two rhythms
    covering one month each, which is the reading the record refuses.
    """
    events = [buy(date(2026, 8, 10), 500.0, symbol='ETF'),
              buy(date(2026, 9, 10), 500.0, symbol='BTC-EUR')]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.monthly_amount == 500.0
    assert figures.months_covered == 2


# --------------------------------------------------------------------- #
# What counts as a purchase, and what a purchase is worth
# --------------------------------------------------------------------- #

def test_a_purchase_is_worth_its_quantity_its_price_and_its_fee():
    """``quantity × unit_price + fee`` — the amount that left the pocket."""
    events = [Event(date(2026, 9, 15), EventType.BUY, 'AAPL', 'Apple Inc',
                    quantity=10, unit_price=150.0, fee=2.5)]

    assert rhythm.measure(events, NOW).portfolio.monthly_amount == 1502.5


def test_only_the_buys_are_a_rhythm():
    """Deposits, grants and dividends are not purchases, and none is counted.

    A twelve-month-old ledger of nothing but those three reports **no** monthly
    amount and **no** dispersion, over twelve observed months — never a zero,
    which would read as *bought nothing* where the truth is *there is no figure*.
    """
    events = [
        Event(date(2025, 10, 1), EventType.DEPOSIT, amount=1000.0),
        Event(date(2026, 3, 1), EventType.GRANT, 'AAPL', 'Apple Inc',
              quantity=5, unit_price=180.0),
        Event(date(2026, 6, 1), EventType.DIVIDEND, 'AAPL', 'Apple Inc',
              amount=12.0),
    ]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.monthly_amount is None
    assert figures.dispersion is None
    assert figures.months_covered == 0
    assert figures.months_observed == 12


def test_a_sale_is_not_subtracted_from_the_month_that_holds_it():
    """Selling and rebuying leaves the month at the buy's full value.

    The named limitation of ADR-0041, asserted rather than merely written: an
    arbitrage inflates the rhythm, and it does so **upwards** — no figure this
    module publishes is ever negative.
    """
    events = [
        Event(date(2026, 9, 5), EventType.SELL, 'AAPL', 'Apple Inc',
              quantity=10, unit_price=200.0, fee=1.0),
        buy(date(2026, 9, 6), 500.0, symbol='MSFT'),
    ]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.monthly_amount == 500.0
    assert figures.months_covered == 1


# --------------------------------------------------------------------- #
# The window — twelve months, bounded by the age of the ledger
# --------------------------------------------------------------------- #

def test_a_young_ledger_answers_for_the_months_it_has_lived():
    """A first event four months ago is four observed months, not twelve."""
    events = months(4, 500.0, start=date(2026, 6, 15))

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.months_observed == 4
    assert figures.months_covered == 4


def test_the_age_is_counted_from_the_first_event_of_any_kind():
    """A deposit opens the observation, and a later first buy does not.

    Otherwise the months before the first purchase would be erased from the
    denominator, and an owner who funded an account in June and bought in
    September would read as having bought in every month observed.
    """
    events = [Event(date(2026, 6, 1), EventType.DEPOSIT, amount=5000.0),
              buy(date(2026, 9, 15), 500.0)]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.months_observed == 4
    assert figures.months_covered == 1


def test_an_old_ledger_that_stopped_buying_reports_the_stop():
    """Five years old, last bought nine months ago: twelve observed, three covered.

    The nine silent months are **uncovered**, not unobserved — which is the
    whole reason the age is counted from the first event rather than the first
    buy, and precisely the thing a reader wants to see.
    """
    events = (months(3, 500.0, start=date(2021, 9, 15))
              + months(3, 500.0, start=date(2025, 10, 15)))

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.months_observed == 12
    assert figures.months_covered == 3


def test_purchases_older_than_the_window_are_outside_it():
    """A rhythm two years ago is not this year's rhythm."""
    events = months(12, 900.0, start=date(2023, 1, 15)) + [
        buy(date(2026, 9, 15), 500.0)]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.monthly_amount == 500.0
    assert figures.months_covered == 1
    assert figures.months_observed == 12


def test_the_window_is_the_twelve_calendar_months_ending_in_the_month_of_now():
    """October 2025 through September 2026, and the day before is outside.

    The edges rather than the middle: a buy on 30 September 2025 falls in the
    thirteenth month back and is counted nowhere, one on 1 October 2025 opens
    the window, and one on the day of ``now`` closes it. The window is made of
    whole calendar months, so the first of them is included entire even though
    the ledger is thirteen months old.
    """
    events = [buy(date(2025, 9, 30), 900.0),
              buy(date(2025, 10, 1), 500.0),
              buy(date(2026, 9, 20), 500.0)]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.months_observed == 12
    assert figures.months_covered == 2
    assert figures.monthly_amount == 500.0


def test_an_empty_ledger_has_observed_nothing():
    """Zero of zero, and two nulls — never zero of twelve.

    Nothing has been observed here, where a portfolio that held off buying for
    a year has observed twelve months of not buying. The two are different
    statements and the denominator is what tells them apart.
    """
    figures = rhythm.measure([], NOW).portfolio

    assert figures.monthly_amount is None
    assert figures.dispersion is None
    assert figures.months_covered == 0
    assert figures.months_observed == 0


def test_a_ledger_dated_entirely_in_the_future_has_observed_nothing():
    """The same answer, and for the same reason: there is nothing behind us."""
    events = [buy(date(2026, 11, 15), 500.0)]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.months_observed == 0
    assert figures.months_covered == 0
    assert figures.monthly_amount is None


def test_a_purchase_dated_later_this_month_has_not_happened_yet():
    """A buy on the 25th is no rhythm on the 20th.

    The month of ``now`` is inside the window, so a row dated ahead inside it
    is the one future row the month index cannot catch — only the instant tells
    them apart. Counted, it would publish planned money as money already spent,
    and it would carry its month into the coverage besides.
    """
    events = [buy(date(2026, 8, 10), 500.0), buy(date(2026, 9, 25), 5000.0)]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.monthly_amount == 500.0
    assert figures.months_covered == 1
    assert figures.months_observed == 2


def test_the_future_is_cut_at_every_grain():
    """The portfolio and each account stop at the same instant.

    An account whose every row is still ahead has observed nothing — and it is
    still in the breakdown, a coverage of zero being a statement rather than an
    absence.
    """
    events = [buy(date(2026, 7, 10), 300.0, account='pea'),
              buy(date(2026, 9, 25), 9000.0, account='pea'),
              buy(date(2026, 9, 28), 9000.0, account='cto')]

    measured = rhythm.measure(events, NOW)
    accounts = dict(measured.accounts)

    assert measured.portfolio.monthly_amount == 300.0
    assert accounts['pea'].monthly_amount == 300.0
    assert accounts['pea'].months_covered == 1
    assert accounts['cto'].monthly_amount is None
    assert accounts['cto'].months_observed == 0


def test_an_undated_row_is_in_no_month():
    """A draft with no day cannot be placed, and it is not counted anywhere."""
    events = [buy(date(2026, 9, 15), 500.0),
              Event(None, EventType.BUY, 'AAPL', 'Apple Inc',
                    quantity=1, unit_price=9999.0)]

    figures = rhythm.measure(events, NOW).portfolio

    assert figures.monthly_amount == 500.0
    assert figures.months_covered == 1


# --------------------------------------------------------------------- #
# The breakdown — by account, and never by symbol
# --------------------------------------------------------------------- #

def test_the_breakdown_splits_the_same_events_by_account():
    """The accounts sum what the headline sums, each on its own events."""
    events = (months(12, 300.0, account='pea')
              + months(6, 200.0, account='cto', start=date(2026, 4, 15)))

    measured = rhythm.measure(events, NOW)

    assert measured.portfolio.months_covered == 12
    # The two accounts overlap for six months, so the portfolio's own months are
    # worth 300 or 500 and its median sits between them.
    assert measured.portfolio.monthly_amount == 400.0
    assert dict(measured.accounts).keys() == {'cto', 'pea'}
    assert dict(measured.accounts)['pea'].monthly_amount == 300.0
    assert dict(measured.accounts)['pea'].months_covered == 12
    assert dict(measured.accounts)['cto'].monthly_amount == 200.0
    assert dict(measured.accounts)['cto'].months_covered == 6


def test_an_event_naming_no_account_is_the_default_one():
    """The aggregator's own resolution, applied here too."""
    measured = rhythm.measure(months(3, 500.0), NOW)

    assert [account for account, _ in measured.accounts] == ['default']
    assert dict(measured.accounts)['default'].monthly_amount == 500.0


def test_an_account_answers_for_its_own_age():
    """An account opened four months into an old ledger observes four months.

    The rule of the headline, applied at the finer grain: an account is not made
    to answer for the months before it existed.
    """
    events = (months(12, 300.0, account='pea', start=date(2020, 1, 15))
              + months(12, 300.0, account='pea', start=date(2025, 10, 15))
              + [buy(date(2026, 8, 15), 200.0, account='cto')])

    accounts = dict(rhythm.measure(events, NOW).accounts)

    assert accounts['pea'].months_observed == 12
    assert accounts['cto'].months_observed == 2
    assert accounts['cto'].months_covered == 1


def test_an_account_that_bought_nothing_is_still_in_the_breakdown():
    """A coverage of zero is a statement about the rhythm, not a missing row."""
    events = months(3, 500.0, account='pea') + [
        Event(date(2026, 1, 5), EventType.DEPOSIT, amount=1000.0,
              account='cto')]

    accounts = dict(rhythm.measure(events, NOW).accounts)

    assert accounts['cto'].months_covered == 0
    assert accounts['cto'].monthly_amount is None
    assert accounts['cto'].months_observed == 9


def test_the_accounts_come_out_in_a_stable_order():
    """Sorted by id, never by amount: a list that reshuffles is unreadable."""
    events = (months(2, 100.0, account='pea')
              + months(2, 900.0, account='cto')
              + months(2, 500.0, account='av'))

    measured = rhythm.measure(events, NOW)

    assert [account for account, _ in measured.accounts] == ['av', 'cto', 'pea']


# --------------------------------------------------------------------- #
# The payload
# --------------------------------------------------------------------- #

def test_the_payload_carries_the_amount_and_the_coverage_together():
    """The four members, and the breakdown as a list of the same four."""
    payload = rhythm.measure(months(3, 500.0, account='pea'), NOW).to_dict()

    assert payload == {
        'monthly_amount': 500.0,
        'months_covered': 3,
        'months_observed': 12,
        'dispersion': 0.0,
        'accounts': [{
            'account': 'pea',
            'monthly_amount': 500.0,
            'months_covered': 3,
            'months_observed': 12,
            'dispersion': 0.0,
        }],
    }
