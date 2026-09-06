"""The scheduler's last-pass records — the app's own runtime state (#668, #656)."""
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple


SCRAPE_WROTE = 'wrote'
SCRAPE_WRITE_FAILED = 'write_failed'
SCRAPE_CLOSED = 'closed'
SCRAPE_NO_PRICE = 'no_price'

BACKWARD = 'backward'
FORWARD = 'forward'
LATERAL = 'lateral'

DIRECTIONS = (BACKWARD, FORWARD, LATERAL)

TERMINAL_COMPLETE = 'complete'

TERMINAL_UNCONVERTIBLE = 'unconvertible'

SKIP_NO_SERIES = 'no_series'
SKIP_TOO_RECENT = 'too_recent'
SKIP_NO_BASE_CURRENCY = 'no_base_currency'
SKIP_NO_QUOTE_CURRENCY = 'no_quote_currency'
SKIP_NOTHING_TO_REPAIR = 'nothing_to_repair'
SKIP_UNIT_LEARNT = 'unit_learnt'
SKIP_WINDOW_TOO_SMALL = 'window_too_small'

INGEST_UPDATED = 'updated'
INGEST_UNCHANGED = 'unchanged'
INGEST_FAILED = 'failed'

PERF_RAN = 'ran'
PERF_FAILED = 'failed'


@dataclass(frozen=True)
class ScrapeRecord:
    """One symbol's last scrape pass (``_scrape_symbol``)."""

    symbol: str
    at: datetime
    market_state: Optional[str]
    closed: bool
    price_present: bool
    verdict: str
    failure_count: int
    next_delay: Optional[float]
    wrote: bool = False
    stale: bool = False
    error: Optional[str] = None


@dataclass(frozen=True)
class BackfillRecord:
    """One ``(symbol, direction)`` pass of the backfill job."""

    symbol: str
    direction: str
    at: datetime
    window: Optional[Tuple[datetime, datetime]] = None
    target: Optional[datetime] = None
    ceiling: Optional[datetime] = None
    anchor: Optional[datetime] = None
    oldest: Optional[datetime] = None
    newest: Optional[datetime] = None
    written: int = 0
    terminal: Optional[str] = None
    skipped: Optional[str] = None
    reason: Optional[str] = None
    failed: bool = False
    error: Optional[str] = None
    failures: int = 0


@dataclass(frozen=True)
class IngestRecord:
    """The last ingestion pass (``ingest``), global."""

    at: datetime
    outcome: str
    shares: Optional[int] = None
    events: Optional[int] = None
    error: Optional[str] = None


@dataclass(frozen=True)
class PerfRecord:
    """The last perf-recompute pass (``recompute_perf``), global."""

    at: datetime
    verdict: str
    error: Optional[str] = None
    horizons: Mapping[str, Optional[date]] = field(default_factory=dict)


class RuntimeRecorder:
    """The one place the four jobs publish to, and the only new state #668 adds."""

    def __init__(self):
        import threading

        self._lock = threading.Lock()
        self._scrape: Dict[str, ScrapeRecord] = {}
        self._backfill: Dict[Tuple[str, str], BackfillRecord] = {}
        self._ingest: Optional[IngestRecord] = None
        self._perf: Optional[PerfRecord] = None

    def record_scrape(self, record: ScrapeRecord) -> ScrapeRecord:
        """Publish one symbol's pass. N scrape threads reach this concurrently."""
        with self._lock:
            self._scrape[record.symbol] = record
        return record

    def record_backfill(self, record: BackfillRecord) -> BackfillRecord:
        """Publish one ``(symbol, direction)`` pass, folding ``failures``."""
        key = (record.symbol, record.direction)
        with self._lock:
            previous = self._backfill.get(key)
            carried = previous.failures if previous is not None else 0
            folded = replace(
                record, failures=carried + 1 if record.failed else 0)
            self._backfill[key] = folded
        return folded

    def record_ingest(self, record: IngestRecord) -> IngestRecord:
        with self._lock:
            self._ingest = record
        return record

    def record_perf(self, record: PerfRecord) -> PerfRecord:
        with self._lock:
            self._perf = record
        return record

    def forget_scrape(self, symbol: str) -> None:
        """Drop a departed symbol's **scrape** record, mirroring #617's cleanup."""
        with self._lock:
            self._scrape.pop(symbol, None)

    def retain(self, symbols: Iterable[str]) -> None:
        """Keep only the records of symbols the ledger still names."""
        keep = set(symbols)
        with self._lock:
            for symbol in [s for s in self._scrape if s not in keep]:
                del self._scrape[symbol]
            for key in [k for k in self._backfill if k[0] not in keep]:
                del self._backfill[key]

    def scrape_of(self, symbol: str) -> Optional[ScrapeRecord]:
        return self._scrape.get(symbol)

    def backfill_of(self, symbol: str,
                    direction: str) -> Optional[BackfillRecord]:
        return self._backfill.get((symbol, direction))

    def records_for(self, shares: Iterable[Mapping[str, Any]]) -> Tuple[
            Dict[str, Optional[ScrapeRecord]],
            Dict[Tuple[str, str], Optional[BackfillRecord]]]:
        """Every record the **snapshot's** symbols have, one ``get`` per key."""
        scrape: Dict[str, Optional[ScrapeRecord]] = {}
        backfill: Dict[Tuple[str, str], Optional[BackfillRecord]] = {}
        for share in shares:
            symbol = share.get('symbol')
            if not symbol or symbol in scrape:
                continue
            scrape[symbol] = self.scrape_of(symbol)
            for direction in DIRECTIONS:
                backfill[(symbol, direction)] = self.backfill_of(
                    symbol, direction)
        return scrape, backfill

    def ingest(self) -> Optional[IngestRecord]:
        return self._ingest

    def perf(self) -> Optional[PerfRecord]:
        return self._perf


__all__ = [
    'BACKWARD', 'FORWARD', 'LATERAL', 'DIRECTIONS',
    'SCRAPE_WROTE', 'SCRAPE_WRITE_FAILED', 'SCRAPE_CLOSED', 'SCRAPE_NO_PRICE',
    'TERMINAL_COMPLETE', 'TERMINAL_UNCONVERTIBLE',
    'SKIP_NO_SERIES', 'SKIP_TOO_RECENT', 'SKIP_WINDOW_TOO_SMALL',
    'SKIP_NO_BASE_CURRENCY', 'SKIP_NO_QUOTE_CURRENCY',
    'SKIP_NOTHING_TO_REPAIR', 'SKIP_UNIT_LEARNT',
    'INGEST_UPDATED', 'INGEST_UNCHANGED', 'INGEST_FAILED',
    'PERF_RAN', 'PERF_FAILED',
    'ScrapeRecord', 'BackfillRecord', 'IngestRecord', 'PerfRecord',
    'RuntimeRecorder',
]
