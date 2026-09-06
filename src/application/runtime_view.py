"""Pure view logic for the app's own runtime state (issue #668, design #656)."""
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from application import build_info
from application import instants
from application import mounts
from application import runtime_state
from application import scheduling

from application.events.schemas import DEFAULT_ACCOUNT  # noqa: F401  (re-exported)


PILL_UNKNOWN = 'unknown'
PILL_NOT_HELD = 'not_held'
PILL_CLOSED = 'closed'
PILL_OPEN = 'open'
PILL_FROZEN = 'frozen'
PILL_FAILING = 'failing'
PILL_BACKOFF = 'backoff'
PILL_WRITE_FAILED = 'write_failed'


NEXT_RUN_SCHEDULED = 'scheduled'
NEXT_RUN_AMBIGUOUS = 'ambiguous'
NEXT_RUN_UNAVAILABLE = 'unavailable'
NEXT_RUN_NOT_HELD = 'not_held'


BACKFILL_UNKNOWN = 'unknown'
BACKFILL_RUNNING = 'running'
BACKFILL_FAILING = 'failing'


@dataclass(frozen=True)
class BackfillProgress:
    """One ``(symbol, direction)`` pass, made into a bar."""

    direction: str
    state: str
    at: Optional[datetime]
    target: Optional[datetime]
    ceiling: Optional[datetime]
    anchor: Optional[datetime]
    oldest: Optional[datetime]
    newest: Optional[datetime]
    window: Optional[Tuple[datetime, datetime]]
    written: int
    failures: int
    ratio: Optional[float]
    error: Optional[str]
    reason: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            'direction': self.direction,
            'state': self.state,
            'at': instants.iso(self.at),
            'target': instants.iso(self.target),
            'ceiling': instants.iso(self.ceiling),
            'anchor': instants.iso(self.anchor),
            'oldest': instants.iso(self.oldest),
            'newest': instants.iso(self.newest),
            'window': (
                [instants.iso(self.window[0]), instants.iso(self.window[1])]
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
    """One row of the shares table's status column, plus the sheet's detail."""

    symbol: str
    name: Optional[str]
    pill: str
    market_state: Optional[str]
    closed: Optional[bool]
    last_pass: Optional[datetime]
    verdict: Optional[str]
    failure_count: int
    next_delay: Optional[float]
    next_run: Optional[datetime]
    next_run_state: str
    held: bool
    frozen: bool
    written: bool
    backward: Optional[BackfillProgress]
    forward: Optional[BackfillProgress]
    lateral: Optional[BackfillProgress]
    accounts: Sequence[str]
    error: Optional[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'symbol': self.symbol,
            'name': self.name,
            'pill': self.pill,
            'market_state': self.market_state,
            'closed': self.closed,
            'last_pass': instants.iso(self.last_pass),
            'verdict': self.verdict,
            'failure_count': self.failure_count,
            'next_delay': self.next_delay,
            'next_run': instants.iso(self.next_run),
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
    """Which single pill one symbol gets. The module's only opinion."""
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
    """Turn one backfill record into a bar, or into the reason there is none."""
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
    """The record's own verdict, in the order it was decided."""
    if record.terminal is not None:
        return record.terminal
    if record.failures > 0:
        return BACKFILL_FAILING
    if record.skipped is not None:
        return record.skipped
    return BACKFILL_RUNNING


def _ratio(record: runtime_state.BackfillRecord,
           now: datetime) -> Optional[float]:
    """How much of the **holding window** is stored, in ``[0, 1]``."""
    if record.terminal == runtime_state.TERMINAL_COMPLETE:
        return 1.0
    target = instants.utc(record.target)
    reached = instants.utc(record.anchor) or instants.utc(record.oldest)
    if target is None or reached is None:
        return None
    ceiling = instants.utc(record.ceiling) if record.ceiling is not None else instants.utc(now)
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
    """One entry per symbol the ledger names, folded from the configuration snapshot."""
    by_symbol: Dict[str, List[str]] = {}
    names: Dict[str, Optional[str]] = {}
    held: Dict[str, bool] = {}
    for share in shares:
        symbol = share.get('symbol')
        if not symbol:
            continue
        account = str(share.get('account') or DEFAULT_ACCOUNT)
        accounts = by_symbol.setdefault(symbol, [])
        if account not in accounts and share.get('quantity'):
            accounts.append(account)
        names.setdefault(symbol, share.get('name'))
        held[symbol] = held.get(symbol, False) or bool(share.get('quantity'))

    rows = []
    for symbol in sorted(by_symbol):
        record = scrape.get(symbol)

        next_run = next_runs.get(symbol)
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
    """The banner's bar: how many series have reached their first acquisition."""
    states: Dict[str, int] = {}
    for symbol in symbols:
        state = symbol.backward.state if symbol.backward else BACKFILL_UNKNOWN
        states[state] = states.get(state, 0) + 1

    total = sum(states.values())
    complete = states.get(runtime_state.TERMINAL_COMPLETE, 0)
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
    """The last ingestion, and whether it kept the previous configuration."""
    if record is None:
        return None
    return {
        'at': instants.iso(record.at),
        'outcome': record.outcome,
        'kept_previous': record.outcome == runtime_state.INGEST_FAILED,
        'shares': record.shares,
        'events': record.events,
        'error': record.error,
    }


def build_perf(record: Optional[runtime_state.PerfRecord]) -> Optional[Dict[str, Any]]:
    """The last perf-recompute pass: when it ran, and whether it went through."""
    if record is None:
        return None
    return {
        'at': instants.iso(record.at),
        'verdict': record.verdict,
        'error': record.error,
    }


def build_accounts(
        record: Optional[runtime_state.PerfRecord]) -> List[Dict[str, Any]]:
    """One row per account the last perf pass computed: its **horizon**."""
    if record is None:
        return []
    return [{'account': account, 'horizon': instants.iso(horizon)}
            for account, horizon in sorted(record.horizons.items())]


def build_errors(
    symbols: Sequence[SymbolRuntime],
    ingest: Optional[runtime_state.IngestRecord],
    perf: Optional[runtime_state.PerfRecord],
) -> List[Dict[str, Any]]:
    """Every error the records carry, newest first."""
    errors: List[Dict[str, Any]] = []

    for symbol in symbols:
        if symbol.error:
            errors.append({
                'source': 'scrape', 'key': symbol.symbol,
                'at': instants.iso(symbol.last_pass), 'message': symbol.error})
        for progress in (symbol.backward, symbol.forward, symbol.lateral):
            if progress is not None and progress.error:
                errors.append({
                    'source': f'backfill:{progress.direction}',
                    'key': symbol.symbol,
                    'at': instants.iso(progress.at),
                    'message': progress.error})

    if ingest is not None and ingest.error:
        errors.append({
            'source': 'ingest', 'key': None,
            'at': instants.iso(ingest.at), 'message': ingest.error})
    if perf is not None and perf.error:
        errors.append({
            'source': 'perf', 'key': None,
            'at': instants.iso(perf.at), 'message': perf.error})

    dated = [error for error in errors if error['at']]
    undated = [error for error in errors if not error['at']]
    dated.sort(key=lambda error: error['at'], reverse=True)
    return dated + undated


def is_rebuilding(reconstruction: Optional[Tuple[int, int]]) -> bool:
    """*The reconstruction still has windows to cover* (contract #745, #763)."""
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
    build: build_info.Build = build_info.UNSTAMPED,
) -> Dict[str, Any]:
    """The whole ``GET /api/runtime`` payload."""
    symbols = build_symbols(
        shares, scrape, backfill, next_runs, now, scheduler_running)
    return {
        'now': instants.iso(now),
        'scheduler_running': scheduler_running,
        'rebuilding': is_rebuilding(reconstruction),
        'store': {'persistence': persistence, 'path': store_path},
        'build': build.to_dict(),
        'symbols': [symbol.to_dict() for symbol in symbols],
        'accounts': build_accounts(perf),
        'backfill': build_backfill_summary(symbols),
        'ingestion': build_ingestion(ingest),
        'perf': build_perf(perf),
        'errors': build_errors(symbols, ingest, perf),
    }


HEALTH_OK = 'ok'
HEALTH_ATTENTION = 'attention'
HEALTH_UNKNOWN = 'unknown'


_SCRAPE_RANK = (PILL_WRITE_FAILED, PILL_BACKOFF, PILL_FROZEN, PILL_FAILING,
                PILL_OPEN, PILL_CLOSED)

_SCRAPE_ATTENTION = (PILL_WRITE_FAILED, PILL_BACKOFF, PILL_FROZEN, PILL_FAILING)

_BACKFILL_ATTENTION = (BACKFILL_FAILING, runtime_state.TERMINAL_UNCONVERTIBLE)


def health_scrape(symbols: Sequence[SymbolRuntime]) -> Dict[str, Any]:
    """The scrape job in one line: its last pass, and its worst symbol's verdict."""
    held = [symbol for symbol in symbols if symbol.held]
    pills = {symbol.pill for symbol in held}
    verdict = next((pill for pill in _SCRAPE_RANK if pill in pills),
                   HEALTH_UNKNOWN)
    passes = [stamped for stamped in
              (instants.utc(symbol.last_pass) for symbol in held) if stamped]
    return {
        'status': _health_status(verdict, _SCRAPE_ATTENTION),
        'at': instants.iso(max(passes)) if passes else None,
        'verdict': verdict,
        'held': len(held),
        'attention': sorted(symbol.symbol for symbol in held
                            if symbol.pill in _SCRAPE_ATTENTION),
    }


def health_backfill(symbols: Sequence[SymbolRuntime]) -> Dict[str, Any]:
    """The backfill job in one line, over its three directions."""
    summary = build_backfill_summary(symbols)
    states = set()
    attention: List[str] = []
    passes: List[datetime] = []
    for symbol in symbols:
        passes_of = (symbol.backward, symbol.forward, symbol.lateral)
        own = {progress.state for progress in passes_of if progress is not None}
        states |= own
        if own & set(_BACKFILL_ATTENTION):
            attention.append(symbol.symbol)
        for progress in passes_of:
            stamped = instants.utc(progress.at) if progress is not None else None
            if stamped is not None:
                passes.append(stamped)

    if BACKFILL_FAILING in states:
        verdict = BACKFILL_FAILING
    elif runtime_state.TERMINAL_UNCONVERTIBLE in states:
        verdict = runtime_state.TERMINAL_UNCONVERTIBLE
    elif summary['in_scope'] == 0:
        verdict = BACKFILL_UNKNOWN
    elif summary['complete'] == summary['in_scope']:
        verdict = runtime_state.TERMINAL_COMPLETE
    else:
        verdict = BACKFILL_RUNNING

    return {
        'status': _health_status(verdict, _BACKFILL_ATTENTION),
        'at': instants.iso(max(passes)) if passes else None,
        'verdict': verdict,
        'complete': summary['complete'],
        'in_scope': summary['in_scope'],
        'attention': sorted(attention),
    }


def health_performance(
        record: Optional[runtime_state.PerfRecord]) -> Dict[str, Any]:
    """The perf job in one line. Two verdicts since #707, and no third to fold."""
    if record is None:
        return {'status': HEALTH_UNKNOWN, 'at': None,
                'verdict': HEALTH_UNKNOWN, 'error': None}
    failed = record.verdict == runtime_state.PERF_FAILED
    return {
        'status': HEALTH_ATTENTION if failed else HEALTH_OK,
        'at': instants.iso(record.at),
        'verdict': record.verdict,
        'error': record.error,
    }


def _health_status(verdict: str, attention: Sequence[str]) -> str:
    """One job's verdict, read as one of the three states."""
    if verdict in attention:
        return HEALTH_ATTENTION
    if verdict == HEALTH_UNKNOWN:
        return HEALTH_UNKNOWN
    return HEALTH_OK


def build_health(
    symbols: Sequence[SymbolRuntime],
    perf: Optional[runtime_state.PerfRecord],
    now: datetime,
    scheduler_running: bool = True,
) -> Dict[str, Any]:
    """The body of ``GET /health`` — the register whose reader is a person."""
    jobs = {
        'scrape': health_scrape(symbols),
        'backfill': health_backfill(symbols),
        'performance': health_performance(perf),
    }
    attention = not scheduler_running or any(
        job['status'] == HEALTH_ATTENTION for job in jobs.values())
    observed = any(job['at'] is not None for job in jobs.values())
    if attention:
        status = HEALTH_ATTENTION
    elif not observed:
        status = HEALTH_UNKNOWN
    else:
        status = HEALTH_OK
    return {
        'status': status,
        'now': instants.iso(now),
        'scheduler_running': scheduler_running,
        'jobs': jobs,
    }


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
    'HEALTH_OK', 'HEALTH_ATTENTION', 'HEALTH_UNKNOWN',
    'health_scrape', 'health_backfill', 'health_performance', 'build_health',
]
