"""Réaffecter, jamais refuser (issue #725, ADR-0013, ADR-0006)."""
from logfmt_logger import getLogger

from application import accounts as accounts_module
from application import ledger
from application.events.aggregator import EventAggregator
from application.events.schemas import DEFAULT_ACCOUNT

logger = getLogger("reassignment")


class NotReassignable(Exception):
    """The target cannot receive the unassigned events."""


def unassigned_events(store) -> int:
    """How many events nobody assigned. The count the offer states."""
    if accounts_module.default_is_declared(store):
        return 0
    rows = store.query(
        'SELECT count(*) FROM event WHERE account = ?', [DEFAULT_ACCOUNT])
    return int(rows[0][0]) if rows else 0


def reassign_unassigned(store, account_id: str) -> int:
    """Move every event naming ``default`` onto ``account_id``. Returns how many."""
    target = (account_id or '').strip()
    if not target or target == DEFAULT_ACCOUNT:
        raise NotReassignable(
            f"{DEFAULT_ACCOUNT!r} is the row every install is given, not a "
            f"declaration; reassign onto an account you declared")
    if target not in accounts_module.account_ids(store):
        raise accounts_module.UnknownAccount(f"No account with id {target!r}")

    moved = unassigned_events(store)
    if not moved:
        return 0

    store.execute('UPDATE event SET account = ? WHERE account = ?',
                  [target, DEFAULT_ACCOUNT])
    EventAggregator().aggregate(ledger.read_events(store))
    logger.info(f"Reassigned {moved} unassigned event(s) to {target}")
    return moved


__all__ = ['NotReassignable', 'unassigned_events', 'reassign_unassigned']
