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

from portfolio_view import build_share, build_shares, weighted_cost_price


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
