"""The export: the ledger back out, in the format it comes in (issue #710).

The store is the truth of the ledger (#697), which closes a door: a portfolio
that used to be a folder of files a person could copy is now a binary DuckDB
file. Two questions follow from that, and one gesture answers both — *can I go
back to v4?* and *is my only backup a binary?*

**The format of the export is the format of the import**, so the round trip is
round by construction rather than by a mapping kept in step by hand. What is
rendered here is what :class:`events.loader.EventLoader` reads, in the column
order the documentation shows, and re-dropping the result into the drop folder
is an ordinary import with no special path anywhere.

Three things about it are decisions rather than defaults.

**The file states its reporting currency, and the column is called
``base_currency``.** Event amounts are the debit *in the reporting currency*
(ADR-0002) and nothing in the file says which one, so a round trip through an
install that answered differently would silently re-read three years of euros
as dollars. The name is the guard: a broker export routinely carries a
``currency`` column meaning the **security's quote** currency, and reading that
one as the reporting currency is exactly the reinterpretation this exists to
prevent. Two currency levels, two names.

**It is a column repeated on every row, not a preamble.** A CSV has one header
row and nowhere above it to put a fact about the file; a sidecar document would
not be imported by the drop folder at all, and the export has to re-enter by the
**normal** import path or it proves nothing. The cost — one repeated cell per
row — buys a file that opens in a spreadsheet like every other one.

**Provenance is not exported.** ``source_id`` / ``source_sheet`` /
``source_row`` say which import carried a row, and the export *replaces* that
import: carrying them out would describe a file the exported one is not.

This is the *rendering* half of #711's deleted ``events/editor.py``, which spec
#695 § 6 had reserved for exactly this use. It is rewritten rather than restored:
what the old module rendered was a file being edited in place — an addressable
``CsvFile``, an atomic rename, a workbook conversion — and none of those three
has a subject once the rows come from the store and the bytes go into an HTTP
response.
"""
import csv
import io
from datetime import date
from typing import Any, Iterable, List, Optional, Sequence

from .loader import BASE_CURRENCY_COLUMN
from .schemas import ACCOUNT_FILE_COLUMNS, Event

#: The columns of an exported event file, in the order the documentation shows
#: them (``website/docs/import-your-events.mdx``). ``base_currency`` closes the
#: list because it is the one column that is a fact about the *file*: a reader
#: scanning left to right meets the event first and its unit last.
EVENT_COLUMNS = (
    'date', 'event_type', 'account', 'symbol', 'name',
    'quantity', 'unit_price', 'fee', 'amount', 'notes',
    BASE_CURRENCY_COLUMN,
)

#: The columns of an exported accounts file — the account file's own three
#: (issue #698), taken from :mod:`events.schemas` so this is a second *name* for
#: that tuple and never a second value.
ACCOUNT_COLUMNS = ACCOUNT_FILE_COLUMNS


def render_events(events: Iterable[Event],
                  base_currency: Optional[str] = None) -> str:
    """The ledger as an importable ``.csv``.

    ``base_currency`` is written on every row when the install has answered the
    question, and left blank on every row when it has not. Blank is the honest
    answer: an install with no reporting currency has interpreted nothing, so
    the file has nothing to state — and a file whose column is empty imports
    everywhere, which is what an unanswered install's backup should do.
    """
    return _render(EVENT_COLUMNS, [
        _event_row(event, base_currency) for event in events
    ])


def render_accounts(accounts: Iterable[Any]) -> str:
    """The declaration as an importable accounts ``.csv`` (issue #698).

    The other half of a round trip that is actually round: an events file naming
    ``pea`` is *not imported at all* where nothing declares ``pea``, so an export
    of the events alone would restore a multi-account install into a refusal.
    Two files rather than one because that is the format — a file is an accounts
    source or an event source according to its header, and never both.
    """
    return _render(ACCOUNT_COLUMNS, [
        {'id': account.id, 'type': account.type, 'label': account.label}
        for account in accounts
    ])


def _event_row(event: Event, base_currency: Optional[str]) -> dict:
    """One event as the cells a file holds.

    ``account`` is written as the store holds it, ``default`` included: the
    seeded account exists on every install (ADR-0013), so the cell always names
    something the re-import can resolve — where a blank cell would be resolved
    by a rule that depends on whether anything else has been declared yet.
    """
    return {
        'date': event.date,
        'event_type': event.event_type.value,
        'account': event.account,
        'symbol': event.symbol,
        'name': event.name,
        'quantity': event.quantity,
        'unit_price': event.unit_price,
        'fee': event.fee,
        'amount': event.amount,
        'notes': event.notes,
        BASE_CURRENCY_COLUMN: base_currency,
    }


def _render(columns: Sequence[str], rows: Sequence[dict]) -> str:
    """Header plus rows, ``\\n``-terminated, UTF-8 without a byte-order mark.

    ``lineterminator='\\n'`` rather than the module default ``\\r\\n``: the file
    is meant to be diffed and version-controlled beside the ones the user wrote
    by hand, and the loader reads either.
    """
    buffer = io.StringIO(newline='')
    writer = csv.DictWriter(buffer, fieldnames=list(columns), restval='',
                            extrasaction='ignore', lineterminator='\n')
    writer.writeheader()
    for row in rows:
        writer.writerow({column: _cell(row.get(column)) for column in columns})
    return buffer.getvalue()


def _cell(value: Any) -> str:
    """One cell as text.

    ``None`` is an **empty cell**, never the string ``'None'`` — an empty cell
    is what *"this event has no fee"* looks like in a file, and what the loader
    reads back as ``None``. A ``float`` goes out through ``repr``, which since
    Python 3.1 is the shortest string that reads back as the same double, so a
    broker's ``0.34898399999999996`` survives the round trip bit for bit.
    """
    if value is None:
        return ''
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def declared_accounts(accounts: Iterable[Any],
                      seed_row: Sequence[Any]) -> List[Any]:
    """The accounts worth writing into a file: everything but an untouched seed.

    The ``default`` row is on every install and nobody declared it, so exporting
    it would turn *"this install declared nothing"* into a file that declares
    something — and re-importing that file would hand the seeded row a
    ``source_id``, making it read-only and forgettable, which is precisely what
    ADR-0013 keeps it from being. A ``default`` a file **took over** is a
    declaration and does leave: the comparison is against the seeded *values*,
    not against the id.
    """
    seed = (seed_row[0], seed_row[1], seed_row[2])
    return [account for account in accounts
            if (account.id, account.type, account.label) != seed]


__all__ = [
    'EVENT_COLUMNS', 'ACCOUNT_COLUMNS', 'BASE_CURRENCY_COLUMN',
    'render_events', 'render_accounts', 'declared_accounts',
]
