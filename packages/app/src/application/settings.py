"""The settings write path — the store's ``setting`` table (issue #701)."""
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Tuple

from application import ledger
from application import settings_registry


@dataclass(frozen=True)
class Change:
    """One dial that moved: what it was worth, and what it is worth now."""

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
    """The dials, with everything a form or an inventory needs to render them."""
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
            'required': spec.required,
            'stored': raw is not None and str(raw).strip() != '',
        })
    return described


def save(store, values: Mapping[str, Any]) -> Tuple[Change, ...]:
    """Validate the whole body, write what moved, and say what moved."""
    if not values:
        raise settings_registry.InvalidSetting(
            '', 'No setting was named; a write with nothing to write is a mistake')

    validated = {key: settings_registry.validate(key, value)
                 for key, value in values.items()}

    current = read_all(store)
    pending = [(key, value) for key, value in validated.items()
               if current.get(key) != value]
    _refuse_a_reinterpretation(store, current, dict(pending))

    changes: List[Change] = []
    with store.transaction():
        for key, value in pending:
            store.execute(
                'INSERT INTO setting (key, value) VALUES (?, ?) '
                'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
                [key, settings_registry.stored_form(key, value)])
            changes.append(Change(key, current.get(key), value))
        _remember_the_reference(store, current, dict(pending))
    return tuple(changes)


def _remember_the_reference(store, current, pending) -> None:
    """Keep the series of a reference that is being switched away from (#760).

    ``ledger.orphan_symbols`` protects the reference the dial points at *right
    now*, so the moment the dial moves the previous one is an orphan and the
    next purge takes the history the backfill spent hours on. Both go in the
    consulted list: the new one because it is about to be fetched, and the old
    one because it has been — including the one chosen before this list
    existed, which is in no list and would otherwise be lost on its first
    switch.

    **Emptying the field is the opposite gesture and is left alone.** #982 made
    a blank the one route for retiring a reference, and the only way the owner
    ever gets those years of closes back off their disk; protecting what it
    releases would fossilise every ticker ever typed. So a switch keeps both,
    and a blank forgets.

    Inside the write transaction on purpose. A reference remembered a moment
    after the dial moved is a reference the purge can catch in between.
    """
    if 'benchmark_symbol' not in pending:
        return
    chosen = pending['benchmark_symbol']
    previous = current.get('benchmark_symbol')
    if chosen:
        ledger.record_consulted_benchmark(store, chosen, previous)
    elif previous:
        ledger.forget_consulted_benchmark(store, previous)


def _refuse_a_reinterpretation(store, current, pending) -> None:
    """Guard the one dial whose second answer would rewrite the past."""
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


__all__ = ['Change', 'read_all', 'describe', 'save']
