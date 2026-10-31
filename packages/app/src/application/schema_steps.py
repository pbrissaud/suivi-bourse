"""The complete list of schema steps: the store's own, then the app's (#1198).

The store runs the list and does not compose it: a step that writes through a
module above the store is declared here, so the store imports none of them.
"""
from logfmt_logger import getLogger

from application import benchmarks
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


def _add_symbol_quote_long_name(connection) -> None:
    """Give ``symbol_quote`` the name Yahoo calls the security (#1386).

    NULL until the scrape or the classification backfill reads it. A no-op on a
    new store, whose table already has the column.
    """
    store_steps.add_column(connection, 'symbol_quote', 'long_name', 'VARCHAR')


def _forget_ticker_names(connection) -> None:
    """Undo the ticker the app used to write as a security's name (#1386).

    ``name ?? symbol`` shows the same text, so the display does not move; the
    row just stops claiming somebody declared it. Idempotent. The write is
    :func:`entries.forget_ticker_names`, ``event`` having one writer.
    """
    entries.forget_ticker_names(connection)


def _add_agent_thinking(connection) -> None:
    """Give ``agent_config`` the analyst's thinking level (#1191).

    A row stored before reads ``low``, the cheap default. A no-op on a new
    store, whose table already has the column. Not ``NOT NULL``: DuckDB refuses
    a constraint on an added column, and :func:`agent.change` keeps a write from
    storing anything but a level, so the DDL says the same.
    """
    store_steps.add_column(connection, 'agent_config', 'thinking',
                           "VARCHAR DEFAULT 'low'")


def _follow_the_references(connection) -> None:
    """Follow what the install already compares against (#1312).

    The displayed ``benchmark_symbol`` first, then every ``benchmark_consulted``
    reference, newest first: the series the owner already holds, and so the
    ones that cost nothing to offer. An off-list ``benchmark_symbol`` (a ticker
    typed through ``PUT /api/settings`` before the list closed) is refused now
    and cleared here, with a line to say so. A step is a one-way, idempotent
    write: a store that already holds ``benchmark_symbols`` keeps its own, and
    one that compared against nothing gets no row.
    """
    def stored(key):
        row = connection.execute(
            'SELECT value FROM setting WHERE key = ?', [key]).fetchone()
        return row[0] if row and row[0] else ''

    if connection.execute(
            "SELECT 1 FROM setting WHERE key = 'benchmark_symbols'").fetchone():
        return
    chosen = stored('benchmark_symbol').strip().upper()
    if chosen and chosen not in benchmarks.BY_SYMBOL:
        logger.warning(f'Cleared the off-list reference {chosen}: the '
                       f'comparison now offers its own list only')
        connection.execute(
            "UPDATE setting SET value = '' WHERE key = 'benchmark_symbol'")
        chosen = ''
    followed = []
    for symbol in [chosen, *stored('benchmark_consulted').split(',')]:
        if symbol in benchmarks.BY_SYMBOL and symbol not in followed:
            followed.append(symbol)
    if not followed:
        return
    for key in ('benchmark_symbols', 'benchmark_consulted'):
        connection.execute(
            'INSERT INTO setting (key, value) VALUES (?, ?) '
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            [key, ','.join(followed)])


#: Every step, oldest first, under the names stores in the wild already carry.
#: The rules of :data:`store_steps.STEPS` hold over this list as a whole: a name is an
#: identity forever, and a new step — the store's own included — is appended
#: **here**, after the last one released.
STEPS = store_steps.STEPS + (
    ('cap_dividend_fee_at_amount', _cap_dividend_fee_at_amount),
    ('add_event_amounts_currency', store_steps._add_event_amounts_currency),
    ('add_agent_model_name', _add_agent_model_name),
    ('add_agent_thinking', _add_agent_thinking),
    ('follow_the_references', _follow_the_references),
    ('add_symbol_quote_long_name', _add_symbol_quote_long_name),
    ('forget_ticker_names', _forget_ticker_names),
)

__all__ = ['STEPS']
