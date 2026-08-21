"""The one list of dials in the product (issue #696 then #701, ADR-0014).

``setting(key, value)`` is a two-column table with no types at all, which is
deliberate: the table is a **mirror** of what a human chose, never the authority
on what a dial *is*. That authority is here, in code, and it is the reason a key
missing from the table is not a defect — it simply reads as the default written
below.

Since #701 the module carries the whole of what a dial is, and not only its
default. The table has no types, so **the validation cannot live in the DDL**;
it lives where the error enters (ADR-0007) — the API's write path — and it reads
its rules from here: type, bounds, and *what changing the value triggers*. That
is what makes this the single list of dials: the write path validates against
it, the effective-configuration view enumerates it, and the form renders it. Four
lists that agreed on Monday disagree by Friday.

Three consequences the rest of the app leans on:

* **the seed is derived, not written twice.** :func:`seeded_defaults` is what
  ``store.open_store`` inserts, so adding a dial in a later version needs no
  migration — the idempotent insert at every boot completes the table by itself;
* **a key with no default is a question, not a hole.** ``base_currency`` has
  none (ADR-0002: the reporting currency has no default and is immutable once
  posed), so it is absent from the seed and :func:`default_for` answers ``None``.
  "Not answered yet" and "answered" must stay two states — a default here would
  silently interpret every amount already imported;
* **no dial requires a restart**, which is a property of *which dials exist*
  rather than of the machinery: the executor-pool pair was the one couple that
  would still have needed one — a ``ThreadPoolExecutor`` does not shrink hot —
  so it was deleted rather than moved, and sizing is always automatic. The
  settings page therefore has one class of field instead of two.

Pure by construction: no store, no environment, no clock, no scheduler. What a
change *does* is named here (:data:`REARM_SCRAPE` and friends) and performed in
:mod:`main`, which is the only module that holds a scheduler to perform it on.
"""
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

#: The dial feeds an attribute every cycle re-reads, and there is nothing to
#: re-arm: the next pass simply reads the new number.
NEXT_CYCLE = 'next_cycle'

#: Changing it re-arms the per-symbol scrape jobs — **only** those whose market
#: is open right now (see :func:`scheduling.rearm_split`). A sleeping symbol is
#: not mis-set, it is off-topic, and it reads the new value when it wakes.
REARM_SCRAPE = 'rearm_scrape'

#: Changing it reschedules the fixed-cadence backfill job.
REARM_BACKFILL_JOB = 'rearm_backfill_job'

#: Answering it makes the whole stock already scraped repairable (issue #704).
#: ``base_currency`` is the one dial whose value is retroactive: every point
#: written before it was answered carries ``price_converted NULL``, and those
#: rows are not lost — the lateral pass repairs them. The effect is therefore
#: *"start now"* rather than *"the next cycle will read it"*: the pass rides on
#: the backfill's cadence, so without this the owner answers the one question
#: the app asks and watches nothing happen for up to a full backfill interval,
#: on the gesture that unblocks every figure in the product.
REPAIR_CONVERSIONS = 'repair_conversions'

#: What a value *is*, for the form and for the error message. The table stores
#: strings either way; this says what the string has to be parseable as.
INTEGER = 'integer'

#: An ISO-4217 alphabetic code. Its own kind rather than a free string with a
#: comment, because the form has to render a currency field and the write path
#: has to refuse ``EURO`` — and a second list of "which string dials are really
#: currencies" is the fourth list ADR-0014 exists against.
CURRENCY = 'currency'


class InvalidSetting(ValueError):
    """A value the registry refuses: unknown key, wrong type, out of bounds.

    Carries ``key`` so the write path can name the field that was refused
    without re-parsing its own message.
    """

    def __init__(self, key: str, message: str):
        super().__init__(message)
        self.key = key


@dataclass(frozen=True)
class SettingSpec:
    """One dial: what it is worth, what it may be worth, and what it moves.

    ``default`` is stored as the string the table holds, so the seed and a
    hand-written ``UPDATE`` produce byte-identical rows; ``parse`` turns that
    string into the value the app uses. ``None`` means *no default* — the key is
    never seeded and reading it before it is written answers ``None``.

    ``minimum`` / ``maximum`` are inclusive and are the whole of the validation
    an integer dial gets. They are not cosmetic: ``regular_interval`` at ``0``
    is a busy loop against Yahoo Finance, and the table would take it happily.

    ``attribute`` names the ``SuiviBourseMetrics`` field the dial feeds when it
    has one, so applying a change is one loop over this list rather than five
    hand-written assignments that can fall out of step with it.
    """

    key: str
    default: Optional[str]
    kind: str
    parse: Callable[[str], Any]
    effect: str
    doc: str
    minimum: Optional[int] = None
    maximum: Optional[int] = None
    attribute: Optional[str] = None


def _int(raw: str) -> int:
    return int(raw)


def _str(raw: str) -> str:
    return raw


def _currency(raw: str) -> str:
    """An ISO-4217 code, upper-cased.

    Upper-casing here and **only** here is what keeps the two currency levels
    apart (issue #702). A *quote* currency is whatever the exchange spells it —
    ``GBp`` is London pence and differs from ``GBP`` by a factor of a hundred, so
    :mod:`fx` matches it case-sensitively and never upper-cases anything. A
    *reporting* currency is a code someone typed, so ``eur`` and ``EUR`` have to
    be the same answer or the store would hold two spellings of one dial.
    """
    return str(raw).strip().upper()


#: A day. Every interval is capped there rather than left open: past 24 hours a
#: cadence is indistinguishable from *off*, and the app has no *off*.
_ONE_DAY = 86400

#: Every dial v5 has, and there are no others. Four of v4's were deleted rather
#: than moved — the executor-pool pair, the ingestion interval and the perf
#: interval — and each for the same reason stated two ways: they either needed a
#: restart to take effect, or they had lost their subject.
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
        attribute='base_currency'),
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


def defaults() -> Dict[str, Any]:
    """Every dial at its code value — the boot state before the store is read."""
    return {spec.key: default_for(spec.key) for spec in SETTINGS}


def resolve(key: str, stored: Optional[str]):
    """The value of ``key`` given what the table holds — ``None`` for absent.

    The rule the whole module exists for, in one line: a row that is missing
    (or blank, which is what an emptied form field writes) falls back to the
    code, and the code is the only other place an answer can come from.
    """
    if stored is None or not str(stored).strip():
        return default_for(key)
    return spec_for(key).parse(str(stored))


def validate(key: str, value: Any):
    """The value ``key`` would take, or :class:`InvalidSetting`.

    The write path's whole rule, and it is here rather than there because the
    bounds are part of what a dial *is*. Accepts what JSON hands a handler — a
    number or the string of one — and answers the parsed value, so a caller
    never has to decide whether ``"120"`` and ``120`` are the same request.
    They are.

    ``None`` and a blank string are refused rather than read as *reset to the
    default*. :func:`resolve` does treat a blank **row** as the default, and
    that asymmetry is deliberate: a blank row is a store that has never been
    answered, while a blank *request* is a form field someone emptied — and
    answering it with the default would make "I cleared this by accident" and
    "I want the default" the same gesture.
    """
    try:
        spec = spec_for(key)
    except KeyError:
        raise InvalidSetting(key, f"Unknown setting {key!r}") from None

    if value is None or (isinstance(value, str) and not value.strip()):
        raise InvalidSetting(
            key, f"{key} has no value; a setting is answered, never blanked")
    if isinstance(value, bool):
        # ``bool`` is an ``int`` in Python, so ``True`` would pass the integer
        # branch below and store as ``1``. No dial is a flag; refuse it.
        raise InvalidSetting(key, f"{key} is not a boolean")

    if spec.kind == INTEGER:
        parsed = _validate_integer(spec, value)
    elif spec.kind == CURRENCY:
        parsed = _validate_currency(spec, value)
    else:
        # Not a fallback: a kind with no validator is a defect of **this**
        # registry, and answering it by stripping the string would let a dial
        # through unvalidated. There was a ``STRING`` kind here that no spec
        # ever used, which is what made this branch look like a default.
        raise InvalidSetting(key, f"{key} has no validator for kind {spec.kind!r}")

    return parsed


def _validate_currency(spec: SettingSpec, value: Any) -> str:
    """Parse one ISO-4217 code. Shape only — never a list of codes.

    Three letters is the whole rule, and stopping there is deliberate. A closed
    list would have to be maintained, would refuse a currency the day it is
    created or renamed, and — worse — would be a *second* authority on what a
    currency is beside the exchange that quotes one. What the shape check buys is
    the mistake that actually happens: ``EURO``, ``€``, or a symbol pasted out of
    a broker page, each of which would otherwise become a pair name Yahoo cannot
    resolve and a portfolio with no converted price and no reason given.
    """
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
        # JSON has one number type, so ``120`` reaches a handler as ``120.0``
        # over the wire and as ``120`` from a test. Both are the same request;
        # ``120.5`` is not one, and ``int(str(120.0))`` raises rather than
        # rounding, which is why the float is handled before the string.
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
    """The string the table holds for a validated ``value``.

    One place, so a value written by the API and the same value written by the
    seed are byte-identical — otherwise ``120`` and ``120.0`` would be two rows
    apart on a comparison that decides whether a job is re-armed.
    """
    spec = spec_for(key)
    return str(int(value)) if spec.kind == INTEGER else str(value)


__all__ = [
    'SettingSpec', 'InvalidSetting', 'SETTINGS', 'BY_KEY',
    'INTEGER', 'CURRENCY',
    'NEXT_CYCLE', 'REARM_SCRAPE', 'REARM_BACKFILL_JOB', 'REPAIR_CONVERSIONS',
    'spec_for', 'seeded_defaults', 'default_for', 'defaults', 'resolve',
    'validate', 'stored_form',
]
