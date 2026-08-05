"""The write half of the configuration directory (issue #662, design #653).

:mod:`influxdb_writer` writes the series; this writes the *configuration*, and
the two are siblings in more than name — each is the only module allowed to put
bytes where its half of the system reads them.

The sequence is #653's, and **its order is the design**::

    build the candidate in memory  →  validate it  →  os.replace  →  republish

There is nothing to roll back because nothing is written until it is known to be
valid, and the republish is a *re-read of the disk* (``reload(force=True)``)
rather than a hand-off of the object we just validated — so the published
snapshot is always a snapshot of what a restart would load. ``invalidate_cache()``
is gone and must not come back: forcing is an argument (#658).

#658 raised the stakes rather than lowering them. A schema-invalid configuration
is now **fatal at boot**, so a write that produces one does not merely log — it
turns the next restart into a crash loop. That is the single thing this module
exists to make impossible.

Which leads to the rule that is easy to get backwards, and that #659's
*tolerant* read (a malformed row comes back with its error, so the ledger can be
used to fix it) only pays off if this module gets right:

* **valid → invalid is refused.** The candidate is rejected whole, nothing is
  written, and the validator's errors travel back verbatim.
* **invalid → invalid is allowed.** When the files on disk are *already*
  rejected, refusing every edit would lock the user out of the ledger exactly
  when it is the only tool that can repair them. The app is already running on
  its previous snapshot (or refusing to boot); an edit cannot make that worse,
  and the response carries what is still broken.

The submitted row is the exception to the tolerance: it must parse on its own,
always. A row the client just typed is the one thing we can always reject
precisely, and accepting it would be writing a defect we could have named.

**Import is stricter than editing**, and the asymmetry is deliberate: an
uploaded file was not there a second ago, so refusing it costs the user nothing
but a corrected spreadsheet, whereas refusing an in-place edit costs them the
only way out. So an import must introduce **no new error** — measured against
the errors the directory already has, which is what keeps an import possible on
a directory that is already broken.
"""
import json
import os
import re
import tempfile
import threading
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from logfmt_logger import getLogger

from events import EventAggregator, EventLoader, EventValidator
from events.aggregator import AggregationError
from events.editor import (
    CSV_COLUMNS,
    TEMP_SUFFIX,
    CsvFile,
    EventEditorReader,
    EventRecord,
    RawRow,
    decode_id,
    fingerprint,
    read_csv,
    render_csv,
    rows_to_cells,
    target_mode,
    workbook_to_csv,
    write_atomic,
)
from events.schemas import Portfolio

logger = getLogger("config_writer")

#: Where an event created from the UI lands. The API contract is expressed in
#: *events* and never in files (#653 — that is what keeps a different store
#: swappable without touching the front), so the client does not choose: the
#: server does, and it chooses one file rather than one per year. A single
#: destination is the predictable one — no file appears that the user did not
#: create, and hand-organised directories (by broker, by year) keep their shape
#: with the UI's own additions gathered in one place they can move rows out of.
ENTRY_FILE = 'ui.csv'

#: What a converted workbook is renamed to. The suffix leaves the loader's view
#: (it filters on ``.csv``/``.xlsx``), which is the whole mechanism: the
#: spreadsheet survives, its rows stop being counted twice.
BACKUP_SUFFIX = '.bak'


class ConfigWriteError(Exception):
    """Base of everything this module refuses to do."""


class WrongMode(ConfigWriteError):
    """The ledger does not exist in manual mode."""


class SourceUnwritable(ConfigWriteError):
    """The events directory cannot be written to.

    The visible end of the fog the map still carries: a PaaS that regenerates
    from ``docker-compose.yaml`` never runs ``make init``, so the container runs
    as ``1000:1000`` over a mount owned by someone else. Naming the condition is
    what turns a mystifying failure into a sentence.
    """


class ReadOnlySource(ConfigWriteError):
    """The addressed row lives in a file this path will not write.

    xlsx, always: openpyxl loads ``data_only=True`` to see cached values, and
    saving from that state writes the values back **over the formulas**.
    """


class UnknownRow(ConfigWriteError):
    """The address does not point at a row that exists."""


class StaleFingerprint(ConfigWriteError):
    """The row at that address is no longer the row the client read.

    Reorder a CSV by hand between the ``GET`` and the ``PATCH`` and the token
    now addresses a different event. Without the check the write would silently
    edit the wrong one.
    """


class Clobber(ConfigWriteError):
    """The write would replace a file that already exists."""


class InvalidCandidate(ConfigWriteError):
    """The candidate would produce a configuration the app refuses to load."""

    def __init__(self, errors: List[str]):
        self.errors = errors
        super().__init__("; ".join(errors) if errors else "invalid configuration")


@dataclass
class WriteResult:
    """What a write did, including the part of it that did not go well.

    ``reloaded`` is not decoration. A write accepted under the invalid → invalid
    rule leaves the configuration unloadable, so the republish fails and the
    published snapshot stays on the previous generation — the front has to say
    so, or the user edits three rows and wonders why nothing moves.
    """

    record: Optional[EventRecord] = None
    reloaded: bool = True
    errors: List[str] = field(default_factory=list)
    source: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            'reloaded': self.reloaded,
            'errors': self.errors,
        }
        if self.record is not None:
            payload['event'] = self.record.to_dict()
        if self.source is not None:
            payload['source'] = self.source
        return payload


class ConfigWriter:
    """Every mutation of the configuration directory, serialised.

    One instance per process, created next to the runtime. The mutex is not
    ``ConfigurationManager``'s: that one serialises *publishers* and is held for
    the duration of a snapshot build, while this one spans read-modify-validate-
    write, which must not interleave with another write or two concurrent edits
    would each validate against a directory the other is about to change.
    """

    def __init__(self, manager):
        self._manager = manager
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # Events — the ledger's write half
    # ------------------------------------------------------------------ #

    def add_event(self, values: Dict[str, Any]) -> WriteResult:
        """Append one event. The server picks the file (see :data:`ENTRY_FILE`)."""
        with self._lock:
            target = self._entry_file()
            cells = rows_to_cells(values)
            self._require_parsable(cells, target)

            csv_file = read_csv(target)
            csv_file.rows.append(cells)
            row_num = len(csv_file.rows) + 1

            reloaded, errors = self._commit(csv_file)
            return WriteResult(
                record=self._record(target, row_num, cells),
                reloaded=reloaded, errors=errors, source=target.name)

    def update_event(self, token: str, if_match: str,
                     values: Dict[str, Any]) -> WriteResult:
        """Edit one row in place, under the ``If-Match`` guard."""
        with self._lock:
            csv_file, index = self._locate(token, if_match)

            # A partial update: only the columns the body names move. Anything
            # else in the row — including a column this build does not know
            # about — is carried through untouched.
            patch = {
                column: value
                for column, value in rows_to_cells(values).items()
                if column in values
            }
            cells = {**csv_file.rows[index], **patch}
            self._require_parsable(cells, csv_file.path)
            csv_file.rows[index] = cells

            reloaded, errors = self._commit(csv_file)
            return WriteResult(
                record=self._record(csv_file.path, index + 2, cells),
                reloaded=reloaded, errors=errors, source=csv_file.path.name)

    def delete_event(self, token: str, if_match: str) -> WriteResult:
        """Remove one row.

        Every id *after* it in the same file changes, because the address is a
        position. The front refetches the collection rather than patching its
        cache — TanStack Query's own invalidation, which is why the ids being
        positional never reaches a user.
        """
        with self._lock:
            csv_file, index = self._locate(token, if_match)
            csv_file.rows.pop(index)
            reloaded, errors = self._commit(csv_file)
            return WriteResult(reloaded=reloaded, errors=errors,
                               source=csv_file.path.name)

    # ------------------------------------------------------------------ #
    # Files — import and the xlsx escape hatch
    # ------------------------------------------------------------------ #

    def can_write(self) -> Tuple[bool, Optional[str]]:
        """Whether the ledger accepts writes, and why not when it does not.

        Asked once by the page rather than discovered by the first failed save:
        the two reasons — manual mode, an unwritable mount — are both states of
        the *installation*, so a UI that offers an edit button and then refuses
        every click is describing itself wrongly.
        """
        try:
            self._writable_source()
        except ConfigWriteError as exc:
            return False, str(exc)
        return True, None

    def list_files(self) -> List[Dict[str, Any]]:
        """The event files, with the row counts and the lock the UI badges."""
        reader = self._reader()
        counts: Dict[str, int] = {}
        for raw in reader.raw_rows():
            counts[raw.path.name] = counts.get(raw.path.name, 0) + 1

        return [
            {
                'name': path.name,
                'editable': path.suffix.lower() == '.csv',
                'rows': counts.get(path.name, 0),
            }
            for path in reader.event_files()
        ]

    def import_file(self, filename: str, data: bytes) -> WriteResult:
        """Add a whole file to the events directory.

        Refused **wholesale** if it introduces an error the directory did not
        already have. That is the answer to #662's second open question, and it
        differs from the in-place rule for a reason worth keeping: a rejected
        import leaves the user with a file they still hold and can correct,
        while a rejected edit would leave them with a ledger they cannot repair.
        """
        with self._lock:
            source = self._writable_source()
            name = Path(filename or '').name
            suffix = Path(name).suffix.lower()
            if suffix not in ('.csv', '.xlsx'):
                raise ConfigWriteError(
                    f"Unsupported file format: {suffix or name!r}. "
                    f"Event files are .csv or .xlsx")

            target = self._inside(source, name)
            if target.exists():
                raise Clobber(
                    f"{name} already exists. Rename the file, or edit the "
                    f"existing one row by row.")

            # Validated from a scratch copy outside the events directory: a
            # candidate sitting *in* it — even under a suffix the loader
            # ignores — is one rename away from being loaded, and reading an
            # xlsx needs a real file on disk.
            with tempfile.TemporaryDirectory() as scratch:
                staged = Path(scratch) / name
                staged.write_bytes(data)
                imported = [
                    RawRow(path=target, file=name, sheet=raw.sheet,
                           row=raw.row, cells=raw.cells)
                    for raw in EventEditorReader(str(staged)).raw_rows()
                ]

            existing = self._reader().raw_rows()
            new_errors = self._new_errors(existing, existing + imported)
            if new_errors:
                raise InvalidCandidate(new_errors)

            self._write_bytes(target, data)
            reloaded = self._republish()
            return WriteResult(reloaded=reloaded, source=name,
                               errors=[] if reloaded else self._errors_now())

    def convert_file(self, filename: str) -> WriteResult:
        """Turn a workbook into the CSV that replaces it.

        Two renames, in this order: the workbook leaves the loader's view
        *before* the CSV enters it. The reverse order would double every event
        in the file for as long as both are visible — and a duplicate event is
        legitimate (#653), so nothing downstream would object; the portfolio
        would simply be twice its size until the next reload. This way the
        window is a missing file, which the very next republish closes.
        """
        with self._lock:
            source = self._writable_source()
            path = self._inside(source, Path(filename or '').name)
            if path.suffix.lower() != '.xlsx':
                raise ConfigWriteError(f"{path.name} is not a workbook")
            if not path.is_file():
                raise UnknownRow(f"No such event file: {path.name}")

            csv_file = workbook_to_csv(path)
            if csv_file.path.exists():
                raise Clobber(
                    f"{csv_file.path.name} already exists beside "
                    f"{path.name}; the conversion would replace it.")

            existing = self._reader().raw_rows()
            converted = [r for r in existing if r.path != path] + [
                RawRow(path=csv_file.path, file=csv_file.path.name, sheet='',
                       row=index + 2, cells=row)
                for index, row in enumerate(csv_file.rows)
            ]
            new_errors = self._new_errors(existing, converted)
            if new_errors:
                raise InvalidCandidate(new_errors)

            staged = self._stage(csv_file.path, render_csv(csv_file))
            try:
                os.replace(path, path.with_name(path.name + BACKUP_SUFFIX))
                os.replace(staged, csv_file.path)
            except BaseException:
                Path(staged).unlink(missing_ok=True)
                raise

            reloaded = self._republish()
            return WriteResult(reloaded=reloaded, source=csv_file.path.name,
                               errors=[] if reloaded else self._errors_now())

    # ------------------------------------------------------------------ #
    # The accounts: block
    # ------------------------------------------------------------------ #

    def set_accounts(self, raw: Optional[List[Dict[str, Any]]]) -> WriteResult:
        """Rewrite ``settings.yaml``'s ``accounts:`` block.

        Hot since #658 — ``settings.yaml`` joined the mtime cache key, so the
        new block is picked up by the next reload instead of the next restart.

        The trap this catches is not the malformed block (``_parse_accounts``
        does that) but the *well-formed* one: removing an id that events still
        reference makes every one of those events invalid
        (``validator.py:128-138``), which since #658 is fatal at boot. So the
        candidate accounts are validated against the events on disk, not on
        their own.

        Only the block is rewritten. ``mode:`` and ``events:`` keep their exact
        bytes, comments included — a settings file is hand-edited, and rewriting
        it through a YAML round-trip would quietly delete the notes its owner
        left in it.
        """
        with self._lock:
            accounts = self._manager._parse_accounts(raw)

            if self._manager.get_mode() == self._manager.MODE_EVENTS:
                rows = self._reader().raw_rows()
                errors = self._validate(rows, accounts)
                if errors and not self._validate(rows, self._accounts_on_disk()):
                    raise InvalidCandidate(errors)

            settings_path = self._manager.settings_path
            text = settings_path.read_text(encoding='utf-8') \
                if settings_path.exists() else ''
            write_atomic(settings_path,
                         _replace_accounts_block(text, _dump_accounts(accounts)))

            reloaded = self._republish()
            return WriteResult(reloaded=reloaded, errors=[] if reloaded
                               else self._errors_now())

    # ------------------------------------------------------------------ #
    # The sequence
    # ------------------------------------------------------------------ #

    def _commit(self, csv_file: CsvFile) -> Tuple[bool, List[str]]:
        """Validate a candidate file, put it in place, republish.

        Returns ``(reloaded, remaining errors)``. Raises
        :class:`InvalidCandidate` when the configuration is valid today and the
        candidate would break it — the one transition #658 made fatal.
        """
        reader = self._reader()
        current = reader.raw_rows()
        candidate = [r for r in current if r.path != csv_file.path] + \
            self._as_raw_rows(csv_file)

        accounts = self._accounts_on_disk()
        errors = self._validate(candidate, accounts)
        if errors and not self._validate(current, accounts):
            raise InvalidCandidate(errors)

        write_atomic(csv_file.path, render_csv(csv_file))
        return self._republish(), errors

    def _validate(self, rows: List[RawRow],
                  accounts: Optional[Portfolio]) -> List[str]:
        """Run the whole loading pipeline over raw rows, in memory.

        The same four stages ``ConfigurationManager._build_snapshot`` runs, in
        the same order, and that is the point rather than an implementation
        detail: a candidate this accepts is one the boot path accepts. Parsing
        is the only stage that reports per row — past it, an event set is
        validated as a set (you cannot sell three shares you own two of without
        knowing about the other file's BUY).
        """
        parser = EventLoader(str(self._source()))

        errors: List[str] = []
        events = []
        for raw in rows:
            try:
                events.append(parser._parse_row(raw.cells, raw.path, raw.row))
            except ValueError as exc:
                errors.append(f"{raw.where()}: {exc}")
        if errors:
            return errors

        events.sort(key=lambda event: event.date)
        account_ids = accounts.ids() if accounts else None

        valid, event_errors = EventValidator(account_ids=account_ids).validate(events)
        if not valid:
            return event_errors

        try:
            shares = EventAggregator().aggregate(
                events, accounts_declared=account_ids is not None)
        except AggregationError as exc:
            return [str(exc)]

        # `shares and` mirrors #658's exemption: schema.yaml's `empty: False`
        # was written for a hand-edited config.yaml, and an events install that
        # legitimately holds nothing must not be told its portfolio is invalid.
        if shares and not self._manager.validator.validate({'shares': shares}):
            return [str(self._manager.validator.errors)]
        return []

    def _new_errors(self, current: List[RawRow],
                    candidate: List[RawRow]) -> List[str]:
        """The errors the candidate adds to the ones already there.

        A difference rather than "is it clean", because a directory that is
        already broken must still accept a file that does not make it worse —
        otherwise the first bad row ever written locks the import out for good.

        Compared on :func:`_error_key` and as a **multiset**, and both are
        forced by what the messages actually contain. The validator numbers its
        events by position in the date-sorted set, so importing anything dated
        earlier renumbers every error after it; a parse error names its file and
        row, so converting a workbook renames all of its own. Compared verbatim,
        both operations would report every pre-existing error as new — refusing
        the conversion precisely when it is the way to reach the broken rows.
        Counting rather than set-testing keeps the other direction honest: a
        second row failing the same way is a new error, not a duplicate.
        """
        accounts = self._accounts_on_disk()
        before = Counter(_error_key(e) for e in self._validate(current, accounts))

        added = []
        for message in self._validate(candidate, accounts):
            key = _error_key(message)
            if before[key]:
                before[key] -= 1
            else:
                added.append(message)
        return added

    def _errors_now(self) -> List[str]:
        """What is wrong with the configuration as it stands, for a failed reload.

        Never raises, and that is the whole point of the guard: this runs
        *because* something is already broken, so the reasons it could throw are
        exactly the conditions it exists to describe — an unparseable
        ``settings.yaml``, a file that vanished mid-write. Letting it propagate
        turned a write that had succeeded into a ``503`` claiming the database
        was unreachable.
        """
        try:
            return self._validate(self._reader().raw_rows(),
                                  self._accounts_on_disk())
        except Exception as exc:
            return [str(exc)]

    def _republish(self) -> bool:
        """Re-read the disk and publish it. ``False`` when it will not load.

        Never raises. A write accepted under the invalid → invalid rule is
        *expected* to fail here, and the failure is information for the client,
        not an error of the request — the bytes did land, and the previously
        published snapshot is still standing (which is ``reload``'s own
        contract, and what keeps the scheduler running through this).
        """
        try:
            self._manager.reload(force=True)
            return True
        except Exception as exc:
            logger.warning(
                f"Configuration written but not republished: {exc}")
            return False

    # ------------------------------------------------------------------ #
    # Addressing
    # ------------------------------------------------------------------ #

    def _locate(self, token: str, if_match: str) -> Tuple[CsvFile, int]:
        """Resolve a token to a row of a writable file, guard checked."""
        try:
            address = decode_id(token)
        except ValueError as exc:
            raise UnknownRow(str(exc))

        source = self._writable_source()
        path = self._inside(source, address.file)

        # The sheet part is empty for a CSV by construction, so a non-empty one
        # *is* the xlsx case — checked before the suffix so a token forged from
        # a workbook address cannot be pointed at a CSV of the same stem.
        if address.sheet or path.suffix.lower() != '.csv':
            raise ReadOnlySource(
                f"{path.name} is read-only. A workbook is loaded with its "
                f"formulas already evaluated, so saving it back would write the "
                f"values over them — convert it to CSV first.")
        if not path.is_file():
            raise UnknownRow(f"No such event file: {path.name}")

        csv_file = read_csv(path)
        index = csv_file.row_index(address.row)
        if index is None:
            raise UnknownRow(
                f"{path.name} has no row {address.row} any more.")

        if fingerprint(csv_file.rows[index]) != (if_match or ''):
            raise StaleFingerprint(
                f"Row {address.row} of {path.name} has changed since it was "
                f"read. Reload the ledger and try again.")

        return csv_file, index

    def _require_parsable(self, cells: Dict[str, Any], path: Path) -> None:
        """The submitted row must be an event on its own terms.

        The exception to the invalid → invalid tolerance, and the reason it is
        an exception: everything else the tolerance forgives was already on
        disk, while this row is one the client typed a moment ago. Writing a
        defect we could have named precisely, into a file the user is trying to
        repair, is the one thing the rule must not be read as permitting.
        """
        try:
            EventLoader(str(path))._parse_row(cells, path, 0)
        except ValueError as exc:
            raise InvalidCandidate([str(exc)])

    def _record(self, path: Path, row_num: int,
                cells: Dict[str, Any]) -> EventRecord:
        """The written row as the ledger will read it back."""
        reader = self._reader()
        return reader.record(RawRow(
            path=path, file=reader._relative(path), sheet='', row=row_num,
            cells=cells))

    def _as_raw_rows(self, csv_file: CsvFile) -> List[RawRow]:
        reader = self._reader()
        file_rel = reader._relative(csv_file.path)
        return [
            RawRow(path=csv_file.path, file=file_rel, sheet='', row=index + 2,
                   cells=row)
            for index, row in enumerate(csv_file.rows)
        ]

    # ------------------------------------------------------------------ #
    # Where the files are
    # ------------------------------------------------------------------ #

    def _reader(self) -> EventEditorReader:
        return EventEditorReader(str(self._source()))

    def _source(self) -> Path:
        """The events source, or a refusal in manual mode."""
        source = self._manager.get_events_source()
        if self._manager.get_mode() != self._manager.MODE_EVENTS or not source:
            raise WrongMode(
                "This installation runs in manual mode: the portfolio is "
                "declared in config.yaml and there is no event ledger to write.")
        return Path(source).expanduser()

    def _writable_source(self) -> Path:
        """The events *directory*, checked for write access.

        Named rather than discovered: the mount is writable since #658 only when
        the container's uid owns it, and a deployment that never ran ``make
        init`` runs as ``1000:1000`` over someone else's files. Without this the
        first edit would surface as a ``PermissionError`` deep in a temp file.
        """
        source = self._source()
        directory = source if source.is_dir() else source.parent
        if not directory.is_dir():
            raise SourceUnwritable(f"The events directory {directory} does not exist.")
        if not os.access(directory, os.W_OK | os.X_OK):
            raise SourceUnwritable(
                f"The events directory {directory} is not writable by this "
                f"process (uid {os.getuid()}). The container must run as the "
                f"user that owns the config directory — see SB_UID/SB_GID.")
        return directory

    def _entry_file(self) -> Path:
        """Where a created event lands.

        A single-file source is its own entry file, provided it is a CSV; a
        directory gets :data:`ENTRY_FILE`, created on first write.
        """
        source = self._source()
        self._writable_source()
        if source.is_file():
            if source.suffix.lower() != '.csv':
                raise ReadOnlySource(
                    f"The events source is the workbook {source.name}, which "
                    f"this path will not write. Convert it to CSV first.")
            return source
        return source / ENTRY_FILE

    @staticmethod
    def _inside(directory: Path, name: str) -> Path:
        """Resolve ``name`` under ``directory``, refusing to leave it.

        The file part of a token is client-supplied and base64 is not a
        signature, so ``../../settings.yaml`` is a token anyone can mint. The
        opacity of the id is a contract about who interprets it, never a
        security claim — the check is here because it is the only place that
        can make it.
        """
        candidate = (directory / name).resolve()
        root = directory.resolve()
        if candidate != root and root not in candidate.parents:
            raise UnknownRow(f"{name!r} is not inside the events directory.")
        return candidate

    def _accounts_on_disk(self) -> Optional[Portfolio]:
        """The declared accounts as ``settings.yaml`` has them *now*.

        Not ``load_accounts()``: that serves the published snapshot, which is by
        design one generation behind a file the user just edited. A candidate is
        validated against the disk it is about to join.
        """
        return self._manager.accounts_on_disk()

    def _stage(self, path: Path, text: str) -> str:
        """Write ``text`` beside ``path`` under an invisible suffix."""
        handle = tempfile.NamedTemporaryFile(
            mode='w', encoding='utf-8', newline='', dir=str(path.parent),
            prefix=f".{path.name}.", suffix=TEMP_SUFFIX, delete=False)
        with handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(handle.name, target_mode(path))
        return handle.name

    def _write_bytes(self, path: Path, data: bytes) -> None:
        """:func:`events.editor.write_atomic` for a binary payload."""
        handle = tempfile.NamedTemporaryFile(
            dir=str(path.parent), prefix=f".{path.name}.", suffix=TEMP_SUFFIX,
            delete=False)
        try:
            with handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(handle.name, target_mode(path))
            os.replace(handle.name, path)
        except BaseException:
            Path(handle.name).unlink(missing_ok=True)
            raise


# --------------------------------------------------------------------------- #
# settings.yaml surgery
# --------------------------------------------------------------------------- #

#: Strips an error message down to *what* is wrong, dropping *where*. The two
#: prefixes the pipeline produces are a positional event number
#: (``Event #7 (2024-01-15, BUY, AAPL): …``) and a file address
#: (``2024.xlsx/Sheet 1 row 5: …``); both move when rows are added or a file is
#: renamed, and neither says anything about the defect itself.
_EVENT_INDEX = re.compile(r'^Event #\d+ ')
_ROW_ADDRESS = re.compile(r'^.*? row \d+: ')


def _error_key(message: str) -> str:
    """The identity of an error, independent of where it currently sits."""
    return _ROW_ADDRESS.sub('', _EVENT_INDEX.sub('', message))


def _dump_accounts(accounts: Optional[Portfolio]) -> str:
    """Render the ``accounts:`` block, or nothing when there are none.

    Written by hand rather than through ``yaml.safe_dump`` for one reason and it
    is not aesthetics: the dump of a whole document would have to be of the
    whole document. Scalars go through :func:`json.dumps`, whose output is a
    strict subset of YAML's double-quoted style, so an id with a colon or an
    accent in a label survives without a quoting rule of our own.
    """
    if accounts is None or not accounts.accounts:
        return ''

    lines = ['accounts:']
    for account in accounts.accounts:
        lines.append(f"  - id: {_scalar(account.id)}")
        lines.append(f"    type: {_scalar(account.type)}")
        lines.append(f"    currency: {_scalar(account.currency)}")
        lines.append(f"    label: {_scalar(account.label)}")
    return "\n".join(lines) + "\n"


def _scalar(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


#: A line that opens a new top-level key, and therefore ends the block above it.
#: The exclusions are what the rule turns on: an indented line continues the
#: block, a ``#`` comment belongs to *something* and is resolved separately
#: below, and a leading ``-`` is a **sequence item at column zero** — which is
#: the idiomatic YAML style, the one this repo's own ``settings.yaml`` uses, and
#: the one that made an earlier "ends at the next line in column zero" rule
#: terminate the block on its very first entry and append a second copy of it.
_TOP_LEVEL_KEY = re.compile(r'^[^\s#-][^:]*:')


def _replace_accounts_block(text: str, block: str) -> str:
    """Swap the ``accounts:`` block of a settings file, leaving the rest alone.

    The block runs from its key to the next **top-level key**, minus any blank
    lines and comments immediately before that key — those introduce what
    follows, so a note written above ``events:`` stays with ``events:``.

    Comments *inside* the block are the one thing lost. That is a bounded, stated
    cost, and it is the deliberate trade against the alternative: a rule that
    also stopped at an interior comment would leave the entries after it behind,
    and a duplicated block is invalid YAML, which since #658 is fatal at boot.
    """
    lines = text.splitlines(keepends=True)

    start = None
    for index, line in enumerate(lines):
        if line.startswith('accounts:'):
            start = index
            break

    if start is None:
        if not block:
            return text
        separator = '' if not text or text.endswith('\n') else '\n'
        return f"{text}{separator}{block}"

    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if _TOP_LEVEL_KEY.match(line) or line.rstrip() in ('---', '...'):
            end = index
            break

    # Give the trailing blanks and comments back to the key they introduce.
    while end - 1 > start and (not lines[end - 1].strip()
                               or lines[end - 1].lstrip().startswith('#')):
        end -= 1

    return ''.join(lines[:start]) + block + ''.join(lines[end:])


__all__ = [
    'ConfigWriter', 'WriteResult', 'ConfigWriteError', 'WrongMode',
    'SourceUnwritable', 'ReadOnlySource', 'UnknownRow', 'StaleFingerprint',
    'Clobber', 'InvalidCandidate', 'ENTRY_FILE', 'BACKUP_SUFFIX',
    'CSV_COLUMNS',
]
