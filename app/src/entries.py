"""The event somebody typed here, and the three gestures it earns (issue #764).

:mod:`ledger` owns the **import**: whole files in, whole files out, and no
row-level write anywhere in it. That rule is #697's second and it is right about
the population it was written for — a line provisioned by ``broker.csv`` must
not be editable, or the file and the store become two truths about the same
purchase, and the one gesture offered instead is forgetting the import.

It says nothing about a row that came from no file. ADR-0005 removed manual mode
and made *typing a position* mean *creating dated events*, so the create form is
the **onboarding**; and a row created there is reachable by no revocation, since
there is no import to forget. Without an edit and a removal, a typo made in the
first five minutes of using this app would be permanent. So the population
splits, and the split is **structural** rather than a comment: this module
writes only rows whose ``source_id`` is ``NULL``, and refuses — never silently
skips — anything else.

It is a module of its own for the reason :mod:`accounts` is one. ``account`` and
``event`` are both written by the import path *and* by the app, and keeping the
two halves apart is what lets *"the import path has no row-level write"* stay
true by inspection instead of by care. :mod:`accounts` is the precedent down to
the shape: three functions, ``source_id NULL`` on the way in, a refusal named
after what the caller must do instead.

Three properties are decisions rather than details.

**Validation has one owner, and it is** :mod:`events.validator`. A typed event
and an imported one obey the same rules or they are two products: the validator
runs over the **whole stored ledger** on every build, so a row one road let
through and the other would have refused fails the *boot*, in the gunicorn
master, in an app the owner then cannot reach to repair it. What this module
adds is not a second rule set but the *context* the file path already had — the
declared accounts — and the refusal it raises carries the field the validator
named, so a form can mark the input rather than print a paragraph. **The
validator is handed the draft as it arrived**, blank account included, and the
file path's ordering is the reason: a blank means ``default`` only while nothing
is declared, so resolving it first would hide the very cell the rule is about
and let this road write a phantom account the other road refuses.

**Nothing is written when anything refuses.** The single-row check, the write
and the replay all live inside one ``store.transaction()``, so a refusal rolls
back to the ledger as it stood. That is ``PUT /api/settings``' rule and
:func:`ledger.import_file`'s alike: a half-applied body is a state nobody asked
for.

**The replay is the last assertion, and it is not the same one.** Per-row
validity is a property of the row; **overselling is a property of the ledger**,
so a `SELL` that is legal on its own can be illegal in company — and a `BUY`
whose removal makes a later `SELL` an oversell is the same fact seen from the
other side. So every one of the three gestures ends by replaying the ledger it
would leave, inside the transaction, exactly as an import does.

**Not in this module**: the ``import_source`` row, the drop folder, and the
symbol's own price history. A symbol row is created here when an event needs one
(the foreign key wants it), and never removed — the orphan is #695 § 10's
deliberate one, named and purgeable, because a forget is reversible and a price
series is not.
"""
from dataclasses import replace
from typing import Dict, List, Mapping, Optional, Sequence

from logfmt_logger import getLogger

import accounts as accounts_module
import ledger
import settings_registry
from events import EventAggregator, EventValidator
from events.schemas import DEFAULT_ACCOUNT, Event

logger = getLogger("entries")


class UnknownEntry(Exception):
    """No event has that id.

    Its own class because its answer is its own — the API turns it into a
    ``404`` — and it must never be confused with the refusal below, which is
    about a row that is very much there.
    """


class ImportedEntry(Exception):
    """The row came from a file, and a file's row is revoked, never edited.

    Carries the import to forget, because that is the whole of what the caller
    has left to do: the message names the file, and the id is published beside
    it so a page can link to the import block rather than re-parse a sentence.
    """

    def __init__(self, message: str, source_id: Optional[int] = None,
                 filename: Optional[str] = None):
        super().__init__(message)
        self.source_id = source_id
        self.filename = filename


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
    """Record one event typed in the app. ``source_id`` stays ``NULL``.

    ``NULL`` is what *"created in the app"* **is** (spec #695 § 6), the same
    column that makes the row editable, and the same column
    :func:`events.export.render_events` deliberately does not export — so a row
    typed here leaves in a file like any other and comes back declared by that
    file, which is the round trip #710 designed and not an exception to it.

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
            '                   quantity, unit_price, fee, amount, notes, '
            '                   source_id, source_sheet, source_row) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)',
            [next_id, event.date, event.event_type.value, account,
             event.symbol, event.name, event.quantity, event.unit_price,
             event.fee, event.amount, event.notes])

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
    row written there: ``source_id NULL``, and no column saying it arrived in
    company (issue #811, ADR-0032).

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
    it stands. It is written **first**, inside this transaction, for the reason
    :func:`ledger.import_file` writes it first: a refused import must leave the
    dial exactly as it found it, and an amount re-read in another unit is the
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

        # **The index is updated as the file is walked**, not read once and
        # frozen: a security named on the first row and left blank on the tenth
        # is the same security, and ``create`` called ten times would have found
        # the name — it re-queries per row. What the prefetch buys is the scan,
        # never a different answer.
        known = _known_names(store)
        settled = []
        for draft in drafts:
            event = _settled(store, draft, known)
            if event.symbol and event.name:
                known[event.symbol] = event.name
            settled.append(event)

        issues = _validator(store).issues(settled)
        if issues:
            raise InvalidEntry(issues[0].message, field=issues[0].field)

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
            '                   quantity, unit_price, fee, amount, notes, '
            '                   source_id, source_sheet, source_row) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)',
            [[event.id, event.date, event.event_type.value, event.account,
              event.symbol, event.name, event.quantity, event.unit_price,
              event.fee, event.amount, event.notes] for event in stored])

        _replays(store)
        logger.info(f"Recorded {len(stored)} event(s) from one file")
    return stored


def update(store, event_id: int, draft: Event) -> Event:
    """Rewrite one event typed in the app, in place.

    The **whole** row is rewritten rather than the members a caller happened to
    send: an event's fields are not independent of one another — a type change
    turns a purchase into a transfer, and a transfer carrying the quantity of the
    purchase it used to be is a row the validator refuses and nobody typed. The
    draft is the event, and what it does not say is absent rather than kept.

    Raises:
        UnknownEntry, ImportedEntry, InvalidEntry,
        events.aggregator.AggregationError: as :func:`create`.
    """
    with store.transaction():
        _require_typed(store, event_id)
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

        _replays(store)
        logger.info(f"Rewrote event {event_id}")
    return replace(event, id=event_id, account=account)


def remove(store, event_id: int) -> None:
    """Delete one event typed in the app.

    Named ``remove`` and not ``delete_event``: :mod:`ledger`'s surface is
    asserted to hold no such name, and a reader who finds one here must find it
    in the module whose whole subject is the row that may carry it.

    The replay runs afterwards for a reason the two gestures above share from
    the other side: removing a purchase can leave a later sale overselling, so a
    deletion is refused exactly as an insertion is, and the ledger is never left
    in a state that would fail the next boot.

    Raises:
        UnknownEntry, ImportedEntry,
        events.aggregator.AggregationError: as :func:`create`.
    """
    with store.transaction():
        _require_typed(store, event_id)
        store.execute('DELETE FROM event WHERE id = ?', [event_id])
        _replays(store)
        logger.info(f"Removed event {event_id}")


# --------------------------------------------------------------------------- #
# What the three are made of
# --------------------------------------------------------------------------- #

def _require_typed(store, event_id: int) -> None:
    """Refuse anything that is not a row this module may write.

    Two refusals and they are not the same news: *no such row* is a ``404``
    (nothing to talk about), *this row came from a file* is a ``409`` naming the
    import — the row is there, that is the whole problem, and forgetting its
    import is the gesture the owner has instead.
    """
    rows = store.query(
        'SELECT e.source_id, s.filename FROM event e '
        'LEFT JOIN import_source s ON s.id = e.source_id '
        'WHERE e.id = ?', [event_id])
    if not rows:
        raise UnknownEntry(f"No event with id {event_id}")

    source_id, filename = rows[0]
    if source_id is not None:
        raise ImportedEntry(
            f"Event {event_id} came from {filename or 'an imported file'} and "
            f"is read-only; correct the file and drop it again, or forget that "
            f"import", source_id=source_id, filename=filename)


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

    **The account is deliberately not settled here**, and that is the whole of
    what makes this road and the file's one road. A blank ``account`` means
    ``default`` *until something is declared and is an error afterwards* (#698),
    so the blank itself is what the validator judges: resolved before
    :func:`_refuse`, ``EventValidator._validate_account`` never sees one, and an
    install declaring ``pea`` would silently grow the phantom ``default`` that
    rule exists to refuse — the file path refusing the same body whole. So the
    blank is carried through the validation and resolved **at the write**, by
    ``event.account or DEFAULT_ACCOUNT``, which is the expression and the
    ordering of :func:`ledger._insert_events`. Whitespace is folded into the
    blank rather than left standing: a ``account`` of ``"  "`` names no account
    on either road, and the file path's own cells arrive stripped.

    ``known`` is that same lookup **prefetched** for a whole file
    (:func:`create_many`) — the query below orders the entire ``event`` table,
    so resolving row by row would scan it once per row.
    """
    return replace(draft, account=(draft.account or '').strip() or None,
                   name=draft.name or _named(store, draft.symbol, known),
                   id=None, source_id=None, source_sheet=None,
                   source_row=None, source_filename=None)


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
    """Run the one validator, with the context the file path already had.

    ``account_ids`` and ``accounts_declared`` are read **inside** the
    transaction, like :func:`ledger.import_file` reads them, so a declaration
    made in the same breath is the one this event is judged against.

    Only the first issue is raised. A form marks one input at a time and a
    ``curl`` reads one sentence; what matters for the criterion is that
    *nothing is written* when there is one, and that is the transaction's doing,
    not this function's.
    """
    issues = _validator(store).issues([event])
    if issues:
        raise InvalidEntry(issues[0].message, field=issues[0].field)


def _validator(store) -> EventValidator:
    """The one validator, with the context the file path already had.

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

    :func:`ledger._insert_symbols`' single-row twin, and it exists for the same
    reason: ``event.symbol`` has a foreign key onto ``symbol``, so a first
    purchase of a ticker nobody owns would violate it. The ingestion creates that
    row, never the scrape — two writers on one row is what the schema's
    generating rule forbids.
    """
    if event.symbol:
        store.execute(
            'INSERT INTO symbol (symbol) VALUES (?) ON CONFLICT DO NOTHING',
            [event.symbol])


def _replays(store) -> None:
    """Replay the ledger this gesture would leave, before the commit.

    The assertion :func:`ledger.import_file` makes at the end of its own
    transaction, for the same reason and against the same failure: an
    unreplayable ledger committed here is a store that raises on every reload,
    and that raise is **fatal at boot** (``build_runtime`` exits), so the API
    that could repair it would never come up to be asked.
    """
    EventAggregator().aggregate(ledger.read_events(store))


__all__ = [
    'UnknownEntry', 'ImportedEntry', 'InvalidEntry',
    'create', 'create_many', 'update', 'remove',
]
