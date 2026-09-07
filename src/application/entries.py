"""The one writer of the ledger, and the gestures a row earns (issues #764, #816)."""
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from logfmt_logger import getLogger

from application import accounts as accounts_module
from application import ledger
from application import settings_registry
from application import store as store_module
from application.events.aggregator import EventAggregator
from application.events.validator import EventValidator
from application.events import export as events_export
from application.events.schemas import DEFAULT_ACCOUNT, Event

logger = getLogger("entries")

DUPLICATE_KEY_COLUMNS = ('date', 'event_type', 'account', 'symbol', 'quantity',
                         'unit_price', 'fee', 'amount')

AMOUNT_PRECISION = '%.16g'


class UnknownEntry(Exception):
    """No event has that id — and ``issued`` says whether one ever did.

    *It was there* and *it never was* are opposite pieces of news, and the store
    is the only side that can tell them apart (#785, ADR-0027): a key it handed
    out named a row once, a key past its mark has never named anything.
    """

    def __init__(self, message: str, issued: bool = False):
        super().__init__(message)
        self.issued = issued


class InvalidEntry(Exception):
    """The event is well formed and the rules refuse it."""

    def __init__(self, message: str, field: Optional[str] = None):
        super().__init__(message)
        self.field = field


@dataclass(frozen=True)
class Duplicate:
    """One line of the file the ledger already holds, and the line it repeats."""

    event: Event
    held: Optional[Event]


def create(store, draft: Event) -> Event:
    """Record one event typed in the app."""
    with store.transaction():
        event = _settled(store, draft)
        _refuse(store, event)
        account = event.account or DEFAULT_ACCOUNT

        next_id = store.reserve('event')
        _insert_symbol(store, event)
        store.execute(
            'INSERT INTO event (id, date, event_type, account, symbol, name, '
            '                   quantity, unit_price, fee, amount, notes) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [next_id, event.date, event.event_type.value, account,
             event.symbol, event.name, event.quantity, event.unit_price,
             event.fee, event.amount, event.notes])

        _stamp_write(store)
        _replays(store)
        logger.info(f"Recorded event {next_id}: {event.event_type.value} "
                    f"{event.symbol or account} on {event.date}")
    return replace(event, id=next_id, account=account)


def create_many(store, drafts: Sequence[Event], *,
                base_currency: Optional[str] = None,
                declare_accounts: Sequence[str] = ()) -> List[Event]:
    """Record a whole file's worth of events. One transaction, one replay."""
    if not drafts and base_currency is None and not declare_accounts:
        return []

    with store.transaction():
        for account_id in declare_accounts:
            accounts_module.create_account(
                store, account_id, store_module.DEFAULT_ACCOUNT_ROW[1])
            logger.info(f"The file names {account_id} and nobody had declared "
                        f"it; declaring it with the import")

        if base_currency is not None:
            store.execute(
                'INSERT INTO setting (key, value) VALUES (?, ?) '
                'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
                ['base_currency',
                 settings_registry.stored_form('base_currency', base_currency)])
            logger.info(f"The file declares {base_currency} as the reporting "
                        f"currency; taking it up")

        settled = _settled_all(store, drafts)
        _refuse_all(store, settled)

        if not settled:
            return []

        next_id = store.reserve('event', len(settled))
        store.executemany(
            'INSERT INTO symbol (symbol) VALUES (?) ON CONFLICT DO NOTHING',
            [[symbol] for symbol in sorted({event.symbol for event in settled
                                            if event.symbol})])
        stored = [replace(event, id=next_id + offset,
                          account=event.account or DEFAULT_ACCOUNT)
                  for offset, event in enumerate(settled)]
        store.executemany(
            'INSERT INTO event (id, date, event_type, account, symbol, name, '
            '                   quantity, unit_price, fee, amount, notes) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [[event.id, event.date, event.event_type.value, event.account,
              event.symbol, event.name, event.quantity, event.unit_price,
              event.fee, event.amount, event.notes] for event in stored])

        _stamp_write(store)
        _replays(store)
        logger.info(f"Recorded {len(stored)} event(s) from one file")
    return stored


def update(store, event_id: int, draft: Event) -> Event:
    """Rewrite one event, in place — **whatever laid it down** (ADR-0032)."""
    with store.transaction():
        _require_known(store, event_id)
        event = _settled(store, draft)
        _refuse(store, event)
        account = event.account or DEFAULT_ACCOUNT

        _insert_symbol(store, event)
        store.execute(
            'UPDATE event SET date = ?, event_type = ?, account = ?, '
            '                 symbol = ?, name = ?, quantity = ?, '
            '                 unit_price = ?, fee = ?, amount = ?, notes = ? '
            'WHERE id = ?',
            [event.date, event.event_type.value, account, event.symbol,
             event.name, event.quantity, event.unit_price, event.fee,
             event.amount, event.notes, event_id])

        _stamp_write(store)
        _replays(store)
        logger.info(f"Rewrote event {event_id}")
    return replace(event, id=event_id, account=account)


def remove(store, event_id: int) -> None:
    """Delete one event — **whatever laid it down** (ADR-0032)."""
    with store.transaction():
        _require_known(store, event_id)
        store.execute('DELETE FROM event WHERE id = ?', [event_id])
        _stamp_write(store)
        _replays(store)
        logger.info(f"Removed event {event_id}")


def remove_selection(store, selection: events_export.Selection) -> int:
    """Delete every event a reduction retains. Returns how many left (#814)."""
    with store.transaction():
        keys = [event.id for event
                in events_export.select(ledger.read_events(store), selection)
                if event.id is not None]
        store.executemany('DELETE FROM event WHERE id = ?',
                          [[key] for key in keys])
        if keys:
            _stamp_write(store)
        _replays(store)
        logger.info(f"Removed {len(keys)} event(s) on a reduction")
    return len(keys)


def content_key(event: Event) -> Tuple:
    """What makes two rows the same purchase — :data:`DUPLICATE_KEY_COLUMNS`."""
    return (
        event.date,
        event.event_type.value,
        (event.account or '').strip() or DEFAULT_ACCOUNT,
        event.symbol,
        _amount(event.quantity),
        _amount(event.unit_price),
        _amount(event.fee),
        _amount(event.amount),
    )


def _amount(value: Optional[float]) -> Optional[float]:
    """One amount, at the precision a round trip through the export survives."""
    if value is None:
        return None
    return float(AMOUNT_PRECISION % value)


def split_duplicates(store, drafts: Sequence[Event]) -> Tuple[List[Event],
                                                              List[Duplicate]]:
    """One file, cut in two: what is new, and what the ledger already has."""
    seen: Dict[Tuple, Optional[Event]] = {
        content_key(event): event for event in ledger.read_events(store)}
    fresh: List[Event] = []
    duplicates: List[Duplicate] = []
    for draft in drafts:
        key = content_key(draft)
        if key in seen:
            duplicates.append(Duplicate(event=draft, held=seen[key]))
        else:
            seen[key] = None
            fresh.append(draft)
    return fresh, duplicates


def judge(store, drafts: Sequence[Event], *,
          declaring: Sequence[str] = (),
          accounts_pending: bool = False) -> None:
    """Refuse what :func:`create_many` would refuse, **without writing a row**.

    Including the ids the file would declare: the writer refuses one no route
    can carry (:func:`accounts.refuse_unaddressable_id`), and a preview that let
    it through would answer a green receipt for a file the confirmed import then
    refuses — which is the one thing a dry run exists not to do (issue #861).
    """
    for account_id in declaring:
        accounts_module.refuse_unaddressable_id(account_id)
    settled = _settled_all(store, drafts)
    _refuse_all(store, settled, declaring=declaring,
                accounts_pending=accounts_pending)
    if not settled:
        return

    if accounts_pending and _validator(store, declaring=declaring).issues(settled):
        return

    would_be = [replace(event, account=event.account or DEFAULT_ACCOUNT)
                for event in settled]
    EventAggregator().aggregate(
        sorted(ledger.read_events(store) + would_be,
               key=lambda event: event.date))


def _settled_all(store, drafts: Sequence[Event]) -> List[Event]:
    """A whole file settled, on **one** read of what the ledger calls things."""
    known = _known_names(store)
    settled = []
    for draft in drafts:
        event = _settled(store, draft, known)
        if event.symbol and event.name:
            known[event.symbol] = event.name
        settled.append(event)
    return settled


def _refuse_all(store, settled: Sequence[Event], *,
                declaring: Sequence[str] = (),
                accounts_pending: bool = False) -> None:
    """:func:`_refuse` over a whole file, on one build of the validator."""
    issues = _validator(store, declaring=declaring,
                        accounts_pending=accounts_pending).issues(settled)
    if issues:
        raise InvalidEntry(issues[0].message, field=issues[0].field)


def _require_known(store, event_id: int) -> None:
    """Refuse an id no row answers to. **One refusal, and it is the only one.**"""
    rows = store.query('SELECT 1 FROM event WHERE id = ?', [event_id])
    if not rows:
        raise UnknownEntry(f"No event with id {event_id}",
                           issued=store.issued('event', event_id))


def _stamp_write(store) -> None:
    """Record the instant the ledger moved (:data:`ledger.LAST_WRITE_KEY`)."""
    store.execute(
        'INSERT INTO setting (key, value) VALUES (?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [ledger.LAST_WRITE_KEY, datetime.now(timezone.utc).isoformat()])


def _settled(store, draft: Event,
             known: Optional[Mapping[str, str]] = None) -> Event:
    """The draft with the one thing the store decides before it is judged."""
    return replace(draft, account=(draft.account or '').strip() or None,
                   name=draft.name or _named(store, draft.symbol, known),
                   id=None)


def _named(store, symbol: Optional[str],
           known: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """What this ledger already calls that security, or the ticker itself."""
    if not symbol:
        return None
    if known is not None:
        return known.get(symbol) or symbol
    rows = store.query(
        'SELECT name FROM event WHERE symbol = ? AND name IS NOT NULL '
        'ORDER BY date DESC, id DESC LIMIT 1', [symbol])
    return rows[0][0] if rows else symbol


def _known_names(store) -> Dict[str, str]:
    """Every security's name as the ledger last stated it, in **one** read."""
    rows = store.query(
        'SELECT symbol, name FROM event '
        'WHERE symbol IS NOT NULL AND name IS NOT NULL ORDER BY date, id')
    return {symbol: name for symbol, name in rows}


def _refuse(store, event: Event) -> None:
    """Run the one validator, with the context a row needs to be judged in."""
    _refuse_all(store, [event])


def _validator(store, *, declaring: Sequence[str] = (),
               accounts_pending: bool = False) -> EventValidator:
    """The one validator, with the context a row needs to be judged in."""
    if accounts_pending:
        return EventValidator(account_ids=None, accounts_declared=False)
    return EventValidator(
        account_ids=accounts_module.account_ids(store) | set(declaring),
        accounts_declared=accounts_module.accounts_are_declared(store))


def _insert_symbol(store, event: Event) -> None:
    """Give the security its row before the event references it."""
    if event.symbol:
        store.execute(
            'INSERT INTO symbol (symbol) VALUES (?) ON CONFLICT DO NOTHING',
            [event.symbol])


def _replays(store) -> None:
    """Replay the ledger this gesture would leave, before the commit."""
    EventAggregator().aggregate(ledger.read_events(store))


__all__ = [
    'DUPLICATE_KEY_COLUMNS', 'AMOUNT_PRECISION',
    'UnknownEntry', 'InvalidEntry', 'Duplicate',
    'create', 'create_many', 'update', 'remove', 'remove_selection',
    'content_key', 'split_duplicates', 'judge',
]
