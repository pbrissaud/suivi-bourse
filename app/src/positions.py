"""The replay's own two tables: ``position`` and ``account_state`` (issue #699).

Spec #695 § 2 / ADR-0003 / ADR-0006. The rule that generates the schema is
*declaration and derived state never share a row*, and this module is one of its
four writers — **the only** writer of these two tables. The configuration path
owns the events, the scrape owns the prices, the perf job owns the series; what
the events *mean* is laid down here, by the replay and by nothing else.

That exclusivity is the ticket, not a tidiness preference. The alternative was a
position row written by two jobs — the replay for the state, the scrape for the
price — and a sold position breaks it for good: its state changes at the instant
its price stops being fetched, so a realized gain riding on the scrape's write
path would be born exactly where that path has just been removed. Prices live on
``symbol_quote`` / ``price_point`` and join at read time; nothing here ever
writes one.

**The write is a replacement, not an upsert**, and the reason is a rhythm rather
than a table size. ADR-0011 prices ``DELETE``+``INSERT`` at 44,8 MB of file
growth — measured over *a thousand cycles* of a job that runs every 120 s. A
replay is not a cycle: it happens on the boot, on a file landing in the drop
folder, and on a write through the API, and only when the ledger's stamp
actually moved. At that rhythm the whole-table replacement is what says the
truth — the position table *is* the replay's output, and a row it no longer
produces (an import forgotten, a symbol nobody names any more) has to leave with
the same gesture that rewrites the rest.
"""
from typing import Dict, List, Mapping, Sequence

from logfmt_logger import getLogger

from events.schemas import CashState, DEFAULT_ACCOUNT

logger = getLogger("positions")

#: The columns of ``position``, in DDL order — the one list, so the ``INSERT``
#: and whatever reads it cannot drift apart.
POSITION_COLUMNS = (
    'account', 'symbol', 'name', 'quantity', 'cost_basis', 'realized_gain',
    'received_dividend',
)


def write_state(store, positions: Sequence[Mapping],
                cash: Mapping[str, CashState]) -> None:
    """Lay down what the replay produced. One transaction, both tables.

    ``positions`` are :meth:`events.schemas.Timeline.current`'s dicts — **sold
    positions included**, which is the point: a position at zero quantity keeps
    its realized gain and its dividends, and dropping it here would take the
    figure away at the exact moment it became the only one left to show.

    ``cash`` is :meth:`events.schemas.Timeline.current_cash` — one row per
    account the events touched. An account nobody has moved money in has no row
    rather than a row of zeros: *"never any cash event"* and *"a balance of
    zero"* are two states, and the perf job's per-field rule reads them
    differently.

    Both tables are emptied and rewritten inside a single transaction, and the
    store holds the connection for its length — so a reader never sees half a
    replay (which here would be *no positions at all*) and a failure leaves the
    previous state whole, the same contract
    :class:`main.ConfigurationManager` gives the snapshot one storey up.
    """
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
    """Every position the store holds, ``(account, symbol)`` ordered.

    A read of what :func:`write_state` laid down, in the same dict shape the
    replay speaks — so a caller can take either without asking which.
    """
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
