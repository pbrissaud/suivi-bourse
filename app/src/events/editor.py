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

**The write mechanics live here too** (issue #662), and only the mechanics: how
a CSV is rendered back, and how it is put in place without ever being observed
half-written. *Whether* a candidate may be written is
:mod:`config_writer`'s question, because answering it needs the validator, the
aggregator and the published snapshot — none of which a file module should know
about. The seam is #653's rule read literally: this module produces bytes, the
other decides they are allowed to land.
"""
import base64
import csv
import hashlib
import io
import os
import tempfile
from dataclasses import dataclass, field
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
    cells: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """The wire shape. ``source`` is display-only provenance — the file's
        *name*, which #652 déc. 14 keeps as a discreet column so an xlsx row can
        carry its lock badge. The address itself stays inside ``id``.

        A row that failed to parse carries its **raw cells** instead of the
        typed fields, and that is what makes the tolerance worth having: without
        them the ledger would report "row 7 is broken" while showing nothing to
        repair, and the user would be back in a text editor — which is precisely
        the state #652 déc. 14 built a row-level ledger to get out of.
        """
        payload: Dict[str, Any] = {
            'id': self.id,
            'etag': self.etag,
            'source': self.source,
            'editable': self.editable,
            'error': self.error,
        }
        if self.event is None:
            payload['cells'] = {
                column: _cell(self.cells.get(column))
                for column in CSV_COLUMNS
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


@dataclass(frozen=True)
class RawRow:
    """One row of one event file, before anything tries to make an Event of it.

    The unit the *write* path works in: a candidate configuration is this list
    with one file's rows swapped, parsed in memory and never touching the disk
    unless it validates. Keeping the raw cells (rather than parsed ``Event``\\ s)
    is what makes that possible — a row the parser rejects still has to be
    carried, or the ledger could not be used to repair one.
    """

    path: Path
    file: str
    sheet: str
    row: int
    cells: Dict[str, Any] = field(default_factory=dict)

    @property
    def editable(self) -> bool:
        return self.path.suffix.lower() in EDITABLE_SUFFIXES

    @property
    def id(self) -> str:
        return encode_id(self.file, self.sheet, self.row)

    def where(self) -> str:
        """Human-readable provenance, for an error message.

        The sheet is named only when there is one, so a CSV error reads
        ``2024.csv row 7`` rather than carrying an empty separator around.
        """
        source = f"{self.file}/{self.sheet}" if self.sheet else self.file
        return f"{source} row {self.row}"


@dataclass
class CsvFile:
    """A CSV event file held in memory, addressed the way the tokens address it.

    ``rows[i]`` is row number ``i + 2`` — the header is row 1, exactly as
    :meth:`EventLoader._load_csv` counts. Mutating this object is how an edit is
    prepared; nothing here writes.
    """

    path: Path
    fieldnames: List[str]
    rows: List[Dict[str, Any]]

    def row_index(self, row_num: int) -> Optional[int]:
        index = row_num - 2
        return index if 0 <= index < len(self.rows) else None


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
        return [self.record(raw) for raw in self.raw_rows()]

    def raw_rows(self) -> List[RawRow]:
        """Every row of every event file, unparsed.

        The read :meth:`list_records` is built on, and the one the write path
        needs on its own: an edit is validated by replacing one file's rows in
        *this* list and parsing the result, so the rows of the files nobody
        touched have to be available without having been turned into records
        first.
        """
        if not self.source_path.exists():
            return []

        rows: List[RawRow] = []
        for path in self.event_files():
            rows.extend(self._read_file(path))
        return rows

    def event_files(self) -> List[Path]:
        """The files to read, in the loader's own order."""
        if self.source_path.is_file():
            return [self.source_path]
        if not self.source_path.is_dir():
            return []
        return [
            f for f in sorted(self.source_path.iterdir())
            if f.suffix.lower() in ('.csv', '.xlsx')
        ]

    def _read_file(self, path: Path) -> List[RawRow]:
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

    def _read_csv(self, path: Path) -> List[RawRow]:
        csv_file = read_csv(path)
        # A CSV has no sheets, so the middle part of the address is empty — the
        # token keeps three parts either way, so one decoder serves both formats.
        return [
            RawRow(path=path, file=self._relative(path), sheet='',
                   row=index + 2, cells=row)
            for index, row in enumerate(csv_file.rows)
        ]

    def _read_xlsx(self, path: Path) -> List[RawRow]:
        try:
            import openpyxl
        except ImportError:
            raise EventLoaderError(
                "openpyxl is required to read XLSX files. "
                "Install it with: pip install openpyxl")

        raws: List[RawRow] = []
        file_rel = self._relative(path)
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
                raws.append(RawRow(
                    path=path, file=file_rel, sheet=sheet.title, row=row_num,
                    cells=dict(zip(headers, values))))
        workbook.close()
        return raws

    def record(self, raw: RawRow) -> EventRecord:
        """Turn one raw row into a record, keeping a parse failure local to it."""
        try:
            event = self._parser._parse_row(raw.cells, raw.path, raw.row)
            error = None
        except ValueError as exc:
            event, error = None, str(exc)

        return EventRecord(
            id=raw.id,
            etag=fingerprint(raw.cells),
            source=raw.path.name,
            editable=raw.editable,
            event=event,
            error=error,
            cells=raw.cells,
        )


# --------------------------------------------------------------------------- #
# CSV mechanics — the bytes half of a write (issue #662)
# --------------------------------------------------------------------------- #

#: The column order a *new* file is created with, and the documented one
#: (``CLAUDE.md`` § CSV Format). ``account`` closes the list because it is the
#: youngest column and the one an opt-out install never fills.
CSV_COLUMNS = (
    'date', 'event_type', 'symbol', 'name', 'quantity', 'unit_price', 'fee',
    'amount', 'notes', 'account',
)

#: Suffix of the file a write lands on before it is renamed into place. It is
#: deliberately **not** an event suffix: the loader, the watcher and
#: ``_compute_cache_key`` all filter on ``.csv``/``.xlsx``, so a half-written
#: candidate sitting in the events directory is invisible to every one of them.
TEMP_SUFFIX = '.sb-tmp'

#: What a converted workbook becomes. Not a deletion, on purpose: xlsx is
#: read-only here precisely *because* the user may still compute in it
#: (``data_only=True`` would freeze the formulas), so the conversion keeps the
#: spreadsheet and only takes it out of the loader's view.
CONVERTED_SUFFIX = '.xlsx.bak'


def read_csv(path: Path) -> CsvFile:
    """Read a CSV event file into memory. A missing file is an empty one.

    The header is taken as it is written, never normalised — the loader reads
    ``row.get('date')`` against exactly these keys, so re-casing them here would
    make the editor and the scheduler disagree about what a file contains.
    """
    if not path.exists():
        return CsvFile(path=path, fieldnames=list(CSV_COLUMNS), rows=[])

    with open(path, 'r', encoding='utf-8', newline='') as handle:
        reader = csv.DictReader(handle)
        fieldnames = list(reader.fieldnames or CSV_COLUMNS)
        return CsvFile(path=path, fieldnames=fieldnames, rows=list(reader))


def render_csv(csv_file: CsvFile) -> str:
    """Render a :class:`CsvFile` back to text, columns and order preserved.

    ``extrasaction='ignore'`` and ``restval=''`` are what let an edited row and
    an untouched one share a writer: the untouched one may carry a column this
    build does not know about (it keeps it), and the edited one may be missing
    one (it gets an empty cell) — neither is an error, and losing a column the
    user added would be a silent data loss.
    """
    buffer = io.StringIO(newline='')
    writer = csv.DictWriter(
        buffer, fieldnames=csv_file.fieldnames, restval='',
        extrasaction='ignore', lineterminator='\n')
    writer.writeheader()
    for row in csv_file.rows:
        writer.writerow({key: _cell(row.get(key)) for key in csv_file.fieldnames})
    return buffer.getvalue()


def _cell(value: Any) -> str:
    """One cell as text. ``None`` is an empty cell, never the string 'None'."""
    return '' if value is None else str(value)


def write_atomic(path: Path, text: str) -> None:
    """Put ``text`` at ``path`` without the file ever being seen half-written.

    Same-directory temp file plus :func:`os.replace`, which is the whole of
    #653's third rule: the rename is atomic on POSIX, so a reader — the
    ingestion job, the watcher, a human's ``cat`` — sees either the previous
    file or the new one. A temp file elsewhere would defeat it, since
    :func:`os.replace` is only atomic within one filesystem, and the config
    directory is a mount of its own.

    ``fsync`` before the rename because the ordering guarantee is about
    *visibility*, not durability: without it a crash can leave the rename
    applied and the content not.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode='w', encoding='utf-8', newline='', dir=str(path.parent),
        prefix=f".{path.name}.", suffix=TEMP_SUFFIX, delete=False)
    try:
        with handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(handle.name, target_mode(path))
        os.replace(handle.name, path)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise


#: Permissions a file the UI creates gets. ``tempfile`` opens at ``0600`` — right
#: for a scratch file and wrong for the one it becomes, since these are the
#: user's own data files sitting beside ones they created by hand at ``0644``.
#: A rewrite silently tightening a file's permissions is the kind of change
#: nobody notices until a second uid needs to read it.
NEW_FILE_MODE = 0o644


def target_mode(path: Path) -> int:
    """Keep an existing file's permissions; give a new one the usual ones."""
    try:
        return path.stat().st_mode & 0o777
    except OSError:
        return NEW_FILE_MODE


def rows_to_cells(values: Dict[str, Any]) -> Dict[str, str]:
    """Normalise an API payload into the cells a CSV row holds.

    Only the documented columns survive, so a client cannot smuggle a column
    into a file by naming it in the body. ``None`` becomes an empty cell — which
    is what "this event has no fee" looks like in a CSV, and what the loader
    reads back as ``None``.
    """
    return {column: _cell(values.get(column)).strip() for column in CSV_COLUMNS}


def workbook_to_csv(path: Path) -> CsvFile:
    """Flatten a workbook into the CSV that replaces it.

    Every worksheet's rows, in workbook order, under the union of their headers
    — a workbook whose sheets disagree on columns still converts, and the cells
    a given sheet does not have come out empty. The address changes (the sheet
    part of every token becomes empty), which is precisely why the conversion is
    an explicit action and not something the editor does behind a save.
    """
    reader = EventEditorReader(str(path))
    raws = reader.raw_rows()

    fieldnames = list(CSV_COLUMNS)
    for raw in raws:
        for key in raw.cells:
            if key and key not in fieldnames:
                fieldnames.append(key)

    target = path.with_suffix('.csv')
    return CsvFile(
        path=target,
        fieldnames=fieldnames,
        rows=[{key: raw.cells.get(key) for key in fieldnames} for raw in raws],
    )


__all__ = [
    'EventRecord', 'EventAddress', 'EventEditorReader', 'RawRow', 'CsvFile',
    'encode_id', 'decode_id', 'fingerprint', 'read_csv', 'render_csv',
    'write_atomic', 'rows_to_cells', 'workbook_to_csv', 'target_mode',
    'EDITABLE_SUFFIXES', 'CSV_COLUMNS', 'TEMP_SUFFIX', 'CONVERTED_SUFFIX',
]
