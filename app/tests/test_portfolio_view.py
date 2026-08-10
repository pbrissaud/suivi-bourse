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
    MODE_ACCOUNTS,
    MODE_MULTI_CURRENCY,
    MODE_TITRES,
    baseline_reference,
    build_accounts,
    build_movers,
    build_share,
    build_shares,
    build_titres_head,
    build_totals_head,
    portfolio_mode,
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
    share = build_share([
        row(account='pea', quantity=1.0, cost_basis=100.0),
        row(account='cto', quantity=9.0, cost_basis=1800.0),
    ], 'AAPL')

    assert share.unit_cost == 190.0


def test_a_sold_position_has_no_unit_cost_rather_than_a_zero_one():
    """ADR-0003. Quantity zero, basis zero — the phantom −932 € has no
    expression left, and the unit price is honestly undefined."""
    share = build_share([row(quantity=0.0, cost_basis=0.0)], 'AAPL')

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
    share = build_share(rows, 'AAPL')

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
    share = build_share(rows, 'AAPL')

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
    share = build_share(rows, 'AAPL')

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
    share = build_share(rows, 'AAPL')

    assert share.market_value == 2000.0
    assert share.cost_basis == 1502.5
    assert share.plus_value_latente == 497.5
    assert share.received_dividend == 8.0
    assert share.unit_gain == 200.0 - 150.25


def test_a_sold_position_reports_zero_invested_by_construction():
    """#672's headline defect. Quantity 0 → basis 0 → nothing invested and a
    latent gain of exactly nothing, rather than minus everything ever paid."""
    share = build_share([row(quantity=0.0, cost_basis=0.0, realized_gain=-335.89,
                             received_dividend=20.0)], 'AAPL')

    assert share.cost_basis == 0.0
    assert share.market_value == 0.0
    assert share.plus_value_latente == 0.0
    assert share.realized_gain == -335.89


def test_percentage_is_none_rather_than_a_division_by_zero():
    share = build_share([row(quantity=0.0, cost_basis=0.0)], 'AAPL')

    assert share.plus_value_pct is None
    assert share.unit_cost is None


def test_absent_price_leaves_derived_figures_absent_not_zero():
    """A position whose symbol has never been fetched — the LEFT join's row.

    Without a price there is no valuation, so there is no latent gain either.
    Composing this out of null-tolerant helpers made such a share report a loss
    of everything invested: the app announcing a total loss because it had never
    seen a quote.
    """
    share = build_share([row(price=None, price_time=None)], 'AAPL')

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


def test_build_share_returns_none_for_an_unknown_symbol():
    assert build_share([row()], 'NOPE') is None


def test_to_dict_emits_iso_timestamps_and_keeps_nulls():
    share = build_share([row(pe_ratio=None)], 'AAPL')
    payload = share.to_dict()

    assert payload['price_time'] == '2024-06-01T00:00:00+00:00'
    assert payload['pe_ratio'] is None
    # #659 reserved a `status` slot here for the pills; #656 decision 6 retired
    # it rather than filling it, and the assertion is inverted rather than
    # deleted because the *absence* is the decision. `/api/shares` answers 503
    # when the store fails, so a pill riding on this payload would disappear
    # exactly when it is the only thing able to explain the empty table. The
    # pills live on `/api/runtime`, which reads no store at all.
    assert 'status' not in payload


# ===================================================================== #
# The consolidated dashboard (issue #660)
#
# #660's testing criterion names the degraded-mode selection explicitly, and
# it earns it: the mode decides which of #652 déc. 6's two incompatible terms
# the head is even allowed to speak.
# ===================================================================== #

def test_no_declared_accounts_is_the_titres_mode():
    """The default install. A designed mode, not a missing configuration."""
    assert portfolio_mode(None) == MODE_TITRES
    assert portfolio_mode([]) == MODE_TITRES


def test_one_currency_across_declared_accounts_is_the_accounts_mode():
    assert portfolio_mode(['EUR', 'EUR']) == MODE_ACCOUNTS


def test_mixed_currencies_are_their_own_mode_not_an_empty_head():
    """`portfolio_totals` is not written for a mixed portfolio at all, so the
    figures are absent by construction. Stating the condition is #655 déc. 8's
    third case — the slot, without the product answer."""
    assert portfolio_mode(['EUR', 'USD']) == MODE_MULTI_CURRENCY


def test_the_mode_is_read_from_the_configuration_not_from_the_data():
    """Declared accounts with an empty series stay in `accounts` mode.

    The two states #655 déc. 8 refuses to collapse: "no declared accounts" is a
    mode, "the perf job has not run yet" is that mode with nothing in it. Here
    the head is all nulls and still says `accounts`.
    """
    head = build_totals_head(None, 'EUR')

    assert head['mode'] == MODE_ACCOUNTS
    assert head['as_of'] is None
    assert head['gain_absolu'] is None
    assert head['total_value'] is None


def test_the_accounts_head_carries_gain_in_euros_and_two_rates():
    """#652 déc. 5: `gain_absolu` € is the headline, xirr and twr_index answer
    two different questions beside it. Grafana's fourth, wrong percentage is
    deleted rather than ported, so there is no field for it to land in."""
    head = build_totals_head({
        'day': date(2026, 8, 5),
        'total_value': 12500.0,
        'cash_balance': 500.0,
        'holdings_value': 12000.0,
        'net_contributed': 10000.0,
        'gain_absolu': 2500.0,
        'xirr': 0.12,
        'twr_index': 124.0,
    }, 'EUR')

    assert head['gain_absolu'] == 2500.0
    assert head['net_contributed'] == 10000.0
    assert head['xirr'] == 0.12
    assert head['currency'] == 'EUR'
    # A **day**, not an instant: the two kinds of time never mix, and this
    # series is stamped with the calendar day it describes (#700).
    assert head['as_of'] == '2026-08-05'
    assert 'plus_value_latente' not in head


def test_a_rate_that_was_never_computable_is_simply_absent():
    """xirr needs an external flow; a portfolio with none has no annualized
    rate. In the store the column exists and reads `NULL`, which is why naming
    it in a SELECT is safe again — `None`, never zero."""
    head = build_totals_head({'total_value': 100.0}, 'EUR')

    assert head['xirr'] is None
    assert head['gain_absolu'] is None


def test_the_relative_delta_is_absent_unless_a_baseline_was_asked_for():
    assert build_totals_head({'total_value': 100.0}, 'EUR')['baseline'] is None


def test_the_relative_delta_compares_against_the_baseline_instant():
    since = datetime(2026, 7, 5, tzinfo=timezone.utc)
    head = build_totals_head({'total_value': 11000.0}, 'EUR', since, 10000.0)

    assert head['baseline'] == {
        'since': '2026-07-05T00:00:00+00:00',
        'total_value': 10000.0,
        'change': 1000.0,
        'change_pct': 0.1,
    }


def test_a_baseline_before_the_portfolio_existed_is_absent_not_a_total_gain():
    """Nothing stored that early means the portfolio did not exist, and calling
    that a gain of its entire value is trap 3 in its most flattering form."""
    since = datetime(2019, 1, 1, tzinfo=timezone.utc)
    baseline = build_totals_head({'total_value': 11000.0}, 'EUR', since)['baseline']

    assert baseline['total_value'] is None
    assert baseline['change'] is None
    assert baseline['change_pct'] is None


def test_the_titres_head_speaks_plus_value_latente_and_never_gain():
    """The two terms of #652 déc. 6 must not share a field. This head has no
    `gain_absolu` to read, so conflating them is impossible rather than unlikely."""
    shares = build_shares([
        row(symbol='AAPL', quantity=10.0, price=200.0, cost_basis=1500.0,
            received_dividend=8.0),
        row(symbol='MSFT', name='Microsoft', quantity=5.0,
            price=400.0, cost_basis=1900.0, received_dividend=0.0),
    ])
    head = build_titres_head(shares)

    assert head['mode'] == MODE_TITRES
    assert head['holdings_value'] == 4000.0        # 2000 + 2000
    assert head['cost_basis'] == 3400.0            # 1500 + 1900
    assert head['plus_value_latente'] == 600.0     # 4000 − 3400
    # The other two named figures ride beside it rather than inside it.
    assert head['received_dividend'] == 8.0
    assert head['realized_gain'] == 0.0
    assert 'gain_absolu' not in head
    assert head['baseline'] is None


def test_the_titres_head_drops_the_currency_when_the_portfolio_mixes_them():
    """Trap 14 — rendering a mixed total as euros is what the baseline does by
    hardcoding `currencyEUR`. A bare number is the honest fallback."""
    shares = build_shares([
        row(symbol='AAPL', currency='USD'),
        row(symbol='AIR.PA', name='Airbus', currency='EUR'),
    ])
    assert build_titres_head(shares)['currency'] is None
    assert build_titres_head(build_shares([row()]))['currency'] == 'USD'


def test_an_empty_titres_portfolio_is_all_absent_rather_than_zero():
    head = build_titres_head([])

    assert head['holdings_value'] is None
    assert head['plus_value_latente'] is None
    assert head['as_of'] is None


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


def test_a_share_whose_price_was_never_observed_is_left_out_too():
    shares = build_shares([row(symbol='AAPL', price=None)])
    movers = build_movers(shares, [{'symbol': 'AAPL', 'price': 100.0}])

    assert movers == []


def test_each_mover_carries_its_own_currency():
    """Which is what lets the block survive the multi-currency mode the head
    refuses: a percentage carries no currency, and the amounts state theirs."""
    shares = build_shares([
        row(symbol='AAPL', currency='USD', price=110.0),
        row(symbol='AIR.PA', name='Airbus', currency='EUR', price=180.0),
    ])
    movers = build_movers(shares, [
        {'symbol': 'AAPL', 'price': 100.0},
        {'symbol': 'AIR.PA', 'price': 200.0},
    ])

    assert {m.symbol: m.currency for m in movers} == {
        'AAPL': 'USD', 'AIR.PA': 'EUR'}


# --------------------------------------------------------------------- #
# The accounts comparison table (issue #661)
# --------------------------------------------------------------------- #

def declared(id='pea', label='PEA Bourso', type='PEA', currency='EUR'):
    """A declared account — the shape `Portfolio.accounts` holds."""
    return SimpleNamespace(id=id, label=label, type=type, currency=currency)


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
    assert (summaries[1].label, summaries[1].currency) == ('CTO', 'EUR')


def test_a_series_without_a_declaration_is_not_a_row():
    """Historical residue: an account since removed from the declaration."""
    summaries = build_accounts([declared('pea')], [metrics('pea'), metrics('old')])

    assert [s.id for s in summaries] == ['pea']


def test_the_identity_fields_come_from_the_declaration_alone():
    """Since #700 the series has no column for them at all: `account_type` and
    `account_currency` were InfluxDB *tags*, recording what the account was when
    the point was written. The declaration is what it is."""
    summaries = build_accounts([declared('pea', currency='EUR')],
                               [metrics('pea')])

    assert summaries[0].currency == 'EUR'
    assert summaries[0].type == 'PEA'
    assert summaries[0].as_of == date(2026, 8, 5)
    assert summaries[0].to_dict()['as_of'] == '2026-08-05'


def test_nothing_is_summed_across_accounts():
    """The consolidated figures have exactly one source (`portfolio_totals`),
    and a second arithmetic path to the same number is how two of them come to
    disagree — besides being plain wrong across currencies."""
    summaries = build_accounts(
        [declared('pea'), declared('cto', 'CTO', 'CTO', 'USD')],
        [metrics('pea', total_value=12500.0), metrics('cto', total_value=3000.0)])

    assert [s.total_value for s in summaries] == [12500.0, 3000.0]
    payload = summaries[0].to_dict()
    assert 'portfolio_total' not in payload and 'share_pct' not in payload
