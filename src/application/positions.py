"""The replay's own two tables: ``position`` and ``account_state`` (issue #699)."""
from typing import Dict, List, Mapping, Sequence

from logfmt_logger import getLogger

from application.events.schemas import CashState, DEFAULT_ACCOUNT

logger = getLogger("positions")

POSITION_COLUMNS = (
    'account', 'symbol', 'name', 'quantity', 'cost_basis', 'realized_gain',
    'received_dividend',
)


def write_state(store, positions: Sequence[Mapping],
                cash: Mapping[str, CashState]) -> None:
    """Lay down what the replay produced. One transaction, both tables."""
    with store.transaction():
        store.execute('DELETE FROM position')
        store.execute('DELETE FROM account_state')
        for row in positions:
            store.execute(
                'INSERT INTO position '
                f'({", ".join(POSITION_COLUMNS)}) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [row.get('account') or DEFAULT_ACCOUNT, row['symbol'],
                 row.get('name'), row.get('quantity') or 0.0,
                 row.get('cost_basis') or 0.0, row.get('realized_gain') or 0.0,
                 row.get('received_dividend') or 0.0])
        for account, state in sorted(cash.items()):
            store.execute(
                'INSERT INTO account_state (account, cash_balance, '
                '                           net_contributed) VALUES (?, ?, ?)',
                [account, state.cash_balance, state.net_contributed])

    logger.debug(
        f"Replay wrote {len(positions)} position(s) and "
        f"{len(cash)} account state(s)")


def read_positions(store) -> List[Dict]:
    """Every position the store holds, ``(account, symbol)`` ordered."""
    rows = store.query(
        f'SELECT {", ".join(POSITION_COLUMNS)} FROM position '
        'ORDER BY account, symbol')
    return [dict(zip(POSITION_COLUMNS, row)) for row in rows]


def read_account_states(store) -> Dict[str, CashState]:
    """Every account's stored cash ledger, keyed by account id."""
    rows = store.query(
        'SELECT account, cash_balance, net_contributed FROM account_state '
        'ORDER BY account')
    return {row[0]: CashState(cash_balance=row[1], net_contributed=row[2])
            for row in rows}


__all__ = [
    'POSITION_COLUMNS', 'write_state', 'read_positions', 'read_account_states',
]
