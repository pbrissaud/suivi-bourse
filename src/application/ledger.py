"""The ledger in the store — read here, written in one place, and nowhere else."""
import hashlib
from dataclasses import dataclass
from datetime import date, datetime
from typing import Dict, List, Optional, Sequence, Tuple

from logfmt_logger import getLogger

from application import instants
from application import quotes
from application import settings_registry
from application.events.schemas import DEFAULT_ACCOUNT, Event, EventType

logger = getLogger("ledger")

LAST_WRITE_KEY = 'ledger_last_write'


_EVENT_COLUMNS = (
    'id, date, event_type, symbol, name, quantity, unit_price, '
    'fee, amount, notes, account'
)


def read_events(store) -> List[Event]:
    """Every event in the ledger, as :class:`events.schemas.Event`, date-sorted."""
    rows = store.query(
        f'SELECT {_EVENT_COLUMNS} FROM event ORDER BY date, id')
    return [_event_from_row(row) for row in rows]


def _event_from_row(row: Sequence) -> Event:
    """One ``event`` row back into an :class:`Event`."""
    (event_id, day, event_type, symbol, name, quantity, unit_price, fee,
     amount, notes, account) = row
    return Event(
        id=event_id,
        date=day,
        event_type=EventType(event_type),
        symbol=symbol,
        name=name,
        quantity=quantity,
        unit_price=unit_price,
        fee=fee,
        amount=amount,
        notes=notes,
        account=account,
    )


_LEDGER_DIGEST = (
    "SELECT md5(string_agg(concat_ws(chr(31), "
    "     cast(id AS VARCHAR), cast(date AS VARCHAR), event_type, account, "
    "     coalesce(symbol, ''), coalesce(name, ''), "
    "     coalesce(cast(quantity AS VARCHAR), ''), "
    "     coalesce(cast(unit_price AS VARCHAR), ''), "
    "     coalesce(cast(fee AS VARCHAR), ''), "
    "     coalesce(cast(amount AS VARCHAR), ''), "
    "     coalesce(notes, '')), chr(30) ORDER BY id)) "
    "FROM event"
)


def stamp(store) -> Optional[str]:
    """A fingerprint of the whole ledger, for the snapshot's cache key."""
    (digest,) = store.query(_LEDGER_DIGEST)[0:1][0]
    declared = store.query(
        'SELECT id, type, label FROM account '
        'WHERE id <> ? ORDER BY id', [DEFAULT_ACCOUNT])
    if digest is None and not declared:
        return None
    declarations = '|'.join(str(tuple(a)) for a in declared)
    payload = f'{digest or ""}#{declarations}'
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def first_payments(store) -> Dict[str, date]:
    """The earliest declared **payment** of every account — a ``DEPOSIT``, dated.

    Derived on every read and stored nowhere (#918): it is a figure the ledger
    already says, and a column holding it would be a derived value in a declared
    row (ADR-0006). Two readers ask it — the account form, which offers it as the
    opening date it pre-fills, and the advisory that contradicts a declared date
    later than it — and they ask it here so the two cannot disagree.

    A ``WITHDRAWAL`` is not a payment and a ``BUY`` is not one either: what opens
    a wrapper is money coming in from outside.
    """
    return {account: day for account, day in store.query(
        "SELECT account, min(date) FROM event "
        "WHERE event_type = 'DEPOSIT' GROUP BY account")
        if day is not None}


def last_write(store) -> Optional[datetime]:
    """When the ledger last changed, or ``None`` — nothing has ever been written."""
    rows = store.query(
        'SELECT value FROM setting WHERE key = ?', [LAST_WRITE_KEY])
    stamped = rows[0][0] if rows else None
    if not stamped:
        return None
    try:
        return instants.utc(datetime.fromisoformat(stamped))
    except ValueError:
        logger.warning(f"Unreadable {LAST_WRITE_KEY}: {stamped!r}")
        return None


@dataclass(frozen=True)
class OrphanSymbol:
    """A ``symbol`` row no event names any more, and the series hanging off it."""

    symbol: str
    points: int


def orphan_symbols(store) -> List[OrphanSymbol]:
    """The symbols nothing declares any more, with the size of their series."""
    rows = store.query(
        'SELECT s.symbol, count(p.symbol) '
        'FROM symbol s LEFT JOIN price_point p ON p.symbol = s.symbol '
        'WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.symbol = s.symbol) '
        '  AND NOT EXISTS (SELECT 1 FROM position q WHERE q.symbol = s.symbol) '
        'GROUP BY s.symbol ORDER BY s.symbol')
    return [OrphanSymbol(symbol=row[0], points=int(row[1])) for row in rows]


def purge_orphan_symbols(store) -> Tuple[List[str], int]:
    """Purge every orphan: its series, its quote row, then the symbol itself."""
    orphans = orphan_symbols(store)
    if not orphans:
        return [], 0

    points = 0
    with store.transaction():
        for orphan in orphans:
            points += quotes.forget_symbol(store, orphan.symbol)

    symbols = [orphan.symbol for orphan in orphans]
    with store.transaction():
        for symbol in symbols:
            store.execute('DELETE FROM symbol WHERE symbol = ?', [symbol])

    logger.info(f"Purged {len(symbols)} orphan symbol(s) and {points} price "
                f"point(s): {', '.join(symbols)}")
    return symbols, points


def currency_to_adopt(store, declared: Optional[str]) -> Optional[str]:
    """What an event file's ``base_currency`` column asks this install to store."""
    if not declared:
        return None

    value = settings_registry.validate('base_currency', declared)
    current = store.setting('base_currency')
    if current == value:
        return None
    if current is None:
        return value

    (events,) = store.query('SELECT count(*) FROM event')[0:1][0]
    if events:
        raise settings_registry.InvalidSetting(
            'base_currency',
            f"the file declares {value} as the reporting currency while this "
            f"install reports in {current} and {events} event(s) are recorded "
            f"in it; importing it would reinterpret every amount already "
            f"stored rather than convert it. Remove those events first.")
    return value


__all__ = [
    'LAST_WRITE_KEY', 'OrphanSymbol',
    'read_events', 'stamp', 'last_write', 'first_payments',
    'orphan_symbols', 'purge_orphan_symbols',
    'currency_to_adopt',
]
