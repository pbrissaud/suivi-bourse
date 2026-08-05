"""The editor read path: event files read *as files* (issue #659, design #653/#655).

:class:`~events.loader.EventLoader` reads the files the way the *scheduler*
needs them — a flat, date-sorted list of :class:`~events.schemas.Event`, with
nothing to say about where each one came from. That is the right shape for
aggregation and the wrong one for a ledger you can edit: an editor needs to
address a row.

So this is a second read of the same files, deliberately *beside* the loader
rather than inside it. #653 §"the UI edits existing files" is explicit about
why: ``Event``, the aggregator and the validator stay **byte-identical**, so
the whole scraping path is untouched by the existence of a UI. Provenance lives
only here.

**The address is not the identity the client sees.** #653 ruled that ``file``
and ``row`` must never leak into the API contract, or the door to a different
store (SQLite, one day) closes. So each row gets:

* an **opaque token** encoding ``(file, sheet, row)`` — the client round-trips
  it and never parses it; it can become a ``rowid`` later without the front
  noticing;
* a **content fingerprint**, exposed as an ``ETag`` and required back as
  ``If-Match`` on a write.

The fingerprint is what closes the stale-address hole. Reorder ``2024.csv`` by
hand between a ``GET`` and a ``PATCH`` and the token now points at a *different*
row; without the check the write would silently edit the wrong event. With it,
the mismatch is a ``409``.

Rejected on the way here, and recorded so it is not re-litigated: a
**content-addressed id** (hash of the fields) is stable under reordering but
**collides on duplicates**, and two identical ``DIVIDEND`` rows on the same date
are perfectly legitimate; a real **``id`` column in the file** is cleanest in
theory but changes a documented, versioned format and breaks the "open it in a
spreadsheet" promise.

Addressing is ``(file, sheet, row)`` and never ``(file, row)`` — the xlsx trap:
:meth:`EventLoader._load_xlsx` iterates *every* worksheet and its ``row_num``
restarts at 2 in each one (``loader.py:125,139``), so two rows in one workbook
share a row number.
"""
import base64
import csv
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from .loader import EventLoader, EventLoaderError
from .schemas import Event

#: Separator inside the opaque token. A unit separator, so it cannot occur in a
#: file name or a sheet title.
_SEP = '\x1f'

#: Extensions the editor can *write*. xlsx is read-only on this path and stays
#: that way: openpyxl loads with ``data_only=True`` to see cached values, and
#: saving from that state writes the values back **in place of the formulas** —
#: it would silently destroy a spreadsheet the user still computes in. #652
#: déc. 14 gives the UI an explicit convert-to-CSV action instead of a
#: half-working save.
EDITABLE_SUFFIXES = ('.csv',)


@dataclass(frozen=True)
class EventRecord:
    """One event as the ledger sees it: the parsed event plus its address.

    ``event`` is ``None`` when the row could not be parsed; ``error`` then
    carries why. The read stays tolerant on purpose — a ledger that 500s
    because one row is malformed cannot be used to *fix* that row, and #652
    déc. 14 made the data page a row-level ledger with an inline edit precisely
    so a bad row has somewhere to be shown. (The application itself is stricter:
    since #658 a file the validator rejects is fatal at boot. This path is what
    lets a human see what the validator objected to.)
    """

    id: str
    etag: str
    source: str
    editable: bool
    event: Optional[Event] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """The wire shape. ``source`` is display-only provenance — the file's
        *name*, which #652 déc. 14 keeps as a discreet column so an xlsx row can
        carry its lock badge. The address itself stays inside ``id``.
        """
        payload: Dict[str, Any] = {
            'id': self.id,
            'etag': self.etag,
            'source': self.source,
            'editable': self.editable,
            'error': self.error,
        }
        if self.event is not None:
            payload.update({
                'date': self.event.date.isoformat(),
                'event_type': self.event.event_type.value,
                'symbol': self.event.symbol,
                'name': self.event.name,
                'quantity': self.event.quantity,
                'unit_price': self.event.unit_price,
                'fee': self.event.fee,
                'amount': self.event.amount,
                'notes': self.event.notes,
                'account': self.event.account,
            })
        return payload


@dataclass(frozen=True)
class EventAddress:
    """The decoded form of a token — server-side only, never on the wire."""

    file: str
    sheet: str
    row: int


def encode_id(file_rel: str, sheet: str, row: int) -> str:
    """Pack an address into the opaque token the client round-trips.

    base64url of the three parts, padding stripped. Not a secret and not
    tamper-proof — the fingerprint is what makes a write safe. It is *opaque*,
    which is a contract about who may interpret it, not a security claim.
    """
    raw = f"{file_rel}{_SEP}{sheet}{_SEP}{row}".encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def decode_id(token: str) -> EventAddress:
    """Unpack a token. Raises ``ValueError`` on anything malformed."""
    padded = token + '=' * (-len(token) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8')
    except Exception as exc:
        raise ValueError(f"Malformed event id: {exc}")

    parts = raw.split(_SEP)
    if len(parts) != 3:
        raise ValueError("Malformed event id: wrong number of parts")
    file_rel, sheet, row = parts
    if not row.isdigit():
        raise ValueError("Malformed event id: row is not a number")
    return EventAddress(file=file_rel, sheet=sheet, row=int(row))


def fingerprint(raw_row: Dict[str, Any]) -> str:
    """Content fingerprint of a row, as an ``ETag`` value.

    Computed over the row's *cells*, canonicalised so a CSV and an xlsx holding
    the same event fingerprint alike: keys lowercased and sorted, values
    stringified and stripped, empty and missing treated as one. Only the columns
    the format defines take part, so adding an unrelated column to a file does
    not invalidate every id in it.
    """
    parts = []
    for column in sorted(EventLoader.ALL_COLUMNS):
        value = raw_row.get(column)
        text = '' if value is None else str(value).strip()
        parts.append(f"{column}={text}")
    digest = hashlib.sha256(_SEP.join(parts).encode('utf-8')).hexdigest()
    return digest[:32]


class EventEditorReader:
    """Reads the event source into addressable :class:`EventRecord` rows.

    Args:
        source_path: the events source — the same one the loader is given, a
            directory or a single file.
    """

    def __init__(self, source_path: str):
        self.source_path = Path(source_path).expanduser()
        # Parsing is delegated to a loader instance so the typed values in the
        # ledger come from *the same* rules the scheduler runs on. Sharing the
        # parser rather than reimplementing it is what keeps the two reads from
        # drifting into disagreeing about what a row means.
        self._parser = EventLoader(str(self.source_path))

    def list_records(self) -> List[EventRecord]:
        """Every row of every event file, in file then row order.

        Not sorted by date, unlike :meth:`EventLoader.load` — a ledger is a view
        of files, and a row's neighbours in the file are what a person edits
        against. Date ordering is the front's business (#652 déc. 14 sorts the
        merged ledger by date for display).
        """
        if not self.source_path.exists():
            return []

        records: List[EventRecord] = []
        for path in self._event_files():
            records.extend(self._read_file(path))
        return records

    def _event_files(self) -> List[Path]:
        """The files to read, in the loader's own order."""
        if self.source_path.is_file():
            return [self.source_path]
        return [
            f for f in sorted(self.source_path.iterdir())
            if f.suffix.lower() in ('.csv', '.xlsx')
        ]

    def _read_file(self, path: Path) -> List[EventRecord]:
        suffix = path.suffix.lower()
        if suffix == '.csv':
            return self._read_csv(path)
        if suffix == '.xlsx':
            return self._read_xlsx(path)
        return []

    def _relative(self, path: Path) -> str:
        """The file's path relative to the source, the token's first part."""
        if self.source_path.is_file():
            return path.name
        try:
            return str(path.relative_to(self.source_path))
        except ValueError:
            return path.name

    def _read_csv(self, path: Path) -> List[EventRecord]:
        records: List[EventRecord] = []
        with open(path, 'r', encoding='utf-8') as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                return []
            # A CSV has no sheets, so the middle part of the address is empty —
            # the token keeps three parts either way, so one decoder serves both
            # formats.
            for row_num, row in enumerate(reader, start=2):
                records.append(self._record(path, '', row_num, row))
        return records

    def _read_xlsx(self, path: Path) -> List[EventRecord]:
        try:
            import openpyxl
        except ImportError:
            raise EventLoaderError(
                "openpyxl is required to read XLSX files. "
                "Install it with: pip install openpyxl")

        records: List[EventRecord] = []
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for sheet in workbook.worksheets:
            rows = list(sheet.iter_rows(values_only=True))
            if not rows:
                continue
            headers = [str(h).lower().strip() if h else '' for h in rows[0]]
            # ``enumerate`` over the *unfiltered* rows, exactly like the loader:
            # a blank row is skipped but still consumes its number, so an
            # address here and a loader error message point at the same line of
            # the spreadsheet.
            for row_num, values in enumerate(rows[1:], start=2):
                if not any(values):
                    continue
                records.append(self._record(
                    path, sheet.title, row_num, dict(zip(headers, values))))
        workbook.close()
        return records

    def _record(self, path: Path, sheet: str, row_num: int,
                raw_row: Dict[str, Any]) -> EventRecord:
        """Turn one raw row into a record, keeping a parse failure local to it."""
        file_rel = self._relative(path)
        try:
            event = self._parser._parse_row(raw_row, path, row_num)
            error = None
        except ValueError as exc:
            event, error = None, str(exc)

        return EventRecord(
            id=encode_id(file_rel, sheet, row_num),
            etag=fingerprint(raw_row),
            source=path.name,
            editable=path.suffix.lower() in EDITABLE_SUFFIXES,
            event=event,
            error=error,
        )


__all__ = [
    'EventRecord', 'EventAddress', 'EventEditorReader',
    'encode_id', 'decode_id', 'fingerprint', 'EDITABLE_SUFFIXES',
]
