"""Pure view logic for the app's own runtime state (issue #668, design #656).

Records + snapshot + job list in, page objects out, ``now`` injected — the taste
of :mod:`scheduling` and :mod:`portfolio_view`, and here it buys something
specific: the three cases that are hardest to get right are all unit-testable
without a scheduler. An ambiguous ``next_run_time``, the backfill's terminal
state and the boot window in which no series has been observed yet are decided
by functions that take dataclasses and a clock.

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
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import mounts
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
#: Nobody holds this symbol, so nothing polls it — **by design**, not by
#: failure. Its own value because ``unknown`` is a statement about *this
#: process* ("it has not got there yet"), which a closed position would wear
#: for ever: the scrape job departs at the sale and its record leaves with it,
#: so no future event could ever clear it. The line is on the page because its
#: history is still being rebuilt (#703), and this says why it is not polled.
PILL_NOT_HELD = 'not_held'
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
#: The symbol is **not scraped by design**: nothing is held, so no job was ever
#: armed for it. Distinct from trap 1's ambiguity, which is about a job the
#: jobstore cannot account for — here there is nothing to account for, and the
#: row exists because the symbol's *history* is still being reconstructed (#703).
NEXT_RUN_NOT_HELD = 'not_held'

# --------------------------------------------------------------------- #
# Backfill display states
# --------------------------------------------------------------------- #

BACKFILL_UNKNOWN = 'unknown'
BACKFILL_RUNNING = 'running'
BACKFILL_FAILING = 'failing'


@dataclass(frozen=True)
class BackfillProgress:
    """One ``(symbol, direction)`` pass, made into a bar.

    ``state`` is either the record's terminal (``complete``,
    ``unconvertible``), a skip reason, or one of the three above, carried
    through **verbatim**. ``no_buy`` was the second terminal and is gone with
    #703: the target is the first *acquisition* now, ``GRANT`` included, so a
    symbol that would have carried it has no holding window and never reaches
    the backfill at all. ``unconvertible`` is the fourth and arrived with #704,
    on the lateral pass — and it is the one terminal that carries a
    :attr:`reason`, because it asks the reader to do something.
    """

    direction: str
    state: str
    at: Optional[datetime]
    target: Optional[datetime]
    #: The top of the holding window — the other end of the span ``ratio``
    #: divides by (issue #703). Published rather than left implicit: a reader
    #: assuming *now* would inflate the bar of every sold line, and would have
    #: no way of telling.
    ceiling: Optional[datetime]
    #: Where the pass resumes from — the bar's **numerator**. Distinct from
    #: ``oldest`` since #703 parted them; see
    #: :class:`runtime_state.BackfillRecord`.
    anchor: Optional[datetime]
    oldest: Optional[datetime]
    newest: Optional[datetime]
    window: Optional[Tuple[datetime, datetime]]
    written: int
    failures: int
    #: ``0.0``–``1.0``, or ``None`` when there is no span to measure against.
    #: Lags by one cycle on purpose — see :class:`runtime_state.BackfillRecord`.
    ratio: Optional[float]
    error: Optional[str]
    #: Why the pass concluded what it concluded, when the state word alone does
    #: not say it (issue #704) — today the currency pair ``unconvertible`` is
    #: about. Beside ``error`` and never inside it: a pair that does not resolve
    #: is a **reply**, and folding it into the errors list would put a fact the
    #: owner has to act on among the transient failures a retry clears.
    reason: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            'direction': self.direction,
            'state': self.state,
            'at': _iso(self.at),
            'target': _iso(self.target),
            'ceiling': _iso(self.ceiling),
            'anchor': _iso(self.anchor),
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
            'reason': self.reason,
        }


@dataclass(frozen=True)
class SymbolRuntime:
    """One row of the shares table's status column, plus the sheet's detail.

    The per-account sub-rows left with #700, together with the dimension they
    described: the price series has no account, so the scrape writes one point
    per symbol and the backfill fetches one window per symbol. A payload that
    kept the shape would have shown a reader N identical bars for one piece of
    work and invited them to conclude the accounts were being tracked apart.
    """

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
    #: Whether the portfolio still holds this symbol anywhere (issue #703). The
    #: scrape's set and the backfill's stopped being the same one, so a row has
    #: to say which of the two it belongs to: a sold line is *reconstructed* and
    #: not polled, and without this field it reads as a scheduler that is stuck.
    held: bool
    #: #628's sonde fired for this symbol on the last ``REGULAR`` pass.
    frozen: bool
    #: A point was persisted on the last pass.
    written: bool
    backward: Optional[BackfillProgress]
    forward: Optional[BackfillProgress]
    #: The lateral pass (issue #704): the conversion of the points already
    #: fetched. A third member rather than a field folded into the other two,
    #: because what it reports is orthogonal to both — a series can be complete
    #: backwards, up to date forwards, and entirely unconverted.
    lateral: Optional[BackfillProgress]
    #: The accounts **holding** this symbol, and empty when nobody does. Kept as
    #: a plain list because the page shows *who holds it*; nothing per-account
    #: is measured about the series.
    accounts: Sequence[str]
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
            'held': self.held,
            'frozen': self.frozen,
            'written': self.written,
            'backward': self.backward.to_dict() if self.backward else None,
            'forward': self.forward.to_dict() if self.forward else None,
            'lateral': self.lateral.to_dict() if self.lateral else None,
            'accounts': list(self.accounts),
            'error': self.error,
        }


def symbol_pill(record: Optional[runtime_state.ScrapeRecord],
                held: bool = True) -> str:
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

    ``held`` comes **first**, above all of it, and for the reason
    ``next_run_state`` gives ``not_held`` the same precedence a few lines down:
    it is a property of the *symbol* rather than of anything a pass observed. A
    sold line has no scrape job and no record, so the ranking below would call
    it ``unknown`` — *"the scheduler has never reached this symbol"* — for the
    life of the process, with no future event able to clear it. That is the risk
    :func:`build_symbols` names when it stops filtering on ``quantity``, and
    answering it in the two other fields while leaving the **headline** wrong
    would be answering it by half.

    Every field behind the pill rides in the payload, so the front can show the
    rest of the truth in the sheet — the pill picks a headline, it does not hide
    anything.
    """
    if not held:
        return PILL_NOT_HELD
    if record is None:
        return PILL_UNKNOWN
    if record.verdict == runtime_state.SCRAPE_WRITE_FAILED:
        return PILL_WRITE_FAILED
    if record.failure_count > scheduling.FAILURE_GRACE:
        return PILL_BACKOFF
    if record.stale:
        return PILL_FROZEN
    if record.failure_count > 0:
        return PILL_FAILING
    if record.closed:
        return PILL_CLOSED
    return PILL_OPEN


def backfill_progress(
    record: Optional[runtime_state.BackfillRecord],
    direction: str,
    now: datetime,
) -> BackfillProgress:
    """Turn one backfill record into a bar, or into the reason there is none.

    The bar answers #656's driving question — *is the backfill advancing, or is
    it stuck?* — from three dates in **one** record: the first acquisition, the
    top of the holding window, and the oldest stored point. All three were read
    by the same pass, so they are coherent with each other, which a reader
    composing them from the watermark and a fresh query would not be.
    """
    if record is None:
        return BackfillProgress(
            direction=direction, state=BACKFILL_UNKNOWN,
            at=None, target=None, ceiling=None, anchor=None, oldest=None,
            newest=None, window=None, written=0, failures=0, ratio=None,
            error=None, reason=None)

    return BackfillProgress(
        direction=direction,
        state=_backfill_state(record),
        at=record.at,
        target=record.target,
        ceiling=record.ceiling,
        anchor=record.anchor,
        oldest=record.oldest,
        newest=record.newest,
        window=record.window,
        written=record.written,
        failures=record.failures,
        ratio=_ratio(record, now),
        error=record.error,
        reason=record.reason,
    )


def _backfill_state(record: runtime_state.BackfillRecord) -> str:
    """The record's own verdict, in the order it was decided.

    A terminal wins over a failure count, and that is not a preference: a
    terminal is a *conclusion* the pass reached — nothing earlier exists — while
    a failure count describes an attempt. A series marked ``complete`` is not
    failing at anything, whatever a stale counter says.
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
    """How much of the **holding window** is stored, in ``[0, 1]``.

    The span is ``[target, ceiling]`` and not ``[target, now]`` (issue #703).
    The two coincided as long as the backfill only ever ran on what was held
    today, and this ticket is exactly what parted them: every symbol now carries
    a window bounded above by its last exit. Dividing by *now* on a line bought
    2020-03-02 and sold 2022-05-04 counts the four years since the sale as
    history still to fetch, and reports **0,82** after the first of three chunks
    where the pass has covered **0,46** — the older the sale, the wider the lie,
    and a line held 2014-2015 reads ~0,92 on its very first cycle. It is
    precisely the class of row #703 adds to the payload, and precisely the
    moment the bar has a use, so the ceiling rides on the record: a consumer
    given ``target``/``oldest`` alone cannot repair it.

    A still-held position has ``ceiling = now``, so nothing about a live line
    changes. A record with no ceiling at all falls back to ``now``, which is
    that same reading.

    ``complete`` is ``1.0`` by definition rather than by arithmetic — the
    watermark is set exactly when the anchor reaches the target, and also when
    the target falls on a day the market never traded, where the arithmetic
    would stop just short of 1 forever and read as a stall.

    ``None`` for the forward pass, for the lateral one, and for a series with
    nothing stored yet: there is no span to measure against, and a bar with an
    invented denominator is worse than no bar. A mute symbol therefore draws no
    bar at all until it reaches its terminal, which is the honest rendering of
    *zero point fetched*. The lateral pass falls out of the arithmetic by itself,
    carrying no ``target``: what it walks is the set of points missing a column,
    which is not an interval of time and shrinks from both ends as the other two
    passes add to it.
    """
    if record.terminal == runtime_state.TERMINAL_COMPLETE:
        return 1.0
    # Every side through `_utc`: `target` comes from an event date and `oldest`
    # from the store, and subtracting a naive instant from an aware one raises.
    # See :func:`_utc`.
    target = _utc(record.target)
    # The **anchor**, not the oldest stored point: #703 parted the two, and the
    # anchor is the one that moves. On a symbol Yahoo answers nothing about for
    # its early windows — a partial delisting, a history that simply starts
    # later — the stored point stays where it is while the anchor descends a
    # chunk a cycle, so a bar drawn from ``oldest`` freezes and then jumps to
    # 1,0 at the terminal: it reports a stall through the whole of the work.
    # ``oldest`` is the fallback for a record written before the field existed.
    reached = _utc(record.anchor) or _utc(record.oldest)
    if target is None or reached is None:
        return None
    ceiling = _utc(record.ceiling) if record.ceiling is not None else _utc(now)
    total = (ceiling - target).total_seconds()
    if total <= 0:
        return 1.0
    covered = (ceiling - reached).total_seconds()
    return max(0.0, min(1.0, covered / total))


def build_symbols(
    shares: Sequence[Dict[str, Any]],
    scrape: Mapping[str, Optional[runtime_state.ScrapeRecord]],
    backfill: Mapping[Tuple[str, str], Optional[runtime_state.BackfillRecord]],
    next_runs: Mapping[str, Optional[datetime]],
    now: datetime,
    scheduler_running: bool = True,
) -> List[SymbolRuntime]:
    """One entry per symbol the ledger names, folded from the configuration snapshot.

    The row set is the snapshot's, never the recorder's key set, and that is
    #656 déc. 3's rule doing two jobs at once: it keeps the reader from
    iterating a dict the scrape threads are writing, and it gives the right
    answer for free — a symbol the scheduler has not reached yet is a row with
    an *unknown* pill rather than a missing line. #661's "the declaration
    drives", one map over.

    **It was the held set until #703**, filtered on ``quantity`` like
    ``_held_symbols``, because a sold position keeps no scrape job and no record
    and would have rendered as a scheduler that is permanently stuck. What
    changed is not the risk but the subject: the backfill now runs on everything
    the portfolio has *ever* held, so a sold line has a pass of its own in
    progress and hiding it would hide the reconstruction the owner is waiting
    for — the bar would read « 2 séries sur 2 » with three histories still being
    rebuilt. The row therefore carries ``held`` and, when it is false,
    :data:`NEXT_RUN_NOT_HELD`: it says *not polled, by design* instead of
    saying nothing at all.

    ``next_runs`` maps a symbol to the jobstore's ``next_run_time``. A **missing
    key** is not the same as a ``None`` value here only in intent; both render
    as :data:`NEXT_RUN_AMBIGUOUS`, because the jobstore genuinely cannot tell
    "being scraped right now" from "departed" (trap 1).
    """
    by_symbol: Dict[str, List[str]] = {}
    names: Dict[str, Optional[str]] = {}
    held: Dict[str, bool] = {}
    for share in shares:
        symbol = share.get('symbol')
        if not symbol:
            continue
        account = str(share.get('account') or DEFAULT_ACCOUNT)
        accounts = by_symbol.setdefault(symbol, [])
        # **Who holds it**, which is what the field says and what the page
        # shows. The filter on ``quantity`` is here and not on the row above:
        # dropping it when the row set widened to every symbol the ledger names
        # (#703) would have changed the meaning of a field already published,
        # silently — a symbol held in a PEA and sold out of a CTO would list
        # both, and a reader summing per account would count a holding nobody
        # has. A symbol nobody holds lists nothing, and ``held`` is the field
        # that says so; *which accounts once held it* is a different question,
        # and the ledger answers it.
        if account not in accounts and share.get('quantity'):
            accounts.append(account)
        names.setdefault(symbol, share.get('name'))
        # Held **anywhere**: one account selling out does not stop the scrape of
        # a symbol another account still holds — there is one job for the symbol.
        held[symbol] = held.get(symbol, False) or bool(share.get('quantity'))

    rows = []
    for symbol in sorted(by_symbol):
        record = scrape.get(symbol)

        next_run = next_runs.get(symbol)
        # ``not_held`` first: it is a property of the *symbol* and true whether
        # or not this process has a scheduler, while the two values below both
        # describe what a jobstore can be asked. A symbol nothing holds has no
        # job by design, and that is the whole answer.
        if not held[symbol]:
            next_run_state = NEXT_RUN_NOT_HELD
        elif not scheduler_running:
            next_run_state = NEXT_RUN_UNAVAILABLE
        elif next_run is None:
            next_run_state = NEXT_RUN_AMBIGUOUS
        else:
            next_run_state = NEXT_RUN_SCHEDULED

        rows.append(SymbolRuntime(
            symbol=symbol,
            name=names.get(symbol),
            pill=symbol_pill(record, held[symbol]),
            market_state=record.market_state if record else None,
            closed=record.closed if record else None,
            last_pass=record.at if record else None,
            verdict=record.verdict if record else None,
            failure_count=record.failure_count if record else 0,
            next_delay=record.next_delay if record else None,
            next_run=next_run,
            next_run_state=next_run_state,
            held=held[symbol],
            frozen=bool(record.stale) if record else False,
            written=bool(record.wrote) if record else False,
            backward=backfill_progress(
                backfill.get((symbol, runtime_state.BACKWARD)),
                runtime_state.BACKWARD, now),
            forward=backfill_progress(
                backfill.get((symbol, runtime_state.FORWARD)),
                runtime_state.FORWARD, now),
            lateral=backfill_progress(
                backfill.get((symbol, runtime_state.LATERAL)),
                runtime_state.LATERAL, now),
            accounts=sorted(by_symbol[symbol]),
            error=record.error if record else None,
        ))
    return rows


def build_backfill_summary(symbols: Sequence[SymbolRuntime]) -> Dict[str, Any]:
    """The banner's bar: how many series have reached their first acquisition.

    Counted over the **backward** pass only. The forward pass has no target — it
    recovers a session missed while the app was down and its healthy steady state
    is a no-op (``too_recent``), so folding it in would make a perfectly well
    portfolio look permanently half-done. The lateral pass (#704) is out for the
    same reason twice over: its healthy steady state is ``nothing_to_repair``,
    and its terminal is not an achievement but a **fault to act on** — counting
    an ``unconvertible`` series as *done* beside a reconstructed one would make
    the banner announce as finished the very thing it should be naming.

    A count of terminal states rather than a mean of the per-series ratios, and
    the difference is not cosmetic: averaging a five-year history against a
    two-week one produces a number that moves for reasons nobody can read. Each
    series keeps its own bar in the sheet.
    """
    states: Dict[str, int] = {}
    for symbol in symbols:
        state = symbol.backward.state if symbol.backward else BACKFILL_UNKNOWN
        states[state] = states.get(state, 0) + 1

    total = sum(states.values())
    complete = states.get(runtime_state.TERMINAL_COMPLETE, 0)
    # One kind of series is outside the bar's denominator, and it is the one
    # found by looking: `unknown` is a **boot window**. The backfill job runs
    # every 60 s, so for the first cycle after a restart no series has a record
    # at all — and counting them as pending made an install announce
    # « 0 séries sur 2 » for a reprise d'historique that had not started. An
    # unobserved series is not known to be pending; it is not known to be
    # anything, which is what the word says.
    #
    # `no_buy` was the second exclusion and left with the state (#703). The
    # denominator therefore counts sold positions too, which is the point: their
    # history is exactly what the reconstruction is for.
    in_scope = total - states.get(BACKFILL_UNKNOWN, 0)

    return {
        'total': total,
        'in_scope': in_scope,
        'complete': complete,
        'failing': states.get(BACKFILL_FAILING, 0),
        'running': states.get(BACKFILL_RUNNING, 0),
        'unknown': states.get(BACKFILL_UNKNOWN, 0),
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
    """The last perf-recompute pass: when it ran, and whether it went through.

    It used to carry ``reasons`` — the three inputs of #618's gate — because a
    skip *was* the three of them being quiet and no single string could say so.
    The gate is gone (issue #707) and the field went with it rather than being
    left as three booleans nothing reads: a recompute that happens every cycle,
    in full, has no decision to publish. What is left is what the two other
    global records publish, a date and an outcome.

    The horizons the record carries are **not** here: they are per account, and
    the payload has a row set for that (:func:`build_accounts`). Publishing them
    twice — as a mapping under the job and as a list beside the accounts — is how
    a page ends up reading whichever it found first.
    """
    if record is None:
        return None
    return {
        'at': _iso(record.at),
        'verdict': record.verdict,
        'error': record.error,
    }


def build_accounts(
        record: Optional[runtime_state.PerfRecord]) -> List[Dict[str, Any]]:
    """One row per account the last perf pass computed: its **horizon**.

    The first day that account's figures were written from (issue #708) — a
    *calendar day*, rendered as one, where every other member of this payload is
    an instant. It comes from process memory like everything else on this route,
    which matters here more than most: what it says is *"the page is filling in
    towards the left"* rather than *"the app has lost four years"*, and a
    resource that needed the store to say it would go quiet exactly when a
    reader needs it.

    It is on the perf record and not derived from the rows because the rows
    answer another question: they say where a series *starts*, which stops being
    the horizon the moment an account's first activity is later than it.

    ``horizon: null`` says **nothing constrains this account** — it holds no
    security still waiting for a price. An account **absent from the list** says
    something else: this pass did not compute it, which is the state of a process
    whose perf job has not run yet, or whose last one raised. Sorted by id, so a
    reader diffing two payloads sees a horizon move rather than a list reorder.
    """
    if record is None:
        return []
    return [{'account': account, 'horizon': _day(horizon)}
            for account, horizon in sorted(record.horizons.items())]


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
        # The lateral pass is in the list for its **failures** only: its
        # ``error`` is a fetch that did not complete, which is exactly what the
        # other two publish here. An ``unconvertible`` terminal carries no
        # ``error`` at all — it travels as a ``reason`` on the pass itself, and
        # a fact the owner has to repair does not belong among the transient
        # failures the next cycle clears.
        for progress in (symbol.backward, symbol.forward, symbol.lateral):
            if progress is not None and progress.error:
                errors.append({
                    'source': f'backfill:{progress.direction}',
                    'key': symbol.symbol,
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


def is_rebuilding(reconstruction: Optional[Tuple[int, int]]) -> bool:
    """*The reconstruction still has windows to cover* (contract #745, #763).

    Reads :meth:`main.SuiviBourseMetrics.reconstruction_state` — process memory
    — and **no query at all**, which is why the member is on the app-state
    resource and not beside the figures: it is a fact about *this process*.

    What it decides on screen is small and exact: the time-weighted return
    carries its base date **only while that date is still moving**. #707
    recomputes the whole series every cycle and the backfill keeps handing it
    earlier prices, so ``twr_since`` walks backwards until the reconstruction
    concludes; once it does, the date stops changing and stops being news. It
    serves nothing else — and **not** the year-to-date, which has its own carrier
    (``totals.ytd``): the two moments do not coincide, the year-to-date becoming
    computable long before the reconstruction finishes.

    ``None`` is the reading a process with no scheduler makes — the gunicorn
    master, a test runtime — and it answers ``False``. That is not the third
    state :data:`advisories.UNOBSERVED` keeps: a boolean has no room for one, and
    ``False`` is the safe reading, since what it enables is the *assertion* that
    a date is still moving, which an observer that cannot see the scheduler has
    no ground to make.
    """
    if reconstruction is None:
        return False
    complete, total = reconstruction
    return total > 0 and complete < total


def build_runtime(
    shares: Sequence[Dict[str, Any]],
    scrape: Mapping[str, Optional[runtime_state.ScrapeRecord]],
    backfill: Mapping[Tuple[str, str], Optional[runtime_state.BackfillRecord]],
    next_runs: Mapping[str, Optional[datetime]],
    ingest: Optional[runtime_state.IngestRecord],
    perf: Optional[runtime_state.PerfRecord],
    now: datetime,
    scheduler_running: bool = True,
    reconstruction: Optional[Tuple[int, int]] = None,
    persistence: str = mounts.UNKNOWN,
    store_path: Optional[str] = None,
) -> Dict[str, Any]:
    """The whole ``GET /api/runtime`` payload.

    No ``mode`` since #711: there is one loading path, so an absent backward
    pass has exactly one reading and the front has nothing left to branch on.

    ``reconstruction`` is the scheduler's ``(complete, total)`` pair and defaults
    to ``None`` — *not observable from here* — which is the honest state of a
    runtime whose scheduler has never started. See :func:`is_rebuilding`.

    ``persistence`` is the mount observation (#741, ADR-0015), and it rides
    **here** rather than on a resource of its own for the reason that put
    ``rebuilding`` here: it is a fact about *this process* — its mount namespace
    — answered from memory with no query, which is what keeps it readable on the
    one route that survives a store nobody can open. The data page's *store*
    block (#724) is what renders it; it carries all three answers, ``unknown``
    included, because a front that only knew two would have to invent one.

    ``store_path`` rides beside it for the same reason and travels in the same
    object, because they are read as one line: *"the path, **and** whether it
    survives"* (#724). It is boot knowledge — the master resolved it before it
    opened anything — so it costs no query either, and it is the half a reader
    needs precisely when the store block's own resource cannot answer.
    """
    symbols = build_symbols(
        shares, scrape, backfill, next_runs, now, scheduler_running)
    return {
        'now': _iso(now),
        'scheduler_running': scheduler_running,
        'rebuilding': is_rebuilding(reconstruction),
        'store': {'persistence': persistence, 'path': store_path},
        'symbols': [symbol.to_dict() for symbol in symbols],
        # The perf horizon per account (issue #708). A top-level row set beside
        # ``symbols`` rather than a member of ``perf``, because that is the shape
        # the front announced before either half was written — the same way
        # ``rebuilding`` and ``portfolio-totals`` arrived — and because it is a
        # list of accounts, which the job's own record is not.
        'accounts': build_accounts(perf),
        'backfill': build_backfill_summary(symbols),
        'ingestion': build_ingestion(ingest),
        'perf': build_perf(perf),
        'errors': build_errors(symbols, ingest, perf),
    }


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    """Stamp a naive datetime as UTC. One rule, applied at every exit.

    Found by looking, and it is the sharper half of a defect the terminal states
    were hiding. The backfill's anchor used to come back through pandas as a
    **tz-naive** instant, so a record whose ``oldest`` came from storage carried
    a naive datetime beside a ``target`` built from an event date, which is
    aware. The store stamps both sides now (:func:`quotes._utc`), and the guard
    stays because the two consequences are what a regression here looks like,
    and the first is not cosmetic:

    * ``(now - oldest)`` raises ``TypeError: can't subtract offset-naive and
      offset-aware datetimes``, and this blueprint's catch-all renders any
      exception as **503 Portfolio storage unavailable** — from the one route
      that touches no storage, and precisely while a backward pass is *in
      progress*, which is the only time the bar is worth drawing. A completed
      pass short-circuits to ``1.0`` before the arithmetic, so the bug was
      invisible on a stack whose history is already filled.
    * a naive ISO string is read by ``new Date()`` as **local** time, quietly
      shifting every instant on the page by the browser's offset.

    Naive means UTC here: the app writes UTC everywhere, and the store's session
    is pinned to it. Saying so explicitly is not a claim about the observation,
    it is the observation written down completely.
    """
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    """ISO-8601 UTC, the wire format #655 fixed for every timestamp."""
    stamped = _utc(value)
    return stamped.isoformat() if stamped is not None else None


def _day(value: Optional[date]) -> Optional[str]:
    """``YYYY-MM-DD`` for a **calendar day**, never an instant (issue #708).

    The two kinds of time do not mix (spec #695 § 3), and this route is where the
    distinction is easiest to lose: every other member of the payload is an
    instant. A horizon is a day, so it is rendered as one — stamping it at
    midnight would let a browser shift it by its own offset and read the day
    before.
    """
    return value.isoformat() if value is not None else None


__all__ = [
    'PILL_UNKNOWN', 'PILL_NOT_HELD', 'PILL_CLOSED', 'PILL_OPEN', 'PILL_FROZEN',
    'PILL_FAILING',
    'PILL_BACKOFF', 'PILL_WRITE_FAILED',
    'NEXT_RUN_SCHEDULED', 'NEXT_RUN_AMBIGUOUS', 'NEXT_RUN_UNAVAILABLE',
    'NEXT_RUN_NOT_HELD',
    'BACKFILL_UNKNOWN', 'BACKFILL_RUNNING', 'BACKFILL_FAILING',
    'BackfillProgress', 'SymbolRuntime',
    'symbol_pill', 'backfill_progress', 'build_symbols',
    'build_backfill_summary', 'build_ingestion', 'build_perf', 'build_accounts',
    'build_errors', 'is_rebuilding', 'build_runtime',
]
