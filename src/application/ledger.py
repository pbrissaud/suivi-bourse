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

#: The references already compared against, newest first, comma-separated. A
#: `setting` row and not a dial: it is the app's own memory of what it fetched,
#: not a question anybody is asked, so it stays out of `settings_registry` and
#: out of the Settings form.
CONSULTED_KEY = 'benchmark_consulted'

#: #760's own bound on the consulted series kept alive.
CONSULTED_LIMIT = 7


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
        'SELECT id, label FROM account '
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
    row. Two readers ask it — the account form, which offers it as the
    opening date it pre-fills, and the advisory that contradicts a declared date
    later than it — and they ask it here so the two cannot disagree.

    A ``WITHDRAWAL`` is not a payment and a ``BUY`` is not one either: what opens
    a wrapper is money coming in from outside.
    """
    return dict(store.query(
        "SELECT account, min(date) FROM event "
        "WHERE event_type = 'DEPOSIT' GROUP BY account"))


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


def consulted_benchmarks(store) -> List[str]:
    """The references this install has compared against, newest first."""
    rows = store.query(
        'SELECT value FROM setting WHERE key = ?', [CONSULTED_KEY])
    stored = rows[0][0] if rows else None
    return [symbol for symbol in str(stored or '').split(',') if symbol]


def record_consulted_benchmark(store, *symbols: Optional[str]) -> List[str]:
    """Remember ``symbols`` as consulted, newest first. Returns the new list.

    Bounded at :data:`CONSULTED_LIMIT`, and the bound **is** the guard: the
    protection below keeps a series out of the purge for good, so an unbounded
    list would turn every ticker ever typed into a permanent resident of the
    store. The eighth consulted reference evicts the oldest, and that one's
    series goes on the next purge like any other orphan.

    Writes with a bare statement and no transaction of its own so it can be
    called from inside one — which is where :func:`settings.save` calls it,
    because a reference protected a moment *after* the dial moved is a
    reference the purge can still catch in between.
    """
    kept = [symbol for symbol in symbols if symbol]
    for symbol in consulted_benchmarks(store):
        if symbol not in kept:
            kept.append(symbol)
    kept = kept[:CONSULTED_LIMIT]

    store.execute(
        'INSERT INTO setting (key, value) VALUES (?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [CONSULTED_KEY, ','.join(kept)])
    return kept


def forget_consulted_benchmark(store, symbol: str) -> List[str]:
    """Drop one reference from the consulted list. Returns the new list.

    The removal route, and the only one (#982): emptying the field is how a
    reference is retired, and what it leaves behind has to go back on the purge
    list — that is the only way the owner ever gets those years of closes off
    their disk. Switching from one reference to another is a different gesture
    and keeps both; see :func:`record_consulted_benchmark`.
    """
    kept = [kept for kept in consulted_benchmarks(store) if kept != symbol]
    store.execute(
        'INSERT INTO setting (key, value) VALUES (?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [CONSULTED_KEY, ','.join(kept)])
    return kept


def orphan_symbols(store) -> List[OrphanSymbol]:
    """The symbols nothing declares any more, with the size of their series.

    Four reasons to survive, and a symbol needs only one::

        event names it     ──►  it happened, the ledger remembers
        position holds it  ──►  it is owned right now
        setting points     ──►  it is *followed*, owned by nobody (#982)
        consulted before   ──►  it was compared against once (#760)

    The third is the one a reader will not guess: a reference ticker has no
    event and no position, so without its clause the first purge would take the
    series the backfill had just spent a cycle filling. Losing it is silent —
    the comparison curve goes missing and nothing says why.

    The fourth exists because the third is about the **current** value only, so
    switching references would purge the one just left — and #760 keeps up to
    seven consulted series precisely so switching back is instant rather than a
    two-hour rebuild. Bounded at :data:`CONSULTED_LIMIT`; the eighth evicts the
    oldest, which becomes an orphan again.
    """
    rows = store.query(
        'SELECT s.symbol, count(p.symbol) '
        'FROM symbol s LEFT JOIN price_point p ON p.symbol = s.symbol '
        'WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.symbol = s.symbol) '
        '  AND NOT EXISTS (SELECT 1 FROM position q WHERE q.symbol = s.symbol) '
        '  AND NOT EXISTS (SELECT 1 FROM setting t '
        '                  WHERE t.key = ? AND t.value = s.symbol) '
        'GROUP BY s.symbol ORDER BY s.symbol',
        ['benchmark_symbol'])
    consulted = set(consulted_benchmarks(store))
    return [OrphanSymbol(symbol=row[0], points=int(row[1]))
            for row in rows if row[0] not in consulted]


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
    'LAST_WRITE_KEY', 'CONSULTED_KEY', 'CONSULTED_LIMIT', 'OrphanSymbol',
    'consulted_benchmarks', 'record_consulted_benchmark',
    'forget_consulted_benchmark',
    'read_events', 'stamp', 'last_write', 'first_payments',
    'orphan_symbols', 'purge_orphan_symbols',
    'currency_to_adopt',
]
