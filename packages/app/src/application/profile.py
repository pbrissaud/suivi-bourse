"""The investor's profile (#1116): four declared facts, and the proposals the
agent makes about them.

**The agent never writes a fact, it proposes one; only the UI confirms.**
:func:`propose` is the agent's one write and lands in ``proposal``;
:func:`confirm`, :func:`put` and :func:`forget` are the app's, and the only
writers of ``profile_fact``. Every write runs under
``ConfigurationManager.writing()``; ``now`` is always injected.

A ``ready`` proposal older than :data:`EXPIRY` reads ``expired``. Nothing
stores that: no background job, the write mutex is busy enough (#972).
"""
import json
import math
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Literal, Optional, Sequence, TypedDict
from uuid import uuid4

from application import instants

EXPIRY = timedelta(days=7)

#: The facts that are one value each; projects are ``project:<id>``.
FACTS = ('income', 'marginal_rate', 'risk_tolerance')
RISK_TOLERANCES = ('prudent', 'balanced', 'dynamic')
MARGINAL_RATE_MAX = 0.6
LABEL_MAX = 80
HORIZON_YEARS = 50
#: A new project's key in a proposal; confirming it mints ``project:<id>``.
NEW_PROJECT = 'project'

_PROJECT_KEY = re.compile(r'project:[0-9a-f]{12}')
_PROPOSAL_ID = re.compile(r'[0-9a-f]{32}')


class Fact(TypedDict):
    value: Any
    confirmed_at: str


class Project(TypedDict):
    id: str
    label: str
    target_year: int
    amount: Optional[float]
    confirmed_at: str


class Profile(TypedDict):
    facts: Dict[str, Fact]
    projects: List[Project]


Status = Literal['ready', 'merged', 'ignored', 'expired']


class Proposal(TypedDict):
    id: str
    key: str
    value: Any
    status: Status
    created_at: str
    decided_at: Optional[str]


class Confirmed(TypedDict):
    proposal: Proposal
    profile: Profile


class Ignored(TypedDict):
    proposal: Proposal


class ProposalsPayload(TypedDict):
    proposals: List[Proposal]


class InvalidProfileFact(ValueError):
    """A value the profile does not take, said in words naming the rule."""

    def __init__(self, message: str, key: str):
        super().__init__(message)
        self.key = key


class UnknownFact(LookupError):
    """A key that names no fact this profile has, or could have."""


class UnknownProposal(LookupError):
    """An id no proposal carries."""


class ProposalNotReady(Exception):
    """A proposal already decided, or expired: nothing is written twice."""

    def __init__(self, status: str):
        super().__init__(f"the proposal is {status}, not ready")
        self.status = status


def is_key(key: str) -> bool:
    """A key a fact can be stored under."""
    return key in FACTS or bool(_PROJECT_KEY.fullmatch(key))


def is_proposal_id(text: str) -> bool:
    return bool(_PROPOSAL_ID.fullmatch(text))


def validate(key: Any, value: Any, now: datetime) -> Any:
    """``value`` as stored, or :class:`InvalidProfileFact` naming the rule."""
    if key == 'income':
        if not isinstance(value, dict) or set(value) != {'amount'}:
            raise InvalidProfileFact(
                "an income is {\"amount\": <annual amount>}; its currency is "
                "the reporting currency", key)
        return {'amount': _amount(value['amount'], key, 'the annual income')}
    if key == 'marginal_rate':
        if not (_number(value) and 0 <= value <= MARGINAL_RATE_MAX):
            raise InvalidProfileFact(
                f"the marginal tax rate is a fraction from 0 to "
                f"{MARGINAL_RATE_MAX} (0.3 for 30 %)", key)
        return value
    if key == 'risk_tolerance':
        if value not in RISK_TOLERANCES or not isinstance(value, str):
            raise InvalidProfileFact(
                f"the risk tolerance is one of {', '.join(RISK_TOLERANCES)}",
                key)
        return value
    if key == NEW_PROJECT or (isinstance(key, str) and _PROJECT_KEY.fullmatch(key)):
        return _project(value, key, now)
    raise InvalidProfileFact(
        f"the key is one of {', '.join(FACTS)}, {NEW_PROJECT} or "
        f"project:<id>", str(key))


def status(row: dict, now: datetime) -> Status:
    """``ready``, ``merged``, ``ignored`` or ``expired``, which is never stored."""
    if row['status'] == 'ready' and now - row['created_at'] > EXPIRY:
        return 'expired'
    return row['status']


# --------------------------------------------------------------- the writes --

def propose(store, key: Any, value: Any, now: datetime) -> str:
    """Record a proposal, ``ready``, and its id. Writes no fact."""
    value = validate(key, value, now)
    _currency(store, key)
    if key.startswith('project:'):
        _existing_project(store, key)
    proposal_id = uuid4().hex
    store.execute(
        'INSERT INTO proposal (id, kind, payload, status, created_at) '
        "VALUES (?, 'profile_fact', ?, 'ready', ?)",
        [proposal_id, json.dumps({'key': key, 'value': value}), now])
    return proposal_id


def confirm(store, proposal_id: str, now: datetime) -> Proposal:
    """Write the proposed fact and mark the proposal ``merged``, together."""
    row = _proposal(store, proposal_id)
    current = status(row, now)
    if current != 'ready':
        raise ProposalNotReady(current)
    key = row['key']
    if key == NEW_PROJECT:
        key = f'project:{uuid4().hex[:12]}'
    elif key.startswith('project:'):
        _existing_project(store, key)
    with store.transaction():
        _write(store, key, row['value'], now)
        store.execute("UPDATE proposal SET status = 'merged', decided_at = ? "
                      'WHERE id = ?', [now, proposal_id])
    return _shape(_proposal(store, proposal_id), now)


def ignore(store, proposal_id: str, now: datetime) -> Proposal:
    """Mark the proposal ``ignored``; nothing else changes."""
    row = _proposal(store, proposal_id)
    current = status(row, now)
    if current != 'ready':
        raise ProposalNotReady(current)
    store.execute("UPDATE proposal SET status = 'ignored', decided_at = ? "
                  'WHERE id = ?', [now, proposal_id])
    return _shape(_proposal(store, proposal_id), now)


def put(store, key: str, value: Any, now: datetime) -> None:
    """The UI's edit of a fact, or of a project that exists."""
    if not is_key(key):
        raise UnknownFact(key)
    if key.startswith('project:'):
        _existing_project(store, key)
    _write(store, key, value, now)


def forget(store, key: str) -> None:
    """Delete one fact, or :class:`UnknownFact` when there is none."""
    if not store.query('SELECT 1 FROM profile_fact WHERE key = ?', [key]):
        raise UnknownFact(key)
    store.execute('DELETE FROM profile_fact WHERE key = ?', [key])


# ---------------------------------------------------------------- the reads --

def read(store) -> Profile:
    """Every confirmed fact, income amount included: the owner's own screen."""
    facts: Dict[str, Fact] = {}
    projects: List[Project] = []
    for key, value, confirmed_at in store.query(
            'SELECT key, value, confirmed_at FROM profile_fact'):
        value, at = json.loads(value), instants.iso(confirmed_at)
        if key.startswith('project:'):
            projects.append({'id': key.partition(':')[2], 'label': value['label'],
                             'target_year': value['target_year'],
                             'amount': value.get('amount'), 'confirmed_at': at})
        else:
            facts[key] = {'value': value, 'confirmed_at': at}
    projects.sort(key=lambda project: (project['target_year'], project['label']))
    return {'facts': {key: facts[key] for key in FACTS if key in facts},
            'projects': projects}


def read_proposals(store, ids: Sequence[str], now: datetime) -> List[Proposal]:
    """The proposals ``ids`` name, in that order; an unknown id is omitted."""
    if not ids:
        return []
    marks = ', '.join('?' for _ in ids)
    rows = {row['id']: row for row in map(_row, store.query(
        f'SELECT {_COLUMNS} FROM proposal WHERE id IN ({marks})', list(ids)))}
    return [_shape(rows[i], now) for i in ids if i in rows]


# ----------------------------------------------------------------- inside --

_COLUMNS = 'id, payload, status, created_at, decided_at'


def _row(row: tuple) -> dict:
    payload = json.loads(row[1])
    return {'id': row[0], 'key': payload['key'], 'value': payload['value'],
            'status': row[2], 'created_at': instants.utc(row[3]),
            'decided_at': instants.utc(row[4])}


def _shape(row: dict, now: datetime) -> Proposal:
    return {'id': row['id'], 'key': row['key'], 'value': row['value'],
            'status': status(row, now),
            'created_at': instants.iso(row['created_at']),
            'decided_at': instants.iso(row['decided_at'])}


def _proposal(store, proposal_id: str) -> dict:
    rows = store.query(f'SELECT {_COLUMNS} FROM proposal WHERE id = ?',
                       [proposal_id])
    if not rows:
        raise UnknownProposal(proposal_id)
    return _row(rows[0])


def _write(store, key: str, value: Any, now: datetime) -> None:
    value = validate(key, value, now)
    if key == 'income':
        value = {**value, 'currency': _currency(store, key)}
    store.execute(
        'INSERT INTO profile_fact (key, value, confirmed_at) VALUES (?, ?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value, '
        'confirmed_at = excluded.confirmed_at',
        [key, json.dumps(value), now])


def _currency(store, key: str) -> Optional[str]:
    """The reporting currency an income is written in; refused while unset."""
    if key != 'income':
        return None
    currency = store.setting('base_currency')
    if not currency:
        raise InvalidProfileFact(
            "declare the reporting currency first: an income is kept in it",
            key)
    return currency


def _existing_project(store, key: str) -> None:
    if not store.query('SELECT 1 FROM profile_fact WHERE key = ?', [key]):
        raise UnknownFact(key)


def _number(value: Any) -> bool:
    """A finite number, and never a ``bool`` (``True == 1`` in Python)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _amount(value: Any, key: str, what: str) -> float:
    if not (_number(value) and value >= 0):
        raise InvalidProfileFact(f"{what} is a finite amount of 0 or more", key)
    return value


def _project(value: Any, key: str, now: datetime) -> dict:
    if not isinstance(value, dict) or not {'label', 'target_year'} <= set(value) or set(value) - {'label', 'target_year', 'amount'}:
        raise InvalidProfileFact(
            'a project is {"label", "target_year", "amount"?}', key)
    label = value['label']
    if not (isinstance(label, str) and label.strip() and len(label.strip()) <= LABEL_MAX and '\n' not in label):
        raise InvalidProfileFact(
            f"a project's label is one line of 1 to {LABEL_MAX} characters",
            key)
    year = value['target_year']
    if type(year) is not int or not now.year <= year <= now.year + HORIZON_YEARS:
        raise InvalidProfileFact(
            f"a project's target year is from {now.year} to "
            f"{now.year + HORIZON_YEARS}", key)
    amount = value.get('amount')
    if amount is not None:
        amount = _amount(amount, key, "a project's amount")
    return {'label': label.strip(), 'target_year': year, 'amount': amount}
