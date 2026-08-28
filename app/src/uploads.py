"""A file handed to the app, read once, and never seen again (issue #811).

ADR-0032's sentence, as a module: **the mounted file was a second truth, the
uploaded file is a payload.** ``ledger.py`` used to refuse a row-level write on
an imported row so that the file and the store would not become two truths about
one purchase — right about a file that is mounted, watched and re-read, and about
nothing else. What arrives here is dead the instant it is parsed, so its rows go
in through :mod:`entries` — the route composes the two halves — and are
indistinguishable from typed ones: same table, same writer, no provenance at all
since #816, and the same three gestures afterwards.

This module therefore **reads and judges, and never writes**: what it hands back
is a list of events and, afterwards, the receipt for the file they came out of.
The split is not tidiness — it is what lets #813's preview run the first half
alone and answer the same receipt without a transaction. Which of those rows the
ledger already holds is not decided here: that comparison needs the ledger, and
this module has no store (:func:`entries.split_duplicates` owns it).

Three things are decisions rather than plumbing.

**The genre is read off the header, never off the name** — the rule that does
not move, only its entrance did. :func:`accounts.is_accounts_file` says what a
file is; an accounts file is **refused** (ADR-0034: accounts are born in the
app), and the refusal names what it recognised, because a file silently not
imported is the symptom this whole ticket exists against.

**The v4 file is recognised by its name, and that is not the same rule.** A
``config.yaml`` has no header to read — it is not a ledger at all — and the two
``legacy_*`` installation facts that used to ``stat`` it said their sentence
later, on another screen, to a reader no longer holding the file. It is said at
the instant of the gesture now, and it names the file and points at the
migration page.

**The bound is written, and it is held in three places because each sees
something the other two do not.** A declared ``Content-Length`` is refused before
the body is parsed at all; ``MAX_CONTENT_LENGTH`` (set in :func:`web.create_app`)
stops a body that declares nothing *while werkzeug is reading it*, which is the
only one of the three that can — the others run after the parse; and the stream
is read one byte past the bound, on the **file**, which is the quantity the
sentence is about. A local hop makes a large payload cheap and a ``MemoryError``
unreadable, which is the trade the number is chosen on.

**Not here**: anything that persists. There is no import row, no pending token,
no sweeper — the receipt is computed from what was written and handed back, and
the store keeps no memory of the file. That is the property #813's preview is
free because of.
"""
import json
import tempfile
from dataclasses import dataclass, replace
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from logfmt_logger import getLogger

import accounts as accounts_module
from events import EventLoader
from events.loader import EventLoaderError
from events.schemas import ACCOUNT_FILE_COLUMNS, DEFAULT_ACCOUNT, Event

logger = getLogger("uploads")

#: What an upload may carry, and **the extension is the only thing that decides
#: it**: no filename has a special meaning here (spec #695 § 6), so ``ui.csv`` is
#: a file like any other. It named the droppable files while there was a folder;
#: it lives here now, with the one door a file has left (ADR-0032).
IMPORT_SUFFIXES = ('.csv', '.xlsx')

#: What one upload may carry. A ledger is text: a hundred thousand events export
#: to a few megabytes, so this is generous by two orders of magnitude for the
#: portfolio this product is about, and small enough that reading it whole is a
#: number rather than a hope.
MAX_UPLOAD_BYTES = 8 * 1024 * 1024

#: What the **whole request** may carry, which is not the same number and must
#: not be compared to the same thing: a ``multipart/form-data`` body is the file
#: plus a boundary, a part header and the filename, so a file of exactly
#: :data:`MAX_UPLOAD_BYTES` arrives as a body slightly larger than it. Measuring
#: the envelope against the file's bound would refuse a legal file and say *a
#: file may carry at most 8 MiB* about a file that carries 8 MiB. The allowance
#: is generous: what it exists to stop is a payload of another order.
MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024

#: The v4 files, by name. They are the two the retired ``legacy_*``
#: installation facts watched for, and they are named here rather than derived:
#: a ``.yaml`` has no header to classify, and *this is v4's* is the one thing
#: worth saying about it.
LEGACY_FILENAMES = ('config.yaml', 'settings.yaml')

#: Where a v4 owner is sent. Versioned and absolute, because this sentence
#: travels in a JSON body a browser may never render (ADR-0025's rule, applied
#: to prose the server writes rather than to a bubble the front draws).
MIGRATION_PAGE = 'https://pbrissaud.github.io/suivi-bourse/docs/v5/coming-from-v4'


class UploadRefused(Exception):
    """The file is not one this app writes rows from, and nothing was written.

    One class for the four refusals below rather than four, because they share
    an answer — ``422``, the file named, the ledger untouched — and a caller
    branching on which of them it is would be a caller re-deciding what the
    sentence already says.
    """


class UploadTooLarge(Exception):
    """The payload is past :data:`MAX_UPLOAD_BYTES`. Its own class for its own
    status: ``413`` is not *the file is wrong*, it is *the file is too big*."""


@dataclass(frozen=True)
class Upload:
    """One file, read: its rows, and the one thing it says about itself.

    ``declared_currency`` is the ``base_currency`` column (#710) — a fact about
    the **whole file** and never about a row, which is why it rides beside the
    events rather than on them. What an install does with it is
    :func:`ledger.currency_to_adopt`'s rule, asked by the caller with the store
    in hand; this module reads the declaration and judges nothing about it.
    """

    filename: str
    events: List[Event]
    declared_currency: Optional[str]


@dataclass(frozen=True)
class FileAccount:
    """One account the **file** names, and how many of its rows carry it.

    The line the import modal is built out of (#835): *a line per account the
    file names, with its volume and its target*. The volume is the half only the
    server can answer — nobody is going to parse a spreadsheet in a browser to
    count it — and it is the half that makes the question answerable: *where do
    these 47 events go* is a decision, *where does TR go* is a riddle.

    ``name`` is the label **as the file writes it**, stripped, and ``''`` for the
    blank column. The blank is a line like the others rather than a special case
    swallowed early: it means ``default`` only while nothing is declared and is
    an error afterwards (#698), so on the install that has since declared ``pea``
    it is exactly the line the reader has to answer.

    Read off the file **as it arrived**, before any correspondence is applied —
    which is what keeps the modal's own question stable while the reader answers
    it, and what makes the census the same at both moments of the gesture.
    """

    name: str
    rows: int


@dataclass(frozen=True)
class AccountMapping:
    """Where each account the file names is to go — **the gesture's parameter**.

    ADR-0006 is the record this is written against, and it holds: this is *not*
    the correspondence table :mod:`reassignment` refused. That one was a second,
    **persistent** truth about the account an event names, standing beside the
    rows for ever; this one is read off the request, applied to the drafts before
    a single row is written, and then it is gone. No ``UPDATE``, no table, no
    window — the next file asks the question again.

    Two members, because the reader has two different answers to give:

    ``targets`` sends every row carrying one label to an account that **is
    already declared** — the file's ``TR`` into the ``cto`` the owner keeps, or
    the blank column into ``default``.

    ``declaring`` names the labels to be **declared as accounts** with the
    import. That is the entry repairing the ``422`` that used to reject the whole
    file and send the reader off to declare an account by hand, holding a file
    the app had just refused.

    ``stated`` is whether a correspondence was offered **at all** — the ``map``
    parameter present, empty object included. It separates the modal, which is
    collecting an answer and must be told what the file names rather than refused
    over it, from a ``curl`` that offered nothing and is answered exactly as it
    was before this ticket.
    """

    targets: Dict[str, str]
    declaring: Tuple[str, ...]
    stated: bool

    def applied(self, events: Sequence[Event]) -> List[Event]:
        """The file's rows read through the correspondence — a **new** list.

        Applied here, on the drafts, and therefore **before** the duplicate
        split: the duplicate key carries the account (:data:`entries.
        DUPLICATE_KEY_COLUMNS`), so a correspondence applied to the write alone
        would make the preview count duplicates against accounts the write is not
        going to use — the forecast would say *four lines are already there* of a
        file that, once mapped, has none. One application, both branches.

        A label the correspondence says nothing about is **left as it is**, and a
        label being declared keeps its own name: it is about to become an account
        under that very id.
        """
        if not self.targets:
            return list(events)
        return [replace(event, account=self.targets.get(_label(event),
                                                        event.account))
                for event in events]


@dataclass(frozen=True)
class Receipt:
    """What the gesture produced, in the units the owner counts in.

    **One object, two moments** (ADR-0032): the preview of #813 answers this
    exact shape before anything is written, and the write answers it after. A
    receipt with a second shape would make the forecast and the fact two things
    to compare rather than one to read twice.

    **Three numbers, and they are the glossary's three** (`CONTEXT.md`
    § Receipt): *what the file holds* (:attr:`rows`), *what of it the ledger
    already has* (:attr:`duplicates`), and *what was — or will be — added*
    (:attr:`written`). They close: ``rows == written + duplicates``, whichever
    moment it is read at, and the flag that writes the duplicates anyway moves
    the same rows from one column to the other rather than inventing a fourth.
    A count of *refused* rows is deliberately not a fourth number: a refusal is
    whole-file here (the loader's rule, at the door), so it is a ``422`` with no
    receipt at all rather than a zero standing in every successful one.

    The **period, the accounts and the securities describe the file**, not the
    subset that landed. That is story 3 read literally — *see before writing
    what the file contains* — and it is what keeps the forecast and the fact one
    sentence: a second upload of the same export skips every row and still says
    which period and which accounts that export covers.

    ``first_day``/``last_day`` are ``None`` together, and only on a file with no
    row in it — a header and nothing under it. There is no period to state then,
    and stating today's would be a figure nobody's file carries.

    ``file_accounts`` is the one member that is **not** a summary of what landed
    but a census of what was handed over: the labels the file's ``account``
    column carries, each with its volume, read before any correspondence is
    applied (#835). It is here rather than beside the receipt because it is the
    same kind of fact as the period — *what this file is* — and because the modal
    needs it at the very first moment, which is the moment the receipt is the
    only thing there is.
    """

    filename: str
    rows: int
    written: int
    duplicates: int
    first_day: Optional[date]
    last_day: Optional[date]
    accounts: Tuple[str, ...]
    symbols: Tuple[str, ...]
    file_accounts: Tuple[FileAccount, ...] = ()


def oversize(content_length: Optional[int]) -> bool:
    """Does the request **declare** more than a body may carry?

    Read before the body is touched at all: werkzeug spools a large multipart
    body to a temporary file, so a refusal taken here costs no disk and no parse.

    It is a declaration, and a client is free not to make one — a chunked body
    has no length to read. That is why the bound is held in **three** places,
    each with something the other two cannot see: here on what was declared,
    ``MAX_CONTENT_LENGTH`` on what werkzeug is actually reading (the only one
    that stops bytes already in flight), and :func:`read` on the file itself,
    which is the quantity the sentence is about.
    """
    return content_length is not None and content_length > MAX_BODY_BYTES


def too_large_detail() -> str:
    """The one sentence the bound is refused with, wherever it is met."""
    return (f"a file may carry at most {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB; "
            f"export a narrower range, or split it")


def read(filename: str, stream) -> Upload:
    """One uploaded file as the events it declares, or a named refusal.

    Nothing here touches the store: the file is judged on what it *is*, and what
    the ledger makes of it is :func:`entries.create_many`'s business. That split
    is what lets #813's preview run this half alone.

    Both outcomes are **said once, here**, which is where the file is judged: a
    refusal returns a ``422`` and leaves no row behind, so the log line is the
    whole of what a headless owner has to read afterwards.

    Raises:
        UploadTooLarge: the stream is past :data:`MAX_UPLOAD_BYTES`.
        UploadRefused: it is a v4 file, an accounts declaration, a format this
            app does not read, or a ledger whose header it cannot recognise.
    """
    name = Path(filename or '').name
    if name.lower() in LEGACY_FILENAMES:
        logger.warning(f"Refused {name}: a v4 configuration file")
        raise UploadRefused(
            f"{name} is a v4 configuration file and this version does not read "
            f"one: a portfolio is a dated event ledger and nothing else. "
            f"Describe those positions as dated events — {MIGRATION_PAGE}")

    suffix = Path(name).suffix.lower()
    if suffix not in IMPORT_SUFFIXES:
        logger.warning(f"Refused {name}: not a {' or a '.join(IMPORT_SUFFIXES)}")
        raise UploadRefused(
            f"{name or 'the file'} is not a ledger this app reads: an event "
            f"file is a {' or a '.join(IMPORT_SUFFIXES)}")

    data = _bounded(stream)
    # The file has to exist on disk for the loader and for the header read: both
    # take a path, and neither changes with the door the file came through. It
    # lives for the length of this call and is removed by the context manager,
    # which is the whole of what *the store keeps no memory of the file* means
    # at this level.
    with tempfile.TemporaryDirectory(prefix='sb-upload-') as folder:
        path = Path(folder) / name
        path.write_bytes(data)
        loaded = _parse(path, name)

    logger.info(f"Read {name}: {len(loaded.events)} event(s)")
    return loaded


def census(rows: Sequence[Event]) -> Tuple[FileAccount, ...]:
    """Every account label the file names, with its volume, sorted (#835).

    Read off the file **as it arrived** — the caller applies no correspondence
    before asking — so the modal's own question does not move under the reader
    while they answer it, and the two moments of the gesture state the same
    census for one file.

    Sorted by the label, blank first: ``''`` sorts before every id, which puts
    *the rows that name no account* at the top of the list, where the line most
    likely to need an answer belongs.
    """
    volumes: Dict[str, int] = {}
    for event in rows:
        label = _label(event)
        volumes[label] = volumes.get(label, 0) + 1
    return tuple(FileAccount(name=name, rows=volumes[name])
                 for name in sorted(volumes))


def mapping(stated: Optional[str],
            declaring: Sequence[str] = ()) -> AccountMapping:
    """The correspondence a request carries, read once and judged for shape.

    It travels on the **query string**, with the gesture's other parameters and
    never in the form: what a multipart body carries is the reader's *ledger*,
    and what the query carries is how it is to be read (#813's rule, applied to
    the one parameter that is not a flag).

    ``stated`` is one JSON object, ``{"TR": "cto", "": "default"}`` — file label
    to the id of a **declared** account. An object rather than repeated pairs
    because a correspondence *is* a mapping: repeated ``from=``/``to=``
    parameters would let a client send four of one and three of the other, and
    the server would have to invent which pairs with which.

    ``declaring`` is the repeated ``declare`` parameter, and it is a second name
    rather than a value inside the object on purpose: an account id is the
    reader's own string, so **any** sentinel written among the targets would be
    an id somebody could really have declared. Two parameters cannot collide.

    Nothing here is judged against the store — this module has none. Whether
    those targets are declared and whether the file names those labels is the
    route's, with the ledger open.

    Raises:
        UploadRefused: the object is not one — the same ``422`` the file's own
            refusals get, because it is the same request being turned back.
    """
    wanted = tuple(dict.fromkeys(
        name.strip() for name in declaring if name and name.strip()))
    if stated is None:
        return AccountMapping(targets={}, declaring=wanted, stated=False)

    try:
        read_back = json.loads(stated)
    except ValueError:
        raise UploadRefused(
            "the account correspondence is not readable: it is one JSON object "
            "mapping each account the file names to a declared account")
    if not isinstance(read_back, dict) or not all(
            isinstance(target, str) for target in read_back.values()):
        raise UploadRefused(
            "the account correspondence is one JSON object mapping each account "
            "the file names to the id of a declared account")

    targets = {str(label).strip(): target.strip()
               for label, target in read_back.items() if target.strip()}
    both = sorted(set(targets) & set(wanted))
    if both:
        # Two answers to one question, and picking either silently is how a
        # reader's rows land somewhere they never asked for.
        raise UploadRefused(
            f"{', '.join(both)} is both sent to a declared account and declared "
            f"itself; one account of the file takes one answer")
    return AccountMapping(targets=targets, declaring=wanted, stated=True)


def _label(event: Event) -> str:
    """The account an event names, as the **file** writes it — ``''`` for blank.

    The same folding :func:`entries._settled` does at the write (whitespace is
    the blank), so the census, the correspondence and the row that lands all
    agree on what one label is.
    """
    return (event.account or '').strip()


def receipt(filename: str, rows: Sequence[Event], *,
            written: int, duplicates: int,
            file_accounts: Tuple[FileAccount, ...] = ()) -> Receipt:
    """The receipt for one file, in the order a reader reads it.

    ``rows`` is **the file**, whole, duplicates included — the period, the
    accounts and the securities are read off it, and the two counts say what
    became of it. Handed the subset that landed instead, the preview and the
    write would state two different periods for one file the moment a single row
    of it was already in the ledger, which is the one thing the *same object,
    two moments* rule exists to stop.

    The accounts and the symbols are **sorted sets** rather than the file's own
    order: they answer *which*, not *how many times*, and a list repeating
    ``AAPL`` fourteen times would be a count wearing a list's clothes.
    """
    days = sorted(event.date for event in rows if event.date)
    return Receipt(
        # A **name**, never a path: what a browser sends is the file's own name
        # on the reader's disk, and the receipt says the file back to them.
        filename=Path(filename or '').name,
        rows=len(rows),
        written=written,
        duplicates=duplicates,
        first_day=days[0] if days else None,
        last_day=days[-1] if days else None,
        accounts=tuple(sorted({event.account or DEFAULT_ACCOUNT
                               for event in rows})),
        symbols=tuple(sorted({event.symbol for event in rows
                              if event.symbol})),
        file_accounts=file_accounts,
    )


def _bounded(stream) -> bytes:
    """The stream's bytes, or the refusal, read one past the bound to tell."""
    data = stream.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadTooLarge(too_large_detail())
    return data


def _parse(path: Path, name: str) -> Upload:
    """The file on disk as events — the header deciding what it is."""
    if accounts_module.is_accounts_file(path):
        logger.warning(f"Refused {name}: it declares accounts, not events")
        raise UploadRefused(
            f"{name} declares accounts ({', '.join(ACCOUNT_FILE_COLUMNS)}) and "
            f"not events; an account is declared in the app, and an event file "
            f"names one it declares")

    loader = EventLoader(str(path))
    try:
        events = loader.load()
    except EventLoaderError as exc:
        # The loader's own sentence, which names the column that is missing or
        # the row that is unreadable. A second wording here would be a second
        # rule about what a ledger file is — so the message is taken as it is,
        # with the one thing in it the reader cannot have seen put right: the
        # loader names the *path* it read, and that path is a temporary
        # directory this module made and is about to remove.
        logger.warning(f"Refused {name}: {exc}")
        raise UploadRefused(str(exc).replace(str(path), name))
    except Exception as exc:
        # **Broad, and deliberately so**: what arrives here is untrusted bytes,
        # and a ``.xlsx`` that is not a zip raises out of openpyxl rather than as
        # an :class:`EventLoaderError`. Left to travel it reaches the blueprint's
        # handler, and the reader is told *the app hit an error it did not
        # expect* about a file **they** chose — which is the one refusal they can
        # actually act on.
        logger.warning(f"Refused {name}: {exc}")
        raise UploadRefused(
            f"{name} could not be read: it is not a ledger this app parses")

    return Upload(filename=name, events=events,
                  declared_currency=loader.declared_currency)


__all__ = [
    'MAX_UPLOAD_BYTES', 'MAX_BODY_BYTES', 'MIGRATION_PAGE', 'LEGACY_FILENAMES',
    'IMPORT_SUFFIXES',
    'AccountMapping', 'FileAccount',
    'Receipt', 'Upload', 'UploadRefused', 'UploadTooLarge',
    'census', 'mapping', 'oversize', 'too_large_detail', 'read', 'receipt',
]
