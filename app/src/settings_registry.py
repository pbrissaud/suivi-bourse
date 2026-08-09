"""The one list of dials in the product (issue #696, ADR-0014).

``setting(key, value)`` is a two-column table with no types at all, which is
deliberate: the table is a **mirror** of what a human chose, never the authority
on what a dial *is*. That authority is here, in code, and it is the reason a key
missing from the table is not a defect — it simply reads as the default written
below.

Two consequences the store leans on:

* **the seed is derived, not written twice.** :func:`seeded_defaults` is what
  ``store.open_store`` inserts, so adding a dial in a later version needs no
  migration — the idempotent insert at every boot completes the table by itself;
* **a key with no default is a question, not a hole.** ``base_currency`` has
  none (ADR-0002: the reporting currency has no default and is immutable once
  posed), so it is absent from the seed and :func:`default_for` answers ``None``.
  "Not answered yet" and "answered" must stay two states — a default here would
  silently interpret every amount already imported.

Pure by construction: no store, no environment, no clock. The validation bounds
and the *effect* of changing a value (which jobs to re-arm) belong to the
settings write path and join the specs there.
"""
from dataclasses import dataclass
from typing import Callable, Dict, Optional, Tuple


@dataclass(frozen=True)
class SettingSpec:
    """One dial: its key, what the code believes it is worth, and how to read it.

    ``default`` is stored as the string the table holds, so the seed and a
    hand-written ``UPDATE`` produce byte-identical rows; ``parse`` turns that
    string into the value the app uses. ``None`` means *no default* — the key is
    never seeded and reading it before it is written answers ``None``.
    """

    key: str
    default: Optional[str]
    parse: Callable[[str], object]
    doc: str


def _int(raw: str) -> int:
    return int(raw)


def _str(raw: str) -> str:
    return raw


#: Every dial v5 has, and there are no others. Three of v4's were deleted rather
#: than moved (the executor-pool pair, the ingestion interval and the perf
#: interval) — they were the only ones that would still have needed a restart,
#: so removing them is what leaves the settings page a single class of field.
SETTINGS: Tuple[SettingSpec, ...] = (
    SettingSpec('regular_interval', '120', _int,
                'Poll cadence, in seconds, of a symbol whose market is REGULAR.'),
    SettingSpec('backfill_interval', '60', _int,
                'How often, in seconds, the backfill job runs.'),
    SettingSpec('backfill_delay', '10', _int,
                'Politeness delay, in seconds, between two yfinance requests.'),
    SettingSpec('backfill_chunk_days', '365', _int,
                'Days of history fetched per backfill request.'),
    SettingSpec('staleness_horizon', '900', _int,
                'Price-freshness sonde horizon, in seconds. 0 disables it.'),
    SettingSpec('base_currency', None, _str,
                'The reporting currency. No default: it is asked, never assumed.'),
)

#: By key, for the O(1) lookups every other function here is built on.
BY_KEY: Dict[str, SettingSpec] = {spec.key: spec for spec in SETTINGS}


def spec_for(key: str) -> SettingSpec:
    """The spec of ``key``, or ``KeyError`` — an unknown dial is not a dial."""
    return BY_KEY[key]


def seeded_defaults() -> Dict[str, str]:
    """The rows the store inserts: every dial that *has* a default, as stored."""
    return {spec.key: spec.default
            for spec in SETTINGS if spec.default is not None}


def default_for(key: str):
    """The code's value for ``key``, parsed. ``None`` when it has no default."""
    spec = spec_for(key)
    return None if spec.default is None else spec.parse(spec.default)


def resolve(key: str, stored: Optional[str]):
    """The value of ``key`` given what the table holds — ``None`` for absent.

    The rule the whole module exists for, in one line: a row that is missing
    (or blank, which is what an emptied form field writes) falls back to the
    code, and the code is the only other place an answer can come from.
    """
    if stored is None or not str(stored).strip():
        return default_for(key)
    return spec_for(key).parse(str(stored))


__all__ = [
    'SettingSpec', 'SETTINGS', 'BY_KEY', 'spec_for', 'seeded_defaults',
    'default_for', 'resolve',
]
