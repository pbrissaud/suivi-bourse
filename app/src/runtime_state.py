"""The scheduler's last-pass records — the app's own runtime state (#668, #656).

Everything the four scheduled jobs know and nothing else does. #656's inventory
found that **9 of 13 state items are already reachable from a request thread**;
this module holds only the four that are not, and the shape it holds them in is
the whole design:

* **One writer, of one shape** (déc. 1). Each job ends its pass by publishing an
  immutable *last-pass record*, rather than instrumentation sprinkled at ten
  sites. One line per job.
* **Publish only what has no home** (déc. 2). No copy of ``_failure_counts``, of
  ``_backfill_complete`` or of ``_share_info_cache`` lives here. A second copy is
  the bug #658 removed when ``SuiviBourseMetrics.shares`` became a *property*,
  and it would be quieter here — a pill showing a backoff the scheduler no longer
  has signals nothing at all.
* **The dated record is the unit of coherence** (déc. 4). A composed read takes
  ``_failure_counts['ASML'] == 5`` at *t* and ``next_run_time`` at *t+ε* reading
  *t+120 s*, because the job just succeeded and re-armed at the base cadence; a
  pill deriving "dead ticker, next attempt in 4 h" from those two is wrong twice
  over. ``scheduling.decide`` handed the job verdict, delay and counter in **one
  call** — so the verdict is computed there, at the instant it is true, and
  travels in the record. **The reader reports observations; it never derives a
  verdict across two items.**
* **Granularity is the job's, not the screen's** (déc. 5): per symbol for scrape,
  per ``(symbol, account, direction)`` for backfill, global for ingest and perf.

Two rules for anyone adding a call site:

**The lock never covers a fetch or a query** (déc. 3). Every method below takes
it for the duration of a dict assignment and nothing more; the record is built by
the caller, *before* the call, out of values it already holds.

**Readers never iterate.** ``dict[key] = value`` and ``dict.get(key)`` are atomic
under the GIL, but copying or iterating a dict another thread mutates raises
``RuntimeError: dictionary changed size during iteration`` — the kind of crash
that only happens in production with forty symbols. So the read path takes the
row set from the **configuration snapshot** and does one ``get`` per key, which
is #661's "the declaration drives" and gives the right answer for free: a symbol
the scheduler has not touched yet is an *unknown* cell, not a missing row. The
two methods that do iterate (:meth:`forget_symbol`, :meth:`backfill_of_symbol`)
hold the lock while they do it.
"""
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Dict, List, Optional, Tuple

# --------------------------------------------------------------------- #
# Vocabulary. Every constant below is a value a *job* writes, never one a
# reader infers — that is decision 4 expressed as a naming rule.
# --------------------------------------------------------------------- #

#: One scrape pass's verdict, as ``scheduling.decide`` and the write path saw it.
SCRAPE_WROTE = 'wrote'
#: Fetched fine, InfluxDB refused. Worth its own value because **#617's counter
#: does not see it**: ``decide`` resets the counter whenever a price was present,
#: so a database outage leaves a symbol polling happily at ``base_interval`` and
#: persisting nothing. The dead-ticker guard is about yfinance, by design.
SCRAPE_WRITE_FAILED = 'write_failed'
#: A recognised closed-family state — slept to the next open. Never a failure.
SCRAPE_CLOSED = 'closed'
#: Not closed, no writable price: #617's definition of a failure.
SCRAPE_NO_PRICE = 'no_price'

#: The two backfill passes, which are independent (#626) and therefore keyed
#: apart: a completed backward watermark never suppresses the forward pass.
BACKWARD = 'backward'
FORWARD = 'forward'

#: The three terminal states of the backward pass, which **must not be
#: collapsed** (#656 trap 6). Manual mode has no backward pass at all
#: (``backfill()`` returns early), so "no progress" there is nominal — rendering
#: it as a stall would be the app accusing itself of a fault it does not have.
TERMINAL_COMPLETE = 'complete'
TERMINAL_NO_BUY = 'no_buy'
TERMINAL_MANUAL_MODE = 'manual_mode'

#: The forward pass's no-op reasons. ``SKIP_TOO_RECENT`` is the *normal* one
#: during live trading: ``newest ≈ now``, the window is sub-day, and the pass
#: stands aside so the ``REGULAR`` writer stays the sole writer of the present.
SKIP_NO_SERIES = 'no_series'
SKIP_TOO_RECENT = 'too_recent'
#: Shared by both passes: a window under a day, or no share info to tag with.
SKIP_WINDOW_TOO_SMALL = 'window_too_small'
SKIP_NO_SHARE_INFO = 'no_share_info'

#: What one ingestion pass did. ``INGEST_FAILED`` is the one that is invisible
#: today anywhere but the log, and it is the reason this record exists: the app
#: goes on running on its previous configuration, correctly and silently.
INGEST_UPDATED = 'updated'
INGEST_UNCHANGED = 'unchanged'
INGEST_FAILED = 'failed'

#: The perf job's verdict — ``scheduling.perf_should_run``'s answer, recorded
#: rather than inferred: ``_perf_dirty_live`` is *consumed* by its reader
#: (#656 trap 4), so a request thread reading it learns about a pending run and
#: nothing about the last one.
PERF_RAN = 'ran'
PERF_SKIPPED = 'skipped'
PERF_FAILED = 'failed'


@dataclass(frozen=True)
class ScrapeRecord:
    """One symbol's last scrape pass (``_scrape_symbol``).

    ``market_state`` is what **this cycle** read, and ``closed`` is what
    ``scheduling.decide`` acted on — two fields rather than one, and the split is
    #656 traps 2 and 3 made structural:

    * ``decide`` **fail-opens** an unrecognised state to ``REGULAR`` while
      ``_share_info_cache`` keeps yfinance's raw value, so the cache and the
      behaviour disagree by construction;
    * the cache is written **only on a successful fetch** (``main.py``'s
      ``_fetch_ticker_data``), so a symbol whose fetch keeps failing goes on
      reporting the market state from *before* its failure — precisely the case a
      pill exists to show.

    So neither is read from the cache. ``market_state`` is ``None`` when the
    fetch failed, which is the honest answer and not a state.
    """

    symbol: str
    at: datetime
    market_state: Optional[str]
    closed: bool
    price_present: bool
    verdict: str
    #: #617's counter **after** the decision, straight out of the same
    #: ``decide`` call that produced ``verdict`` and ``next_delay``.
    failure_count: int
    next_delay: Optional[float]
    #: The accounts a point was actually persisted for, and the ones #628's
    #: sonde flagged. Per account because the sonde is, and because a symbol can
    #: be stale in one account and fresh in another.
    accounts_written: Tuple[str, ...] = ()
    stale_accounts: Tuple[str, ...] = ()
    error: Optional[str] = None


@dataclass(frozen=True)
class BackfillRecord:
    """One ``(symbol, account, direction)`` pass of the backfill job.

    ``failures`` is the piece with **no equivalent anywhere in the app today**:
    ``_backfill_backward`` logs a warning and returns ``0``, so nothing
    distinguishes "pacing normally" from "wedged on yfinance" — the question that
    made #656 grow in the first place. It is a *consecutive* counter, folded by
    :meth:`RuntimeRecorder.record_backfill` under the lock, and it is the
    backfill's equivalent of #617's counter rather than a copy of it.

    ``oldest`` is the oldest stored point **as observed at the start of this
    pass**, so a bar drawn from it lags the chunk this very pass wrote by one
    cycle. That is deliberate: a record is a dated observation, and advancing it
    to where the write is *expected* to have landed would be a claim. ``at`` is
    carried so the lag is visible rather than hidden.
    """

    symbol: str
    account: str
    direction: str
    at: datetime
    window: Optional[Tuple[datetime, datetime]] = None
    #: The backward pass's target — the first BUY. ``None`` in manual mode and
    #: for a symbol with no BUY event.
    target: Optional[datetime] = None
    oldest: Optional[datetime] = None
    #: The forward pass's anchor: the newest stored point it measured from.
    newest: Optional[datetime] = None
    written: int = 0
    terminal: Optional[str] = None
    skipped: Optional[str] = None
    #: Whether this pass counts against the consecutive-failure counter. A fetch
    #: that came back empty is **not** a failure — an empty window is how a
    #: weekend classifies itself (#606), and counting it would make every Monday
    #: morning look wedged.
    failed: bool = False
    error: Optional[str] = None
    #: Filled by the recorder, never by the caller.
    failures: int = 0


@dataclass(frozen=True)
class IngestRecord:
    """The last ingestion pass (``ingest``), global.

    ``INGEST_FAILED`` carries ``error`` and means the app is running on its
    *previous* configuration — a state that is correct by construction since #658
    and completely silent outside the log.
    """

    at: datetime
    outcome: str
    shares: Optional[int] = None
    events: Optional[int] = None
    error: Optional[str] = None


@dataclass(frozen=True)
class PerfRecord:
    """The last perf-recompute pass (``recompute_perf``), global.

    The record carries **the three inputs of** ``scheduling.perf_should_run``
    rather than a single "reason", and that is the honest shape: a skip happens
    when all three are quiet, so "which reason it skipped for" only answers if
    the three are shown. A run names the one(s) that fired; a skip names three
    conditions that did not. Reducing them to one string would be the reader
    inventing a verdict, which is the one thing #656 déc. 4 forbids.
    """

    at: datetime
    verdict: str
    events_changed: bool = False
    backfill_pending: bool = False
    live_write: bool = False
    error: Optional[str] = None


class RuntimeRecorder:
    """The one place the four jobs publish to, and the only new state #668 adds.

    Created **master-side**, beside ``ConfigWriter`` and for the same reason: it
    is a mutex and three references, and a ``threading.Lock`` crosses ``fork()``
    unharmed because the master is single-threaded at that instant. Building it
    there rather than in ``start_runtime`` is what lets ``GET /api/runtime``
    answer before the scheduler has started — and answering *while nothing works*
    is the entire point of the resource (#656 déc. 6).
    """

    def __init__(self):
        # Imported here rather than at module scope so the record dataclasses
        # above stay importable by a pure test with no threading in sight.
        import threading

        self._lock = threading.Lock()
        self._scrape: Dict[str, ScrapeRecord] = {}
        self._backfill: Dict[Tuple[str, str, str], BackfillRecord] = {}
        self._ingest: Optional[IngestRecord] = None
        self._perf: Optional[PerfRecord] = None

    # ------------------------------------------------------------------ #
    # Writes — one per job, at the end of its pass
    # ------------------------------------------------------------------ #

    def record_scrape(self, record: ScrapeRecord) -> ScrapeRecord:
        """Publish one symbol's pass. N scrape threads reach this concurrently."""
        with self._lock:
            self._scrape[record.symbol] = record
        return record

    def record_backfill(self, record: BackfillRecord) -> BackfillRecord:
        """Publish one ``(symbol, account, direction)`` pass, folding ``failures``.

        The fold is a read-modify-write, which is why it happens here rather than
        at the call site: two backfill passes of the same series never overlap
        today (one job, sequential), but a counter whose increment lives outside
        the lock is a bug waiting for the day that stops being true.
        """
        key = (record.symbol, record.account, record.direction)
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

    def forget_symbol(self, symbol: str) -> None:
        """Drop a departed symbol's records, mirroring #617's counter cleanup.

        Invisible to a reader either way — the row set comes from the snapshot,
        so a record nobody asks for is never rendered — but a process running for
        months through many portfolio edits would otherwise accumulate them, and
        #597 is already this app's story of a structure that grew without bound.

        Iterating the backfill keys is safe **because it holds the lock**: this
        is a writer, and the rule the module states is that *readers* never
        iterate.
        """
        with self._lock:
            self._scrape.pop(symbol, None)
            for key in [k for k in self._backfill if k[0] == symbol]:
                del self._backfill[key]

    # ------------------------------------------------------------------ #
    # Reads — one get per key, driven by the configuration snapshot
    # ------------------------------------------------------------------ #

    def scrape_of(self, symbol: str) -> Optional[ScrapeRecord]:
        return self._scrape.get(symbol)

    def backfill_of(self, symbol: str, account: str,
                    direction: str) -> Optional[BackfillRecord]:
        return self._backfill.get((symbol, account, direction))

    def backfill_of_symbol(self, symbol: str) -> List[BackfillRecord]:
        """Every stored backfill pass of one symbol, across accounts.

        The one read that cannot be expressed as "one get per key" — the request
        knows the symbol but not which accounts the *scheduler* has seen, which
        may lag the snapshot by a cycle after an edit. It takes the lock and
        materialises a list rather than yielding, so the caller never holds a
        cursor into a dict the backfill thread is writing.
        """
        with self._lock:
            return [r for k, r in self._backfill.items() if k[0] == symbol]

    def ingest(self) -> Optional[IngestRecord]:
        return self._ingest

    def perf(self) -> Optional[PerfRecord]:
        return self._perf


__all__ = [
    'BACKWARD', 'FORWARD',
    'SCRAPE_WROTE', 'SCRAPE_WRITE_FAILED', 'SCRAPE_CLOSED', 'SCRAPE_NO_PRICE',
    'TERMINAL_COMPLETE', 'TERMINAL_NO_BUY', 'TERMINAL_MANUAL_MODE',
    'SKIP_NO_SERIES', 'SKIP_TOO_RECENT', 'SKIP_WINDOW_TOO_SMALL',
    'SKIP_NO_SHARE_INFO',
    'INGEST_UPDATED', 'INGEST_UNCHANGED', 'INGEST_FAILED',
    'PERF_RAN', 'PERF_SKIPPED', 'PERF_FAILED',
    'ScrapeRecord', 'BackfillRecord', 'IngestRecord', 'PerfRecord',
    'RuntimeRecorder',
]
