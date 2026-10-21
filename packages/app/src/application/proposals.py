"""What every kind of proposal shares (#1116, #1119): its life, and nothing else.

The agent proposes and only the UI decides, so a proposal is one ``proposal``
row that is ``ready`` until a person says ``merged`` or ``ignored``. Two more
statuses are **read, never stored**: ``expired``, a ``ready`` row older than
:data:`EXPIRY`, and ``stale``, a ``ready`` row of events whose ledger moved
since it was made. Pure: ``now`` is injected, and a kind's own module decides
what its payload means.
"""
import json
from datetime import datetime, timedelta
from typing import Dict, Literal, Optional, Sequence

from application import instants

EXPIRY = timedelta(days=7)

Status = Literal['ready', 'merged', 'ignored', 'expired', 'stale']

COLUMNS = 'id, payload, status, created_at, decided_at'


class UnknownProposal(LookupError):
    """An id no proposal of this kind carries."""


class ProposalNotReady(Exception):
    """A proposal already decided, expired or stale: nothing is written twice."""

    def __init__(self, status: str):
        super().__init__(f"the proposal is {status}, not ready")
        self.status = status


class StaleProposal(ProposalNotReady):
    """The ledger changed since the proposal was made."""

    def __init__(self):
        super().__init__('stale')


def status(row: dict, now: datetime,
           current_stamp: Optional[str] = None) -> Status:
    """The status a reader sees. A row carrying a ``stamp`` is judged against
    ``current_stamp``, the ledger's fingerprint now."""
    if row['status'] != 'ready':
        return row['status']
    if now - row['created_at'] > EXPIRY:
        return 'expired'
    if 'stamp' in row and row['stamp'] != current_stamp:
        return 'stale'
    return 'ready'


def fetch(store, kind: str, ids: Sequence[str]) -> Dict[str, dict]:
    """``{id: row}`` of the ``kind`` proposals ``ids`` name; the payload is
    decoded and its members sit in the row beside the columns."""
    if not ids:
        return {}
    marks = ', '.join('?' for _ in ids)
    rows = store.query(
        f'SELECT {COLUMNS} FROM proposal WHERE kind = ? AND id IN ({marks})',
        [kind, *ids])
    return {row[0]: {**json.loads(row[1]), 'id': row[0], 'status': row[2],
                     'created_at': instants.utc(row[3]),
                     'decided_at': instants.utc(row[4])} for row in rows}


def insert(store, kind: str, payload: dict, proposal_id: str,
           now: datetime) -> None:
    store.execute(
        'INSERT INTO proposal (id, kind, payload, status, created_at) '
        "VALUES (?, ?, ?, 'ready', ?)",
        [proposal_id, kind, json.dumps(payload), now])


def decide(store, kind: str, proposal_id: str, decided: str,
           now: datetime) -> bool:
    """Decide a proposal that is still ready; ``False`` when it was not.

    The guard is in the ``UPDATE`` itself, so a decision that lost a race
    writes nothing, and inside a transaction rolls the rest back with it.
    """
    return bool(store.query(
        'UPDATE proposal SET status = ?, decided_at = ? '
        "WHERE kind = ? AND id = ? AND status = 'ready' AND created_at >= ? "
        'RETURNING id', [decided, now, kind, proposal_id, now - EXPIRY]))
