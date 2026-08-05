"""Pure view logic for the app's own runtime state (issue #668, design #656).

Records + snapshot + job list in, page objects out, ``now`` injected — the taste
of :mod:`scheduling` and :mod:`portfolio_view`, and here it buys something
specific: the three cases that are hardest to get right are all unit-testable
without a scheduler. An ambiguous ``next_run_time``, the three terminal backfill
states, and manual mode's *nominal* absence of a backward pass are decided by
functions that take dataclasses and a clock.

The contract this module is built to honour (#656 déc. 4): **it reports
observations and never derives a verdict across two items.** Every verdict it
renders was computed by the job that knew, atomically, and travelled in one
record. What is left here is folding — one row per share with the per-account
detail beside it, the way :func:`portfolio_view.build_shares` already folds
positions — plus the arithmetic of a progress bar, which is two dates in one
record divided by a clock.

The one thing it *does* decide is priority: a symbol can be several things at
once, and a single pill has to choose. That choice is stated in
:func:`symbol_pill` and it is the module's only opinion.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import runtime_state
import scheduling

#: Mirrors ``events.schemas.DEFAULT_ACCOUNT``. Duplicated for the same reason
#: :mod:`portfolio_view` duplicates it: importing ``events.schemas`` pulls the
#: package ``__init__`` and with it pandas and openpyxl, which a pure view module
#: has no business dragging in.
DEFAULT_ACCOUNT = 'default'

# --------------------------------------------------------------------- #
# The pills (#652 déc. 15)
# --------------------------------------------------------------------- #

#: Nothing observed yet — this process has never completed a pass for the
#: symbol. A *designed* state on a freshly booted container, not a fault, and
#: deliberately distinct from every other value here.
PILL_UNKNOWN = 'unknown'
#: The market was shut on the last pass, so the job slept to the next open.
PILL_CLOSED = 'closed'
#: The last pass wrote a point. The only entirely reassuring value.
PILL_OPEN = 'open'
#: #628's sonde: the stored price stayed frozen across consecutive ``REGULAR``
#: cycles while the live quote moved.
PILL_FROZEN = 'frozen'
#: #617, before the delay has grown: failing, still retrying at ``base_interval``.
PILL_FAILING = 'failing'
#: #617, past the grace window: the re-arm delay is now growing geometrically.
PILL_BACKOFF = 'backoff'
#: The quote arrived and the point did not land. See
#: :data:`runtime_state.SCRAPE_WRITE_FAILED` — #617's counter cannot see this.
PILL_WRITE_FAILED = 'write_failed'

# --------------------------------------------------------------------- #
# What the jobstore can and cannot say (#656 trap 1)
# --------------------------------------------------------------------- #

#: A live job with a next fire time — the only case where a countdown is true.
NEXT_RUN_SCHEDULED = 'scheduled'
#: No job in the jobstore for this symbol — and the reading is **ambiguous**. A
#: ``date`` job is removed while it runs and re-added at the end of
#: ``_scrape_symbol``, so absence means "being scraped right now" *or* "symbol
#: departed", and a cycle can be seconds long (rate-limit retries sleep up to
#: 8 s). Rendering it as either one alone is the trap; the value says both.
NEXT_RUN_AMBIGUOUS = 'ambiguous'
#: There is no scheduler in this process yet (the master, or a test). Not the
#: same as absence *from* a running jobstore, which is why it is not folded in.
NEXT_RUN_UNAVAILABLE = 'unavailable'

# --------------------------------------------------------------------- #
# Backfill display states
# --------------------------------------------------------------------- #

BACKFILL_UNKNOWN = 'unknown'
BACKFILL_RUNNING = 'running'
BACKFILL_FAILING = 'failing'


@dataclass(frozen=True)
class BackfillProgress:
    """One ``(symbol, account, direction)`` pass, made into a bar.

    ``state`` is either a terminal from the record (``complete`` / ``no_buy`` /
    ``manual_mode``), a skip reason, or one of the three above. The three
    terminals are carried through **verbatim and never collapsed**: they mean
    "there is nothing left to fetch", "this symbol was never bought" and "this
    installation has no backward pass at all", and only the first is progress.
    """

    account: str
    direction: str
    state: str
    at: Optional[datetime]
    target: Optional[datetime]
    oldest: Optional[datetime]
    newest: Optional[datetime]
    window: Optional[Tuple[datetime, datetime]]
    written: int
    failures: int
    #: ``0.0``–``1.0``, or ``None`` when there is no span to measure against.
    #: Lags by one cycle on purpose — see :class:`runtime_state.BackfillRecord`.
    ratio: Optional[float]
    error: Optional[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'account': self.account,
            'direction': self.direction,
            'state': self.state,
            'at': _iso(self.at),
            'target': _iso(self.target),
            'oldest': _iso(self.oldest),
            'newest': _iso(self.newest),
            'window': (
                [_iso(self.window[0]), _iso(self.window[1])]
                if self.window else None
            ),
            'written': self.written,
            'failures': self.failures,
            'ratio': self.ratio,
            'error': self.error,
        }


@dataclass(frozen=True)
class AccountRuntime:
    """One ``(symbol, account)`` pair — the detail the sheet shows."""

    account: str
    #: #628's sonde fired for this pair on the last ``REGULAR`` pass.
    frozen: bool
    #: A point was persisted for this pair on the last pass.
    written: bool
    backward: Optional[BackfillProgress]
    forward: Optional[BackfillProgress]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'account': self.account,
            'frozen': self.frozen,
            'written': self.written,
            'backward': self.backward.to_dict() if self.backward else None,
            'forward': self.forward.to_dict() if self.forward else None,
        }


@dataclass(frozen=True)
class SymbolRuntime:
    """One row of the shares table's status column, plus the sheet's detail."""

    symbol: str
    name: Optional[str]
    pill: str
    #: yfinance's raw value **as read this cycle**, never the cache's. ``None``
    #: when the fetch failed, which is the honest answer and not a state.
    market_state: Optional[str]
    closed: Optional[bool]
    last_pass: Optional[datetime]
    verdict: Optional[str]
    failure_count: int
    next_delay: Optional[float]
    next_run: Optional[datetime]
    next_run_state: str
    accounts: Sequence[AccountRuntime]
    error: Optional[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'symbol': self.symbol,
            'name': self.name,
            'pill': self.pill,
            'market_state': self.market_state,
            'closed': self.closed,
            'last_pass': _iso(self.last_pass),
            'verdict': self.verdict,
            'failure_count': self.failure_count,
            'next_delay': self.next_delay,
            'next_run': _iso(self.next_run),
            'next_run_state': self.next_run_state,
            'accounts': [a.to_dict() for a in self.accounts],
            'error': self.error,
        }


def symbol_pill(record: Optional[runtime_state.ScrapeRecord]) -> str:
    """Which single pill one symbol gets. The module's only opinion.

    A symbol can be several things at once — backing off *and* shut, frozen
    *and* open — so the order below is a claim about what the reader came to
    find out. #652 déc. 15 frames the question the page answers as *"is the
    market asleep, or is the app broken?"*, so **broken beats asleep** all the
    way down:

    1. ``write_failed`` first, because it is the only value that means nothing is
       being persisted right now, and because #617's counter is blind to it.
    2. ``backoff`` next: the delay has grown, so this symbol will not be tried
       again for a long time — the news with the longest consequence.
    3. ``frozen``: the writer runs and stores a value that no longer moves. It
       outranks ``failing`` because a failing fetch is at least visible in the
       price stopping, while this one looks healthy from every other angle.
    4. ``failing``, then the two ordinary states.

    Every field behind the pill rides in the payload, so the front can show the
    rest of the truth in the sheet — the pill picks a headline, it does not hide
    anything.
    """
    if record is None:
        return PILL_UNKNOWN
    if record.verdict == runtime_state.SCRAPE_WRITE_FAILED:
        return PILL_WRITE_FAILED
    if record.failure_count > scheduling.FAILURE_GRACE:
        return PILL_BACKOFF
    if record.stale_accounts:
        return PILL_FROZEN
    if record.failure_count > 0:
        return PILL_FAILING
    if record.closed:
        return PILL_CLOSED
    return PILL_OPEN


def backfill_progress(
    record: Optional[runtime_state.BackfillRecord],
    account: str,
    direction: str,
    now: datetime,
) -> BackfillProgress:
    """Turn one backfill record into a bar, or into the reason there is none.

    The bar answers #656's driving question — *is the backfill advancing, or is
    it stuck?* — from two dates in **one** record: the oldest stored point and
    the first BUY. Both were read by the same pass, so they are coherent with
    each other, which a reader composing them from the watermark and a fresh
    query would not be.
    """
    if record is None:
        return BackfillProgress(
            account=account, direction=direction, state=BACKFILL_UNKNOWN,
            at=None, target=None, oldest=None, newest=None, window=None,
            written=0, failures=0, ratio=None, error=None)

    return BackfillProgress(
        account=account,
        direction=direction,
        state=_backfill_state(record),
        at=record.at,
        target=record.target,
        oldest=record.oldest,
        newest=record.newest,
        window=record.window,
        written=record.written,
        failures=record.failures,
        ratio=_ratio(record, now),
        error=record.error,
    )


def _backfill_state(record: runtime_state.BackfillRecord) -> str:
    """The record's own verdict, in the order it was decided.

    A terminal wins over a failure count, and that is not a preference: the three
    terminals are *conclusions* the pass reached (nothing earlier exists, nothing
    was ever bought, this mode has no backward pass), while a failure count
    describes an attempt. A series marked ``complete`` is not failing at
    anything, whatever a stale counter says.
    """
    if record.terminal is not None:
        return record.terminal
    if record.failures > 0:
        return BACKFILL_FAILING
    if record.skipped is not None:
        return record.skipped
    return BACKFILL_RUNNING


def _ratio(record: runtime_state.BackfillRecord,
           now: datetime) -> Optional[float]:
    """How much of the history since the first BUY is stored, in ``[0, 1]``.

    ``complete`` is ``1.0`` by definition rather than by arithmetic — the
    watermark is set exactly when the oldest point reaches the target, and also
    when the target falls on a day the market never traded, where the arithmetic
    would stop just short of 1 forever and read as a stall.

    ``None`` for the forward pass and for a symbol with no BUY: there is no span
    to measure against, and a bar with an invented denominator is worse than no
    bar.
    """
    if record.terminal == runtime_state.TERMINAL_COMPLETE:
        return 1.0
    # Both sides through `_utc`: `target` comes from an event date and is aware,
    # `oldest` comes from InfluxDB through pandas and is naive, and subtracting
    # one from the other raises. See :func:`_utc`.
    target = _utc(record.target)
    oldest = _utc(record.oldest)
    if target is None or oldest is None:
        return None
    total = (_utc(now) - target).total_seconds()
    if total <= 0:
        return 1.0
    covered = (_utc(now) - oldest).total_seconds()
    return max(0.0, min(1.0, covered / total))


def build_symbols(
    shares: Sequence[Dict[str, Any]],
    scrape: Mapping[str, Optional[runtime_state.ScrapeRecord]],
    backfill: Mapping[Tuple[str, str, str], Optional[runtime_state.BackfillRecord]],
    next_runs: Mapping[str, Optional[datetime]],
    now: datetime,
    scheduler_running: bool = True,
) -> List[SymbolRuntime]:
    """One entry per held symbol, folded from the **configuration snapshot**.

    The row set is the snapshot's, never the recorder's key set, and that is
    #656 déc. 3's rule doing two jobs at once: it keeps the reader from
    iterating a dict the scrape threads are writing, and it gives the right
    answer for free — a symbol the scheduler has not reached yet is a row with
    an *unknown* pill rather than a missing line. #661's "the declaration
    drives", one map over.

    ``next_runs`` maps a symbol to the jobstore's ``next_run_time``. A **missing
    key** is not the same as a ``None`` value here only in intent; both render
    as :data:`NEXT_RUN_AMBIGUOUS`, because the jobstore genuinely cannot tell
    "being scraped right now" from "departed" (trap 1).
    """
    by_symbol: Dict[str, List[str]] = {}
    names: Dict[str, Optional[str]] = {}
    for share in shares:
        symbol = share.get('symbol')
        if not symbol:
            continue
        account = str(share.get('account') or DEFAULT_ACCOUNT)
        accounts = by_symbol.setdefault(symbol, [])
        if account not in accounts:
            accounts.append(account)
        names.setdefault(symbol, share.get('name'))

    rows = []
    for symbol in sorted(by_symbol):
        record = scrape.get(symbol)
        stale = set(record.stale_accounts) if record else set()
        written = set(record.accounts_written) if record else set()

        accounts = [
            AccountRuntime(
                account=account,
                frozen=account in stale,
                written=account in written,
                backward=backfill_progress(
                    backfill.get((symbol, account, runtime_state.BACKWARD)),
                    account, runtime_state.BACKWARD, now),
                forward=backfill_progress(
                    backfill.get((symbol, account, runtime_state.FORWARD)),
                    account, runtime_state.FORWARD, now),
            )
            for account in sorted(by_symbol[symbol])
        ]

        next_run = next_runs.get(symbol)
        if not scheduler_running:
            next_run_state = NEXT_RUN_UNAVAILABLE
        elif next_run is None:
            next_run_state = NEXT_RUN_AMBIGUOUS
        else:
            next_run_state = NEXT_RUN_SCHEDULED

        rows.append(SymbolRuntime(
            symbol=symbol,
            name=names.get(symbol),
            pill=symbol_pill(record),
            market_state=record.market_state if record else None,
            closed=record.closed if record else None,
            last_pass=record.at if record else None,
            verdict=record.verdict if record else None,
            failure_count=record.failure_count if record else 0,
            next_delay=record.next_delay if record else None,
            next_run=next_run,
            next_run_state=next_run_state,
            accounts=accounts,
            error=record.error if record else None,
        ))
    return rows


def build_backfill_summary(symbols: Sequence[SymbolRuntime]) -> Dict[str, Any]:
    """The banner's bar: how many series have finished reaching their first BUY.

    Counted over the **backward** pass only. The forward pass has no target — it
    recovers a session missed while the app was down and its healthy steady state
    is a no-op (``too_recent``), so folding it in would make a perfectly well
    portfolio look permanently half-done.

    A count of terminal states rather than a mean of the per-series ratios, and
    the difference is not cosmetic: averaging a five-year history against a
    two-week one produces a number that moves for reasons nobody can read. Each
    series keeps its own bar in the sheet.
    """
    states: Dict[str, int] = {}
    for symbol in symbols:
        for account in symbol.accounts:
            backward = account.backward
            state = backward.state if backward else BACKFILL_UNKNOWN
            states[state] = states.get(state, 0) + 1

    total = sum(states.values())
    complete = states.get(runtime_state.TERMINAL_COMPLETE, 0)
    # Three kinds of series are outside the bar's denominator, for two reasons.
    #
    # `no_buy` and `manual_mode` are not progress and not stalls — they are
    # series with nothing to fetch. Counting them as pending would leave the bar
    # permanently short on a manual install, which is trap 6 rendered wrong.
    #
    # `unknown` is the one found by looking, and it is a **boot window**: the
    # backfill job runs every 60 s, so for the first cycle after a restart no
    # series has a record at all — and counting them as pending made a manual
    # install announce « 0 séries sur 2 » for a reprise d'historique that was
    # never going to happen. An unobserved series is not known to be pending; it
    # is not known to be anything, which is what the word says.
    nothing_to_do = sum(
        states.get(state, 0)
        for state in (runtime_state.TERMINAL_NO_BUY,
                      runtime_state.TERMINAL_MANUAL_MODE,
                      BACKFILL_UNKNOWN))
    in_scope = total - nothing_to_do

    return {
        'total': total,
        'in_scope': in_scope,
        'complete': complete,
        'failing': states.get(BACKFILL_FAILING, 0),
        'running': states.get(BACKFILL_RUNNING, 0),
        'unknown': states.get(BACKFILL_UNKNOWN, 0),
        'no_buy': states.get(runtime_state.TERMINAL_NO_BUY, 0),
        'manual_mode': states.get(runtime_state.TERMINAL_MANUAL_MODE, 0),
        'ratio': complete / in_scope if in_scope > 0 else None,
    }


def build_ingestion(record: Optional[runtime_state.IngestRecord]) -> Optional[Dict[str, Any]]:
    """The last ingestion, and whether it kept the previous configuration.

    ``kept_previous`` is the field the banner exists for. Since #658 a rejected
    configuration cannot be published at all, so the app goes on running —
    correctly — on its last valid snapshot, and the *only* trace of it today is a
    line in the log. That is a silent failure lasting until someone looks, which
    is exactly what a banner is for.
    """
    if record is None:
        return None
    return {
        'at': _iso(record.at),
        'outcome': record.outcome,
        'kept_previous': record.outcome == runtime_state.INGEST_FAILED,
        'shares': record.shares,
        'events': record.events,
        'error': record.error,
    }


def build_perf(record: Optional[runtime_state.PerfRecord]) -> Optional[Dict[str, Any]]:
    """The last ``perf_should_run`` verdict, with its three inputs beside it.

    Three booleans rather than one reason, because a skip *is* the three of them
    being quiet: "nothing changed since the last run" only means something once
    the reader can see which three things were checked. #618's gate is the whole
    story here, and reducing it to a string would be this module deciding
    something a job already decided.
    """
    if record is None:
        return None
    return {
        'at': _iso(record.at),
        'verdict': record.verdict,
        'reasons': {
            'events_changed': record.events_changed,
            'backfill_pending': record.backfill_pending,
            'live_write': record.live_write,
        },
        'error': record.error,
    }


def build_errors(
    symbols: Sequence[SymbolRuntime],
    ingest: Optional[runtime_state.IngestRecord],
    perf: Optional[runtime_state.PerfRecord],
) -> List[Dict[str, Any]]:
    """Every error the records carry, newest first.

    #656's inventory ends on "**any error at all** — ``logger.error``, and that
    is it". This is the list that answers it, and it is a *fold of dated
    observations*, not a journal: each job holds its last pass only, so an error
    disappears the moment the same job succeeds. That is the intended behaviour —
    a page that keeps yesterday's transient failure on screen teaches people to
    ignore it.
    """
    errors: List[Dict[str, Any]] = []

    for symbol in symbols:
        if symbol.error:
            errors.append({
                'source': 'scrape', 'key': symbol.symbol,
                'at': _iso(symbol.last_pass), 'message': symbol.error})
        for account in symbol.accounts:
            for progress in (account.backward, account.forward):
                if progress is not None and progress.error:
                    errors.append({
                        'source': f'backfill:{progress.direction}',
                        'key': f'{symbol.symbol} / {progress.account}',
                        'at': _iso(progress.at),
                        'message': progress.error})

    if ingest is not None and ingest.error:
        errors.append({
            'source': 'ingest', 'key': None,
            'at': _iso(ingest.at), 'message': ingest.error})
    if perf is not None and perf.error:
        errors.append({
            'source': 'perf', 'key': None,
            'at': _iso(perf.at), 'message': perf.error})

    # Newest first, and an error with no instant last: it cannot be placed, and
    # putting it at the top would make an undatable line outrank a fresh one.
    dated = [error for error in errors if error['at']]
    undated = [error for error in errors if not error['at']]
    dated.sort(key=lambda error: error['at'], reverse=True)
    return dated + undated


def build_runtime(
    shares: Sequence[Dict[str, Any]],
    scrape: Mapping[str, Optional[runtime_state.ScrapeRecord]],
    backfill: Mapping[Tuple[str, str, str], Optional[runtime_state.BackfillRecord]],
    next_runs: Mapping[str, Optional[datetime]],
    ingest: Optional[runtime_state.IngestRecord],
    perf: Optional[runtime_state.PerfRecord],
    now: datetime,
    mode: str,
    scheduler_running: bool = True,
) -> Dict[str, Any]:
    """The whole ``GET /api/runtime`` payload.

    ``mode`` rides along because manual mode changes what an *absent* backward
    pass means, and the front has to be able to say so without a second request.
    """
    symbols = build_symbols(
        shares, scrape, backfill, next_runs, now, scheduler_running)
    return {
        'now': _iso(now),
        'mode': mode,
        'scheduler_running': scheduler_running,
        'symbols': [symbol.to_dict() for symbol in symbols],
        'backfill': build_backfill_summary(symbols),
        'ingestion': build_ingestion(ingest),
        'perf': build_perf(perf),
        'errors': build_errors(symbols, ingest, perf),
    }


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    """Stamp a naive datetime as UTC. One rule, applied at every exit.

    Found by looking, and it is the sharper half of a defect the terminal states
    were hiding. ``InfluxDBWriter.get_oldest_timestamp`` returns whatever pandas
    hands back from the Arrow ``time`` column, which is **tz-naive** — so a
    record whose ``oldest`` came from InfluxDB carries a naive datetime beside a
    ``target`` built from an event date, which is aware. Two consequences, and
    the first is not cosmetic:

    * ``(now - oldest)`` raises ``TypeError: can't subtract offset-naive and
      offset-aware datetimes``, and this blueprint's catch-all renders any
      exception as **503 Portfolio storage unavailable** — from the one route
      that touches no storage, and precisely while a backward pass is *in
      progress*, which is the only time the bar is worth drawing. A completed
      pass short-circuits to ``1.0`` before the arithmetic, so the bug was
      invisible on a stack whose history is already filled.
    * a naive ISO string is read by ``new Date()`` as **local** time, quietly
      shifting every instant on the page by the browser's offset.

    Naive means UTC here: the app writes UTC everywhere, and ``influx_sql``
    carries the same rule for the other direction. Saying so explicitly is not a
    claim about the observation, it is the observation written down completely.
    """
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    """ISO-8601 UTC, the wire format #655 fixed for every timestamp."""
    stamped = _utc(value)
    return stamped.isoformat() if stamped is not None else None


__all__ = [
    'PILL_UNKNOWN', 'PILL_CLOSED', 'PILL_OPEN', 'PILL_FROZEN', 'PILL_FAILING',
    'PILL_BACKOFF', 'PILL_WRITE_FAILED',
    'NEXT_RUN_SCHEDULED', 'NEXT_RUN_AMBIGUOUS', 'NEXT_RUN_UNAVAILABLE',
    'BACKFILL_UNKNOWN', 'BACKFILL_RUNNING', 'BACKFILL_FAILING',
    'AccountRuntime', 'BackfillProgress', 'SymbolRuntime',
    'symbol_pill', 'backfill_progress', 'build_symbols',
    'build_backfill_summary', 'build_ingestion', 'build_perf', 'build_errors',
    'build_runtime',
]
