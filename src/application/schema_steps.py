"""The complete list of schema steps: the store's own, then the app's (#1198).

The store runs the list and does not compose it: a step that writes through a
module above the store is declared here, so the store imports none of them.
"""
from logfmt_logger import getLogger

from application import entries
from application import store

# The store's logger, so the line reads as it did when the step lived there.
logger = getLogger("store")


def _cap_dividend_fee_at_amount(connection) -> None:
    """Bring a stored dividend's fee down to its amount (#1166).

    The aggregator books ``amount - fee``, so a fee past the gross booked a
    negative dividend, and the validator now refuses one. The boot replay
    validates the whole ledger, so a row written before that refusal would stop
    the app from starting: it is capped here, the dividend nets to zero, the
    least the row can say without inventing the figure that was meant.

    The fee it held is appended to the row's label, so the owner can re-enter
    the withholding that was meant: a log line alone does not outlive a
    redeploy. A no-op on a store holding no such row, and then the derived
    series stay.

    The write itself is :func:`entries.cap_dividend_fees`, ``event`` having one
    writer; it runs on this connection, inside this step's transaction. It is
    declared here rather than in :mod:`store` because :mod:`entries` sits above
    the store, and the store imports nothing above it.
    """
    capped = entries.cap_dividend_fees(connection)
    if not capped:
        return
    connection.execute('DELETE FROM account_metrics')
    connection.execute('DELETE FROM portfolio_totals')
    said = ', '.join(f'#{event_id} (fee {was})' for event_id, was in sorted(capped))
    logger.warning(f'Capped the fee of these dividends at their amount: {said}')


#: Every step, oldest first, under the names stores in the wild already carry.
#: The rules of :data:`store.STEPS` hold over this list as a whole: a name is an
#: identity forever, and a new step — the store's own included — is appended
#: **here**, after the last one released.
STEPS = store.STEPS + (
    ('cap_dividend_fee_at_amount', _cap_dividend_fee_at_amount),
)

__all__ = ['STEPS']
