"""A file handed to the app, read once, and never seen again (issue #811)."""
import json
import tempfile
from dataclasses import dataclass, replace
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from logfmt_logger import getLogger

from application import accounts as accounts_module
from application.events.loader import EventLoader
from application.events.loader import EventLoaderError
from application.events.schemas import ACCOUNT_FILE_COLUMNS, DEFAULT_ACCOUNT, Event

logger = getLogger("uploads")

IMPORT_SUFFIXES = ('.csv', '.xlsx')

MAX_UPLOAD_BYTES = 8 * 1024 * 1024

MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024

LEGACY_FILENAMES = ('config.yaml', 'settings.yaml')

MIGRATION_PAGE = 'https://pbrissaud.github.io/suivi-bourse/docs/v5/coming-from-v4'


class UploadRefused(Exception):
    """The file is not one this app writes rows from, and nothing was written."""


class UploadTooLarge(Exception):
    """The payload is past :data:`MAX_UPLOAD_BYTES`. Its own class for its own status: ``413`` is not *the file is wrong*, it is *the file is too big*."""


@dataclass(frozen=True)
class Upload:
    """One file, read: its rows, and the one thing it says about itself."""

    filename: str
    events: List[Event]
    declared_currency: Optional[str]


@dataclass(frozen=True)
class FileAccount:
    """One account the **file** names, and how many of its rows carry it."""

    name: str
    rows: int


@dataclass(frozen=True)
class AccountMapping:
    """Where each account the file names is to go — **the gesture's parameter**."""

    targets: Dict[str, str]
    declaring: Tuple[str, ...]
    stated: bool

    def applied(self, events: Sequence[Event]) -> List[Event]:
        """The file's rows read through the correspondence — a **new** list."""
        if not self.targets:
            return list(events)
        return [replace(event, account=self.targets.get(_label(event),
                                                        event.account))
                for event in events]


@dataclass(frozen=True)
class Receipt:
    """What the gesture produced, in the units the owner counts in."""

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
    """Does the request **declare** more than a body may carry?"""
    return content_length is not None and content_length > MAX_BODY_BYTES


def too_large_detail() -> str:
    """The one sentence the bound is refused with, wherever it is met."""
    return (f"a file may carry at most {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB; "
            f"export a narrower range, or split it")


def read(filename: str, stream) -> Upload:
    """One uploaded file as the events it declares, or a named refusal."""
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
    with tempfile.TemporaryDirectory(prefix='sb-upload-') as folder:
        path = Path(folder) / name
        path.write_bytes(data)
        loaded = _parse(path, name)

    logger.info(f"Read {name}: {len(loaded.events)} event(s)")
    return loaded


def census(rows: Sequence[Event]) -> Tuple[FileAccount, ...]:
    """Every account label the file names, with its volume, sorted (#835)."""
    volumes: Dict[str, int] = {}
    for event in rows:
        label = _label(event)
        volumes[label] = volumes.get(label, 0) + 1
    return tuple(FileAccount(name=name, rows=volumes[name])
                 for name in sorted(volumes))


def mapping(stated: Optional[str],
            declaring: Sequence[str] = ()) -> AccountMapping:
    """The correspondence a request carries, read once and judged for shape."""
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
        raise UploadRefused(
            f"{', '.join(both)} is both sent to a declared account and declared "
            f"itself; one account of the file takes one answer")
    return AccountMapping(targets=targets, declaring=wanted, stated=True)


def _label(event: Event) -> str:
    """The account an event names, as the **file** writes it — ``''`` for blank."""
    return (event.account or '').strip()


def receipt(filename: str, rows: Sequence[Event], *,
            written: int, duplicates: int,
            file_accounts: Tuple[FileAccount, ...] = ()) -> Receipt:
    """The receipt for one file, in the order a reader reads it."""
    days = sorted(event.date for event in rows if event.date)
    return Receipt(
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
        logger.warning(f"Refused {name}: {exc}")
        raise UploadRefused(str(exc).replace(str(path), name))
    except Exception as exc:
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
