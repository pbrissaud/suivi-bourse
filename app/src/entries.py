"""The one writer of the ledger, and the gestures a row earns (issues #764, #816).

**One population, one writer, one set of gestures** (ADR-0032). There were two
until #816: a row typed in the app, which corrected and deleted, and a row a
mounted file had provisioned, which did neither — ``PUT`` and ``DELETE`` refused
it in ``409``, and the only gesture offered instead was *forget the whole file*.
That asymmetry had a real argument behind it — a file that is **mounted, watched
and re-read** and the store must not become two truths about the same purchase —
and the argument was about the mount, not about provenance. A file is handed
over by ``POST /api/events/import`` now, parsed once and never seen again; it is
a payload, dead the instant it is read. So its rows come in here, through the
same functions the form uses, and are indistinguishable from typed ones. A typo
in an imported line is a typo, not a fate, and undoing an import is a deletion
over the ledger's own reduction rather than a revocation of a batch identity.

What that leaves is a module with a *whole* subject rather than half of one:
every write to ``event`` in this application happens below, and the sentence
*"the import path has no row-level write"* has nothing left to be true about.

Three properties are decisions rather than details.

**Validation has one owner, and it is** :mod:`events.validator`. A typed event
and an imported one obey the same rules or they are two products: the validator
runs over the **whole stored ledger** on every build, so a row one road let
through and the other would have refused fails the *boot*, in an app the owner
then cannot reach to repair it. What this module
adds is not a second rule set but the *context* a file's rows need too — the
declared accounts — and the refusal it raises carries the field the validator
named, so a form can mark the input rather than print a paragraph. **The
validator is handed the draft as it arrived**, blank account included: a blank
means ``default`` only while nothing is declared, so resolving it first would
hide the very cell the rule is about and let a phantom ``default`` grow on an
install that declares ``pea``.

**Nothing is written when anything refuses.** The single-row check, the write
and the replay all live inside one ``store.transaction()``, so a refusal rolls
back to the ledger as it stood. That is ``PUT /api/settings``' rule, and it is
what makes a file imported whole or not at all: a half-applied body is a state
nobody asked for.

**The replay is the last assertion, and it is not the same one.** Per-row
validity is a property of the row; **overselling is a property of the ledger**,
so a `SELL` that is legal on its own can be illegal in company — and a `BUY`
whose removal makes a later `SELL` an oversell is the same fact seen from the
other side. So every one of the gestures ends by replaying the ledger it
would leave, inside the transaction.

**The bulk removal is what replaced the revocation** (issue #814, ADR-0032).
:func:`remove_selection` deletes what the ledger's own reduction retains,
*whatever* laid the rows down — which is now every row, there being one kind. It
undoes a whole import without ever naming an import, and it reaches the twelve
rows somebody mistyped, which no revocation could. What separates it from the
three gestures above is not a population but an address: they take **one row by
its key**, and this one takes none.

**A duplicate is caught by content, and never by a constraint** (issue #813,
ADR-0032). :data:`DUPLICATE_KEY_COLUMNS` is the key; :func:`split_duplicates`
compares it against the ledger and against the file itself, and the import skips
what it finds unless the caller says otherwise. It is declared **nowhere in the
DDL**, and that is the point rather than an omission: two `BUY` of ten shares at
the same price on the same day are one order filled twice, and a unique index
over those eight columns would make that impossible to record **from the
keyboard as well** — :func:`create` asks nothing about duplicates, and two
strictly identical `POST /api/events` both land. ADR-0007's rule decides it from
the other side too: the error a constraint would catch does not enter here, it
enters at the import, and it is caught there.

**Not in this module**: reading the ledger back (:func:`ledger.read_events`) and
the symbol's own price history. A symbol row is created here when an event needs
one (the foreign key wants it), and never removed — the orphan is #695 § 10's
deliberate one, named and purgeable, because a row can be typed again and a
price series cannot.
"""
from dataclasses import replace
from datetime import datetime, timezone
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from logfmt_logger import getLogger

import accounts as accounts_module
import ledger
import settings_registry
from events import EventAggregator, EventValidator
from events import export as events_export
from events.schemas import DEFAULT_ACCOUNT, Event

logger = getLogger("entries")

#: **What makes two rows the same purchase** (issue #813, ADR-0032). Eight
#: members, and the two that are missing are the whole decision: ``name`` and
#: ``notes`` are excluded, or annotating a row would make it re-importable — the
#: reader who writes *"PEA, ordre du matin"* on line 42 would find line 42 landing
#: a second time at the next upload of the same export.
#:
#: It is named here rather than spelled inline because a second spelling of it is
#: how the preview and the write come to disagree about what a duplicate is; and
#: it is a **tuple of column names** so a test can say *these eight, and no
#: constraint over them* against the DDL.
DUPLICATE_KEY_COLUMNS = ('date', 'event_type', 'account', 'symbol', 'quantity',
                         'unit_price', 'fee', 'amount')


class UnknownEntry(Exception):
    """No event has that id.

    Its own class because its answer is its own — the API turns it into a
    ``404``. It is now the **only** thing addressing a row by its key can be
    refused for: ``ImportedEntry`` and the ``409`` it carried went with the
    second population (ADR-0032, #816), and a row is never turned away for where
    it came from, because there is nowhere left for it to come from.
    """


class InvalidEntry(Exception):
    """The event is well formed and the rules refuse it.

    ``field`` is the input to mark — :class:`events.validator.ValidationIssue`'s
    own, forwarded rather than re-derived, so the sentence and the field it is
    about cannot drift apart.
    """

    def __init__(self, message: str, field: Optional[str] = None):
        super().__init__(message)
        self.field = field


# --------------------------------------------------------------------------- #
# The three gestures
# --------------------------------------------------------------------------- #

def create(store, draft: Event) -> Event:
    """Record one event typed in the app.

    The row carries no column saying where it came from, because there is only
    one kind of row (ADR-0032): what leaves in an export and comes back through
    an upload is the same row it was, and the round trip #710 designed is the
    ordinary case rather than an exception to a rule.

    Returns the event as stored, key included.

    Raises:
        InvalidEntry: the event is not one the ledger takes; nothing is written.
        events.aggregator.AggregationError: the ledger it would make does not
            replay (an oversell).
    """
    with store.transaction():
        event = _settled(store, draft)
        _refuse(store, event)
        account = event.account or DEFAULT_ACCOUNT

        (next_id,) = store.query(
            'SELECT coalesce(max(id), 0) + 1 FROM event')[0:1][0]
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
                base_currency: Optional[str] = None) -> List[Event]:
    """Record a whole file's worth of events. One transaction, one replay.

    :func:`create` N times would be N replays of the ledger, which is quadratic
    in the size of an import and is the only reason this exists — the rules are
    the same rules, read from the same validator, and a row written here is a
    row written there, with no column saying it arrived in company (issue #811,
    ADR-0032).

    Three details are the difference between *the same rules* and *the same
    code*:

    * **the validator is built once and judges the list**, so a file of three
      hundred rows costs one read of the declaration rather than three hundred;
    * **the names are resolved from one index** rather than one query per row —
      ``_named``'s query orders the whole ``event`` table, so per-row it is a
      scan per row;
    * **the ids are contiguous from one read of the maximum**, which is what
      keeps ``ORDER BY date, id`` reproducible: the rows arrive date-sorted from
      the loader, so their keys are monotonic in the order the aggregator will
      replay them.

    ``base_currency`` is the one thing a **file** says about itself rather than
    about a row: the reporting currency its amounts are recorded in (#710), as
    :func:`ledger.currency_to_adopt` has already decided it against the ledger as
    it stands. It is written **first**, inside this transaction, and that is the
    ordering rather than a preference: a refused import must leave the dial
    exactly as it found it, and an amount re-read in another unit is the
    unrecoverable act ADR-0002 names.

    Returns the events as stored, keys included, in the order they were written.

    Raises:
        InvalidEntry: a row is not one the ledger takes; **nothing is written**,
            the whole file included, which is the loader's rule at the door.
        events.aggregator.AggregationError: the ledger it would make does not
            replay (an oversell).
    """
    if not drafts and base_currency is None:
        return []

    with store.transaction():
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

        (next_id,) = store.query(
            'SELECT coalesce(max(id), 0) + 1 FROM event')[0:1][0]
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
    """Rewrite one event, in place — **whatever laid it down** (ADR-0032).

    A row an upload wrote is corrected exactly like a row somebody typed, and
    that is the whole of #816: a typo in line 14 of an export used to cost the
    revocation of the two hundred and eighty-four lines around it.

    The **whole** row is rewritten rather than the members a caller happened to
    send: an event's fields are not independent of one another — a type change
    turns a purchase into a transfer, and a transfer carrying the quantity of the
    purchase it used to be is a row the validator refuses and nobody typed. The
    draft is the event, and what it does not say is absent rather than kept.

    Raises:
        UnknownEntry, InvalidEntry,
        events.aggregator.AggregationError: as :func:`create`.
    """
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
    """Delete one event — **whatever laid it down** (ADR-0032).

    One row at a time, which is what a reader who wants to drop a single line of
    a two-hundred-line import needs, and what the revocation could never do.

    The replay runs afterwards for a reason the two gestures above share from
    the other side: removing a purchase can leave a later sale overselling, so a
    deletion is refused exactly as an insertion is, and the ledger is never left
    in a state that would fail the next boot.

    Raises:
        UnknownEntry,
        events.aggregator.AggregationError: as :func:`create`.
    """
    with store.transaction():
        _require_known(store, event_id)
        store.execute('DELETE FROM event WHERE id = ?', [event_id])
        _stamp_write(store)
        _replays(store)
        logger.info(f"Removed event {event_id}")


def remove_selection(store, selection: events_export.Selection) -> int:
    """Delete every event a reduction retains. Returns how many left (#814).

    The gesture ADR-0032 makes the successor of the revocation, and it is a
    better one: it undoes a whole import without ever naming an import, and it
    reaches the twelve rows somebody mistyped, which no revocation could. What
    it is *about* is the reduction — so **no row is asked where it came from**,
    which since #816 is not a restraint this function shows but a question the
    application no longer has anywhere to ask.

    The reduction is :class:`events.export.Selection`, the export routes' own,
    read by :func:`events.export.select` and by nothing written a second time
    here: the reduction the table shows is the reduction the deletion consumes,
    and one vocabulary arriving over one contract is what keeps the two from
    drifting a chip apart. Whether the reduction reduces **anything** is the
    HTTP boundary's question, not this function's — an empty ``Selection``
    retains the whole ledger, which is a perfectly good thing to ask of a
    library and a request the route refuses.

    **The reduction is read inside the transaction**, so what is deleted is what
    the reduction retained at the instant of the delete and not a set assembled
    against a ledger another writer has moved since.

    A reduction that retains nothing removes nothing and does not complain: the
    empty selection is a *state* — the same one an export answers with a header
    and no row under it — and never an error.

    Raises:
        events.aggregator.AggregationError: the ledger it would leave does not
            replay. Removing a `BUY` can leave a later `SELL` overselling, and
            in bulk that is likelier than one row at a time, not less — a
            reduction on one account can take away the purchases and leave the
            sales. Nothing is written when it does.
    """
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


# --------------------------------------------------------------------------- #
# The forecast: what the gesture would do, decided without doing it (#813)
#
# Neither function below writes a row, and that is the property, not a side
# effect: ``?dry_run=1`` answers the receipt off these two and the store is
# **unchanged** — no import row to sweep, no pending token, nothing with a
# lifetime. It is the whole of ADR-0032's *the preview holds no server state*.
# --------------------------------------------------------------------------- #

def content_key(event: Event) -> Tuple:
    """What makes two rows the same purchase — :data:`DUPLICATE_KEY_COLUMNS`.

    **The account is resolved here and the name is not read at all.** A blank
    ``account`` means ``default``, which is the value the write puts in the row
    (``event.account or DEFAULT_ACCOUNT``), so a file that omits the column and
    a ledger that stores ``default`` have to hash to the same thing or every
    re-import of an account-less export would land twice. ``name`` and ``notes``
    are absent for the reason the constant states.

    The type travels as its ``value`` rather than as the enum: an event read
    back out of the store and one just parsed out of a file must key alike, and
    the string is what both of them agree on.
    """
    return (
        event.date,
        event.event_type.value,
        (event.account or '').strip() or DEFAULT_ACCOUNT,
        event.symbol,
        event.quantity,
        event.unit_price,
        event.fee,
        event.amount,
    )


def split_duplicates(store, drafts: Sequence[Event]) -> Tuple[List[Event],
                                                              List[Event]]:
    """One file, cut in two: what is new, and what the ledger already has.

    Returns ``(fresh, duplicates)`` in the file's own order, and the two lists
    partition ``drafts`` — nothing is dropped and nothing is counted twice.

    **The comparison is against the ledger and against the file itself**, in one
    pass: the set starts as every key the store holds and grows as the file is
    walked, so a row the ledger already has *and* a row the file repeats are
    both duplicates. Set semantics rather than a multiset is the decision, and
    it is story 6 that pays for it: two `BUY` of ten shares at the same price on
    the same day **are** flagged, because nothing in the file distinguishes one
    order filled twice from an export appended to itself — and the owner, who is
    the only one who knows, has the flag that writes them anyway.

    The store is only read. Whether the caller then writes what comes back is
    the caller's business, and ``?dry_run=1`` is exactly the caller that does
    not.
    """
    seen = {content_key(event) for event in ledger.read_events(store)}
    fresh: List[Event] = []
    duplicates: List[Event] = []
    for draft in drafts:
        key = content_key(draft)
        if key in seen:
            duplicates.append(draft)
        else:
            seen.add(key)
            fresh.append(draft)
    return fresh, duplicates


def judge(store, drafts: Sequence[Event]) -> None:
    """Refuse what :func:`create_many` would refuse, **without writing a row**.

    A forecast that only counted lines would be a forecast the commit could
    contradict: the reader would read *twelve events will be written*, press the
    button, and get a ``422`` naming an account nobody declared. So the preview
    runs the same two judgements the write runs — the validator over the whole
    file, then the replay of the ledger it would leave — and raises the same two
    exceptions, which the route turns into the same two statuses.

    The replay is the only part that is not literally the same code, and it is
    the same assertion: :func:`_replays` aggregates the ledger **after** the
    insert, which is this list merged into the stored one. Merged by date and by
    a stable sort, because that is the order the insert would produce — the new
    ids come from ``max(id) + 1``, so on a day the ledger already has rows for,
    the file's rows follow them.

    Raises:
        InvalidEntry, events.aggregator.AggregationError: as
            :func:`create_many`, and for the same reasons.
    """
    settled = _settled_all(store, drafts)
    _refuse_all(store, settled)
    if not settled:
        return

    would_be = [replace(event, account=event.account or DEFAULT_ACCOUNT)
                for event in settled]
    EventAggregator().aggregate(
        sorted(ledger.read_events(store) + would_be,
               key=lambda event: event.date))


# --------------------------------------------------------------------------- #
# What the gestures are made of
# --------------------------------------------------------------------------- #

def _settled_all(store, drafts: Sequence[Event]) -> List[Event]:
    """A whole file settled, on **one** read of what the ledger calls things.

    **The index is updated as the file is walked**, not read once and frozen: a
    security named on the first row and left blank on the tenth is the same
    security, and :func:`create` called ten times would have found the name — it
    re-queries per row. What the prefetch buys is the scan, never a different
    answer.
    """
    known = _known_names(store)
    settled = []
    for draft in drafts:
        event = _settled(store, draft, known)
        if event.symbol and event.name:
            known[event.symbol] = event.name
        settled.append(event)
    return settled


def _refuse_all(store, settled: Sequence[Event]) -> None:
    """:func:`_refuse` over a whole file, on one build of the validator.

    Only the first issue is raised, for :func:`_refuse`'s own reason: a form
    marks one input at a time. What matters is that *nothing is written* when
    there is one, and on the write path that is the transaction's doing — on the
    preview's it is that there is no write to undo.
    """
    issues = _validator(store).issues(settled)
    if issues:
        raise InvalidEntry(issues[0].message, field=issues[0].field)


def _require_known(store, event_id: int) -> None:
    """Refuse an id no row answers to. **One refusal, and it is the only one.**

    There were two until #816, and the second — *this row came from a file*, a
    ``409`` naming the import to forget — went with the population it described
    (ADR-0032). What is left is *no such row*, which is a ``404`` and nothing to
    talk about; a row that is there is a row these gestures address.
    """
    rows = store.query('SELECT 1 FROM event WHERE id = ?', [event_id])
    if not rows:
        raise UnknownEntry(f"No event with id {event_id}")


def _stamp_write(store) -> None:
    """Record the instant the ledger moved (:data:`ledger.LAST_WRITE_KEY`).

    Called from inside each gesture's transaction, so the stamp and the rows it
    is about commit together or not at all. ``import_source.imported_at``
    answered the question for free while a file was a row; a file is a payload
    now, so the writer says it — and says it of a correction and a deletion too,
    which the old query, being about imports, never counted as writes.

    The instant is UTC and written in ISO 8601, which is the one clock and the
    one spelling this product has (``test_suite_conventions``).
    """
    store.execute(
        'INSERT INTO setting (key, value) VALUES (?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [ledger.LAST_WRITE_KEY, datetime.now(timezone.utc).isoformat()])


def _settled(store, draft: Event,
             known: Optional[Mapping[str, str]] = None) -> Event:
    """The draft with the one thing the store decides before it is judged.

    **The name**, which is an attribute of the *security* and not of each of its
    events — the argument that took ``Nom`` out of the ledger table (ADR-0020),
    applied to the write path: the form does not ask for it, so it is read off
    whatever the ledger already says this symbol is called, and falls back to the
    ticker on a security nothing has named yet. Inventing it here rather than
    letting it be ``NULL`` is what keeps :meth:`EventValidator._validate_event`'s
    *"name is required"* one rule for both roads instead of a refusal the form
    could never satisfy.

    **The account is deliberately not settled here**, and it is the reason the
    form's rows and a file's rows can share one road. A blank ``account`` means
    ``default`` *until something is declared and is an error afterwards* (#698),
    so the blank itself is what the validator judges: resolved before
    :func:`_refuse`, ``EventValidator._validate_account`` never sees one, and an
    install declaring ``pea`` would silently grow the phantom ``default`` that
    rule exists to refuse — a file carrying the same cell being refused whole.
    So the blank is carried through the validation and resolved **at the
    write**, by ``event.account or DEFAULT_ACCOUNT``. Whitespace is folded into
    the blank rather than left standing: an ``account`` of ``"  "`` names no
    account, and a file's own cells arrive stripped.

    ``known`` is that same lookup **prefetched** for a whole file
    (:func:`create_many`) — the query below orders the entire ``event`` table,
    so resolving row by row would scan it once per row.
    """
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
    """Every security's name as the ledger last stated it, in **one** read.

    The same answer :func:`_named` gives one symbol at a time, and it has to
    stay the same one: the rows come back in ``(date, id)`` order and each
    overwrites the last, so what survives per symbol is the newest — which is
    that query's ``ORDER BY date DESC, id DESC LIMIT 1``, read from the other
    end.
    """
    rows = store.query(
        'SELECT symbol, name FROM event '
        'WHERE symbol IS NOT NULL AND name IS NOT NULL ORDER BY date, id')
    return {symbol: name for symbol, name in rows}


def _refuse(store, event: Event) -> None:
    """Run the one validator, with the context a row needs to be judged in.

    ``account_ids`` and ``accounts_declared`` are read **inside** the
    transaction, so a declaration made in the same breath is the one this event
    is judged against.

    Only the first issue is raised. A form marks one input at a time and a
    ``curl`` reads one sentence; what matters for the criterion is that
    *nothing is written* when there is one, and that is the transaction's doing,
    not this function's.
    """
    issues = _validator(store).issues([event])
    if issues:
        raise InvalidEntry(issues[0].message, field=issues[0].field)


def _validator(store) -> EventValidator:
    """The one validator, with the context a row needs to be judged in.

    Built from a **read of the store**, which is what makes a declaration made
    in the same breath the one an event is judged against — and built once per
    gesture, however many rows the gesture carries: the two queries below are
    about the ledger, not about the row.
    """
    return EventValidator(
        account_ids=accounts_module.account_ids(store),
        accounts_declared=accounts_module.accounts_are_declared(store))


def _insert_symbol(store, event: Event) -> None:
    """Give the security its row before the event references it.

    :func:`create_many`'s ``executemany`` twin, one row at a time, and it exists
    for the same reason: ``event.symbol`` has a foreign key onto ``symbol``, so a
    first purchase of a ticker nobody owns would violate it. The ingestion
    creates that row, never the scrape — two writers on one row is what the
    schema's generating rule forbids.
    """
    if event.symbol:
        store.execute(
            'INSERT INTO symbol (symbol) VALUES (?) ON CONFLICT DO NOTHING',
            [event.symbol])


def _replays(store) -> None:
    """Replay the ledger this gesture would leave, before the commit.

    The last thing every gesture does, and always against the same failure: an
    unreplayable ledger committed here is a store that raises on every reload,
    and that raise is **fatal at boot** (``build_runtime`` exits), so the API
    that could repair it would never come up to be asked.
    """
    EventAggregator().aggregate(ledger.read_events(store))


__all__ = [
    'DUPLICATE_KEY_COLUMNS',
    'UnknownEntry', 'InvalidEntry',
    'create', 'create_many', 'update', 'remove', 'remove_selection',
    'content_key', 'split_duplicates', 'judge',
]
