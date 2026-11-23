"""The settings the agent proposes (#1628, #1629): one key, its value, and the
owner's decision.

**The agent never writes a setting, it proposes one; only the UI confirms.**
:func:`propose` is the agent's one write and lands in ``proposal``.
:func:`confirm` marks the row ``merged`` and applies nothing. A stored setting
is written just before it by :func:`write`, through ``settings.save``, the
road the settings page itself takes; the log level is applied by the caller
once the decision has won.

The row's life is :mod:`application.proposals`'; ``now`` is always injected.
"""
from datetime import datetime
from typing import Any, List, Literal, Optional, Sequence, Tuple, TypedDict
from uuid import uuid4

from application import benchmarks
from application import boot_env
from application import instants
from application import proposals
from application import settings
from application import settings_registry
from application.proposals import ProposalNotReady, UnknownProposal

KIND = 'setting'

#: The process's own setting: applied until the next restart, never stored.
LOG_LEVEL = 'log_level'

#: The stored settings the agent may propose (#1629), an explicit list:
#: ``base_currency`` is in the registry and not here, so it stays refused.
STORED = ('update_check', 'staleness_horizon', 'backfill_delay',
          'backfill_chunk_days', 'regular_interval', 'backfill_interval',
          'benchmark_symbols', 'benchmark_symbol')

#: The settings the agent may propose, and nothing else.
KEYS = (LOG_LEVEL, *STORED)

#: Said with a refused comparison fund, so the agent offers one that exists.
OFFERED = 'The offered references are ' + ', '.join(
    f'{b.symbol} ({b.index})' for b in benchmarks.BENCHMARKS)

#: A setting never goes ``stale``: that is the events' (``proposals.Status``).
Status = Literal['ready', 'merged', 'ignored', 'expired']


class SettingProposal(TypedDict):
    id: str
    key: str
    value: Any
    #: The setting's value when the proposal was made: the card's *from*.
    previous: Any
    #: The registry's line on a stored setting; ``None`` for the log level.
    doc: Optional[str]
    status: Status
    created_at: str
    decided_at: Optional[str]


class SettingProposalDecided(TypedDict):
    proposal: SettingProposal


class SettingProposalsPayload(TypedDict):
    proposals: List[SettingProposal]


class InvalidSettingProposal(ValueError):
    """A key outside :data:`KEYS`, or a value its setting does not take."""


class SettingMoved(ValueError):
    """The stored value is no longer the one the proposal was made from."""


def validate(key: Any, value: Any) -> Any:
    """``value`` as it would be applied, or :class:`InvalidSettingProposal`.

    A stored setting is read by the registry's own validator. The log level
    is read against the levels ``main.set_log_level`` takes, and never by
    calling it: that would apply the level.
    """
    if key not in KEYS:
        raise InvalidSettingProposal(
            f"{key!r} is not a setting that can be proposed; those are "
            f"{', '.join(KEYS)}. The owner changes any other setting "
            f"themself, in the app's Settings")
    if key != LOG_LEVEL:
        if key == 'benchmark_symbols' and isinstance(value, str) \
                and value.strip():
            # A model writes one fund as a string as readily as a list.
            value = value.split(',')
        try:
            return settings_registry.validate(key, value)
        except settings_registry.InvalidSetting as exc:
            offered = f'. {OFFERED}' if key.startswith('benchmark_') else ''
            raise InvalidSettingProposal(f'{exc}{offered}') from None
    level = value.strip().upper() if isinstance(value, str) else None
    if level not in boot_env.LOG_LEVELS:
        raise InvalidSettingProposal(
            f"the log level is one of {', '.join(boot_env.LOG_LEVELS)}")
    return level


def propose(store, key: Any, value: Any, log_level: str,
            now: datetime) -> str:
    """Record a proposal, ``ready``, and its id. Writes no setting.

    The setting's value now is kept with it, so the card reads *from → to*
    and :func:`write` can tell a setting that moved since. ``log_level`` is
    the process's, which no store holds.
    """
    value = validate(key, value)
    current = log_level if key == LOG_LEVEL else settings.read_all(store)[key]
    if value == current:
        raise InvalidSettingProposal(f"{key} is already {current}")
    proposal_id = uuid4().hex
    proposals.insert(
        store, KIND, {'key': key, 'value': value, 'previous': current},
        proposal_id, now)
    return proposal_id


def write(store, proposal_id: str, now: datetime,
          is_ready=None) -> Tuple[settings.Change, ...]:
    """Write a ready proposal's stored setting, and say what moved.

    Called before :func:`confirm`, under the same writers' mutex, so a write
    ``settings.save`` refuses leaves the proposal ``ready``. Its guards are
    ``PUT /api/settings``'; ``is_ready`` is the comparison's gate. A setting
    that is no longer at ``previous`` is :class:`SettingMoved`. Nothing is
    written for the log level, nor for a proposal that is not ready:
    :func:`confirm` says why.
    """
    # ponytail: two transactions, as ``settings.save`` opens its own and DuckDB
    # does not nest them. A store that fails between the two leaves the setting
    # written and the card ready; one transaction if that is ever seen.
    found = read(store, [proposal_id], now)
    if not found or found[0]['status'] != 'ready' \
            or found[0]['key'] == LOG_LEVEL:
        return ()
    key, value = found[0]['key'], found[0]['value']
    if settings.read_all(store)[key] != found[0]['previous']:
        raise SettingMoved(key)
    return settings.save(store, {key: value}, is_ready)


def confirm(store, proposal_id: str, now: datetime) -> SettingProposal:
    """Mark the proposal ``merged``. A stored setting is written before, by
    :func:`write`; the caller applies a log level after."""
    return _decide(store, proposal_id, 'merged', now)


def ignore(store, proposal_id: str, now: datetime) -> SettingProposal:
    """Mark the proposal ``ignored``; nothing else changes."""
    return _decide(store, proposal_id, 'ignored', now)


def read(store, ids: Sequence[str], now: datetime) -> List[SettingProposal]:
    """The proposals ``ids`` name, in that order; an unknown id is omitted."""
    rows = proposals.fetch(store, KIND, ids)
    return [_shape(rows[i], now) for i in ids if i in rows]


def _decide(store, proposal_id: str, decided: str,
            now: datetime) -> SettingProposal:
    """Decide a proposal that is still ready, or say why not: an id that names
    none is :class:`UnknownProposal`, any other is :class:`ProposalNotReady`."""
    won = proposals.decide(store, KIND, proposal_id, decided, now)
    rows = proposals.fetch(store, KIND, [proposal_id])
    if not rows:
        raise UnknownProposal(proposal_id)
    if not won:
        raise ProposalNotReady(proposals.status(rows[proposal_id], now))
    return _shape(rows[proposal_id], now)


def _shape(row: dict, now: datetime) -> SettingProposal:
    spec = settings_registry.BY_KEY.get(row['key'])
    return {'id': row['id'], 'key': row['key'], 'value': row['value'],
            'previous': row['previous'], 'doc': spec.doc if spec else None,
            'status': proposals.status(row, now),
            'created_at': instants.iso(row['created_at']),
            'decided_at': instants.iso(row['decided_at'])}
