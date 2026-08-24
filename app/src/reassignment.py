"""Réaffecter, jamais refuser (issue #725, ADR-0013, ADR-0006).

The path exists and it fabricates a line nobody declared. Running for a month
with nothing declared puts the whole ledger under the ``default`` row the schema
seeds — which is the rule of #698 doing exactly what it says — and then
declaring two accounts makes that row **undeletable** the instant an event names
it. The accounts page ends up showing a line carrying the entire history that
its owner never created.

That page treats it **at the render** (named *Non affecté*, distinguished,
carrying a link to here) because prevention arrives too late for whoever is
already in the state. Prevention belongs here, and its form is settled:
**réaffecter, jamais refuser**. Refusing is the trap dismantled elsewhere under
another name — it locks the owner out of the one action that repairs their
state.

Two tempting models are refused, each for a reason that holds:

* **a correspondence layer** ``default → pea`` beside the events is a *second
  truth* about the account an event names, which ADR-0006 forbids head on;
* **a re-import with a mapping table** requires the owner to still have the
  file, which #728 has just established cannot be assumed — the drop folder is
  an optional read-only bind.

So: a **named and bounded exception**. The ``account`` column of an imported
event is writable at the moment the first account is declared, and never
afterwards. That is not a hole in the read-only rule, it is its counterpart: the
read-only rule puts the repair in the file because the file is *wrong*, and here
the file was **right under the rule in force when it was imported** (a blank
column meant ``default``) — the application changed the rule underneath it.
**A change of rule is not paid for by editing 285 lines.**

Four things make the exception bounded rather than merely narrow, and none of
them is a flag:

* **The population is the column's own value.** The one statement this module
  writes is ``UPDATE event SET account = ? WHERE account = 'default'``. There is
  no id to pass, no row to address, and therefore nothing here that can rewrite
  an event naming a declared account — which is the whole of *jamais ensuite*,
  said by a ``WHERE`` rather than by a promise.
* **And ``default`` is not always the row nobody declared.** Its owner may
  rename it, retype it, or let a file take it over (#698, #729), and from that
  instant its events name an account somebody declared — so
  :func:`accounts.default_is_declared` empties the population, and the ``WHERE``
  above is never reached. Without that half the exception reached a declared
  account by the back door: one pre-ticked click on a second declaration would
  have moved a whole ledger off the one line its owner had put a name on.
* **The window opens at the first declaration, and the target says so.** The
  target must be a declared account: neither the seeded row nor an unknown id.
  An account that is neither *is* a declaration, so *the first account has been
  declared* needs no second predicate to be checked against — and before that
  instant there is nothing to reassign onto, because a blank column still
  legitimately means ``default``.
* **It closes by running.** Afterwards no event carries ``default``, so a second
  call moves nothing at all. The exception is spent by the repair it exists for.

It is a module of its own for the reason it always was, said the other way round
since #816: ``event`` has **one** writer (:mod:`entries`), and a gesture that
rewrites a column of it in bulk is not one of that module's four. Folding it in
would make *the four gestures and what they refuse* read as five, one of which
answers to no key at all — so the exception is named, and it is named here.

**Not in this module**: the declaration itself (:mod:`accounts`), and the replay
that follows the write (:func:`main.replay_after_write`). What is here is the
assertion :mod:`entries` makes for the same reason — the ledger this gesture
would leave is replayed before the commit.
"""
from logfmt_logger import getLogger

import accounts as accounts_module
import ledger
from events import EventAggregator
from events.schemas import DEFAULT_ACCOUNT

logger = getLogger("reassignment")


class NotReassignable(Exception):
    """The target cannot receive the unassigned events.

    Its own class because it is not :class:`accounts.UnknownAccount`: the row is
    very much there — it is the seeded one, and reassigning ``default`` onto
    ``default`` is a gesture with no subject rather than a missing account.
    """


def unassigned_events(store) -> int:
    """How many events nobody assigned. The count the offer states.

    Naming ``default`` is **not** the whole predicate, and the missing half is
    what keeps the exception from reaching a declared account by the back door:
    the seeded row can *become* a declaration — its owner renames it (the N = 1
    gesture #729 built the declaration block for), retypes it, or a file takes it
    over (#698) — and from that moment those events name the account their owner
    named. Counted as unassigned, a later second declaration would have moved a
    whole ledger off the one line somebody had put their own name on, in one
    pre-ticked click and with nothing to undo it by: the source files' contents
    have not moved, so a re-scan reports them unchanged, and a blank column is
    refused by then anyway.

    So the population is empty there, and it is empty rather than refused: those
    events are assigned, which is a state and not a mistake.
    """
    if accounts_module.default_is_declared(store):
        return 0
    rows = store.query(
        'SELECT count(*) FROM event WHERE account = ?', [DEFAULT_ACCOUNT])
    return int(rows[0][0]) if rows else 0


def reassign_unassigned(store, account_id: str) -> int:
    """Move every event naming ``default`` onto ``account_id``. Returns how many.

    **The caller owns the transaction** — because the gesture this serves is
    sometimes *declare an account and reassign in the same breath*, and a
    declaration committed without the reassignment the owner asked for in the
    same click is a half gesture nobody asked for.

    Raises:
        NotReassignable: the target is the seeded row, or is blank.
        accounts.UnknownAccount: no account has that id — a ``404``, never a
            silent create, which is :func:`accounts._require`'s own answer.
        events.aggregator.AggregationError: the ledger it would leave does not
            replay. It cannot be produced by moving the whole ``default``
            population at once — two valid per-account sequences merge into a
            sequence whose quantity is their sum, so no oversell can appear —
            and the replay stands all the same, for :mod:`entries`' reason: an
            unreplayable ledger committed here raises on every reload, and that
            raise is **fatal at boot**, in an app the owner then cannot reach.
    """
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
