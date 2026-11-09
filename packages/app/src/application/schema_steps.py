"""The complete list of schema steps: the store's own, then the app's (#1198).

The store runs the list and does not compose it: a step that writes through a
module above the store is declared here, so the store imports none of them.
"""
import secrets

from logfmt_logger import getLogger

from application import auth_gate
from application import benchmarks
from application import entries
from application import store_steps
from application.store_ddl import NOTIFICATIONS_DDL

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


def _add_backward_failed_at(connection) -> None:
    """Give ``symbol_quote`` the backward pass's last failed request (#1460).

    NULL until a request fails. A no-op on a new store, whose table already has
    the column.
    """
    store_steps.add_column(
        connection, 'symbol_quote', 'backward_failed_at', 'TIMESTAMPTZ')


def _forget_ticker_names(connection) -> None:
    """Undo the ticker the app used to write as a security's name (#1386).

    ``name ?? symbol`` shows the same text, so the display does not move; the
    row just stops claiming somebody declared it. Idempotent.
    """
    connection.execute('UPDATE event SET name = NULL WHERE name = symbol')


def _add_agent_thinking(connection) -> None:
    """Give ``agent_config`` the analyst's thinking level (#1191).

    A row stored before reads ``low``, the cheap default. A no-op on a new
    store, whose table already has the column. Not ``NOT NULL``: DuckDB refuses
    a constraint on an added column, and :func:`agent.change` keeps a write from
    storing anything but a level, so the DDL says the same.
    """
    store_steps.add_column(connection, 'agent_config', 'thinking',
                           "VARCHAR DEFAULT 'low'")


def _forget_dashboard_layout(connection) -> None:
    """Drop the saved dashboard layout: the dashboard is fixed now.

    Nothing reads the row any more; deleting it keeps ``setting`` from carrying
    a dead key for ever. Idempotent: a store without the row deletes nothing.
    """
    connection.execute("DELETE FROM setting WHERE key = 'dashboard_layout'")


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


def _move_agent_provider(connection) -> None:
    """Move the one provider ``agent_config`` held into ``agent_provider``.

    It becomes the default provider, keeping its key, address and model. The
    old columns are emptied so the key is not stored twice; ``enabled`` and
    ``thinking`` stay where they are. A no-op on a store that never configured
    a provider, and on one that already holds providers.
    """
    if connection.execute('SELECT 1 FROM agent_provider').fetchone():
        return
    row = connection.execute(
        'SELECT provider, base_url, api_key, key_set_at, model, updated_at '
        'FROM agent_config WHERE id = 1 AND provider IS NOT NULL').fetchone()
    if row is None:
        return
    kind, base_url, api_key, key_set_at, model, updated_at = row
    connection.execute(
        'INSERT INTO agent_provider (id, label, kind, base_url, api_key, '
        'key_set_at, default_model, is_default, last_test_at, created_at) '
        'VALUES (?, NULL, ?, ?, ?, ?, ?, TRUE, NULL, ?)',
        [secrets.token_hex(6), kind, base_url, api_key, key_set_at, model,
         updated_at])
    connection.execute(
        'UPDATE agent_config SET provider = NULL, model = NULL, '
        'model_name = NULL, base_url = NULL, api_key = NULL, key_set_at = NULL')


def _backfill_agent_usage(connection) -> None:
    """Index the tokens of the threads saved before ``agent_usage`` existed."""
    # Imported here: the module loads Pydantic AI, which a boot that has no
    # such step to run has no use for.
    from application import agent_usage
    agent_usage.backfill(connection)
def _add_notification_channels(connection) -> None:
    """Give a store the tables the outbound channels live in (§ 3.6).

    The DDL creates them on every open, which is what a store from before this
    release gets; the step is the record that the generation exists, and it is
    the same ``IF NOT EXISTS`` statement, so a store that already has them
    changes nothing.
    """
    connection.execute(NOTIFICATIONS_DDL)


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
    ('add_auth_session_seconds', auth_gate.add_session_seconds),
    ('add_backward_failed_at', _add_backward_failed_at),
    ('move_token_to_access_tokens', auth_gate.move_token_to_access_tokens),
    ('move_agent_provider', _move_agent_provider),
    ('backfill_agent_usage', _backfill_agent_usage),
    ('make_account_label_optional', store_steps._make_account_label_optional),
    ('forget_dashboard_layout', _forget_dashboard_layout),
    ('add_notification_channels', _add_notification_channels),
)

__all__ = ['STEPS']
