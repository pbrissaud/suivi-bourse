"""The settings the agent proposes (#1628): one key, its value, and the owner's
decision.

**The agent never writes a setting, it proposes one; only the UI confirms.**
:func:`propose` is the agent's one write and lands in ``proposal``.
:func:`confirm` marks the row ``merged`` and applies nothing: its caller does,
once the decision has won, through the road the settings page itself takes.

The row's life is :mod:`application.proposals`'; ``now`` is always injected.
"""
from datetime import datetime
from typing import Any, List, Literal, Optional, Sequence, TypedDict
from uuid import uuid4

from application import boot_env
from application import instants
from application import proposals
from application.proposals import ProposalNotReady, UnknownProposal

KIND = 'setting'

#: The settings the agent may propose: the log level, and nothing else yet.
KEYS = ('log_level',)

#: A setting never goes ``stale``: that is the events' (``proposals.Status``).
Status = Literal['ready', 'merged', 'ignored', 'expired']


class SettingProposal(TypedDict):
    id: str
    key: str
    value: Any
    #: The setting's value when the proposal was made: the card's *from*.
    previous: Any
    status: Status
    created_at: str
    decided_at: Optional[str]


class SettingProposalDecided(TypedDict):
    proposal: SettingProposal


class SettingProposalsPayload(TypedDict):
    proposals: List[SettingProposal]


class InvalidSettingProposal(ValueError):
    """A key outside :data:`KEYS`, or a value its setting does not take."""


def validate(key: Any, value: Any) -> str:
    """``value`` as it would be applied, or :class:`InvalidSettingProposal`.

    Read against the levels ``main.set_log_level`` takes, and never by calling
    it: that would apply the level.
    """
    if key not in KEYS:
        raise InvalidSettingProposal(
            f"{key!r} is not a setting that can be proposed; the only one is "
            f"{', '.join(KEYS)}. The owner changes any other setting "
            f"themself, in the app's Settings")
    level = value.strip().upper() if isinstance(value, str) else None
    if level not in boot_env.LOG_LEVELS:
        raise InvalidSettingProposal(
            f"the log level is one of {', '.join(boot_env.LOG_LEVELS)}")
    return level


def propose(store, key: Any, value: Any, current: str, now: datetime) -> str:
    """Record a proposal, ``ready``, and its id. Writes no setting.

    ``current`` is the setting's value now, kept so the card reads
    *from → to* whatever the setting has become since.
    """
    value = validate(key, value)
    if value == current:
        raise InvalidSettingProposal(f"the log level is already {current}")
    proposal_id = uuid4().hex
    proposals.insert(
        store, KIND, {'key': key, 'value': value, 'previous': current},
        proposal_id, now)
    return proposal_id


def confirm(store, proposal_id: str, now: datetime) -> SettingProposal:
    """Mark the proposal ``merged``. The caller applies ``value`` after."""
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
    return {'id': row['id'], 'key': row['key'], 'value': row['value'],
            'previous': row['previous'],
            'status': proposals.status(row, now),
            'created_at': instants.iso(row['created_at']),
            'decided_at': instants.iso(row['decided_at'])}
