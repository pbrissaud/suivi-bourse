"""The ledger in the store, with its provenance (issue #697, spec #695 § 6).

The store becomes the truth of the ledger. Dropping a ``.csv``/``.xlsx`` into
the drop folder imports it on its own; the events land in the database with
their **provenance**, and the files stop being what gets re-read.

Three rules carry the whole module, and the third is the surprising one:

1. **Re-dropping the same filename replaces its rows** — a re-drop does not
   double the ledger.
2. **An import is forgotten, never a line.** Read-only forbids the pointwise
   edit, not the bulk revocation; without it, a line provisioned by a file
   would be at once *unalterable* and *indestructible*. There is therefore no
   function here that updates one event row, and its absence is asserted by the
   suite rather than left to good intentions.

   Since #764 that sentence names its **population** rather than the whole
   table: it is about a row *this module wrote*, which is a row that came from
   a file. A row somebody typed in the app comes from no file, no revocation
   can reach it, and leaving it uneditable would make a typo in the onboarding
   form (ADR-0005) definitive. Its three gestures live in :mod:`entries`, in a
   module of their own for the same reason :mod:`accounts` is one — so that
   *"the import path has no row-level write"* stays true by construction and
   not by care.
3. **Removing the file from disk does nothing.** :func:`sync_drop_folder` only
   ever adds or replaces what it finds; it has no branch that reacts to a file
   that is gone, which is what makes the rule true by construction instead of
   by care.

What survives of #662 is not an address but a display: ``(source_id,
source_sheet, source_row)`` exists to say *"row 14 of 2024.csv"* and never to
write. The opaque token and the ``ETag`` died with #711 because **the file was
the address**; in the store a row has a primary key, which does not go stale.

And the polling dies with its subject. In v4 the ingestion re-read the files
every 300 s *because they were the truth*. The ledger now changes only when a
write changes it — a quiet, synchronous, in-process gesture — so the replay
follows the write (:meth:`main.SuiviBourseMetrics.ingest`), and the drop folder
stays watched with no dial at all: a headless install has nobody to click
*import*.

Since #698 the drop folder holds **two kinds of source**, and the order between
them is a rule rather than a convenience: *all account sources are imported
before all event sources*, or the events' foreign key has nothing to point at.
The ``account`` table itself is :mod:`accounts`' — this module owns
``import_source``, hands it a ``source_id``, and never writes an account row of
its own.

Since #710 an event file may also **declare the reporting currency its amounts
are recorded in**, which is the one thing an import writes outside its own three
tables — and the exception is earned rather than convenient: the export states
the currency so that a round trip cannot silently reinterpret every amount it
carries, and reading that declaration is the whole reason it is worth writing.
:func:`_currency_to_adopt` holds the rule and nothing else here knows about it.

**Not in this module**: the replay into ``position`` / ``account_state`` (#699).
What is here writes ``import_source``, ``symbol`` and ``event`` — and, under the
paragraph above, one row of ``setting``.
"""
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from logfmt_logger import getLogger

import accounts as accounts_module
import settings_registry
from events import EventAggregator, EventLoader, EventValidator
from events.schemas import DEFAULT_ACCOUNT, Event, EventType

logger = getLogger("ledger")

#: The two kinds of source ``import_source.kind`` distinguishes. Which one a
#: file is, is read off its **header** (:func:`accounts.is_accounts_file`) and
#: never off its name — no filename has a special meaning in v5.
KIND_EVENTS = 'events'
KIND_ACCOUNTS = 'accounts'

#: What counts as a droppable file, of either kind. The extension is the only
#: thing that does: **no filename has a special meaning in v5** (spec #695 § 6),
#: so ``ui.csv`` is a file like any other and ``settings.yaml`` sitting in the
#: same folder is simply not one of these.
IMPORT_SUFFIXES = ('.csv', '.xlsx')

#: The outcomes :func:`sync_drop_folder` reports, one per file it looked at.
IMPORTED = 'imported'
UNCHANGED = 'unchanged'
REFUSED = 'refused'


class UnknownImport(Exception):
    """Asked to forget an import that is not in the store.

    Its own class because its answer is its own: the API turns it into a 404,
    and it must never be confused with "forgot nothing because there was
    nothing to forget", which is a successful revocation of an empty import.
    """


@dataclass(frozen=True)
class ImportRecord:
    """One row of ``import_source`` — the provenance of everything it carried."""
    id: int
    filename: str
    kind: str
    imported_at: Optional[datetime]
    fingerprint: str
    events: int = 0


@dataclass(frozen=True)
class SyncOutcome:
    """What one file in the drop folder led to, for logs and for the API.

    ``kind`` says which of the two sources it was taken for, which is what makes
    a refusal readable: *"refused, as an accounts file"* names the header the
    app read, and a user who meant to drop events knows immediately that their
    ``event_type`` column is missing.

    ``rows`` counts what the file carried — events for an event source, accounts
    for an accounts source.
    """
    filename: str
    outcome: str
    rows: int = 0
    error: Optional[str] = None
    kind: str = KIND_EVENTS

    @property
    def events(self) -> int:
        """Rows, when the source is an event source. ``0`` otherwise."""
        return self.rows if self.kind == KIND_EVENTS else 0


# --------------------------------------------------------------------------- #
# Provenance — displayable, never an address
# --------------------------------------------------------------------------- #

def fingerprint_of(path: Path) -> str:
    """A content hash of the file, which is what makes a re-drop detectable.

    Content and not mtime. The v4 ingestion fingerprinted by mtime because it
    re-read the files on a timer and only needed to know *whether* to bother;
    here the fingerprint decides whether rows are rewritten, and a ``touch``
    that rewrote the ledger would make the always-on watch expensive for no
    reason. It is also what a re-drop of an identical file has to be a no-op
    against — down to ``imported_at``, so the provenance a user is shown does
    not creep forward on its own.
    """
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def provenance_label(event: Event) -> Optional[str]:
    """*"2024.csv, row 14"* — the one string the interface shows.

    ``None`` for a row with no source, which is what a line created in the UI
    is (``source_id IS NULL`` means "created in the UI", spec #695 § 6). The
    sheet only appears when there is one, so a CSV does not carry an empty
    parenthesis around for the sake of a uniform format.
    """
    if not event.source_filename:
        return None
    parts = [event.source_filename]
    if event.source_sheet:
        parts.append(f"sheet {event.source_sheet}")
    if event.source_row is not None:
        parts.append(f"row {event.source_row}")
    return ", ".join(parts)


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #

_EVENT_COLUMNS = (
    'e.id, e.date, e.event_type, e.symbol, e.name, e.quantity, e.unit_price, '
    'e.fee, e.amount, e.notes, e.account, e.source_id, e.source_sheet, '
    'e.source_row, s.filename'
)


def read_events(store) -> List[Event]:
    """Every event in the ledger, as :class:`events.schemas.Event`, date-sorted.

    Sorted in SQL by ``(date, id)`` rather than in Python: ``id`` is monotonic
    per import, so two events on the same date come back in the order their
    file wrote them, and a replay is reproducible across restarts. The
    aggregator assumes a date-sorted list and nothing more.

    The join to ``import_source`` is what carries the filename onto the event,
    so a caller holding an event can render its provenance without going back
    to the store for it.

    **The key comes down with the row** (issue #764). ``event.id`` was in the
    DDL from #696 and in nothing this function returned, so the ledger the app
    published held no address at all — and an address is what a row typed in the
    app needs to be editable. It rides here rather than being fetched a second
    time by whoever wants it, exactly as the filename does: one ``SELECT``, and
    a holder of an :class:`Event` holds everything it takes to say what that
    event is and where it came from.
    """
    rows = store.query(
        f'SELECT {_EVENT_COLUMNS} FROM event e '
        'LEFT JOIN import_source s ON s.id = e.source_id '
        'ORDER BY e.date, e.id')
    return [_event_from_row(row) for row in rows]


def _event_from_row(row: Sequence) -> Event:
    """One ``event`` row (joined to its source) back into an :class:`Event`."""
    (event_id, day, event_type, symbol, name, quantity, unit_price, fee,
     amount, notes, account, source_id, source_sheet, source_row,
     filename) = row
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
        source_id=source_id,
        source_sheet=source_sheet,
        source_row=source_row,
        source_filename=filename,
    )


def list_imports(store, kind: Optional[str] = None) -> List[ImportRecord]:
    """The imports the store holds, newest name last, with their event counts.

    The count is what makes the revocation gesture answerable *before* it is
    made — "forget this import" is destructive in bulk, so the number of rows
    it takes with it belongs next to the button that offers it.
    """
    clause = 'WHERE s.kind = ?' if kind else ''
    rows = store.query(
        'SELECT s.id, s.filename, s.kind, s.imported_at, s.fingerprint, '
        '       count(e.id) '
        'FROM import_source s LEFT JOIN event e ON e.source_id = s.id '
        f'{clause} '
        'GROUP BY s.id, s.filename, s.kind, s.imported_at, s.fingerprint '
        'ORDER BY s.filename',
        [kind] if kind else None)
    return [ImportRecord(id=r[0], filename=r[1], kind=r[2], imported_at=r[3],
                         fingerprint=r[4], events=r[5]) for r in rows]


def stamp(store) -> Optional[str]:
    """A fingerprint of the whole ledger, for the snapshot's cache key.

    The heir of the mtime fingerprint #658 built, moved to its new subject: the
    files are no longer the truth, so what a snapshot must be invalidated
    against is the *store*. Built from the sources' own fingerprints plus the
    event count, so it moves on a re-drop that changed content (the fingerprint
    changes), on a forget (a source disappears) and on nothing else.

    **The declaration joins it** (issue #698). An account created or relabelled
    in the app changes no import and no event, so a stamp built from the imports
    alone would leave the published snapshot showing the previous list — and the
    snapshot is where every reader takes its accounts from.

    ``None`` when there is neither an import nor a declaration — the fresh
    install with nothing yet dropped, which is a legitimate state and not a hole
    to report. The seeded ``default`` row is not a declaration and does not
    count, or no install would ever be fresh.
    """
    rows = store.query(
        'SELECT id, filename, fingerprint FROM import_source ORDER BY id')
    declared = store.query(
        'SELECT id, type, label, source_id FROM account '
        'WHERE id <> ? ORDER BY id', [DEFAULT_ACCOUNT])
    if not rows and not declared:
        return None
    (count,) = store.query('SELECT count(*) FROM event')[0:1][0]
    imports = '|'.join(f'{r[0]}:{r[1]}:{r[2]}' for r in rows)
    declarations = '|'.join(str(tuple(a)) for a in declared)
    payload = f'{imports}#{declarations}#{count}'
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


# --------------------------------------------------------------------------- #
# Writing — the import, and the one destructive gesture
# --------------------------------------------------------------------------- #

def sync_drop_folder(store, directory,
                     now: Optional[datetime] = None) -> List[SyncOutcome]:
    """Import every file the drop folder holds, accounts first. Idempotent.

    Called on every write that could have changed the folder — the watcher's
    callback and the boot — and it is safe to call on a filesystem event that
    changed nothing, because an unchanged fingerprint costs one hash and no
    write at all.

    **A folder that does not exist is a fresh install**, not a broken one: the
    user has not dropped a file into what the mount will create for them. Same
    answer as an empty folder, and never a boot failure.

    Each file is its own transaction and its own verdict. A refusal is per
    source on purpose — one bad file must not hold the whole folder hostage —
    and the refused file leaves no row behind at all, not even the ``symbol``
    rows it would have needed.

    Two rules of order, both from issue #698:

    * **all account sources before all event sources.** An event's ``account``
      references ``account(id)``, so a file naming ``pea`` needs the row to
      already be there — the foreign key is not a check that runs later, it is
      the reason the ordering exists. It is *all* before *all*, not a
      per-directory alphabetical shuffle: two files sorted ``events.csv`` then
      ``pea.csv`` would otherwise refuse on the first pass and succeed on the
      second, which is a folder whose meaning depends on how many times it was
      scanned.
    * **a declaration that moved re-imports the events**, fingerprint or not.
      An event file imported before its accounts existed had its rows written
      under ``default``; leaving them there would show the user the accounts
      they declared next to a ledger that ignores them. Re-importing is how the
      column stops being a label and becomes a key — and a file that cannot pay
      the new rule (a blank column, now that accounts exist) is refused *then*,
      with the previous rows left exactly where they were.

    **The forced pass happens once, and that is deliberate.** A refusal rolls
    back, so the refused file keeps its stored fingerprint and later scans
    report it ``unchanged`` — its rows stay under ``default`` and the error is
    logged once, when the user made the change that caused it. The retry comes
    with the file's next edit, which is exactly what the fix is: a file refused
    for a blank ``account`` column can only be repaired by writing that column,
    and writing it moves the fingerprint. The alternative — re-reading and
    re-validating every unchanged file on every filesystem event — would put a
    parse of the whole drop folder behind a watch that exists to cost one hash.
    """
    source = Path(directory).expanduser()
    if not source.is_dir():
        return []

    declaring, eventful = [], []
    for path in sorted(source.iterdir()):
        if path.suffix.lower() not in IMPORT_SUFFIXES or not path.is_file():
            continue
        # Read once: the header is what classifies a file, and asking twice
        # would open every workbook in the folder a second time.
        bucket = declaring if accounts_module.is_accounts_file(path) else eventful
        bucket.append(path)

    before = _declaration_stamp(store)
    outcomes = [_sync_accounts_file(store, path, now) for path in declaring]
    force = _declaration_stamp(store) != before

    outcomes.extend(_sync_event_file(store, path, now, force=force)
                    for path in eventful)
    return outcomes


def _declaration_stamp(store) -> List[tuple]:
    """The account table as a comparable value, to see a declaration move."""
    return store.query(
        'SELECT id, type, label, source_id FROM account ORDER BY id')


def _sync_event_file(store, path: Path, now: Optional[datetime], *,
                     force: bool = False) -> SyncOutcome:
    """Import one event file if its content moved, and report what happened."""
    digest = _digest_or_none(path)
    if digest is None:
        return SyncOutcome(path.name, REFUSED, error="cannot read the file")

    if not force and _fingerprint_in_store(store, path.name) == digest:
        return SyncOutcome(path.name, UNCHANGED)

    try:
        count = import_file(store, path, fingerprint=digest, now=now)
    except Exception as exc:
        logger.warning(f"Refused {path.name}: {exc}")
        return SyncOutcome(path.name, REFUSED, error=str(exc))

    logger.info(f"Imported {path.name}: {count} event(s)")
    return SyncOutcome(path.name, IMPORTED, rows=count)


def _sync_accounts_file(store, path: Path,
                        now: Optional[datetime]) -> SyncOutcome:
    """Import one accounts file if its content moved (issue #698)."""
    digest = _digest_or_none(path)
    if digest is None:
        return SyncOutcome(path.name, REFUSED, kind=KIND_ACCOUNTS,
                           error="cannot read the file")

    if _fingerprint_in_store(store, path.name) == digest:
        return SyncOutcome(path.name, UNCHANGED, kind=KIND_ACCOUNTS)

    try:
        count = import_accounts_file(store, path, fingerprint=digest, now=now)
    except Exception as exc:
        logger.warning(f"Refused accounts file {path.name}: {exc}")
        return SyncOutcome(path.name, REFUSED, kind=KIND_ACCOUNTS,
                           error=str(exc))

    logger.info(f"Imported {path.name}: {count} account(s)")
    return SyncOutcome(path.name, IMPORTED, rows=count, kind=KIND_ACCOUNTS)


def _digest_or_none(path: Path) -> Optional[str]:
    try:
        return fingerprint_of(path)
    except OSError as exc:
        logger.warning(f"Cannot read {path.name}: {exc}")
        return None


def _fingerprint_in_store(store, filename: str) -> Optional[str]:
    known = store.query(
        'SELECT fingerprint FROM import_source WHERE filename = ?', [filename])
    return known[0][0] if known else None


def import_accounts_file(store, path: Path, *, fingerprint: Optional[str] = None,
                         now: Optional[datetime] = None) -> int:
    """Import one accounts file, replacing whatever it declared before.

    The same shape as :func:`import_file` and for the same reasons — one
    transaction, keyed on the filename, all-or-nothing — with the account rows
    themselves written by :mod:`accounts`, which owns that table.

    Returns the number of accounts declared.

    Raises:
        AccountSourceError: the file cannot be read, or what it declares
            collides with a declaration that already stands.
        AccountInUse: it stopped declaring an account an event still names.
            The cascade is refused rather than performed (ADR-0013).
        AggregationError: dropping this source's events leaves a ledger that
            does not replay.
    """
    stamped = now or datetime.now(timezone.utc)
    digest = fingerprint or fingerprint_of(path)
    rows = accounts_module.load_account_rows(path)

    with store.transaction():
        source_id = _upsert_source(store, path.name, KIND_ACCOUNTS, stamped,
                                   digest)
        # The mirror of what :func:`import_file` does with accounts: a source
        # declares one kind of thing at a time, so a file whose header flipped
        # from events to accounts leaves its event rows behind unless they go
        # here. Without it they would hang off a source marked ``accounts``,
        # invisible to every gesture that reasons about kinds and removable only
        # by forgetting an import that no longer claims them.
        store.execute('DELETE FROM event WHERE source_id = ?', [source_id])
        written = accounts_module.apply_source(store, source_id, rows)

        # The ledger the drop would leave, replayed before the commit — the
        # same assertion :func:`import_file` makes, and for a sharper reason:
        # the DELETE above can remove the BUYs another file's SELLs rest on, and
        # an unreplayable ledger committed here is a store that raises on every
        # reload. That raise is fatal at boot (``build_runtime`` exits), so the
        # API that could forget this import would never come up to be asked.
        EventAggregator().aggregate(read_events(store))
    return written


def import_file(store, path: Path, *, fingerprint: Optional[str] = None,
                now: Optional[datetime] = None) -> int:
    """Import one event file into the store, replacing whatever it left before.

    One transaction, and the order inside it is the design:

    1. the ``import_source`` row, keyed on the **filename** — the identity of a
       source is its name (spec #695 § 6), so a re-drop finds its own row and a
       rename is a new source, repairable by forgetting the old one;
    2. ``DELETE FROM event WHERE source_id = ?`` — this is *replaces*, and it is
       why a correction does not double the ledger;
    3. **whatever this source used to declare is retired** (issue #698). A
       source declares one kind of thing at a time, so overwriting an accounts
       file with events takes its accounts with it — and if an event still names
       one, this raises and the re-drop is refused whole, which is the cascade
       refusal seen from its other side. A no-op on the common path;
    4. **the ``symbol`` rows, before the events.** Not an optimisation: a row
       naming ``AAPL`` would violate its foreign key otherwise, which is the
       acceptance criterion saying that a symbol gets its row at ingestion,
       before any yfinance call could have created one;
    5. the event rows;
    6. **the whole prospective ledger is validated and replayed** before the
       commit. Per-row validation is not enough — overselling is a property of
       the ledger, not of a file — and a file that only breaks in company must
       be refused as squarely as one that breaks alone. A failure rolls the
       whole transaction back, so a bad file is *not imported at all* and what
       was already good is untouched.

    A file that **declares a reporting currency** (issue #710) has that read
    before anything else, by :func:`_currency_to_adopt`; the row it produces is
    written first inside the transaction, so a refused import leaves the dial
    exactly as it found it.

    Returns the number of event rows written.

    Raises:
        EventLoaderError: the file could not be read or parsed.
        EventValidationError: the file, or the ledger it would make, is invalid.
        AggregationError: the resulting ledger does not replay (an oversell).
        accounts.AccountInUse: it stopped declaring an account an event names.
        settings_registry.InvalidSetting: the file declares a reporting currency
            that is not a currency, or one this install can no longer take.
    """
    stamped = now or datetime.now(timezone.utc)
    digest = fingerprint or fingerprint_of(path)
    loader = EventLoader(str(path))
    parsed = loader.load()
    # Decided **before** the transaction opens, and therefore against the ledger
    # as it stands rather than as this import leaves it. Inside, step 2 has
    # already deleted this source's own rows, so a re-drop of the only file in a
    # store would be judged against an empty ledger and could quietly
    # reinterpret every amount it is about to re-insert.
    adopted = _currency_to_adopt(store, loader.declared_currency)

    with store.transaction():
        if adopted is not None:
            store.execute(
                'INSERT INTO setting (key, value) VALUES (?, ?) '
                'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
                ['base_currency', settings_registry.stored_form(
                    'base_currency', adopted)])
            logger.info(f"{path.name} declares {adopted} as the reporting "
                        f"currency; taking it up")
        source_id = _upsert_source(store, path.name, KIND_EVENTS, stamped, digest)
        store.execute('DELETE FROM event WHERE source_id = ?', [source_id])
        accounts_module.forget_source(store, source_id)

        # The account rules read the table, never a parameter (issue #698), and
        # they read it **here** rather than before the transaction: the two
        # statements above are part of this drop, so a file that used to declare
        # the accounts it is now dropping must be judged against the declaration
        # it leaves behind, not the one it is replacing. Otherwise a file could
        # be refused for breaking a rule it had just repealed.
        validator = EventValidator(
            account_ids=accounts_module.account_ids(store),
            accounts_declared=accounts_module.accounts_are_declared(store))

        # The file on its own terms first, so the message names what the user
        # just dropped rather than the ledger as a whole.
        validator.validate_or_raise(parsed)

        _insert_symbols(store, parsed)
        written = _insert_events(store, parsed, source_id)

        # The ledger as it would stand. Validated and replayed here too, which
        # is what makes the rollback below a real refusal.
        whole = read_events(store)
        validator.validate_or_raise(whole)
        EventAggregator().aggregate(whole)
    return written


def forget_import(store, source_id: int) -> int:
    """Forget an import: every row it laid down, in one gesture.

    The **only** destructive gesture in this module, and it is deliberately in
    bulk. Read-only forbids editing line 42 of ``broker.csv``; it does not
    forbid revoking the file. Without this, a line provisioned by a file would
    be both unalterable and indestructible, which is the trap #697 exists to
    avoid.

    What it does **not** remove is the ``symbol`` rows the import created.
    Forgetting an import is reversible — re-drop the file — while the price
    series hanging off a symbol is not, and #695 § 10 keeps those orphans
    deliberately, named and purgeable on demand.

    Returns the number of event rows removed (``0`` is a legitimate answer: an
    import that carried no event is still an import).

    **Two transactions, and not by preference.** DuckDB refuses to delete a
    referenced key in the same transaction that deleted the rows referencing it
    — its foreign-key index still holds them — so the events are committed away
    before the source row is touched. The window between the two is one
    statement wide in a single-threaded process, and what it can leave behind is
    an ``import_source`` row carrying zero events: visible in
    :func:`list_imports` with ``events == 0``, and repaired by forgetting it
    again, which then succeeds. The alternative — deleting the source first — is
    the one the engine forbids outright.

    An **accounts** import takes its accounts with it, and that is where the one
    refusal lives: forgetting is refused outright while an event names one of
    them (:class:`accounts.AccountInUse`, ADR-0013). Cascading — deleting the
    events too, or orphaning them — is what the refusal exists instead of. The
    user's move is the same either way: forget the event imports first, then
    the declaration they rest on.

    Raises:
        UnknownImport: no import has that id.
        accounts.AccountInUse: it declared an account an event still names.
    """
    known = store.query(
        'SELECT id, kind FROM import_source WHERE id = ?', [source_id])
    if not known:
        raise UnknownImport(f"No import with id {source_id}")

    # Refuse before anything is removed. `forget_source` raises on the first
    # account an event names, and it is called first precisely so that a refusal
    # leaves the import whole rather than half-forgotten.
    retired = accounts_module.forget_source(store, source_id)

    (removed,) = store.query(
        'SELECT count(*) FROM event WHERE source_id = ?', [source_id])[0:1][0]
    store.execute('DELETE FROM event WHERE source_id = ?', [source_id])
    store.execute('DELETE FROM import_source WHERE id = ?', [source_id])
    logger.info(f"Forgot import {source_id}: {removed} event(s) and "
                f"{len(retired)} account(s) removed")
    return removed


def _currency_to_adopt(store, declared: Optional[str]) -> Optional[str]:
    """What an event file's ``base_currency`` column asks this install to store.

    ``None`` means *write nothing*: the file declares no currency, or it declares
    the one already in force. Anything else is the value the import writes into
    ``setting``.

    The rule the whole thing rests on (ADR-0021): **the app reads a declaration,
    it never asserts one.** An exported file states the currency its amounts were
    recorded in — event amounts being the debit *in the reporting currency*
    (ADR-0002), a file carrying none is a file every amount of which can be
    silently re-read as another unit. So a store that has never answered the
    question takes the file's answer, and that is what makes the headless round
    trip work with no ``curl`` at all: drop the export, and the install is the
    install it came from.

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
            f"stored rather than convert it. Forget those imports first.")
    return value


# --------------------------------------------------------------------------- #
# The row-level gestures the two writers above are made of
# --------------------------------------------------------------------------- #

def _upsert_source(store, filename: str, kind: str, stamped: datetime,
                   digest: str) -> int:
    """The ``import_source`` row for this filename, created or refreshed.

    Ids are allocated as ``max(id) + 1`` rather than by a sequence: the table
    holds a handful of rows, it is written under a transaction that already
    serialises its writers (one process, one ingestion), and a sequence would be
    a second thing to keep in step with the DDL for no gain.
    """
    known = store.query(
        'SELECT id FROM import_source WHERE filename = ?', [filename])
    if known:
        source_id = known[0][0]
        store.execute(
            'UPDATE import_source SET kind = ?, imported_at = ?, fingerprint = ? '
            'WHERE id = ?', [kind, stamped, digest, source_id])
        return source_id

    (next_id,) = store.query(
        'SELECT coalesce(max(id), 0) + 1 FROM import_source')[0:1][0]
    store.execute(
        'INSERT INTO import_source (id, filename, kind, imported_at, fingerprint) '
        'VALUES (?, ?, ?, ?, ?)', [next_id, filename, kind, stamped, digest])
    return next_id


def _insert_symbols(store, events: Sequence[Event]) -> None:
    """Give every symbol the file names its row — before the events reference it.

    ``symbol`` is a bare one-column table whose only job is to be the target of
    a foreign key (spec #695 § 3). It pays for the integrity that keeps a typo'd
    ticker out of the price table without an index on the price table, and it is
    the ingestion that creates it, never the scrape: two writers on one row is
    the thing the schema's generating rule exists to forbid.
    """
    for symbol in sorted({e.symbol for e in events if e.symbol}):
        store.execute(
            'INSERT INTO symbol (symbol) VALUES (?) ON CONFLICT DO NOTHING',
            [symbol])


def _insert_events(store, events: Sequence[Event], source_id: int) -> int:
    """Write the file's events, carrying their provenance.

    The account written is the one the aggregator resolves, and since #698 that
    is one expression with no branch in it: the event's own account, or
    ``default`` when the column is blank. The validator has already refused a
    blank column when accounts are declared and an unknown id in every case, so
    what reaches this line is always an id the foreign key will accept.
    """
    (next_id,) = store.query('SELECT coalesce(max(id), 0) + 1 FROM event')[0:1][0]

    for offset, event in enumerate(events):
        account = event.account or DEFAULT_ACCOUNT
        store.execute(
            'INSERT INTO event (id, date, event_type, account, symbol, name, '
            '                   quantity, unit_price, fee, amount, notes, '
            '                   source_id, source_sheet, source_row) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [next_id + offset, event.date, event.event_type.value, account,
             event.symbol, event.name, event.quantity, event.unit_price,
             event.fee, event.amount, event.notes,
             source_id, event.source_sheet, event.source_row])
    return len(events)


def import_counts(outcomes: Sequence[SyncOutcome]) -> Dict[str, int]:
    """Tally the outcomes of a sync, for one log line and for ``/api/runtime``."""
    tally = {IMPORTED: 0, UNCHANGED: 0, REFUSED: 0}
    for outcome in outcomes:
        tally[outcome.outcome] = tally.get(outcome.outcome, 0) + 1
    return tally


__all__ = [
    'ImportRecord', 'SyncOutcome', 'UnknownImport',
    'KIND_EVENTS', 'KIND_ACCOUNTS', 'IMPORT_SUFFIXES',
    'IMPORTED', 'UNCHANGED', 'REFUSED',
    'fingerprint_of', 'provenance_label',
    'read_events', 'list_imports', 'stamp',
    'sync_drop_folder', 'import_file', 'import_accounts_file', 'forget_import',
    'import_counts',
]
