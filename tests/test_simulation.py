"""A sale, simulated (#1108).

Pure arithmetic: every figure below is computed by hand and frozen here, so a
change in the rule shows up as a changed number rather than as a passing test.
"""
from datetime import date

import pytest

from application import taxation
from application.simulation import (Account, Line, SimulationRefused,
                                    simulate_sale)


NOW = date(2026, 6, 1)

CTO = {'rate': 0.128, 'social_rate': 0.172}
PEA = {'rate_before': 0.128, 'rate_after': 0.0, 'threshold_years': 5,
       'age_basis': taxation.FIRST_PAYMENT, 'social_rate': 0.172}
LADDER = {'brackets': [{'upper_bound': 1_000.0, 'rate': 0.10},
                       {'upper_bound': None, 'rate': 0.20}]}


def account(kind, parameters=None, lines=(), *, id='a', first_payment=None):
    return Account(id=id, kind=kind, parameters=parameters or {},
                   opened_on=None, first_payment=first_payment,
                   lines=list(lines))


CW8 = Line('CW8.PA', 15, 6_150.0, 512.3)


# --------------------------------------------------------------------------- #
# simulate_sale — one case per family
# --------------------------------------------------------------------------- #

def test_a_flat_sale_taxes_the_lot():
    sale = simulate_sale(account(taxation.FLAT_REALISED, CTO, [CW8],
                                 id='cto'), 'CW8.PA', 10, now=NOW)

    numbers = ('proceeds', 'gain', 'tax_now', 'net_proceeds')
    assert {key: sale[key] for key in numbers} == pytest.approx(
        {'proceeds': 5_123.0, 'gain': 1_023.0, 'tax_now': 306.9,
         'net_proceeds': 4_816.1})
    assert {key: value for key, value in sale.items()
            if key not in numbers} == {
        'account': 'cto', 'symbol': 'CW8.PA', 'quantity': 10, 'price': 512.3,
        'if_withdrawn': None,
        'position_after': {'quantity': 5, 'cost_basis': 2_050.0,
                           'unit_cost': 410.0},
        'reason': None, 'fees': 0,
        'not_modelled': ['social_contributions_detail']}


def test_a_bracketed_sale_straddles_two_brackets_from_bracket_zero():
    sale = simulate_sale(
        account(taxation.BRACKETED_REALISED, LADDER,
                [Line('X', 10, 1_000.0, 250.0)]), 'X', 8, now=NOW)

    # gain 8 × 150 = 1 200: 1 000 at 10 %, 200 at 20 %.
    assert sale['gain'] == pytest.approx(1_200.0)
    assert sale['tax_now'] == pytest.approx(140.0)
    assert sale['not_modelled'] == ['social_contributions_detail',
                                    'annual_accumulation']


#: L = 1 000 − 500 = 500, V = 2 000 + 2 500 = 4 500.
PLAN = [Line('A', 10, 1_000.0, 200.0), Line('B', 10, 3_000.0, 250.0)]


def pea(lines=PLAN, **facts):
    facts.setdefault('first_payment', date(2021, 1, 1))
    return account(taxation.AGED_FLAT_REALISED, PEA, lines, **facts)


def test_an_aged_sale_owes_nothing_now_and_the_prorata_on_withdrawal():
    under = simulate_sale(pea(), 'A', 9, now=date(2025, 6, 1))
    over = simulate_sale(pea(), 'A', 9, now=date(2026, 6, 1))

    # proceeds 1 800 × 500 / 4 500 = 200, below the lot's own gain of 900.
    assert under['gain'] == pytest.approx(900.0)
    assert under['tax_now'] == 0
    assert under['net_proceeds'] == pytest.approx(1_800.0)
    assert under['if_withdrawn'] == pytest.approx(60.0)     # 200 × 30 %
    assert over['if_withdrawn'] == pytest.approx(34.4)      # 200 × 17.2 %


def test_a_negative_prorata_owes_nothing_on_withdrawal():
    lines = [Line('A', 10, 1_000.0, 200.0), Line('B', 10, 5_000.0, 250.0)]

    assert simulate_sale(pea(lines), 'A', 9, now=NOW)['if_withdrawn'] == 0


def test_an_unvalued_line_elsewhere_leaves_the_withdrawal_unknown():
    lines = PLAN + [Line('C', 1, 10.0, None)]

    assert simulate_sale(pea(lines), 'A', 9, now=NOW)['if_withdrawn'] is None


def test_a_lot_at_a_loss_owes_nothing_and_says_the_loss_is_not_offset():
    sale = simulate_sale(account(taxation.FLAT_REALISED, CTO,
                                 [Line('X', 10, 1_000.0, 80.0)]),
                         'X', 5, now=NOW)

    assert sale['gain'] == pytest.approx(-100.0)
    assert sale['tax_now'] == 0
    assert sale['not_modelled'] == ['social_contributions_detail',
                                    'loss_offset']


@pytest.mark.parametrize('kind, tax_now, reason', [
    (taxation.NONE, 0, 'no_tax_model'),
    (taxation.WITHHOLDING_INCOME, None, 'not_projectable'),
    (None, None, 'no_model'),
])
def test_the_kinds_without_a_projection_say_why(kind, tax_now, reason):
    parameters = {'rate': 0.3} if kind == taxation.WITHHOLDING_INCOME else {}
    sale = simulate_sale(account(kind, parameters, [CW8]), 'CW8.PA', 10,
                         now=NOW)

    assert (sale['tax_now'], sale['reason']) == (tax_now, reason)
    if tax_now is None:
        assert sale['net_proceeds'] is None
    else:
        assert sale['net_proceeds'] == pytest.approx(5_123.0)


@pytest.mark.parametrize('qty', [15, 15 * (1 - 1e-10), 15 * (1 + 1e-10)])
def test_a_full_sale_empties_the_line(qty):
    sale = simulate_sale(account(taxation.FLAT_REALISED, CTO, [CW8]),
                         'CW8.PA', qty, now=NOW)

    assert sale['quantity'] == 15
    assert sale['position_after'] == {'quantity': 0, 'cost_basis': 0,
                                      'unit_cost': None}


@pytest.mark.parametrize('symbol, qty, lines', [
    ('CW8.PA', 0, [CW8]),
    ('CW8.PA', -1, [CW8]),
    ('CW8.PA', 15.001, [CW8]),
    ('OTHER', 1, [CW8]),
    ('CW8.PA', 1, [Line('CW8.PA', 15, 6_150.0, None)]),
    ('CW8.PA', 1, [Line('CW8.PA', 15, 6_150.0, 0.0)]),
])
def test_a_sale_that_cannot_happen_is_refused(symbol, qty, lines):
    with pytest.raises(SimulationRefused):
        simulate_sale(account(taxation.FLAT_REALISED, CTO, lines), symbol,
                      qty, now=NOW)


@pytest.mark.parametrize('qty', [float('nan'), float('inf'), True, '5'])
def test_a_quantity_that_is_not_a_number_is_refused(qty):
    with pytest.raises(SimulationRefused):
        simulate_sale(account(taxation.FLAT_REALISED, CTO, [CW8]), 'CW8.PA',
                      qty, now=NOW)


def test_a_nan_price_is_an_unvalued_line():
    with pytest.raises(SimulationRefused):
        simulate_sale(account(taxation.FLAT_REALISED, CTO,
                              [Line('X', 10, 1_000.0, float('nan'))]),
                      'X', 1, now=NOW)


def test_a_pea_with_no_age_date_has_no_withdrawal_figure():
    assert simulate_sale(pea(first_payment=None), 'A', 9,
                         now=NOW)['if_withdrawn'] is None


def test_an_unreadable_model_says_so():
    sale = simulate_sale(account(taxation.FLAT_REALISED, {'rate': 'high'},
                                 [CW8]), 'CW8.PA', 10, now=NOW)

    assert (sale['tax_now'], sale['reason']) == (None, 'unreadable_model')
    assert sale['net_proceeds'] is None


def test_a_symbol_not_held_names_what_the_account_holds():
    """A line sold to zero is not held, and an empty account says so."""
    sold_out = Line('GONE', 0, 0.0, 10.0)
    with pytest.raises(SimulationRefused, match='it holds: CW8.PA$'):
        simulate_sale(account(taxation.FLAT_REALISED, CTO, [CW8, sold_out]),
                      'X', 1, now=NOW)
    with pytest.raises(SimulationRefused, match='it holds: nothing$'):
        simulate_sale(account(taxation.FLAT_REALISED, CTO, [sold_out]),
                      'X', 1, now=NOW)
