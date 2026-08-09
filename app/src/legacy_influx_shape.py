"""**Disposable.** The v4 InfluxDB field shape, out of the v5 position state.

Issue #699, and it is written to be deleted by the next ticket — the one that
moves the price path off ``influxdb_writer.py``. Nothing new should ever be
added here, and nothing should grow a second caller.

It exists because #699 is an *expand* step. The position stopped being two
quantities and a unit price, but P1 still reads InfluxDB, so changing the shape
without this adapter would mean joining two stores to render one table. One
thin function keeps the whole price path — the live write, the backfill's
enrichment, ``influx_reads`` and ``portfolio_view`` — byte-for-byte unchanged
for exactly one ticket.

The mapping is not a rename, and the arithmetic is what makes it honest:

* ``purchased_quantity`` and ``owned_quantity`` **collapse onto the held
  quantity**. They were separate because a GRANT raised one and not the other,
  and that separation is what #672 D2 deleted — two quantities are lot matching
  by the back door. Downstream, ``invested`` is computed as
  ``purchased_quantity × purchased_price``, so the collapse makes it
  ``cost_basis`` exactly, and a sold position reports zero invested instead of
  its whole purchase cost as a loss.
* ``purchased_price`` is the **derived** unit cost, and ``0.0`` on a sold
  position — where the figure is undefined and the field's only consumer is the
  product above, which is zero either way.
* ``purchased_fee`` is **always ``None``**, i.e. the field is not written at
  all. Two reasons, and the second is why it is not ``0.0``. Writing the fee
  again would subtract it twice from the same figure, since it is inside
  ``cost_basis`` now. And writing a **zero** would not be neutral either: the
  provisioned Grafana dashboard has a *Fees* stat panel reading this field with
  ``lastNotNull``, so a zero would tell a user who has paid fees on every trade
  that they have paid none. An absent field keeps the last true value showing
  and reads as *"this version stopped saying"* — the same rule this ticket
  applies to a gauge whose subject is gone.

``realized_gain`` has **no legacy field at all** and is not smuggled into one:
it is a position state written by the replay (#672 D4), and the scrape's write
path is removed at the instant it is born.
"""
from typing import Mapping

from events.schemas import unit_cost


def legacy_position_fields(position: Mapping) -> dict:
    """The five v4 portfolio fields of an InfluxDB point, from one position."""
    quantity = position.get('quantity') or 0.0
    cost_basis = position.get('cost_basis') or 0.0
    return {
        'purchased_quantity': quantity,
        'purchased_price': unit_cost(quantity, cost_basis) or 0.0,
        'purchased_fee': None,
        'owned_quantity': quantity,
        'received_dividend': position.get('received_dividend') or 0.0,
    }


__all__ = ['legacy_position_fields']
