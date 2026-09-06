"""The settings write path — the store's ``setting`` table (issue #701, ADR-0014)."""
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Tuple

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
    return tuple(changes)


def _refuse_a_reinterpretation(store, current, pending) -> None:
    """Guard the one dial whose second answer would rewrite the past (ADR-0002)."""
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
