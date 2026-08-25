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
  per ``(symbol, direction)`` for backfill, global for ingest and perf. Both were
  per ``(symbol, account)`` until #700 took the account dimension off the price
  series — a job that now runs **once per symbol** would have published N
  identical records, one per account, and a page would have drawn N identical
  bars for one piece of work.

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
one method that does iterate (:meth:`RuntimeRecorder.retain`) holds the lock
while it does.
"""
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple

# --------------------------------------------------------------------- #
# Vocabulary. Every constant below is a value a *job* writes, never one a
# reader infers — that is decision 4 expressed as a naming rule.
# --------------------------------------------------------------------- #

#: One scrape pass's verdict, as ``scheduling.decide`` and the write path saw it.
SCRAPE_WROTE = 'wrote'
#: Fetched fine, the store refused. Worth its own value because **#617's counter
#: does not see it**: ``decide`` resets the counter whenever a price was present,
#: so a refused write leaves a symbol polling happily at ``base_interval`` and
#: persisting nothing. The dead-ticker guard is about yfinance, by design.
SCRAPE_WRITE_FAILED = 'write_failed'
#: A recognised closed-family state — slept to the next open. Never a failure.
SCRAPE_CLOSED = 'closed'
#: Not closed, no writable price: #617's definition of a failure.
SCRAPE_NO_PRICE = 'no_price'

#: The **three** backfill passes, independent (#626, #704) and therefore keyed
#: apart: a completed backward watermark never suppresses the forward pass, and
#: neither of them says anything about a conversion that is still missing.
#: :data:`LATERAL` joined them as *one more direction* rather than as a record of
#: its own, which is the whole of what "it rides on the backfill" buys — the
#: recorder, the fold of consecutive failures, the retention on a forgotten
#: import and the payload's shape all come for free.
BACKWARD = 'backward'
FORWARD = 'forward'
LATERAL = 'lateral'

#: The three, in one tuple, because a reader has to fetch one record per
#: direction and a hand-written pair at that call site is exactly what left the
#: lateral pass invisible on ``/api/runtime`` when it landed. Adding a direction
#: is adding it here.
DIRECTIONS = (BACKWARD, FORWARD, LATERAL)

#: The backward pass's **one** terminal state: there is nothing left to fetch.
#: It had two others and both lost their subject. ``manual_mode`` left with the
#: mode it named (#711); ``no_buy`` — "this symbol was never bought" — became
#: unreachable at #703, where the target became the first **acquisition**,
#: ``GRANT`` included. A position with neither a ``BUY`` nor a ``GRANT`` cannot
#: carry a positive quantity, so it has no holding window and never enters the
#: backfill's set at all: the state is not renamed, it has no instances.
TERMINAL_COMPLETE = 'complete'

#: The lateral pass's terminal, and the fourth of the family (issue #704): the
#: currency pair a symbol's conversion needs **does not resolve**. It is a reply
#: and never a failure — yfinance completed the request and answered that
#: ``XYZEUR=X`` is not a ticker — which is exactly why it is a terminal rather
#: than a counter: *"waiting for a conversion"* and *"will never convert"* are
#: two different sentences, and only the second asks the owner to do something.
#: The record carries ``reason`` beside it, because a terminal with no pair named
#: leaves a reader in front of an empty column with no explanation.
TERMINAL_UNCONVERTIBLE = 'unconvertible'

#: The forward pass's no-op reasons. ``SKIP_TOO_RECENT`` is the *normal* one
#: during live trading: ``newest ≈ now``, the window is sub-day, and the pass
#: stands aside so the ``REGULAR`` writer stays the sole writer of the present.
SKIP_NO_SERIES = 'no_series'
SKIP_TOO_RECENT = 'too_recent'
#: The lateral pass's three no-ops, and two of them are the reason it has skips
#: at all rather than terminals (issue #704):
#:
#: * ``SKIP_NO_BASE_CURRENCY`` — the reporting currency is unanswered, so every
#:   ``price_converted`` in the store is ``NULL`` and **none of them is a pair
#:   that failed**. The absence is transitory and lifted by a write of the
#:   owner's; arming ``unconvertible`` here would make answering the dial change
#:   nothing for the whole stock already scraped, which is the trap the ticket
#:   writes down in black and white.
#: * ``SKIP_NO_QUOTE_CURRENCY`` — the *security's* currency is unknown **and
#:   asking for it answered nothing** (issue #773). It used to mean the weaker
#:   *nobody has asked*, which covered a line sold before the install existed —
#:   never polled by the live scrape (#699), fully reconstructed by the backfill
#:   (ADR-0009), and so quoted for years in a unit the app had no path left to
#:   learn. The pass now asks, once per symbol; what is left under this key is
#:   the reply *Yahoo names no currency for this*, which is durable, is not a
#:   failure, and still never arms ``unconvertible`` — there is no pair yet.
#: * ``SKIP_NOTHING_TO_REPAIR`` — the steady state: every point carries its
#:   conversion.
SKIP_NO_BASE_CURRENCY = 'no_base_currency'
SKIP_NO_QUOTE_CURRENCY = 'no_quote_currency'
SKIP_NOTHING_TO_REPAIR = 'nothing_to_repair'
#: The backward pass's own: a window under a day, which is what a chunk boundary
#: landing inside a single trading session leaves.
#:
#: ``no_share_info`` left with #700 and is worth a line because its *subject*
#: left, not its handling: a historical point used to need the symbol's currency
#: and exchange, since those were InfluxDB **tags** and a point written without
#: them landed in a different series than its own live points. In the store they
#: are columns of ``symbol_quote``, written by the scrape and joined at read
#: time, so a backfill needs nothing from yfinance but the prices.
SKIP_WINDOW_TOO_SMALL = 'window_too_small'

#: What one ingestion pass did. ``INGEST_FAILED`` is the one that is invisible
#: today anywhere but the log, and it is the reason this record exists: the app
#: goes on running on its previous configuration, correctly and silently.
INGEST_UPDATED = 'updated'
INGEST_UNCHANGED = 'unchanged'
INGEST_FAILED = 'failed'

#: The perf job's verdict, and since #707 it has **two** values rather than
#: three: the recompute is integral and unconditional, so a cycle either laid the
#: cache down or failed trying. ``PERF_SKIPPED`` left with
#: ``scheduling.perf_should_run`` — with no gate there is no third outcome to
#: report, and keeping the name would have left the page a state nothing can
#: reach.
PERF_RAN = 'ran'
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
    #: Whether the point landed, and whether #628's sonde flagged the series.
    #: Both were tuples of account ids until #700: a symbol could be stale in one
    #: account and fresh in another because the *series* was per account. It is
    #: not any more — one market observation, one row — so the two questions have
    #: one answer each.
    wrote: bool = False
    stale: bool = False
    error: Optional[str] = None


@dataclass(frozen=True)
class BackfillRecord:
    """One ``(symbol, direction)`` pass of the backfill job.

    ``failures`` is the piece with **no equivalent anywhere in the app today**:
    ``_backfill_backward`` logs a warning and returns ``0``, so nothing
    distinguishes "pacing normally" from "wedged on yfinance" — the question that
    made #656 grow in the first place. It is a *consecutive* counter, folded by
    :meth:`RuntimeRecorder.record_backfill` under the lock, and it is the
    backfill's equivalent of #617's counter rather than a copy of it.

    The key lost its ``account`` with #700, and so did the pass: a price series
    is per symbol, so a per-account backfill would have fetched the same window
    from Yahoo once per account holding the share.

    ``oldest`` is the oldest stored point **as observed at the start of this
    pass**, so a bar drawn from it lags the chunk this very pass wrote by one
    cycle. That is deliberate: a record is a dated observation, and advancing it
    to where the write is *expected* to have landed would be a claim. ``at`` is
    carried so the lag is visible rather than hidden.
    """

    symbol: str
    direction: str
    at: datetime
    window: Optional[Tuple[datetime, datetime]] = None
    #: The backward pass's target — the first **acquisition**, ``BUY`` or
    #: ``GRANT`` (issue #703). Never ``None`` on a backward record: a symbol
    #: with no acquisition has no holding window and no backfill at all.
    target: Optional[datetime] = None
    #: The top of the holding window the backward pass walks down from — the day
    #: after the last exit, or *now* while the position is still held (issue
    #: #703). It rides on the record because it is the **denominator** of the
    #: progress bar: measuring against ``now`` on a line sold in 2022 counts
    #: four years nobody held as history left to fetch, and reports 0,82 where
    #: the pass has covered 0,46. A reader cannot correct that from the outside,
    #: which is why it is published rather than recomputed.
    ceiling: Optional[datetime] = None
    #: Where the pass **resumes from** — ``_backward_anchor``'s answer, the
    #: minimum of the ceiling, the oldest stored point and the oldest window
    #: tried. It is the bar's numerator, and it is not ``oldest`` since #703
    #: parted the two: on a symbol Yahoo answers nothing about for its early
    #: windows, the stored point never moves while the anchor descends a chunk
    #: a cycle, so a bar drawn from ``oldest`` freezes and then jumps to 1,0 at
    #: the terminal. ``None`` on a record from before this field existed, where
    #: ``oldest`` is the honest fallback.
    anchor: Optional[datetime] = None
    #: The oldest **stored** point, reported rather than decided upon: it is
    #: what the series actually holds, which is a different question from where
    #: the pass has got to, and the sheet shows both.
    oldest: Optional[datetime] = None
    #: The forward pass's anchor: the newest stored point it measured from.
    newest: Optional[datetime] = None
    written: int = 0
    terminal: Optional[str] = None
    skipped: Optional[str] = None
    #: Why a terminal was reached, in one sentence, when the terminal alone does
    #: not say it (issue #704). ``complete`` needs none — it is the conclusion of
    #: a pass whose target is on the record already — while ``unconvertible``
    #: names the pair that does not resolve: the owner is being asked to act, and
    #: a state word with no subject is an empty line with no explanation.
    #: Deliberately **not** ``error``: a reply is not a failure, and
    #: :func:`runtime_view.build_errors` folds ``error`` into the page's error
    #: list, where this does not belong.
    reason: Optional[str] = None
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

    It carried **the three inputs of** ``scheduling.perf_should_run`` beside the
    verdict, because a skip *was* the three of them being quiet and naming a
    single "reason" would have been the reader inventing one. The gate is gone
    (issue #707), and so are they: there is no longer a decision to explain, only
    a pass that ran — every cycle, in full — or raised. What is left is the same
    shape every other record has, an observation and its date.

    ``horizons`` is the one thing this record grew back (issue #708), and it obeys
    decision 2 — *publish only what has no home*. The perf **horizon** of an
    account is ``1 + max over s of min(oldest price(s) − 1, last held day(s))``,
    computed inside the recompute and written down nowhere: the rows say where a
    series *starts*, which is a different question the moment an account's first
    activity is later than its horizon. ``None`` for an account nothing
    constrains, and an **empty mapping** for a pass that failed or that ran
    before a reporting currency was answered — never a stale copy of the previous
    one, since it would then read as *this* pass's answer.
    """

    at: datetime
    verdict: str
    error: Optional[str] = None
    horizons: Mapping[str, Optional[date]] = field(default_factory=dict)


class RuntimeRecorder:
    """The one place the four jobs publish to, and the only new state #668 adds.

    Created **master-side**, beside ``ConfigurationManager`` and for the same reason: it
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
        self._backfill: Dict[Tuple[str, str], BackfillRecord] = {}
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
        """Publish one ``(symbol, direction)`` pass, folding ``failures``.

        The fold is a read-modify-write, which is why it happens here rather than
        at the call site: two backfill passes of the same series never overlap
        today (one job, sequential), but a counter whose increment lives outside
        the lock is a bug waiting for the day that stops being true.
        """
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
        """Drop a departed symbol's **scrape** record, mirroring #617's cleanup.

        Called when the per-symbol scrape job leaves, which since #703 is no
        longer the same event as leaving the ledger: a position sold out stops
        being polled and goes on being *reconstructed*, so taking its backfill
        records away here would blank the progress of the very pass that is still
        running — and no future event would ever bring them back.
        """
        with self._lock:
            self._scrape.pop(symbol, None)

    def retain(self, symbols: Iterable[str]) -> None:
        """Keep only the records of symbols the ledger still names.

        The counterpart of :meth:`forget_scrape`: what takes a *backfill* record
        away is the symbol leaving the ledger — a forgotten import — and nothing
        else. Invisible to a reader either way (the row set comes from the
        snapshot), but a process running for months through many portfolio edits
        would otherwise accumulate them, and #597 is already this app's story of
        a structure that grew without bound.

        Iterating the keys is safe **because it holds the lock**: this is a
        writer, and the rule the module states is that *readers* never iterate.
        """
        keep = set(symbols)
        with self._lock:
            for symbol in [s for s in self._scrape if s not in keep]:
                del self._scrape[symbol]
            for key in [k for k in self._backfill if k[0] not in keep]:
                del self._backfill[key]

    # ------------------------------------------------------------------ #
    # Reads — one get per key, driven by the configuration snapshot
    # ------------------------------------------------------------------ #

    def scrape_of(self, symbol: str) -> Optional[ScrapeRecord]:
        return self._scrape.get(symbol)

    def backfill_of(self, symbol: str,
                    direction: str) -> Optional[BackfillRecord]:
        return self._backfill.get((symbol, direction))

    def records_for(self, shares: Iterable[Mapping[str, Any]]) -> Tuple[
            Dict[str, Optional[ScrapeRecord]],
            Dict[Tuple[str, str], Optional[BackfillRecord]]]:
        """Every record the **snapshot's** symbols have, one ``get`` per key.

        The read path of the module's two consumers, and it lives here rather
        than at each of them because the second — ``/health``'s body, issue #818
        — would otherwise be a copy of the first. Two copies of this loop is how
        the lateral pass came to be missing from ``/api/runtime`` on the day it
        landed, and :data:`DIRECTIONS` is spelled out **once** so that adding a
        fourth direction is adding it there and nowhere else.

        The row set is the declaration's and never this object's key set (déc.
        3): it keeps a request thread from iterating a dict the scrape threads
        are writing, and it answers *unknown* rather than *missing* for a symbol
        the scheduler has not reached yet.
        """
        scrape: Dict[str, Optional[ScrapeRecord]] = {}
        backfill: Dict[Tuple[str, str], Optional[BackfillRecord]] = {}
        for share in shares:
            symbol = share.get('symbol')
            # A symbol held in two accounts is two rows of the snapshot and one
            # series: it is read once, not once per holding.
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
    'SKIP_NOTHING_TO_REPAIR',
    'INGEST_UPDATED', 'INGEST_UNCHANGED', 'INGEST_FAILED',
    'PERF_RAN', 'PERF_FAILED',
    'ScrapeRecord', 'BackfillRecord', 'IngestRecord', 'PerfRecord',
    'RuntimeRecorder',
]
