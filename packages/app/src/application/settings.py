"""The settings write path — the store's ``setting`` table (issue #701)."""
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

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


def save(store, values: Mapping[str, Any],
         is_ready: Optional[Callable[[str], bool]] = None
         ) -> Tuple[Change, ...]:
    """Validate the whole body, write what moved, and say what moved.

    ``is_ready`` is the comparison's gate (#1312): given, it refuses a
    ``benchmark_symbol`` whose history is not complete. The followed-list
    invariant needs no store beyond this one and always holds.
    """
    if not values:
        raise settings_registry.InvalidSetting(
            '', 'No setting was named; a write with nothing to write is a mistake')

    validated = {key: settings_registry.validate(key, value)
                 for key, value in values.items()}

    current = read_all(store)
    pending = [(key, value) for key, value in validated.items()
               if current.get(key) != value]
    _refuse_a_reinterpretation(store, current, dict(pending))
    pending = list(_keep_the_chosen_reference_followed(
        current, dict(pending), is_ready).items())

    changes: List[Change] = []
    with store.transaction():
        for key, value in pending:
            store.execute(
                'INSERT INTO setting (key, value) VALUES (?, ?) '
                'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
                [key, settings_registry.stored_form(key, value)])
            changes.append(Change(key, current.get(key), value))
        _remember_the_references(store, dict(pending))
    return tuple(changes)


def _keep_the_chosen_reference_followed(current, pending, is_ready
                                        ) -> Dict[str, Any]:
    """The displayed reference is always a followed one (#1312).

    A choice outside the followed list, or not complete yet, is refused; and
    dropping the displayed ETF from the list clears the choice with it, so the
    page falls back instead of showing a reference nobody follows.
    """
    following = pending.get('benchmark_symbols', current['benchmark_symbols'])
    chosen = pending.get('benchmark_symbol', current['benchmark_symbol'])
    if 'benchmark_symbol' in pending and chosen:
        if chosen not in following:
            raise settings_registry.InvalidSetting(
                'benchmark_symbol',
                f"{chosen} is not followed; follow it first")
        if is_ready is not None and not is_ready(chosen):
            raise settings_registry.InvalidSetting(
                'benchmark_symbol',
                f"{chosen} is still being downloaded; it can be displayed "
                f"once its history is complete")
    elif chosen and chosen not in following:
        pending['benchmark_symbol'] = None
    return pending


def _remember_the_references(store, pending) -> None:
    """Keep the series of every ETF the owner follows (#760, #1312).

    ``ledger.orphan_symbols`` protects the reference the dial points at *right
    now* and the consulted ones, so a followed ETF goes in the consulted list in
    the write itself: one not recorded a moment after it was followed is one the
    purge can catch in between. **Unfollowing never forgets** — the series stays
    until ``forget_consulted_benchmark`` is asked for, by name.

    Inside the write transaction on purpose.
    """
    if 'benchmark_symbols' in pending:
        ledger.record_consulted_benchmark(store, *pending['benchmark_symbols'])


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
