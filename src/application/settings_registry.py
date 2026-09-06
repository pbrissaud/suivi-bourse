"""The one list of dials in the product (issue #696 then #701, ADR-0014)."""
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

NEXT_CYCLE = 'next_cycle'

REARM_SCRAPE = 'rearm_scrape'

REARM_BACKFILL_JOB = 'rearm_backfill_job'

REPAIR_CONVERSIONS = 'repair_conversions'

INTEGER = 'integer'

CURRENCY = 'currency'


class InvalidSetting(ValueError):
    """A value the registry refuses: unknown key, wrong type, out of bounds."""

    def __init__(self, key: str, message: str):
        super().__init__(message)
        self.key = key


@dataclass(frozen=True)
class SettingSpec:
    """One dial: what it is worth, what it may be worth, and what it moves."""

    key: str
    default: Optional[str]
    kind: str
    parse: Callable[[str], Any]
    effect: str
    doc: str
    minimum: Optional[int] = None
    maximum: Optional[int] = None
    attribute: Optional[str] = None
    required: bool = False


def _int(raw: str) -> int:
    return int(raw)


def _currency(raw: str) -> str:
    """An ISO-4217 code, upper-cased."""
    return str(raw).strip().upper()


_ONE_DAY = 86400

SETTINGS: Tuple[SettingSpec, ...] = (
    SettingSpec(
        'regular_interval', '120', INTEGER, _int, REARM_SCRAPE,
        'Poll cadence, in seconds, of a symbol whose market is REGULAR. It is '
        'also the base of the dead-ticker back-off, which it therefore '
        'rescales retroactively.',
        minimum=10, maximum=_ONE_DAY, attribute='regular_interval'),
    SettingSpec(
        'backfill_interval', '60', INTEGER, _int, REARM_BACKFILL_JOB,
        'How often, in seconds, the backfill job runs.',
        minimum=10, maximum=_ONE_DAY),
    SettingSpec(
        'backfill_delay', '10', INTEGER, _int, NEXT_CYCLE,
        'Politeness delay, in seconds, between two yfinance requests.',
        minimum=0, maximum=3600, attribute='backfill_delay'),
    SettingSpec(
        'backfill_chunk_days', '365', INTEGER, _int, NEXT_CYCLE,
        'Days of history fetched per backfill request.',
        minimum=1, maximum=3650, attribute='backfill_chunk_days'),
    SettingSpec(
        'staleness_horizon', '900', INTEGER, _int, NEXT_CYCLE,
        'Price-freshness sonde horizon, in seconds. 0 disables it.',
        minimum=0, maximum=_ONE_DAY, attribute='staleness_horizon'),
    SettingSpec(
        'base_currency', None, CURRENCY, _currency, REPAIR_CONVERSIONS,
        'The reporting currency, as an ISO-4217 code. No default: it is asked, '
        'never assumed, and it is fixed from the first recorded event.',
        attribute='base_currency', required=True),
)

BY_KEY: Dict[str, SettingSpec] = {spec.key: spec for spec in SETTINGS}


def spec_for(key: str) -> SettingSpec:
    """The spec of ``key``, or ``KeyError`` — an unknown dial is not a dial."""
    return BY_KEY[key]


def seeded_defaults() -> Dict[str, str]:
    """The rows the store inserts: every dial that *has* a default, as stored."""
    return {spec.key: spec.default
            for spec in SETTINGS if spec.default is not None}


def required_keys() -> Tuple[str, ...]:
    """The dials the app must be told, in the registry's order (ADR-0035)."""
    return tuple(spec.key for spec in SETTINGS if spec.required)


def default_for(key: str):
    """The code's value for ``key``, parsed. ``None`` when it has no default."""
    spec = spec_for(key)
    return None if spec.default is None else spec.parse(spec.default)


def defaults() -> Dict[str, Any]:
    """Every dial at its code value — the boot state before the store is read."""
    return {spec.key: default_for(spec.key) for spec in SETTINGS}


def resolve(key: str, stored: Optional[str]):
    """The value of ``key`` given what the table holds — ``None`` for absent."""
    if stored is None or not str(stored).strip():
        return default_for(key)
    return spec_for(key).parse(str(stored))


def validate(key: str, value: Any):
    """The value ``key`` would take, or :class:`InvalidSetting`."""
    try:
        spec = spec_for(key)
    except KeyError:
        raise InvalidSetting(key, f"Unknown setting {key!r}") from None

    if value is None or (isinstance(value, str) and not value.strip()):
        raise InvalidSetting(
            key, f"{key} has no value; a setting is answered, never blanked")
    if isinstance(value, bool):
        raise InvalidSetting(key, f"{key} is not a boolean")

    if spec.kind == INTEGER:
        parsed = _validate_integer(spec, value)
    elif spec.kind == CURRENCY:
        parsed = _validate_currency(spec, value)
    else:
        raise InvalidSetting(key, f"{key} has no validator for kind {spec.kind!r}")

    return parsed


def _validate_currency(spec: SettingSpec, value: Any) -> str:
    """Parse one ISO-4217 code. Shape only — never a list of codes."""
    parsed = spec.parse(value)
    if len(parsed) != 3 or not parsed.isalpha():
        raise InvalidSetting(
            spec.key,
            f"{spec.key} must be a three-letter ISO-4217 code (EUR, USD, GBP), "
            f"got {value!r}")
    return parsed


def _validate_integer(spec: SettingSpec, value: Any) -> int:
    """Parse and bound one integer dial. Split out to keep :func:`validate` flat."""
    if isinstance(value, float):
        if not value.is_integer():
            raise InvalidSetting(spec.key, f"{spec.key} must be a whole number")
        parsed = int(value)
    else:
        try:
            parsed = int(str(value).strip())
        except ValueError:
            raise InvalidSetting(
                spec.key, f"{spec.key} must be a whole number, got {value!r}"
            ) from None

    if spec.minimum is not None and parsed < spec.minimum:
        raise InvalidSetting(
            spec.key,
            f"{spec.key} must be at least {spec.minimum}, got {parsed}")
    if spec.maximum is not None and parsed > spec.maximum:
        raise InvalidSetting(
            spec.key,
            f"{spec.key} must be at most {spec.maximum}, got {parsed}")
    return parsed


def stored_form(key: str, value: Any) -> str:
    """The string the table holds for a validated ``value``."""
    spec = spec_for(key)
    return str(int(value)) if spec.kind == INTEGER else str(value)


__all__ = [
    'SettingSpec', 'InvalidSetting', 'SETTINGS', 'BY_KEY',
    'INTEGER', 'CURRENCY',
    'NEXT_CYCLE', 'REARM_SCRAPE', 'REARM_BACKFILL_JOB', 'REPAIR_CONVERSIONS',
    'spec_for', 'seeded_defaults', 'required_keys', 'default_for', 'defaults',
    'resolve', 'validate', 'stored_form',
]
