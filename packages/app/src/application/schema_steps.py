"""The complete list of schema steps: the store's own, then the app's (#1198).

The store runs the list and does not compose it: a step that writes through a
module above the store is declared here, so the store imports none of them.
"""
from logfmt_logger import getLogger

from application import entries
from application import store_steps

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


def _add_agent_model_name(connection) -> None:
    """Give ``agent_config`` the display name of its model (#1269).

    ``CREATE TABLE IF NOT EXISTS`` does not reach a table it finds. The column
    stays NULL on a configuration stored before: the agent page shows the id
    until a model is chosen again. A no-op on a new store. The write is
    :func:`store_steps.add_column`, the store's own, as the step has no need of a
    module above it.
    """
    store_steps.add_column(connection, 'agent_config', 'model_name', 'VARCHAR')


def _add_agent_thinking(connection) -> None:
    """Give ``agent_config`` the analyst's thinking level (#1191).

    A row stored before reads ``low``, the cheap default. A no-op on a new
    store, whose table already has the column. Not ``NOT NULL``: DuckDB refuses
    a constraint on an added column, and :func:`agent.change` keeps a write from
    storing anything but a level, so the DDL says the same.
    """
    store_steps.add_column(connection, 'agent_config', 'thinking',
                           "VARCHAR DEFAULT 'low'")


#: Every step, oldest first, under the names stores in the wild already carry.
#: The rules of :data:`store_steps.STEPS` hold over this list as a whole: a name is an
#: identity forever, and a new step — the store's own included — is appended
#: **here**, after the last one released.
STEPS = store_steps.STEPS + (
    ('cap_dividend_fee_at_amount', _cap_dividend_fee_at_amount),
    ('add_event_amounts_currency', store_steps._add_event_amounts_currency),
    ('add_agent_model_name', _add_agent_model_name),
    ('add_agent_thinking', _add_agent_thinking),
)

__all__ = ['STEPS']
