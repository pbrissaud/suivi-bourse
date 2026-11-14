"""The journal: what the process logged, kept to be read back (``GET /api/logs``).

A ring of the last :data:`CAPACITY` records on the root logger, beside a file
log rotated at midnight that keeps :data:`KEEP_DAYS` days. The ring answers the
page; the file is what the download hands over.
"""
import itertools
import logging
import threading
from collections import deque
from datetime import datetime, timezone
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from typing import Any, Deque, Dict, Iterator, List, Optional, Tuple

from logfmt_logger import LogfmtFormatter

from application import instants

CAPACITY = 5000
KEEP_DAYS = 7
LIMIT = 1000
LOG_NAME = 'suivi-bourse.log'

#: A minimum severity, as the page's filter names it.
LEVELS = {'debug': logging.DEBUG, 'info': logging.INFO,
          'warning': logging.WARNING, 'error': logging.ERROR}

#: The job a record belongs to, off the module that logged it; the one
#: ``suivi_bourse`` logger is shared by every job, so its name cannot say.
_MODULE_JOBS = {'scrape': 'scrape', 'backfill': 'backfill',
                'performance': 'performance', 'ingestion': 'ingestion',
                'perf_series': 'performance'}
JOBS = ('scrape', 'backfill', 'performance', 'ingestion', 'system')


def job_of(record: logging.LogRecord) -> str:
    named = record.name.rsplit('.', 1)[-1]
    return _MODULE_JOBS.get(record.module, _MODULE_JOBS.get(named, 'system'))


def level_of(levelno: int) -> str:
    """The page's words: critical reads as an error."""
    return ('error' if levelno >= logging.ERROR else
            'warning' if levelno >= logging.WARNING else
            'info' if levelno >= logging.INFO else 'debug')


class Ring(logging.Handler):
    """The last :data:`CAPACITY` records, each stamped with a sequence number."""

    #: Not a destination: ``job_history`` must still hand an otherwise
    #: unhandled record to ``logging.lastResort``.
    passive = True

    def __init__(self, capacity: int = CAPACITY):
        super().__init__()
        self._rows: Deque[Dict[str, Any]] = deque(maxlen=capacity)
        self._seq = itertools.count(1)
        self._guard = threading.Lock()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            detail = (logging.Formatter().formatException(record.exc_info)
                      if record.exc_info else None)
            row = {
                'time': instants.iso(datetime.fromtimestamp(
                    record.created, timezone.utc)),
                'level': level_of(record.levelno),
                'job': job_of(record),
                'message': record.getMessage(),
                'detail': detail,
            }
        except Exception:
            self.handleError(record)
            return
        with self._guard:
            self._rows.append({**row, 'seq': next(self._seq)})

    def select(self, level: Optional[str] = None, job: Optional[str] = None,
               since: Optional[datetime] = None, q: Optional[str] = None,
               cursor: int = 0, limit: int = LIMIT
               ) -> Tuple[List[Dict[str, Any]], int]:
        """Newest first; ``cursor`` is the last ``seq`` the caller has seen."""
        floor = LEVELS.get((level or '').lower(), 0)
        needle = (q or '').lower()
        since_iso = instants.iso(since) if since else None
        with self._guard:
            rows = list(self._rows)
        last = rows[-1]['seq'] if rows else cursor
        picked = []
        for row in reversed(rows):
            if row['seq'] <= cursor:
                break
            if LEVELS.get(row['level'], logging.CRITICAL) < floor:
                continue
            if job and row['job'] != job:
                continue
            if since_iso and row['time'] < since_iso:
                continue
            if needle and needle not in (
                    row['message'] + ' ' + (row['detail'] or '')).lower():
                continue
            picked.append({k: v for k, v in row.items() if k != 'seq'})
            if len(picked) >= limit:
                break
        return picked, last


RING = Ring()
_file: Optional[logging.Handler] = None


def install(directory: Optional[Path] = None) -> None:
    """Hang the ring (once) and the file log (replacing any earlier) on the root."""
    global _file
    root = logging.getLogger()
    if RING not in root.handlers:
        root.addHandler(RING)
    if _file is not None:
        root.removeHandler(_file)
        _file.close()
        _file = None
    if directory is None:
        return
    directory.mkdir(parents=True, exist_ok=True)
    _file = TimedRotatingFileHandler(
        directory / LOG_NAME, when='midnight', backupCount=KEEP_DAYS - 1,
        encoding='utf-8')
    _file.setFormatter(LogfmtFormatter())
    _file.passive = True
    root.addHandler(_file)


def files(directory: Path) -> List[Path]:
    """The kept log files, oldest first."""
    return sorted(directory.glob(LOG_NAME + '*'),
                  key=lambda path: path.stat().st_mtime)


def stream(directory: Path) -> Iterator[bytes]:
    for path in files(directory):
        with path.open('rb') as handle:
            yield from iter(lambda: handle.read(65536), b'')
