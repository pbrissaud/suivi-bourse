"""**Disposable**, like the module it covers — it goes with `influxdb_writer.py`.

#699 is an expand step: the position changed shape while P1 still reads
InfluxDB, so one thin adapter keeps the price path intact for exactly one
ticket. What is worth asserting is that the adapter is *arithmetically honest* —
the figure downstream builds out of these fields has to come out to the cost
basis, and to zero on a position nobody holds.
"""
import pytest

from legacy_influx_shape import legacy_position_fields


def _position(quantity=18.0, cost_basis=2469.0, received_dividend=2.4):
    return {
        'name': 'Apple', 'symbol': 'AAPL', 'account': 'default',
        'quantity': quantity, 'cost_basis': cost_basis,
        'realized_gain': 156.5, 'received_dividend': received_dividend,
    }


def test_the_legacy_invested_figure_is_the_cost_basis():
    """Downstream computes ``purchased_quantity × purchased_price``."""
    fields = legacy_position_fields(_position())

    assert (fields['purchased_quantity'] *
            fields['purchased_price']) == pytest.approx(2469.0)


def test_the_two_quantities_collapse_onto_the_held_one():
    fields = legacy_position_fields(_position())

    assert fields['purchased_quantity'] == 18.0
    assert fields['owned_quantity'] == 18.0


def test_the_fee_field_is_absent_rather_than_a_false_zero():
    """The fee has *moved*, and the field the writer skips says so.

    Publishing it again would subtract it twice from the figure it is already
    inside; publishing a zero would tell the Grafana *Fees* panel — which reads
    this field with ``lastNotNull`` — that a user who pays fees on every trade
    pays none. ``influxdb_writer`` does not write a ``None`` field at all, so
    the last true value keeps showing.
    """
    assert legacy_position_fields(_position())['purchased_fee'] is None


def test_a_sold_position_reports_zero_invested():
    """The −932 €, on the legacy path too — by construction, not by a guard."""
    fields = legacy_position_fields(_position(quantity=0.0, cost_basis=0.0))

    assert fields['purchased_quantity'] == 0.0
    assert fields['owned_quantity'] == 0.0
    assert fields['purchased_price'] == 0.0
    assert (fields['purchased_quantity'] * fields['purchased_price']) == 0.0


def test_the_realized_gain_is_not_smuggled_into_a_legacy_field():
    """It is written by the replay; the price path never carries it (#672 D4)."""
    fields = legacy_position_fields(_position())

    assert 'realized_gain' not in fields
    assert set(fields) == {'purchased_quantity', 'purchased_price',
                           'purchased_fee', 'owned_quantity',
                           'received_dividend'}
