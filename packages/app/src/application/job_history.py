"""The jobs' recent passes, kept in process memory (issue #1236).

``RuntimeRecorder`` keeps the **last** record of each job; this keeps the last
24 hours of them, so the System page can tell a job that failed once from one
that has failed every pass since yesterday. Memory only: at a 10 s cadence a
write per pass would contend with the global writer (#972), and the page says
*since start* instead.

Each key holds 24 hourly slots (counts, summed duration, last error) and the 20
most recent passes in full. A per-pass cap could not hold 24 hours at every
cadence, which is why the slots exist at all.
"""
import logging
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Deque, Dict, Iterable, Iterator, List, Optional, Tuple

from application import instants

SCRAPE = 'scrape'
BACKFILL = 'backfill'
PERFORMANCE = 'performance'
INGESTION = 'ingestion'

OK = 'ok'
ATTENTION = 'attention'
ERROR = 'error'
IDLE = 'idle'

SLOTS = 24
RECENT = 20
MAX_LINES = 10
LINE_CHARS = 300

#: ``(job, symbol)`` — the symbol only for the scrape, which runs per symbol.
Key = Tuple[str, Optional[str]]


@dataclass
class Lines:
    """The WARNING-and-above lines one pass logged, bounded."""

    lines: List[Dict[str, str]] = field(default_factory=list)
    overflow: int = 0

    def add(self, record: logging.LogRecord) -> None:
        if len(self.lines) >= MAX_LINES:
            self.overflow += 1
            return
        self.lines.append({
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage()[:LINE_CHARS],
        })


class _Capture(logging.Handler):
    """A root handler that hands each record to the pass open on its thread.

    On the root because yfinance logs to its own logger. A line logged outside
    any pass, or on another thread, is not kept.

    A handler on the root also counts as *a handler was found*, which switches
    off ``logging.lastResort`` for every logger that has none of its own: their
    warnings would vanish from stderr. So a record no other handler takes is
    handed to ``lastResort`` here, as Python would have done.
    """

    def __init__(self):
        super().__init__(logging.WARNING)
        self.open: Dict[int, Lines] = {}

    def emit(self, record: logging.LogRecord) -> None:
        lines = self.open.get(threading.get_ident())
        if lines is not None:
            lines.add(record)
        last = logging.lastResort
        if last is None or record.levelno < last.level:
            return
        if not self._handled_elsewhere(record.name):
            last.handle(record)

    def _handled_elsewhere(self, name: str) -> bool:
        logger: Optional[logging.Logger] = logging.getLogger(name)
        while logger is not None:
            if any(handler is not self for handler in logger.handlers):
                return True
            if not logger.propagate:
                return False
            logger = logger.parent
        return False


_capture = _Capture()
logging.getLogger().addHandler(_capture)


@contextmanager
def capturing() -> Iterator[Lines]:
    """Collect what this thread logs at WARNING and above until the block ends."""
    ident = threading.get_ident()
    previous = _capture.open.get(ident)
    lines = Lines()
    _capture.open[ident] = lines
    try:
        yield lines
    finally:
        if previous is None:
            _capture.open.pop(ident, None)
        else:
            _capture.open[ident] = previous


@dataclass
class Slot:
    passes: int = 0
    errors: int = 0
    attentions: int = 0
    idles: int = 0
    duration: float = 0.0
    last_error: Optional[str] = None
    last_error_at: Optional[datetime] = None


@dataclass(frozen=True)
class Pass:
    at: datetime
    duration: float
    outcome: str
    error: Optional[str]
    lines: Tuple[Dict[str, str], ...] = ()
    overflow: int = 0


@dataclass
class _Track:
    slots: Dict[datetime, Slot] = field(default_factory=dict)
    recent: Deque[Pass] = field(default_factory=lambda: deque(maxlen=RECENT))


def _hour(at: datetime) -> datetime:
    return instants.utc(at).replace(minute=0, second=0, microsecond=0)


class JobHistory:
    """Every job's last 24 hours, one lock, no store."""

    def __init__(self, now: Optional[datetime] = None):
        self.started = now or datetime.now(timezone.utc)
        self._lock = threading.Lock()
        self._tracks: Dict[Key, _Track] = {}

    def record(self, job: str, symbol: Optional[str], one: Pass) -> None:
        hour = _hour(one.at)
        oldest = hour - timedelta(hours=SLOTS - 1)
        with self._lock:
            track = self._tracks.setdefault((job, symbol), _Track())
            for stale in [h for h in track.slots if h < oldest]:
                del track.slots[stale]
            slot = track.slots.setdefault(hour, Slot())
            slot.passes += 1
            slot.duration += one.duration
            if one.outcome == ERROR:
                slot.errors += 1
                slot.last_error, slot.last_error_at = one.error, one.at
            elif one.outcome == ATTENTION:
                slot.attentions += 1
            elif one.outcome == IDLE:
                slot.idles += 1
            track.recent.append(one)

    def forget(self, symbol: str) -> None:
        """Drop a departed symbol's scrape history, with its record."""
        with self._lock:
            self._tracks.pop((SCRAPE, symbol), None)

    def retain(self, symbols: Iterable[str]) -> None:
        keep = set(symbols)
        with self._lock:
            for key in [k for k in self._tracks
                        if k[0] == SCRAPE and k[1] not in keep]:
                del self._tracks[key]

    def read(self, now: datetime) -> Dict[str, Any]:
        """The 24 hours ending at ``now``'s hour, aged on read and never written."""
        current = _hour(now)
        hours = [current - timedelta(hours=SLOTS - 1 - i) for i in range(SLOTS)]
        with self._lock:
            tracks = {key: (dict(track.slots), list(track.recent))
                      for key, track in self._tracks.items()}

        def view(key: Key, lines: bool = True) -> Dict[str, Any]:
            slots, recent = tracks.get(key, ({}, []))
            return {
                'slots': [_slot_dict(hour, slots.get(hour)) for hour in hours],
                'passes': [_pass_dict(one, lines) for one in reversed(recent)
                           if one.at >= hours[0]],
                # Out of the window too: the ingestion runs at boot and on a
                # write, so a quiet day would otherwise read as *never ran*.
                'last': _pass_dict(recent[-1], lines) if recent else None,
            }

        symbols = sorted(symbol for job, symbol in tracks if job == SCRAPE)
        merged = sorted(
            ((symbol, one) for symbol in symbols
             for one in tracks[(SCRAPE, symbol)][1] if one.at >= hours[0]),
            key=lambda pair: pair[1].at, reverse=True)[:RECENT]

        return {
            'now': instants.iso(now),
            'started': instants.iso(self.started),
            'jobs': {
                job: view((job, None))
                for job in (BACKFILL, PERFORMANCE, INGESTION)},
            # Per symbol without the log lines: a symbol failing every pass
            # would carry 20 × 10 of them to each poll. The lines ride on the
            # scrape's 20 newest passes, all symbols mixed, which is what the
            # job's own strip opens.
            'scrape': {symbol: view((SCRAPE, symbol), lines=False)
                       for symbol in symbols},
            'scrape_recent': [{**_pass_dict(one), 'symbol': symbol}
                              for symbol, one in merged],
        }


def _slot_dict(hour: datetime, slot: Optional[Slot]) -> Dict[str, Any]:
    slot = slot or Slot()
    return {
        'hour': instants.iso(hour),
        'passes': slot.passes,
        'errors': slot.errors,
        'attentions': slot.attentions,
        'idles': slot.idles,
        'duration': slot.duration,
        'last_error': slot.last_error,
        'last_error_at': instants.iso(slot.last_error_at),
    }


def _pass_dict(one: Pass, lines: bool = True) -> Dict[str, Any]:
    return {
        'at': instants.iso(one.at),
        'duration': one.duration,
        'outcome': one.outcome,
        'error': one.error,
        'lines': list(one.lines) if lines else [],
        'overflow': one.overflow if lines else 0,
    }


class Run:
    """One pass in progress: the caller settles its outcome before it ends."""

    def __init__(self):
        self.outcome = OK
        self.error: Optional[str] = None

    def settle(self, outcome: str, error: Optional[str] = None) -> None:
        self.outcome, self.error = outcome, error


@contextmanager
def timed(history: JobHistory, job: str,
          symbol: Optional[str] = None) -> Iterator[Run]:
    """Time one pass, capture its log lines, and record it — raising or not."""
    run = Run()
    at = datetime.now(timezone.utc)
    started = time.monotonic()
    with capturing() as lines:
        try:
            yield run
        except BaseException as exc:
            run.settle(ERROR, f"{type(exc).__name__}: {exc}")
            raise
        finally:
            history.record(job, symbol, Pass(
                at=at, duration=time.monotonic() - started,
                outcome=run.outcome, error=run.error,
                lines=tuple(lines.lines), overflow=lines.overflow))


__all__ = [
    'SCRAPE', 'BACKFILL', 'PERFORMANCE', 'INGESTION',
    'OK', 'ATTENTION', 'ERROR', 'IDLE',
    'SLOTS', 'RECENT', 'MAX_LINES', 'LINE_CHARS',
    'Lines', 'capturing', 'Slot', 'Pass', 'JobHistory', 'Run', 'timed',
]
