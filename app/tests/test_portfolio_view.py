"""Tests for the pure view aggregation (issue #659).

The second half of #655's testing criterion: the arithmetic on top of P1. Every
test here is literal row lists in, numbers out — no InfluxDB, no pandas, no
clock — which is the property :mod:`portfolio_view` exists to have.

Two properties carry most of the weight:

* the cost price is a **quantity-weighted mean**, not a sum and not a plain
  mean, and both wrong answers look like prices;
* **absence is not zero**, everywhere, because a `0.00 €` is a claim and a `—`
  is not.
"""
from datetime import datetime, timezone
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
    valuation_series,
    weighted_cost_price,
)


def row(**overrides):
    """A P1 row with sane defaults, overridden per test."""
    base = {
        'share_symbol': 'AAPL',
        'share_name': 'Apple Inc',
        'account': 'default',
        'share_currency': 'USD',
        'share_exchange': 'NMS',
        'quote_type': 'EQUITY',
        'time': datetime(2024, 6, 1, tzinfo=timezone.utc),
        'share_price': 200.0,
        'purchased_quantity': 10.0,
        'purchased_price': 150.0,
        'purchased_fee': 2.5,
        'owned_quantity': 10.0,
        'received_dividend': 0.0,
        'dividend_yield': 0.5,
        'pe_ratio': 30.0,
        'market_cap': 3.0e12,
    }
    base.update(overrides)
    return base


# --------------------------------------------------------------------- #
# The weighted mean — the module's most load-bearing line
# --------------------------------------------------------------------- #

def test_cost_price_is_quantity_weighted_not_averaged():
    """1 share at 100 and 9 at 200 cost 190 each.

    A plain sum says 300, a plain mean says 150. Both are plausible-looking
    prices, which is exactly why this earns a test: neither wrong answer looks
    wrong on screen.
    """
    rows = [
        row(account='pea', purchased_quantity=1.0, purchased_price=100.0),
        row(account='cto', purchased_quantity=9.0, purchased_price=200.0),
    ]
    assert weighted_cost_price(rows) == 190.0


def test_cost_price_is_none_when_nothing_was_bought():
    """Trap 13's NULLIF guard. A fully-sold position has no cost price, and
    rendering the division as 0 would put a 100 % gain on screen."""
    assert weighted_cost_price([row(purchased_quantity=0.0)]) is None
    assert weighted_cost_price([]) is None


def test_cost_price_ignores_rows_missing_either_factor():
    rows = [
        row(account='pea', purchased_quantity=10.0, purchased_price=150.0),
        row(account='cto', purchased_quantity=None, purchased_price=None),
    ]
    assert weighted_cost_price(rows) == 150.0


# --------------------------------------------------------------------- #
# Folding per-account rows into a table row
# --------------------------------------------------------------------- #

def test_quantities_sum_across_accounts_and_the_breakdown_survives():
    """The breakdown P1 computes and every Grafana panel immediately sums away."""
    rows = [
        row(account='pea', owned_quantity=10.0, purchased_quantity=10.0,
            purchased_price=150.0, purchased_fee=2.5),
        row(account='cto', owned_quantity=5.0, purchased_quantity=5.0,
            purchased_price=180.0, purchased_fee=1.5),
    ]
    share = build_share(rows, 'AAPL')

    assert share.owned_quantity == 15.0
    assert share.purchased_fee == 4.0
    assert [a.account for a in share.accounts] == ['cto', 'pea']
    # Each account keeps its own cost price, unweighted — it is already one.
    assert {a.account: a.cost_price for a in share.accounts} == {
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


def test_the_display_name_comes_from_the_newest_row():
    """Trap 9 / déc. 3: the symbol is the identity, the name is an attribute.

    A rename must not split anything — the two rows below are one share.
    """
    rows = [
        row(account='pea', share_name='Apple',
            time=datetime(2024, 1, 1, tzinfo=timezone.utc)),
        row(account='cto', share_name='Apple Inc.',
            time=datetime(2024, 6, 1, tzinfo=timezone.utc)),
    ]
    share = build_share(rows, 'AAPL')

    assert share.symbol == 'AAPL'
    assert share.name == 'Apple Inc.'
    assert len(share.accounts) == 2


def test_plus_value_latente_is_holdings_plus_dividends_minus_invested_and_fees():
    """#652 déc. 6's always-computable term — and deliberately *not* "Gain",
    which is total value − net contributed and needs declared accounts."""
    rows = [row(owned_quantity=10.0, share_price=200.0, received_dividend=8.0,
                purchased_quantity=10.0, purchased_price=150.0, purchased_fee=2.5)]
    share = build_share(rows, 'AAPL')

    # 2000 + 8 − 1500 − 2.5
    assert share.market_value == 2000.0
    assert share.invested == 1500.0
    assert share.plus_value_latente == 505.5
    assert share.unit_gain == 50.0


def test_percentage_is_none_rather_than_a_division_by_zero():
    rows = [row(purchased_quantity=0.0, purchased_price=0.0, owned_quantity=0.0)]
    share = build_share(rows, 'AAPL')

    assert share.plus_value_pct is None
    assert share.cost_price is None


def test_absent_price_leaves_derived_figures_absent_not_zero():
    """A share whose price was never observed has no valuation — not a zero one."""
    rows = [row(share_price=None)]
    share = build_share(rows, 'AAPL')

    assert share.price is None
    assert share.market_value is None
    assert share.plus_value_latente is None
    assert share.unit_gain is None


def test_a_fundamental_missing_from_the_newest_row_is_read_from_an_older_one():
    rows = [
        row(account='pea', pe_ratio=28.0,
            time=datetime(2024, 1, 1, tzinfo=timezone.utc)),
        row(account='cto', pe_ratio=None,
            time=datetime(2024, 6, 1, tzinfo=timezone.utc)),
    ]
    assert build_share(rows, 'AAPL').pe_ratio == 28.0


# --------------------------------------------------------------------- #
# The whole table
# --------------------------------------------------------------------- #

def test_build_shares_groups_by_symbol_and_sorts():
    rows = [
        row(share_symbol='MSFT', share_name='Microsoft'),
        row(share_symbol='AAPL', account='pea'),
        row(share_symbol='AAPL', account='cto'),
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
    # The slot #656 will fill; present and null until then, so the payload shape
    # does not change when the status pills land.
    assert payload['status'] is None


# ===================================================================== #
# The consolidated dashboard (issue #660)
#
# #660's testing criterion names the degraded-mode selection explicitly, and
# it earns it: the mode decides which of #652 déc. 6's two incompatible terms
# the head is even allowed to speak.
# ===================================================================== #

def test_no_declared_accounts_is_the_titres_mode():
    """The default install. A designed mode, not a missing configuration."""
    assert portfolio_mode(None, events_mode=True) == MODE_TITRES
    assert portfolio_mode([], events_mode=True) == MODE_TITRES


def test_declared_accounts_in_manual_mode_still_get_the_titres_head():
    """`update_account_metrics` returns early when the snapshot has no events,
    so a declared `accounts:` block in manual mode produces **no series at all**.

    Answering `accounts` there would leave the dashboard waiting forever on a
    computation that is never going to run — a permanent "en cours de calcul"
    that looks exactly like a broken app.
    """
    assert portfolio_mode(['EUR'], events_mode=False) == MODE_TITRES


def test_one_currency_across_declared_accounts_is_the_accounts_mode():
    assert portfolio_mode(['EUR', 'EUR'], events_mode=True) == MODE_ACCOUNTS


def test_mixed_currencies_are_their_own_mode_not_an_empty_head():
    """`portfolio_totals` is not written for a mixed portfolio at all, so the
    figures are absent by construction. Stating the condition is #655 déc. 8's
    third case — the slot, without the product answer."""
    assert portfolio_mode(['EUR', 'USD'], events_mode=True) == MODE_MULTI_CURRENCY


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
        'time': datetime(2026, 8, 5, tzinfo=timezone.utc),
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
    assert head['as_of'] == '2026-08-05T00:00:00+00:00'
    assert 'plus_value_latente' not in head


def test_a_rate_that_was_never_computable_is_simply_absent():
    """xirr needs an external flow; a portfolio with none has no annualized
    rate, and InfluxDB has no column for it either. `None`, never zero."""
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
        row(share_symbol='AAPL', owned_quantity=10.0, share_price=200.0,
            purchased_quantity=10.0, purchased_price=150.0, purchased_fee=2.5,
            received_dividend=8.0),
        row(share_symbol='MSFT', share_name='Microsoft', owned_quantity=5.0,
            share_price=400.0, purchased_quantity=5.0, purchased_price=380.0,
            purchased_fee=1.5, received_dividend=0.0),
    ])
    head = build_titres_head(shares)

    assert head['mode'] == MODE_TITRES
    assert head['holdings_value'] == 4000.0        # 2000 + 2000
    assert head['invested'] == 3400.0              # 1500 + 1900
    assert head['plus_value_latente'] == 604.0     # 4000 + 8 − 3400 − 4
    assert 'gain_absolu' not in head
    assert head['baseline'] is None


def test_the_titres_head_drops_the_currency_when_the_portfolio_mixes_them():
    """Trap 14 — rendering a mixed total as euros is what the baseline does by
    hardcoding `currencyEUR`. A bare number is the honest fallback."""
    shares = build_shares([
        row(share_symbol='AAPL', share_currency='USD'),
        row(share_symbol='AIR.PA', share_name='Airbus', share_currency='EUR'),
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
# --------------------------------------------------------------------- #

def day_row(day, symbol='AAPL', account='default', price=100.0, owned=10.0,
            pq=10.0, pp=90.0):
    return {
        'day': datetime(2024, 6, day, tzinfo=timezone.utc),
        'share_symbol': symbol,
        'account': account,
        'share_price': price,
        'owned_quantity': owned,
        'purchased_quantity': pq,
        'purchased_price': pp,
    }


def test_valuation_sums_the_days_closing_state_across_positions():
    series = valuation_series([
        day_row(1, 'AAPL', price=100.0, owned=10.0, pq=10.0, pp=90.0),
        day_row(1, 'MSFT', price=400.0, owned=5.0, pq=5.0, pp=380.0),
    ])

    assert series == [{
        't': '2024-06-01T00:00:00+00:00',
        'value': 3000.0,     # 1000 + 2000
        'invested': 2800.0,  # 900 + 1900
    }]


def test_a_position_missing_a_day_is_carried_forward_not_dropped():
    """The defect this function exists to prevent: MSFT's exchange is shut on
    the 2nd, so it has no row. Dropping it would show the whole portfolio losing
    2000 € and getting it back on the 3rd — a valuation curve that is really a
    map of exchange holidays.
    """
    series = valuation_series([
        day_row(1, 'AAPL', price=100.0), day_row(1, 'MSFT', price=400.0, owned=5.0),
        day_row(2, 'AAPL', price=110.0),
        day_row(3, 'AAPL', price=120.0), day_row(3, 'MSFT', price=410.0, owned=5.0),
    ])

    assert [point['value'] for point in series] == [3000.0, 3100.0, 3250.0]


def test_a_position_contributes_nothing_before_its_first_row():
    """Forward-fill only looks backwards. A share bought on the 2nd must not
    inflate the 1st."""
    series = valuation_series([
        day_row(1, 'AAPL', price=100.0),
        day_row(2, 'AAPL', price=100.0), day_row(2, 'MSFT', price=400.0, owned=5.0),
    ])

    assert [point['value'] for point in series] == [1000.0, 3000.0]


def test_the_same_symbol_in_two_accounts_is_two_series_not_one():
    """Keyed on (symbol, account): forward-filling on the symbol alone would let
    one account's row overwrite the other's and halve the portfolio."""
    series = valuation_series([
        day_row(1, 'AAPL', account='pea', owned=10.0, price=100.0),
        day_row(1, 'AAPL', account='cto', owned=4.0, price=100.0),
    ])

    assert series[0]['value'] == 1400.0


def test_an_empty_window_is_an_empty_series():
    assert valuation_series([]) == []


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
        {'share_symbol': 'AAPL', 'share_price': 100.0,
         'time': datetime(2026, 8, 4, 20, 0, tzinfo=timezone.utc)},
        {'share_symbol': 'AIR.PA', 'share_price': 200.0,
         'time': datetime(2026, 8, 4, 15, 30, tzinfo=timezone.utc)},
    ]
    assert baseline_reference(rows) == datetime(
        2026, 8, 4, 20, 0, tzinfo=timezone.utc)


def test_the_reference_close_is_absent_when_nothing_precedes_the_cut():
    assert baseline_reference([]) is None
    assert baseline_reference([{'share_symbol': 'AAPL', 'share_price': 1.0}]) is None


def test_movers_rank_by_percentage_and_report_what_the_move_was_worth():
    shares = build_shares([
        row(share_symbol='AAPL', share_price=110.0, owned_quantity=10.0),
        row(share_symbol='MSFT', share_name='Microsoft', share_price=380.0,
            owned_quantity=5.0),
    ])
    movers = build_movers(shares, [
        {'share_symbol': 'AAPL', 'share_price': 100.0},
        {'share_symbol': 'MSFT', 'share_price': 400.0},
    ])

    assert [m.symbol for m in movers] == ['AAPL', 'MSFT']
    assert movers[0].change_pct == 0.1
    assert movers[0].contribution == 100.0     # +10 € × 10 shares
    assert movers[1].change == -20.0
    assert movers[1].contribution == -100.0


def test_a_market_that_has_not_opened_today_reports_zero_not_absence():
    """Its last point *is* the baseline point, so the change is a real zero —
    the share has genuinely not traded since its close."""
    shares = build_shares([row(share_symbol='AAPL', share_price=100.0)])
    movers = build_movers(shares, [{'share_symbol': 'AAPL', 'share_price': 100.0}])

    assert movers[0].change == 0.0
    assert movers[0].change_pct == 0.0


def test_a_share_with_no_baseline_is_left_out_rather_than_shown_flat():
    """Its first day. It has not failed to move — there is nothing to compare
    against, and a zero in a movers list is a claim."""
    shares = build_shares([
        row(share_symbol='AAPL', share_price=110.0),
        row(share_symbol='NEW', share_name='Fresh', share_price=50.0),
    ])
    movers = build_movers(shares, [{'share_symbol': 'AAPL', 'share_price': 100.0}])

    assert [m.symbol for m in movers] == ['AAPL']


def test_a_share_whose_price_was_never_observed_is_left_out_too():
    shares = build_shares([row(share_symbol='AAPL', share_price=None)])
    movers = build_movers(shares, [{'share_symbol': 'AAPL', 'share_price': 100.0}])

    assert movers == []


def test_each_mover_carries_its_own_currency():
    """Which is what lets the block survive the multi-currency mode the head
    refuses: a percentage carries no currency, and the amounts state theirs."""
    shares = build_shares([
        row(share_symbol='AAPL', share_currency='USD', share_price=110.0),
        row(share_symbol='AIR.PA', share_name='Airbus', share_currency='EUR',
            share_price=180.0),
    ])
    movers = build_movers(shares, [
        {'share_symbol': 'AAPL', 'share_price': 100.0},
        {'share_symbol': 'AIR.PA', 'share_price': 200.0},
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
        'time': datetime(2026, 8, 5, tzinfo=timezone.utc),
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
    """The order the human wrote in settings.yaml, which beats any sort this
    module could invent — and the table sorts on demand anyway."""
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
    """Historical residue: an account since removed from settings.yaml."""
    summaries = build_accounts([declared('pea')], [metrics('pea'), metrics('old')])

    assert [s.id for s in summaries] == ['pea']


def test_the_declaration_wins_over_the_series_tags():
    """`account_currency` records what the account *was* when the point was
    written; the declaration is what it is. Trap 14 seen from the other end."""
    summaries = build_accounts(
        [declared('pea', currency='EUR')],
        [metrics('pea', account_currency='USD')])

    assert summaries[0].currency == 'EUR'


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
