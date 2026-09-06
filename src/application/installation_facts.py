"""The installation facts — a tiny table carrying an acknowledgement."""
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from logfmt_logger import getLogger

from application import boot_env
from application import fx
from application import instants

logger = getLogger("installation_facts")

DERIVED = 'derived'

RECORDED = 'recorded'

UNOBSERVED = object()

UNREAD_ENVIRONMENT = 'unread_environment'
RECONSTRUCTION_RUNNING = 'reconstruction_running'
ASSUMED_BASE_CURRENCY = 'assumed_base_currency'


class UnknownFact(KeyError):
    """A key no installation fact carries. The registry is closed, so this is a mistake."""


class FactNotStanding(LookupError):
    """The key is one of the three, and nothing is standing under it right now."""


@dataclass(frozen=True)
class Context:
    """What the derivable observations read, gathered by the caller."""

    unread_variables: Optional[Tuple[str, ...]] = None

    reconstruction: Optional[Tuple[int, int]] = None

    @property
    def reconstruction_concluded(self) -> bool:
        """Every series has reached its first acquisition — *and it was observed*."""
        if self.reconstruction is None:
            return False
        complete, total = self.reconstruction
        return total > 0 and complete >= total


def unread_environment() -> List[str]:
    """The ``SB_*``/``INFLUXDB_*`` variables that are set and no longer read."""
    return list(boot_env.unread(os.environ))


def observe(workloads=None) -> 'Context':
    """Gather what the derivable installation facts' predicates read (#709)."""
    return Context(
        unread_variables=tuple(unread_environment()),
        reconstruction=(None if workloads is None
                        else workloads.reconstruction_state()),
    )


@dataclass(frozen=True)
class FactSpec:
    """One installation fact: what makes it stand, and what it says when it does."""

    key: str
    kind: str
    observe: Callable[[Any, Context], Any]
    message: Callable[[Mapping[str, Any]], str]
    doc: str
    level: int = logging.WARNING


@dataclass(frozen=True)
class InstallationFact:
    """A standing installation fact: its row, plus what it names *right now*."""

    key: str
    first_seen_at: datetime
    acknowledged_at: Optional[datetime]
    message: str
    detail: Optional[Dict[str, Any]]

    @property
    def acknowledged(self) -> bool:
        return self.acknowledged_at is not None

    def to_dict(self) -> Dict[str, Any]:
        """The JSON shape. ``acknowledged`` is published beside its date because a client branches on the boolean and displays the instant."""
        return {
            'key': self.key,
            'first_seen_at': instants.iso(self.first_seen_at),
            'acknowledged': self.acknowledged,
            'acknowledged_at': instants.iso(self.acknowledged_at),
            'message': self.message,
            'detail': self.detail,
        }


def _observe_unread_environment(opened, context: Context):
    """The ``SB_*`` / ``INFLUXDB_*`` variables that are set and obeyed by nothing."""
    if context.unread_variables is None:
        return UNOBSERVED
    if not context.unread_variables:
        return None
    return {'variables': list(context.unread_variables)}


def _observe_reconstruction(opened, context: Context):
    """How far the historical reconstruction has got — process memory only."""
    if context.reconstruction is None:
        return UNOBSERVED
    complete, total = context.reconstruction
    if total <= 0 or complete >= total:
        return None
    return {'complete': complete, 'total': total, 'remaining': total - complete}


def _observe_assumed_base_currency(opened, context: Context):
    """The events whose amounts were taken to be in the reporting currency."""
    base = opened.setting('base_currency')
    if not base:
        return None

    target, _ = fx.normalise(base)
    rows = opened.query(
        'SELECT e.id, e.date, e.event_type, e.symbol, e.account, q.currency '
        'FROM event e JOIN symbol_quote q ON q.symbol = e.symbol '
        'WHERE q.currency IS NOT NULL '
        '  AND (e.unit_price IS NOT NULL OR e.fee IS NOT NULL '
        '       OR e.amount IS NOT NULL) '
        'ORDER BY e.date, e.id')

    events: List[Dict[str, Any]] = []
    for identifier, day, event_type, symbol, account, currency in rows:
        quoted, _ = fx.normalise(currency)
        if quoted is None or quoted == target:
            continue
        events.append({
            'id': identifier,
            'date': day.isoformat() if day is not None else None,
            'event_type': event_type,
            'symbol': symbol,
            'account': account,
            'quote_currency': currency,
        })

    if not events:
        return None
    return {
        'base_currency': base,
        'events': events,
        'symbols': sorted({event['symbol'] for event in events}),
        'currencies': sorted({event['quote_currency'] for event in events}),
    }


def _say_unread_environment(detail: Mapping[str, Any]) -> str:
    variables = detail['variables']
    return (
        f"{len(variables)} environment variable(s) are set and read by nothing: "
        f"{', '.join(variables)}. The settings they named live in the store "
        f"since v5 — set them on the settings page, or with one "
        f"PUT /api/settings — and those that were removed have no replacement "
        f"at all. Unset them, or acknowledge this notice.")


def _say_reconstruction(detail: Mapping[str, Any]) -> str:
    return (
        f"The historical reconstruction is running: {detail['complete']} of "
        f"{detail['total']} series have reached their first acquisition. Your "
        f"performance figures are computed from the history stored so far and "
        f"will keep moving until it is complete.")


def _say_assumed_base_currency(detail: Mapping[str, Any]) -> str:
    base = detail['base_currency']
    return (
        f"Your amounts were read as {base}. {len(detail['events'])} event(s) on "
        f"{len(detail['symbols'])} line(s) quoted in "
        f"{', '.join(detail['currencies'])} ({', '.join(detail['symbols'])}) "
        f"were imported before any price had been observed, so this version took "
        f"the amounts in your files to be {base} already. If your broker "
        f"exported them in the security's own currency, re-export those lines "
        f"in {base} and drop the file again; if they were already in {base}, "
        f"acknowledge this notice.")


SPECS: Tuple[FactSpec, ...] = (
    FactSpec(
        UNREAD_ENVIRONMENT, DERIVED, _observe_unread_environment,
        _say_unread_environment,
        'Environment variables are set that this version reads for nothing.'),
    FactSpec(
        RECONSTRUCTION_RUNNING, DERIVED, _observe_reconstruction,
        _say_reconstruction,
        'The historical reconstruction has not reached every first acquisition.',
        level=logging.INFO),
    FactSpec(
        ASSUMED_BASE_CURRENCY, RECORDED, _observe_assumed_base_currency,
        _say_assumed_base_currency,
        'Amounts imported from files were taken to be in the reporting currency.'),
)

BY_KEY: Dict[str, FactSpec] = {spec.key: spec for spec in SPECS}


def spec_for(key: str) -> FactSpec:
    """The spec of ``key``, or :class:`UnknownFact` — the list is closed."""
    try:
        return BY_KEY[key]
    except KeyError:
        raise UnknownFact(key) from None


@dataclass(frozen=True)
class _Row:
    """The three columns, and there are only ever three."""

    key: str
    first_seen_at: datetime
    acknowledged_at: Optional[datetime]


def _rows(opened) -> Dict[str, _Row]:
    """Every row the table holds, by key. It has three at the very most."""
    return {
        key: _Row(key, instants.utc(first_seen_at), instants.utc(acknowledged_at))
        for key, first_seen_at, acknowledged_at in opened.query(
            'SELECT key, first_seen_at, acknowledged_at FROM installation_fact')
    }


def refresh(opened, context: Context,
            now: Optional[datetime] = None) -> List[InstallationFact]:
    """Re-observe every installation fact, arm what stands, drop what no longer does."""
    now = now or datetime.now(timezone.utc)
    rows = _rows(opened)
    standing: List[InstallationFact] = []

    for spec in SPECS:
        detail = spec.observe(opened, context)
        row = rows.get(spec.key)

        if detail is UNOBSERVED:
            if row is not None:
                standing.append(_fact(spec, row, None))
            continue

        if detail is None:
            if row is not None:
                _drop(opened, spec.key)
            continue

        if row is None:
            if spec.kind == RECORDED:
                continue
            row = _arm(opened, spec, detail, now)
        standing.append(_fact(spec, row, detail))

    return standing


def record(opened, key: str, context: Context,
           now: Optional[datetime] = None) -> Optional[InstallationFact]:
    """Arm a :data:`RECORDED` installation fact — the event half, called where it happens."""
    spec = spec_for(key)
    if spec.kind != RECORDED:
        raise ValueError(
            f"{key} is a derivable installation fact; refresh() arms it, "
            f"not record()")

    detail = spec.observe(opened, context)
    if detail is None or detail is UNOBSERVED:
        return None
    if _rows(opened).get(key) is not None:
        return None

    row = _arm(opened, spec, detail, now or datetime.now(timezone.utc))
    return _fact(spec, row, detail)


def listing(opened, context: Context) -> List[InstallationFact]:
    """What the API answers: the rows that stand, each re-derived at this instant."""
    rows = _rows(opened)
    shown: List[InstallationFact] = []
    for spec in SPECS:
        row = rows.get(spec.key)
        if row is None:
            continue
        if row.acknowledged_at is not None:
            continue
        detail = spec.observe(opened, context)
        if detail is UNOBSERVED or detail is None:
            detail = None
        shown.append(_fact(spec, row, detail))
    return shown


def acknowledge(opened, key: str, context: Optional[Context] = None,
                now: Optional[datetime] = None) -> InstallationFact:
    """Acknowledge one installation fact. The only gesture the table offers."""
    spec = spec_for(key)
    row = _rows(opened).get(key)
    if row is None:
        raise FactNotStanding(key)

    if row.acknowledged_at is None:
        acknowledged_at = now or datetime.now(timezone.utc)
        with opened.transaction():
            opened.execute(
                'UPDATE installation_fact SET acknowledged_at = ? WHERE key = ?',
                [acknowledged_at, key])
        row = _Row(key, row.first_seen_at, acknowledged_at)

    detail = spec.observe(opened, context or Context())
    if detail is UNOBSERVED or detail is None:
        detail = None
    return _fact(spec, row, detail)


def _arm(opened, spec: FactSpec, detail: Mapping[str, Any],
         now: datetime) -> _Row:
    """Write the row and say it once, in logfmt."""
    with opened.transaction():
        opened.execute(
            'INSERT INTO installation_fact (key, first_seen_at, acknowledged_at) '
            'VALUES (?, ?, NULL) ON CONFLICT (key) DO NOTHING',
            [spec.key, now])
    logger.log(spec.level, spec.message(detail), extra={'context': {
        'installation_fact': spec.key,
        'first_seen_at': instants.iso(now),
    }})
    return _Row(spec.key, now, None)


def _drop(opened, key: str) -> None:
    """Take the row away, acknowledgement included. See :func:`refresh`."""
    with opened.transaction():
        opened.execute('DELETE FROM installation_fact WHERE key = ?', [key])


def _fact(spec: FactSpec, row: _Row,
          detail: Optional[Mapping[str, Any]]) -> InstallationFact:
    """Join a row to what its observation named, or to nothing at all."""
    return InstallationFact(
        key=row.key,
        first_seen_at=row.first_seen_at,
        acknowledged_at=row.acknowledged_at,
        message=spec.message(detail) if detail else spec.doc,
        detail=dict(detail) if detail else None,
    )


__all__ = [
    'InstallationFact', 'FactSpec', 'Context', 'UnknownFact',
    'FactNotStanding', 'DERIVED', 'RECORDED', 'UNOBSERVED',
    'UNREAD_ENVIRONMENT',
    'RECONSTRUCTION_RUNNING', 'ASSUMED_BASE_CURRENCY',
    'SPECS', 'BY_KEY', 'spec_for',
    'refresh', 'record', 'listing', 'acknowledge',
]
