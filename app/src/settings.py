"""The settings write path — the store's ``setting`` table (issue #701, ADR-0014).

The one writer of a dial is an HTTP request, and this module is where it lands.
Everything above it is a route (validate the body, answer a status) and
everything below it is two columns of text; what is here is the part that has to
be right whichever of the two calls it:

* **validate the whole body before writing any of it.** A ``PUT`` carrying five
  dials of which the fourth is out of bounds writes *nothing*. Half-applying it
  would leave the caller with a state they never asked for and no way to name
  it — and the form that sent it would re-render three fields it did not save.
* **write only what actually changed.** The comparison is against the value the
  store *resolves* to, not against the row: a dial answered by the code and
  re-posted at that same value is not a change, and must not be, because
  :mod:`main` re-arms exactly the jobs this function reports as changed. A save
  button that rewrote every row would reset every timer on every click.

Reading is the sibling half and lives here too, so that "what does this install
run?" and "change what this install runs" read the same table through the same
registry — the acceptance criterion that ``/api/config`` must not carry a second
enumeration of the dials.
"""
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Tuple

import settings_registry


@dataclass(frozen=True)
class Change:
    """One dial that moved: what it was worth, and what it is worth now.

    ``before`` is the *effective* value — the row if there was one, the code's
    default otherwise — because that is what the app was actually running on,
    and it is what :mod:`main` needs to decide which jobs the change reaches
    (``regular_interval``'s old value is what says which symbols were polling).
    """

    key: str
    before: Any
    after: Any


def read_all(store) -> Dict[str, Any]:
    """Every dial's effective value, by key. Absent rows read as the code's."""
    rows = dict(store.query('SELECT key, value FROM setting'))
    return {
        spec.key: settings_registry.resolve(spec.key, rows.get(spec.key))
        for spec in settings_registry.SETTINGS
    }


def describe(store) -> List[Dict[str, Any]]:
    """The dials, with everything a form or an inventory needs to render them.

    One pass over the registry, so the list a client sees *is* the registry.
    ``stored`` is published rather than derived from ``value != default``: a dial
    answered at its default value is answered, and a page that showed it as
    untouched would be telling the reader something the store does not say.
    """
    rows = dict(store.query('SELECT key, value FROM setting'))
    described = []
    for spec in settings_registry.SETTINGS:
        raw = rows.get(spec.key)
        described.append({
            'key': spec.key,
            'value': settings_registry.resolve(spec.key, raw),
            'default': settings_registry.default_for(spec.key),
            'type': spec.kind,
            'minimum': spec.minimum,
            'maximum': spec.maximum,
            'effect': spec.effect,
            'doc': spec.doc,
            'stored': raw is not None and str(raw).strip() != '',
        })
    return described


def save(store, values: Mapping[str, Any]) -> Tuple[Change, ...]:
    """Validate the whole body, write what moved, and say what moved.

    Atomic on **both** counts, and they are two different mechanisms: the
    validation pass runs before any statement does, and the statements then run
    inside one transaction. Without the second, a five-dial body that meets a
    disk-full or a closed connection on its third key leaves two dials committed
    at values the running process never applied — the store saying 300 s and the
    scheduler polling at 120 s until the next restart.

    Raises:
        settings_registry.InvalidSetting: an unknown key, a value of the wrong
            type, a value outside the dial's bounds, or a reporting currency
            that is no longer free to move. Nothing is written.
    """
    if not values:
        raise settings_registry.InvalidSetting(
            '', 'No setting was named; a write with nothing to write is a mistake')

    # Two passes, and the split is the point: the first can raise, the second
    # touches the store. There is no arrangement of one pass that keeps a
    # rejected body from having written its first three keys.
    validated = {key: settings_registry.validate(key, value)
                 for key, value in values.items()}

    current = read_all(store)
    pending = [(key, value) for key, value in validated.items()
               if current.get(key) != value]
    _refuse_a_reinterpretation(store, current, dict(pending))

    changes: List[Change] = []
    store.execute('BEGIN TRANSACTION')
    try:
        for key, value in pending:
            store.execute(
                'INSERT INTO setting (key, value) VALUES (?, ?) '
                'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
                [key, settings_registry.stored_form(key, value)])
            changes.append(Change(key, current.get(key), value))
    except Exception:
        store.execute('ROLLBACK')
        raise
    store.execute('COMMIT')
    return tuple(changes)


def _refuse_a_reinterpretation(store, current, pending) -> None:
    """Guard the one dial whose second answer would rewrite the past (ADR-0002).

    Every amount in the ledger is recorded *in the base currency*, so changing
    it once events exist does not convert anything — it silently re-reads three
    years of euros as dollars. ADR-0002 calls that the unrecoverable act, and it
    is the only reason this dial is not simply writable like the other five.

    The rule is the documented one and not a blunt write-once: **free while the
    ledger is empty, fixed from the first event**. With no event nothing has
    been interpreted, so nothing can be re-interpreted — which is what lets an
    install answer late, or think again before importing.

    What this does *not* do is say what a currency looks like: an ISO-4217
    check, and the import that answers the question on a headless install, are
    the currency ticket's. This is only the guard the write path owes the ADR
    on the day it becomes possible to write the dial at all.
    """
    if 'base_currency' not in pending:
        return
    if current.get('base_currency') is None:
        return  # never answered: this is the answer, not a change
    events = store.query('SELECT count(*) FROM event')[0][0]
    if events:
        raise settings_registry.InvalidSetting(
            'base_currency',
            f"base_currency is {current['base_currency']!r} and "
            f"{events} event(s) are recorded in it; changing it now would "
            f"reinterpret every amount already imported rather than convert "
            f"it. Forget those imports first.")


def change_for(changes: Tuple[Change, ...], key: str) -> Optional[Change]:
    """The change to ``key`` in ``changes``, or ``None`` — a tuple is short."""
    for change in changes:
        if change.key == key:
            return change
    return None


__all__ = ['Change', 'read_all', 'describe', 'save', 'change_for']
