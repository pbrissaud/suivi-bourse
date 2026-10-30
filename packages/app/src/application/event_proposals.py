"""Ledger events the agent proposes, and the owner merges (#1119).

**The agent never writes an event, it proposes a batch; only the UI merges it.**
:func:`propose` writes one ``proposal`` row and no event: the positions after
the batch are computed in memory by a dry run. :func:`merge` is the app's, and
writes the events and marks the proposal ``merged`` in one transaction. A batch
is made against one ledger: it carries that ledger's fingerprint
(:func:`ledger.stamp`), and a merge that finds another reads ``stale`` and
writes nothing. ``now`` is always injected.
"""
import json
import re
from datetime import datetime
from typing import (
    Any, List, Literal, NotRequired, Optional, Sequence, TypedDict, Union,
)
from uuid import uuid4

from application import accounts as accounts_module
from application import entries
from application import instants
from application import ledger
from application import proposals
from application import statements
from application.event_body import (
    TEXT_FIELDS, InvalidBody, body_of, event_from_body,
)
from application.events.aggregator import AggregationError
from application.events.schemas import Event
from application.proposals import (
    ProposalNotReady, StaleProposal, UnknownProposal,
)

KIND = 'events'
EVENTS_MAX = 200
TITLE_MAX = 80
#: A text member (symbol, name, account, notes) is a label, not a document.
TEXT_MAX = 200

Mark = Literal['statement', 'gap', 'estimated_price']


class ProposedLine(TypedDict):
    """One proposed event, as a card lists it."""
    date: str
    event_type: str
    account: Optional[str]
    symbol: Optional[str]
    quantity: Optional[float]
    unit_price: Optional[float]
    fee: Optional[float]
    amount: Optional[float]
    notes: Optional[str]
    #: Set by the app on a statement's lines, never proposed (#1120).
    marks: NotRequired[List[Mark]]
    price_source: NotRequired[Optional[str]]
    #: A statement's line number, and what it called the title: shown in the
    #: UI only, never in the thread.
    n: NotRequired[int]
    name: NotRequired[Optional[str]]
    isin: NotRequired[Optional[str]]


class UnresolvedLine(TypedDict):
    """A statement line still waiting for the owner to choose its title."""
    n: int
    name: str
    isin: Optional[str]


class TotalCheck(TypedDict):
    """The total the statement states, against the lines read."""
    stated: float
    read: float
    gap_pct: float


class StatementFacts(TypedDict):
    """What a statement proposal says beyond its lines (#1120)."""
    kind: Literal['positions', 'operations']
    as_of: Optional[str]
    dropped: int
    unresolved: List[UnresolvedLine]
    pending_held: int
    total_check: Union[None, TotalCheck, Literal['unverifiable']]


class EventsProposal(TypedDict):
    id: str
    kind: Literal['events']
    title: str
    status: proposals.Status
    count: int
    events: List[ProposedLine]
    #: What a statement came to; absent on a proposal the agent wrote.
    statement: NotRequired[StatementFacts]
    created_at: str
    decided_at: Optional[str]


class EventsProposalsPayload(TypedDict):
    proposals: List[EventsProposal]


_VALIDATOR_LINE = re.compile(r'Event #(\d+) \([^)]*\): (.*)', re.DOTALL)


class InvalidProposal(ValueError):
    """A batch the app refuses whole, in words naming the line and the field."""

    def __init__(self, message: str, line: Optional[int] = None,
                 field: Optional[str] = None):
        super().__init__(message)
        self.line = line
        self.field = field


def parse(events_json: Any) -> List[Event]:
    """The events a JSON list holds, or :class:`InvalidProposal` on the first
    line that is not one. A ``mark`` is refused: only the app sets one."""
    try:
        listed = json.loads(events_json)
    except (TypeError, ValueError) as exc:
        raise InvalidProposal(
            f"events_json: not valid JSON: {exc}",
            field='events_json')
    if not isinstance(listed, list) or not listed:
        raise InvalidProposal(
            "events_json: a non-empty JSON list of events is required", field='events_json')
    if len(listed) > EVENTS_MAX:
        raise InvalidProposal(
            f"events_json: {len(listed)} events is past the "
            f"{EVENTS_MAX} a proposal holds; propose them in several batches",
            field='events_json')
    events = []
    for line, body in enumerate(listed, 1):
        for member in ('mark', 'marks'):
            if isinstance(body, dict) and member in body:
                raise InvalidProposal(
                    f"line {line} ({member}): a mark is set by the app, "
                    f"never proposed; leave it out", line, member)
        try:
            event = event_from_body(body)
        except InvalidBody as exc:
            raise InvalidProposal(f"line {line} ({exc.field}): {exc}",
                                  line, exc.field)
        for field in TEXT_FIELDS:
            if len(getattr(event, field) or '') > TEXT_MAX:
                raise InvalidProposal(
                    f"line {line} ({field}): {field} is past {TEXT_MAX} "
                    f"characters", line, field)
        events.append(event)
    return events


def propose(store, title: Any, events_json: Any, now: datetime) -> str:
    """Record a proposal, ``ready``, and its id. Writes no event."""
    return _record(store, _title(title), parse(events_json), now)


def propose_statement(store, title: Any, statement: dict,
                      now: datetime) -> str:
    """Record a statement's proposal, ``ready``, and its id (#1120).

    Only the validated extraction is stored: the events are derived from it, the
    owner's edits and the ledger at every read (:func:`reading`).
    """
    title = _title(title)
    _reconciled(store, statement, None)  # refuses what cannot be read at all
    proposal_id = uuid4().hex
    proposals.insert(
        store, KIND,
        {'title': title, 'statement': statement,
         'stamp': ledger.stamp(store) or ''},
        proposal_id, now)
    return proposal_id


def read(store, ids: Sequence[str], now: datetime) -> List[EventsProposal]:
    """The proposals ``ids`` name, in that order; an unknown id is omitted."""
    rows = proposals.fetch(store, KIND, ids)
    current = ledger.stamp(store) or ''
    return [_shape(store, rows[i], now, current) for i in ids if i in rows]


def ready(store, proposal_id: str, now: datetime) -> dict:
    """A ``ready`` proposal, or the refusal that says why it is not one."""
    return _ready(store, proposal_id, now)


def reading(store, row: dict, edits: Optional[dict] = None, *,
            merging: bool = False) -> statements.Reading:
    """A statement proposal read against the ledger as it is, with the owner's
    ``edits``. Merging is refused while a line waits for its ticker or a price."""
    found = _reconciled(store, row['statement'], edits)
    if merging:
        for line in found.unresolved:
            raise InvalidProposal(
                f"line {line['n']} (symbol): choose the title for "
                f"\"{line['name']}\" ({line.get('isin') or 'no ISIN'})",
                line['n'], 'symbol')
        for drafted in found.unpriced():
            raise InvalidProposal(
                f"line {drafted.n or drafted.event.symbol} (unit_price): no "
                f"close is known for {drafted.event.symbol}; type a price",
                drafted.n, 'unit_price')
    return found


def events_of(store, row: dict, edits: Optional[dict] = None, *,
              merging: bool = False) -> List[Event]:
    """The events a proposal holds: a statement's, derived now; or the agent's."""
    if 'statement' not in row:
        return [event_from_body(body) for body in row['events']]
    return [drafted.event for drafted in reading(
        store, row, edits, merging=merging).drafted
        if drafted.event.unit_price is not None]


def merge(store, proposal_id: str, now: datetime,
          drafts: Sequence[Event], **how: Any) -> List[Event]:
    """Write ``drafts`` (the proposal's events, the lines the owner kept, their
    amounts as the owner answered) and mark the proposal ``merged``, together.

    ``how`` is what :func:`entries.record_many` takes. A ledger that moved
    since the proposal raises :class:`StaleProposal`, and nothing is written.
    """
    with store.transaction():
        _ready(store, proposal_id, now)
        written = entries.record_many(store, drafts, **how)
        if not proposals.decide(store, KIND, proposal_id, 'merged', now):
            raise ProposalNotReady('merged')
        return written


def ignore(store, proposal_id: str, now: datetime) -> EventsProposal:
    """Mark the proposal ``ignored``; the ledger does not change."""
    with store.transaction():
        _ready(store, proposal_id, now, allow_stale=True)
        if not proposals.decide(store, KIND, proposal_id, 'ignored', now):
            raise ProposalNotReady('ignored')
    return _shape(store, _row(store, proposal_id), now,
                  ledger.stamp(store) or '')


def repropose(store, proposal_id: str, now: datetime) -> str:
    """The same events, validated against the ledger as it is now, as a **new**
    proposal; the old one reads ``ignored``. No model is asked."""
    with store.transaction():
        row = _ready(store, proposal_id, now, allow_stale=True)
        if 'statement' in row:
            new_id = propose_statement(store, row['title'], row['statement'], now)
        else:
            new_id = _record(store, row['title'], events_of(store, row), now)
        proposals.decide(store, KIND, proposal_id, 'ignored', now)
    return new_id


def rekind(store, proposal_id: str, now: datetime) -> str:
    """The same extraction read as the other kind of statement, as a **new**
    proposal with no edit carried over; the old one reads ``ignored``. No model
    is asked."""
    with store.transaction():
        row = _ready(store, proposal_id, now, allow_stale=True)
        if 'statement' not in row:
            raise InvalidProposal(
                "only a statement can be read as the other kind", field='kind')
        other = 'operations' if row['statement']['kind'] == 'positions' \
            else 'positions'
        new_id = propose_statement(
            store, row['title'], {**row['statement'], 'kind': other}, now)
        proposals.decide(store, KIND, proposal_id, 'ignored', now)
    return new_id


# ----------------------------------------------------------------- inside --

def _title(title: Any) -> str:
    text = title.strip() if isinstance(title, str) else ''
    if not 1 <= len(text) <= TITLE_MAX or not text.isprintable():
        raise InvalidProposal(
            f"title (title): a proposal's title is one line of 1 to "
            f"{TITLE_MAX} characters", field='title')
    return text


def _record(store, title: str, events: Sequence[Event], now: datetime) -> str:
    """Judge the batch against the ledger as it is, then store it."""
    _known_accounts(store, events)
    fresh, _ = entries.split_duplicates(store, events)
    lines = {id(event): n for n, event in enumerate(events, 1)}
    try:
        entries.judge(store, fresh)
    except entries.InvalidEntry as exc:
        found = _VALIDATOR_LINE.fullmatch(str(exc))
        if not found:
            raise InvalidProposal(f"({exc.field}): {exc}", field=exc.field)
        line = lines[id(fresh[int(found[1]) - 1])]
        raise InvalidProposal(f"line {line} ({exc.field}): {found[2]}",
                              line, exc.field)
    except AggregationError as exc:
        raise InvalidProposal(*_unreplayable(exc, events))
    proposal_id = uuid4().hex
    proposals.insert(
        store, KIND,
        {'title': title, 'events': [body_of(event) for event in events],
         'stamp': ledger.stamp(store) or ''},
        proposal_id, now)
    return proposal_id


def _unreplayable(exc: AggregationError, events: Sequence[Event]):
    """The refusal of a batch that does not replay, on the line that sells it."""
    line = next((n for n, event in enumerate(events, 1)
                 if event.symbol == exc.symbol and event.date == exc.day), None)
    where = f"line {line} (quantity)" if line else "quantity (quantity)"
    return f"{where}: {exc}", line, 'quantity'


def _known_accounts(store, events: Sequence[Event]) -> None:
    """The agent never declares an account: one it names must exist."""
    declared = accounts_module.account_ids(store)
    for line, event in enumerate(events, 1):
        if event.account and event.account not in declared:
            raise InvalidProposal(
                f"line {line} (account): account '{event.account}' does not "
                f"exist; ask the owner to create it in Comptes, then propose "
                f"again", line, 'account')


def _row(store, proposal_id: str) -> dict:
    rows = proposals.fetch(store, KIND, [proposal_id])
    if not rows:
        raise UnknownProposal(proposal_id)
    return rows[proposal_id]


def _ready(store, proposal_id: str, now: datetime,
           allow_stale: bool = False) -> dict:
    """The row, or why the proposal cannot be acted on (``stale`` included)."""
    row = _row(store, proposal_id)
    current = proposals.status(row, now, ledger.stamp(store) or '')
    if current == 'stale' and allow_stale:
        return row
    if current == 'stale':
        raise StaleProposal()
    if current != 'ready':
        raise ProposalNotReady(current)
    return row


def lines_of(found: statements.Reading) -> List[ProposedLine]:
    """A reading's lines as a card lists them: the events, then the lines still
    waiting for a ticker (the title they carry is for the UI, never the thread)."""
    lines = [{**{key: body.get(key) for key in _LISTED},
              'marks': drafted.marks, 'price_source': drafted.price_source,
              'n': drafted.n}
             for drafted in found.drafted
             for body in [body_of(drafted.event)]]
    lines += [{'date': line.get('date') or found.as_of or '',
               'event_type': line.get('event_type') or 'BUY', 'account': None,
               'symbol': None, 'quantity': line.get('quantity'),
               'unit_price': line.get('unit_price'), 'fee': line.get('fee'),
               'amount': line.get('amount'), 'notes': None,
               'marks': ['statement'], 'n': line['n'], 'name': line['name'],
               'isin': line.get('isin')} for line in found.unresolved]
    return lines


def _reconciled(store, statement: dict, edits: Optional[dict]):
    """:func:`statements.reconcile`, its refusals in the proposal's words."""
    try:
        return statements.reconcile(store, statement, edits)
    except statements.InvalidStatement as exc:
        raise InvalidProposal(str(exc), field=exc.field)


def _shape(store, row: dict, now: datetime, stamp: str) -> EventsProposal:
    shaped = {
        'id': row['id'], 'kind': KIND, 'title': row['title'],
        'status': proposals.status(row, now, stamp),
        'created_at': instants.iso(row['created_at']),
        'decided_at': instants.iso(row['decided_at']),
    }
    if 'statement' not in row:
        return {**shaped, 'count': len(row['events']), 'events': [
            {key: body.get(key) for key in _LISTED} for body in row['events']]}
    found = _reconciled(store, row['statement'], None)
    lines = lines_of(found)
    return {**shaped, 'count': len(lines), 'events': lines,
            'statement': found.facts()}


_LISTED = ('date', 'event_type', 'account', 'symbol', 'quantity',
           'unit_price', 'fee', 'amount', 'notes')
