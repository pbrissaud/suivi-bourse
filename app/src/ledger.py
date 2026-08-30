"""The ledger in the store — read here, written in one place, and nowhere else.

**One population, one writer** (ADR-0032, issue #816). This module used to own
the *import*: whole files in, whole files out, an ``import_source`` row, three
provenance columns on every event, a revocation by file and a ``409`` that
refused a row-level write on a row a file had provisioned. All of it answered
one question — *a file and the store must not become two truths about the same
purchase* — and that question was about a file that is **mounted, watched and
re-read**. There is no folder any more: a file is handed to
``POST /api/events/import``, parsed once (:mod:`uploads`) and never seen again,
and its rows go in through :mod:`entries` exactly as typed ones do. The argument
did not survive the mount, and neither did the split it produced — so the
population that had to be revoked in bulk *because it could not be corrected*
has nothing left to be, and *"the import path has no row-level write"* has
nothing left to protect.

What is left here is the **reading** side of the ledger, plus the one gesture
that belongs to no row at all:

* :func:`read_events` — the whole ledger, date-sorted, as the aggregator wants
  it. Every reader in the app goes through it.
* :func:`stamp` — the snapshot's cache key, a fingerprint of what a snapshot is
  built from. The sources being gone, it fingerprints the **rows** themselves,
  which is what an edit in place moves and a count of them does not.
* :func:`last_write` — when the ledger last changed, recorded by the writer
  (:mod:`entries`) because nothing else observes a write any more.
* :func:`orphan_symbols` / :func:`purge_orphan_symbols` — spec #695 § 10's
  deliberate orphan, named and purgeable on demand.
* :func:`currency_to_adopt` — the one thing a **file** says about itself rather
  than about a row (#710), asked by the upload route before it writes anything.

**Not in this module**: any write to ``event``. That is :mod:`entries`', whole
and entire, and it is a fact about the tree now rather than a rule to defend.
"""
import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional, Sequence, Tuple

from logfmt_logger import getLogger

import instants
import quotes
import settings_registry
from events.schemas import DEFAULT_ACCOUNT, Event, EventType

logger = getLogger("ledger")

#: The ``setting`` row :mod:`entries` stamps on every write, and the only thing
#: left in the store that observes *when* the ledger moved. ``import_source``
#: carried an ``imported_at`` and answered the question for free; with the table
#: gone the writer records the instant itself, in the one place a key that did
#: not exist yesterday costs no migration at all (:func:`store.apply_schema`).
#:
#: It is a **row of its own with a single writer**, which is what ADR-0006 asks:
#: no dial shares it, and :func:`settings.read_all` enumerates the registry
#: rather than the table, so it is invisible to ``/api/settings`` and to the form.
LAST_WRITE_KEY = 'ledger_last_write'


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #

_EVENT_COLUMNS = (
    'id, date, event_type, symbol, name, quantity, unit_price, '
    'fee, amount, notes, account'
)


def read_events(store) -> List[Event]:
    """Every event in the ledger, as :class:`events.schemas.Event`, date-sorted.

    Sorted in SQL by ``(date, id)`` rather than in Python: ``id`` is monotonic
    per write, so two events on the same date come back in the order they were
    recorded, and a replay is reproducible across restarts. The aggregator
    assumes a date-sorted list and nothing more.

    **The key comes down with the row** (issue #764). ``event.id`` was in the
    DDL from #696 and in nothing this function returned, so the ledger the app
    published held no address at all — and an address is what a row needs to be
    editable. There is no join left to make: the columns below are the table's
    own, all of them, since #816 took the provenance away.
    """
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


#: The ledger's rows folded into one string **by the engine** rather than by
#: Python: :func:`stamp` runs on every rebuild, and materialising the whole table
#: to hash it would make the cache key cost what the rebuild it exists to avoid
#: costs. ``chr(31)``/``chr(30)`` are the unit and record separators, which no
#: cell of a ledger carries; every nullable column is coalesced, or two rows
#: differing only in where a ``NULL`` sits would fold to the same bytes.
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
    """A fingerprint of the whole ledger, for the snapshot's cache key.

    The heir of the mtime fingerprint #658 built, on its third subject and its
    last. The files were the truth, then the ``import_source`` rows were what a
    snapshot had to be invalidated against; since #816 there are neither, so what
    it fingerprints is **the rows themselves**.

    That is not a fallback, it is the only thing that works now: a correction to
    one row's price changes no count and no source, and a stamp built from a
    count would republish the ledger as it was. The gestures :mod:`entries`
    offers — the write, the rewrite in place, the removal, the removal in bulk —
    all move this string, which is the whole of what a cache key owes.

    **The declaration joins it** (issue #698). An account created or relabelled
    in the app changes no event, so a stamp built from the ledger alone would
    leave the published snapshot showing the previous list — and the snapshot is
    where every reader takes its accounts from.

    ``None`` when there is neither an event nor a declaration — the fresh install
    with nothing recorded, which is a legitimate state and not a hole to report.
    The seeded ``default`` row is not a declaration and does not count, or no
    install would ever be fresh.
    """
    (digest,) = store.query(_LEDGER_DIGEST)[0:1][0]
    declared = store.query(
        'SELECT id, type, label FROM account '
        'WHERE id <> ? ORDER BY id', [DEFAULT_ACCOUNT])
    if digest is None and not declared:
        return None
    declarations = '|'.join(str(tuple(a)) for a in declared)
    payload = f'{digest or ""}#{declarations}'
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def last_write(store) -> Optional[datetime]:
    """When the ledger last changed, or ``None`` — nothing has ever been written.

    **The last write, never the last observation** (#724). The two are one
    keystroke apart on a page and they are not the same fact: a price observed
    two minutes ago says the scheduler is alive, which is liveness and belongs to
    the banner, while *"nothing has entered your ledger since 3 January"* is a
    property of the installation's own data — the one the store block exists to
    state. Showing the newest ``price_point`` there would make a store whose last
    write was a year ago look freshly written.

    It was ``max(import_source.imported_at)`` while a file was a row; a file is a
    payload now, so the **writer** stamps the instant (:data:`LAST_WRITE_KEY`)
    and this reads it back. Same fact, one table along, and it counts a
    correction and a deletion as the writes they are — which the old query, being
    about imports, never did.
    """
    # The row, and never :meth:`store.Store.setting`: that method resolves a
    # **dial** against the registry, and this key is deliberately not one —
    # asking the registry for it is a ``KeyError``, which is the registry saying
    # what it should say about a row that is not a setting.
    rows = store.query(
        'SELECT value FROM setting WHERE key = ?', [LAST_WRITE_KEY])
    stamped = rows[0][0] if rows else None
    if not stamped:
        return None
    try:
        return instants.utc(datetime.fromisoformat(stamped))
    except ValueError:
        # Nothing in this app writes that row in another shape; unreadable is
        # therefore *unknown*, and never an exception thrown at a page whose
        # whole question is how the store is doing.
        logger.warning(f"Unreadable {LAST_WRITE_KEY}: {stamped!r}")
        return None


@dataclass(frozen=True)
class OrphanSymbol:
    """A ``symbol`` row no event names any more, and the series hanging off it.

    ``points`` is what the purge would remove, and it is published because the
    gesture has to be answerable *before* it is made — the same rule that puts a
    row count in the confirmation of a bulk deletion.
    """

    symbol: str
    points: int


def orphan_symbols(store) -> List[OrphanSymbol]:
    """The symbols nothing declares any more, with the size of their series.

    Spec #695 § 10 keeps them **deliberately**: a reconstructed price series is
    not something the app can make again on demand, so it never throws one away
    by itself. What it owes in exchange is that they be *named and purgeable on
    demand*, and this is the first half.

    A **sold position is not an orphan**: its events are still in the ledger, so
    it is still named here and never appears in this list. The predicate is the
    absence of an event, not a quantity at zero — the two are the distinction
    ADR-0003 spent a table on.

    ``position`` is tested too, and not out of caution: it references
    ``symbol(symbol)`` as well, so a row there would make the purge's ``DELETE``
    trip a foreign key. It cannot happen — the replay rewrites ``position`` from
    the events, so a symbol no event names has no position either — and the
    clause is what makes *the purge always succeeds* true by construction rather
    than by that reasoning holding.
    """
    rows = store.query(
        'SELECT s.symbol, count(p.symbol) '
        'FROM symbol s LEFT JOIN price_point p ON p.symbol = s.symbol '
        'WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.symbol = s.symbol) '
        '  AND NOT EXISTS (SELECT 1 FROM position q WHERE q.symbol = s.symbol) '
        'GROUP BY s.symbol ORDER BY s.symbol')
    return [OrphanSymbol(symbol=row[0], points=int(row[1])) for row in rows]


def purge_orphan_symbols(store) -> Tuple[List[str], int]:
    """Purge every orphan: its series, its quote row, then the symbol itself.

    The second half of #695 § 10's exchange, and the **only** gesture on that
    page that destroys anything.

    What it returns is what the interface has to say next to it, and what it
    deliberately does **not** say is *bytes*: measured, 79 % of the rows of a
    real store were purged for **zero bytes** returned (126,0 Mo before, 126,0
    Mo after, the same content rebuilt from scratch fitting in 26,0). DuckDB
    reuses its blocks; the file does not shrink. Reporting rows is the truth,
    and the sentence beside the button is the rest of it.

    The market's two tables are written through :func:`quotes.forget_symbol`,
    theirs being the only writer of them (ADR-0006); the ``symbol`` row is this
    module's, which is why the gesture is assembled here.

    **Two transactions, and not by preference**: DuckDB refuses to delete a
    referenced key in the transaction that deleted the rows referencing it,
    because its foreign-key index still holds them. So ``symbol_quote`` is
    committed away before ``symbol`` is touched. What the window between the two
    can leave behind is a symbol row with no series, which reads as an orphan
    holding zero points and is repaired by purging again — the alternative,
    deleting the symbol first, is the one the engine forbids outright.
    """
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
    """What an event file's ``base_currency`` column asks this install to store.

    A file arrives one way now, so the question is put once, by that road:
    :func:`entries.judge` for the preview and the upload route before it writes.

    ``None`` means *write nothing*: the file declares no currency, or it declares
    the one already in force. Anything else is the value the import writes into
    ``setting``.

    The rule the whole thing rests on (ADR-0021): **the app reads a declaration,
    it never asserts one.** An exported file states the currency its amounts were
    recorded in — event amounts being the debit *in the reporting currency*
    (ADR-0002), a file carrying none is a file every amount of which can be
    silently re-read as another unit. So a store that has never answered the
    question takes the file's answer, and that is what makes the round trip work:
    upload the export, and the install is the install it came from.

    A **disagreement** is arbitrated by the dial's own mutability rule rather
    than by a second one invented here — free while the ledger is empty, fixed
    from the first recorded event (:func:`settings._refuse_a_reinterpretation`).
    With no event, nothing has been interpreted and nothing can be
    reinterpreted; with events, adopting would re-read every one of them in
    another unit, which is the unrecoverable act ADR-0002 names. Two spellings of
    *"may this install still answer"* would eventually disagree, and the symptom
    would be a portfolio silently changing currency.

    The **shape** of the code is not judged here either: it goes to
    :func:`settings_registry.validate`, the one authority on what a currency
    looks like, so an events file saying ``EURO`` is refused with the message the
    settings form gives — and refused *whole*, since the raise happens before the
    transaction opens.
    """
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
    'read_events', 'stamp', 'last_write',
    'orphan_symbols', 'purge_orphan_symbols',
    'currency_to_adopt',
]
