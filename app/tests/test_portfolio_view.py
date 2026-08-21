"""Tests for the pure view aggregation (issue #659, rewritten by #700).

The second half of #655's testing criterion: the arithmetic on top of P1. Every
test here is literal row lists in, numbers out — no store, no pandas, no clock —
which is the property :mod:`portfolio_view` exists to have.

Three properties carry most of the weight, and each of them names a wrong figure
it prevents:

* the unit cost is a **derived weighted mean** (``Σ cost_basis / Σ quantity``),
  not a sum and not a plain mean, and both wrong answers look like prices;
* the latent gain is ``market_value − cost_basis`` and **carries neither
  dividends nor fees** — adding either counts it twice and rebuilds the
  composite #672 replaced by three named figures;
* **absence is not zero**, everywhere, because a `0,00 €` is a claim and a `—`
  is not.
"""
from datetime import date, datetime, timezone
from types import SimpleNamespace

from portfolio_view import (
    baseline_reference,
    build_accounts,
    build_movers,
    build_shares,
    session_baseline_instant,
    unit_cost,
    valuation_series,
)


def row(**overrides):
    """A P1 row with sane defaults, overridden per test.

    The shape ``store_reads.PortfolioReader.positions`` returns: the position's
    own columns joined to its symbol's newest observation. There is no account
    on the market half — a price belongs to none (#700).
    """
    base = {
        'symbol': 'AAPL',
        'name': 'Apple Inc',
        'account': 'default',
        'currency': 'USD',
        'exchange': 'NMS',
        'quote_type': 'EQUITY',
        'price_time': datetime(2024, 6, 1, tzinfo=timezone.utc),
        'price': 200.0,
        'quantity': 10.0,
        'cost_basis': 1500.0,
        'realized_gain': 0.0,
        'received_dividend': 0.0,
        'dividend_yield': 0.5,
        'pe_ratio': 30.0,
        'market_cap': 3.0e12,
    }
    base.update(overrides)
    return base


# --------------------------------------------------------------------- #
# The derived unit cost — the module's most load-bearing line
# --------------------------------------------------------------------- #

def test_unit_cost_is_quantity_weighted_not_averaged():
    """1 share at 100 and 9 at 200 cost 190 each.

    A plain sum says 300, a plain mean says 150. Both are plausible-looking
    prices, which is exactly why this earns a test: neither wrong answer looks
    wrong on screen. Storing the basis as an *amount* is what makes the weighted
    mean fall out of one division instead of being rebuilt.
    """
    share, = build_shares([
        row(account='pea', quantity=1.0, cost_basis=100.0),
        row(account='cto', quantity=9.0, cost_basis=1800.0),
    ])

    assert share.unit_cost == 190.0


def test_a_sold_position_has_no_unit_cost_rather_than_a_zero_one():
    """ADR-0003. Quantity zero, basis zero — the phantom −932 € has no
    expression left, and the unit price is honestly undefined."""
    share, = build_shares([row(quantity=0.0, cost_basis=0.0)])

    assert share.unit_cost is None
    assert unit_cost(0.0, 0.0) is None


# --------------------------------------------------------------------- #
# Folding per-account rows into a table row
# --------------------------------------------------------------------- #

def test_quantities_sum_across_accounts_and_the_breakdown_survives():
    """The breakdown P1 computes and every Grafana panel immediately sums away."""
    rows = [
        row(account='pea', quantity=10.0, cost_basis=1500.0),
        row(account='cto', quantity=5.0, cost_basis=900.0),
    ]
    share, = build_shares(rows)

    assert share.quantity == 15.0
    assert share.cost_basis == 2400.0
    assert [a.account for a in share.accounts] == ['cto', 'pea']
    # Each account keeps its own unit cost, derived from its own two figures.
    assert {a.account: a.unit_cost for a in share.accounts} == {
        'pea': 150.0, 'cto': 180.0}


def test_instrument_fields_are_never_summed_across_accounts():
    """Holding the same ETF in a PEA and a CTO does not double its market cap."""
    rows = [
        row(account='pea', market_cap=3.0e12, pe_ratio=30.0, dividend_yield=0.5),
        row(account='cto', market_cap=3.0e12, pe_ratio=30.0, dividend_yield=0.5),
    ]
    share, = build_shares(rows)

    assert share.market_cap == 3.0e12
    assert share.pe_ratio == 30.0
    assert share.dividend_yield == 0.5


def test_the_price_is_one_observation_whatever_the_accounts_say():
    """#700, seen from the reader. The join is on the symbol, so both rows carry
    the *same* market columns — there is no second observation to reconcile, and
    a rename in one account cannot move the price."""
    rows = [
        row(account='pea', name='Apple'),
        row(account='cto', name='Apple Inc.'),
    ]
    share, = build_shares(rows)

    assert share.symbol == 'AAPL'
    assert share.price == 200.0
    assert share.name in ('Apple', 'Apple Inc.')
    assert len(share.accounts) == 2


def test_latent_gain_is_market_value_minus_cost_basis_and_nothing_else():
    """Spec #695 § 8's first named figure. Dividends are the third figure and
    the acquisition fee is *inside* the basis since #699 — adding either here
    would count it twice and rebuild the composite that produced −932 €."""
    rows = [row(quantity=10.0, price=200.0, cost_basis=1502.5,
                received_dividend=8.0)]
    share, = build_shares(rows)

    assert share.market_value == 2000.0
    assert share.cost_basis == 1502.5
    assert share.plus_value_latente == 497.5
    assert share.received_dividend == 8.0
    assert share.unit_gain == 200.0 - 150.25


def test_a_sold_position_reports_zero_invested_by_construction():
    """#672's headline defect. Quantity 0 → basis 0 → nothing invested and a
    latent gain of exactly nothing, rather than minus everything ever paid."""
    share, = build_shares([row(quantity=0.0, cost_basis=0.0,
                               realized_gain=-335.89,
                               received_dividend=20.0)])

    assert share.cost_basis == 0.0
    assert share.market_value == 0.0
    assert share.plus_value_latente == 0.0
    assert share.realized_gain == -335.89


def test_percentage_is_none_rather_than_a_division_by_zero():
    share, = build_shares([row(quantity=0.0, cost_basis=0.0)])

    assert share.plus_value_pct is None
    assert share.unit_cost is None


def test_absent_price_leaves_derived_figures_absent_not_zero():
    """A position whose symbol has never been fetched — the LEFT join's row.

    Without a price there is no valuation, so there is no latent gain either.
    Composing this out of null-tolerant helpers made such a share report a loss
    of everything invested: the app announcing a total loss because it had never
    seen a quote.
    """
    share, = build_shares([row(price=None, price_time=None)])

    assert share.price is None
    assert share.market_value is None
    assert share.plus_value_latente is None
    assert share.unit_gain is None
    # The position's own figures are unaffected: they come from the replay.
    assert share.quantity == 10.0
    assert share.cost_basis == 1500.0


# --------------------------------------------------------------------- #
# The whole table
# --------------------------------------------------------------------- #

def test_build_shares_groups_by_symbol_and_sorts():
    rows = [
        row(symbol='MSFT', name='Microsoft'),
        row(symbol='AAPL', account='pea'),
        row(symbol='AAPL', account='cto'),
    ]
    shares = build_shares(rows)

    assert [s.symbol for s in shares] == ['AAPL', 'MSFT']
    assert len(shares[0].accounts) == 2


def test_an_empty_portfolio_is_an_empty_list():
    """Not an error, and not a None — #655's empty-collection state."""
    assert build_shares([]) == []


def test_to_dict_emits_iso_timestamps_and_keeps_nulls():
    share, = build_shares([row(pe_ratio=None)])
    payload = share.to_dict()

    assert payload['price_time'] == '2024-06-01T00:00:00+00:00'
    assert payload['pe_ratio'] is None
    # #659 reserved a `status` slot here for the pills; #656 decision 6 retired
    # it rather than filling it, and the assertion is inverted rather than
    # deleted because the *absence* is the decision. The shares resource answers
    # 503 when the store fails, so a pill riding on this payload would disappear
    # exactly when it is the only thing able to explain the empty table. The
    # pills live on `/api/runtime`, which reads no store at all.
    assert 'status' not in payload


# --------------------------------------------------------------------- #
# The main chart's degraded half
#
# The join #700 made explicit: the day's closes come from the price series,
# the day's holdings from the replay. They used to be the same row.
# --------------------------------------------------------------------- #

def close(day, symbol='AAPL', price=100.0):
    return {'day': date(2024, 6, day), 'symbol': symbol, 'price': price}


def holding(symbol='AAPL', account='default', quantity=10.0, cost_basis=900.0):
    return {'symbol': symbol, 'account': account,
            'quantity': quantity, 'cost_basis': cost_basis}


def test_valuation_sums_the_days_closing_state_across_positions():
    series = valuation_series(
        [close(1, 'AAPL', 100.0), close(1, 'MSFT', 400.0)],
        lambda day: [holding('AAPL', quantity=10.0, cost_basis=900.0),
                     holding('MSFT', quantity=5.0, cost_basis=1900.0)])

    assert series == [{
        't': '2024-06-01',
        'value': 3000.0,     # 1000 + 2000
        'invested': 2800.0,  # 900 + 1900
    }]


def test_a_symbol_missing_a_day_is_carried_forward_not_dropped():
    """The defect this function exists to prevent: MSFT's exchange is shut on
    the 2nd, so it has no close. Dropping it would show the whole portfolio
    losing 2000 € and getting it back on the 3rd — a valuation curve that is
    really a map of exchange holidays.
    """
    series = valuation_series(
        [close(1, 'AAPL', 100.0), close(1, 'MSFT', 400.0),
         close(2, 'AAPL', 110.0),
         close(3, 'AAPL', 120.0), close(3, 'MSFT', 410.0)],
        lambda day: [holding('AAPL', quantity=10.0),
                     holding('MSFT', quantity=5.0)])

    assert [point['value'] for point in series] == [3000.0, 3100.0, 3250.0]


def test_a_position_contributes_nothing_before_it_is_held():
    """The holdings come from the replay, which knows when a position starts.

    A share bought on the 2nd must not inflate the 1st — and that is now a
    property of the *ledger* rather than of when a price happened to be written.
    """
    def held(day):
        if day == date(2024, 6, 1):
            return [holding('AAPL', quantity=10.0)]
        return [holding('AAPL', quantity=10.0), holding('MSFT', quantity=5.0)]

    series = valuation_series(
        [close(1, 'AAPL', 100.0),
         close(2, 'AAPL', 100.0), close(2, 'MSFT', 400.0)],
        held)

    assert [point['value'] for point in series] == [1000.0, 3000.0]


def test_the_same_symbol_in_two_accounts_is_two_holdings_at_one_price():
    """The account dimension lives on the holding and no longer on the price:
    one close, two positions, and the sum is the whole portfolio."""
    series = valuation_series(
        [close(1, 'AAPL', 100.0)],
        lambda day: [holding('AAPL', account='pea', quantity=10.0),
                     holding('AAPL', account='cto', quantity=4.0)])

    assert series[0]['value'] == 1400.0


def test_a_holding_with_no_close_yet_contributes_nothing_to_the_value():
    """The crater #706 is about, left standing here on purpose.

    The carrying convention has **two** terms — no price *and* a terminal
    backfill — and the second does not exist yet. Inventing it now would draw a
    portfolio flat-at-cost through a whole reconstruction and then correct
    itself, which is the misreading that ticket exists to prevent.
    """
    series = valuation_series(
        [close(1, 'AAPL', 100.0)],
        lambda day: [holding('AAPL', quantity=10.0, cost_basis=900.0),
                     holding('NEW', quantity=5.0, cost_basis=500.0)])

    assert series[0]['value'] == 1000.0
    assert series[0]['invested'] == 1400.0


def test_a_price_from_before_the_window_is_carried_into_it():
    """The two terms have to be bounded the same way.

    The holdings come from the replay, which knows nothing of the window; the
    prices come from a read that is bounded by it. Without the carry-in, a
    symbol whose last close predates ``from`` counts its whole cost in
    ``invested`` and nothing in ``value`` — the curve reporting a loss of that
    position's entire worth for as long as the window's left edge sits after
    its last quote.
    """
    series = valuation_series(
        [close(2, 'AAPL', 110.0)],
        lambda day: [holding('AAPL', quantity=10.0, cost_basis=900.0),
                     holding('OLD', quantity=5.0, cost_basis=400.0)],
        carried_in={'OLD': 80.0})

    assert series[0]['value'] == 10.0 * 110.0 + 5.0 * 80.0
    assert series[0]['invested'] == 1300.0


def test_a_carried_in_price_is_superseded_by_a_close_inside_the_window():
    series = valuation_series(
        [close(1, 'AAPL', 100.0), close(2, 'AAPL', 110.0)],
        lambda day: [holding('AAPL', quantity=10.0)],
        carried_in={'AAPL': 80.0})

    assert [point['value'] for point in series] == [1000.0, 1100.0]


def test_an_empty_window_is_an_empty_series():
    assert valuation_series([], lambda day: []) == []


# --------------------------------------------------------------------- #
# Movers
# --------------------------------------------------------------------- #

def test_the_session_baseline_is_midnight_of_the_newest_observations_day():
    """#652 déc. 8's trap. Read this as: on a Sunday the block still shows
    Friday's session, because the anchor is the newest *observation* and not the
    clock. Anchoring on midnight-today would make every weekend read zero.
    """
    friday_close = datetime(2026, 7, 31, 21, 0, tzinfo=timezone.utc)

    assert session_baseline_instant(friday_close) == datetime(
        2026, 7, 31, tzinfo=timezone.utc)


def test_the_reference_close_is_an_observed_price_not_the_midnight_cut():
    """Found by looking at the page.

    Labelling the block with `session_baseline_instant` read « depuis la clôture
    du 5 août 2026 » on the *afternoon* of 5 August — announcing a close that
    had not happened. The cut is the rule; the newest row at or before it is the
    session the comparison actually rests on, and it is already in the payload.
    """
    rows = [
        {'symbol': 'AAPL', 'price': 100.0,
         't': datetime(2026, 8, 4, 20, 0, tzinfo=timezone.utc)},
        {'symbol': 'AIR.PA', 'price': 200.0,
         't': datetime(2026, 8, 4, 15, 30, tzinfo=timezone.utc)},
    ]
    assert baseline_reference(rows) == datetime(
        2026, 8, 4, 20, 0, tzinfo=timezone.utc)


def test_the_reference_close_is_absent_when_nothing_precedes_the_cut():
    assert baseline_reference([]) is None
    assert baseline_reference([{'symbol': 'AAPL', 'price': 1.0}]) is None


def test_movers_rank_by_percentage_and_report_what_the_move_was_worth():
    shares = build_shares([
        row(symbol='AAPL', price=110.0, quantity=10.0),
        row(symbol='MSFT', name='Microsoft', price=380.0, quantity=5.0),
    ])
    movers = build_movers(shares, [
        {'symbol': 'AAPL', 'price': 100.0},
        {'symbol': 'MSFT', 'price': 400.0},
    ])

    assert [m.symbol for m in movers] == ['AAPL', 'MSFT']
    assert movers[0].change_pct == 0.1
    assert movers[0].contribution == 100.0     # +10 € × 10 shares
    assert movers[1].change == -20.0
    assert movers[1].contribution == -100.0


def test_a_market_that_has_not_opened_today_reports_zero_not_absence():
    """Its last point *is* the baseline point, so the change is a real zero —
    the share has genuinely not traded since its close."""
    shares = build_shares([row(symbol='AAPL', price=100.0)])
    movers = build_movers(shares, [{'symbol': 'AAPL', 'price': 100.0}])

    assert movers[0].change == 0.0
    assert movers[0].change_pct == 0.0


def test_a_share_with_no_baseline_is_left_out_rather_than_shown_flat():
    """Its first day. It has not failed to move — there is nothing to compare
    against, and a zero in a movers list is a claim."""
    shares = build_shares([
        row(symbol='AAPL', price=110.0),
        row(symbol='NEW', name='Fresh', price=50.0),
    ])
    movers = build_movers(shares, [{'symbol': 'AAPL', 'price': 100.0}])

    assert [m.symbol for m in movers] == ['AAPL']


def test_a_sold_position_is_left_out_rather_than_shown_flat():
    """The same rule as the one above, on the population that slipped past it.

    A position at zero quantity is no longer polled, so its stored quote is
    frozen at the day it stopped being one — it therefore *equals* its own
    baseline, the `change is None` guard lets it through, and it lands in the
    list at exactly zero. Seven of them on the real portfolio, on a block whose
    entire subject is movement. The page filtered them out again on its side, so
    nothing showed; the rule was written on the server and applied on the
    client, and a second consumer saw all seven.
    """
    shares = build_shares([
        row(symbol='AAPL', price=110.0, quantity=10.0),
        row(symbol='GONE', name='Sold long ago', price=50.0, quantity=0.0),
    ])
    movers = build_movers(shares, [
        {'symbol': 'AAPL', 'price': 100.0},
        {'symbol': 'GONE', 'price': 50.0},
    ])

    assert [m.symbol for m in movers] == ['AAPL']


def test_a_share_whose_price_was_never_observed_is_left_out_too():
    shares = build_shares([row(symbol='AAPL', price=None)])
    movers = build_movers(shares, [{'symbol': 'AAPL', 'price': 100.0}])

    assert movers == []


def test_a_mover_carries_no_currency_of_its_own():
    """#702: every amount on the block is in the reporting currency.

    The row used to state the security's quote currency, which is what let the
    block survive the mixed-currency mode the head refused. There is no such
    mode and no such mixture: `price` is converted, so `change` and
    `contribution` are too, and a column repeating one identical code down the
    block is a fact about the block.
    """
    shares = build_shares([
        row(symbol='AAPL', currency='USD', price=110.0),
        row(symbol='AIR.PA', name='Airbus', currency='EUR', price=180.0),
    ])
    movers = build_movers(shares, [
        {'symbol': 'AAPL', 'price': 100.0},
        {'symbol': 'AIR.PA', 'price': 200.0},
    ])

    assert movers and all('currency' not in m.to_dict() for m in movers)


# --------------------------------------------------------------------- #
# The accounts comparison table (issue #661)
# --------------------------------------------------------------------- #

def declared(id='pea', label='PEA Bourso', type='PEA'):
    """A declared account — the shape `Portfolio.accounts` holds.

    No `currency`: `Account.currency` is deleted (#702, ADR-0002).
    """
    return SimpleNamespace(id=id, label=label, type=type)


def metrics(account='pea', **overrides):
    base = {
        'account': account,
        'day': date(2026, 8, 5),
        'cash_balance': 500.0,
        'holdings_value': 12000.0,
        'total_value': 12500.0,
        'net_contributed': 10000.0,
        'xirr': 0.12,
        'gain_absolu': 2500.0,
        'twr_index': 118.4,
    }
    base.update(overrides)
    return base


def test_accounts_keep_their_declaration_order():
    """The store's `ORDER BY id`, stable across restarts and across a re-drop —
    and the table sorts on demand anyway."""
    summaries = build_accounts(
        [declared('cto', 'CTO Degiro', 'CTO'), declared('pea')],
        [metrics('pea'), metrics('cto')])

    assert [s.id for s in summaries] == ['cto', 'pea']


def test_a_declared_account_with_no_series_is_a_row_of_absences():
    """Declared but not yet computed. #652 déc. 4 makes the declaration the
    list, so no data cannot remove a row — it empties one."""
    summaries = build_accounts([declared('pea'), declared('cto', 'CTO', 'CTO')],
                               [metrics('pea')])

    assert summaries[1].as_of is None
    assert summaries[1].total_value is None
    assert summaries[1].xirr is None
    # The identity fields still come from the declaration.
    assert (summaries[1].label, summaries[1].type) == ('CTO', 'CTO')


def test_a_series_without_a_declaration_is_not_a_row():
    """Historical residue: an account since removed from the declaration."""
    summaries = build_accounts([declared('pea')], [metrics('pea'), metrics('old')])

    assert [s.id for s in summaries] == ['pea']


def test_the_identity_fields_come_from_the_declaration_alone():
    """Since #700 the series has no column for them at all: `account_type` and
    `account_currency` were InfluxDB *tags*, recording what the account was when
    the point was written. The declaration is what it is — and since #702 it
    declares no currency at all, so the row does not carry one."""
    summaries = build_accounts([declared('pea')], [metrics('pea')])

    assert 'currency' not in summaries[0].to_dict()
    assert summaries[0].type == 'PEA'
    assert summaries[0].as_of == date(2026, 8, 5)
    assert summaries[0].to_dict()['as_of'] == '2026-08-05'


def test_nothing_is_summed_across_accounts():
    """The consolidated figures have exactly one source (`portfolio_totals`),
    and a second arithmetic path to the same number is how two of them come to
    disagree — besides being plain wrong across currencies."""
    summaries = build_accounts(
        [declared('pea'), declared('cto', 'CTO', 'CTO')],
        [metrics('pea', total_value=12500.0), metrics('cto', total_value=3000.0)])

    assert [s.total_value for s in summaries] == [12500.0, 3000.0]
    payload = summaries[0].to_dict()
    assert 'portfolio_total' not in payload and 'share_pct' not in payload
