"""An import in two steps: a preview that writes nothing, then a commit (§ 3.4).

:func:`judge` reads the lines of a file against the ledger and gives each a
status; :func:`keep` holds a preview between the two requests, under a token.
The commit **judges again** under the writers' lock, against the ledger as it is
then: a row that became a duplicate in between is skipped, not written twice.
"""
import math
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Dict, List, Mapping, Optional, Sequence

from application import ledger
from application.events.schemas import DEFAULT_ACCOUNT, Event, EventType, canonical_symbol, is_ascii_symbol
from application.import_formats import SECURITY_TYPES, Line, Reading

NEW = 'new'
DUPLICATE = 'duplicate'
UNKNOWN_SECURITY = 'unknown_security'
UNREADABLE = 'unreadable'

#: Two prices (or amounts) this close are the same one.
TOLERANCE = 0.01

#: How many previews are held, and for how long: a preview is a minute's work.
MAX_HELD = 8
HOLD_SECONDS = 3600


class InvalidResolution(ValueError):
    """A resolution names a row or a security that cannot be."""


@dataclass(frozen=True)
class Row:
    """One line of the preview, judged."""

    n: int
    status: str
    event: Optional[Event] = None
    isin: Optional[str] = None
    reason: Optional[str] = None
    matched_event_id: Optional[int] = None
    matched_on: Optional[List[str]] = None


@dataclass(frozen=True)
class Held:
    """A preview waiting for its commit."""

    account_id: str
    reading: Reading
    at: float


_held: 'OrderedDict[str, Held]' = OrderedDict()
_lock = threading.Lock()


def keep(account_id: str, reading: Reading) -> str:
    """Hold a reading for the commit, and answer the token that names it."""
    token = secrets.token_urlsafe(24)
    now = time.monotonic()
    with _lock:
        for old in [t for t, h in _held.items() if now - h.at > HOLD_SECONDS]:
            del _held[old]
        _held[token] = Held(account_id, reading, now)
        while len(_held) > MAX_HELD:
            _held.popitem(last=False)
    return token


def recall(token: str) -> Optional[Held]:
    """The preview under ``token`` if it is still held."""
    with _lock:
        held = _held.get(token)
        if held and time.monotonic() - held.at > HOLD_SECONDS:
            del _held[token]
            return None
        return held


def release(token: str) -> None:
    """A preview that was committed is spent."""
    with _lock:
        _held.pop(token, None)


def judge(store, account_id: str, lines: Sequence[Line],
          associate: Optional[Mapping[int, str]] = None) -> List[Row]:
    """Every line against the ledger of ``account_id``: its status, and what it repeats.

    ``associate`` maps a row number to the symbol the owner says its security
    is; it settles every row of the file that carries the same ISIN.
    """
    chosen = _chosen(associate or {}, lines)
    isins = {isin: symbol for isin, symbol in store.query(
        'SELECT isin, symbol FROM symbol_isin')}
    isins.update({line.isin: chosen[line.n] for line in lines
                  if line.isin and line.n in chosen})
    names = {(row.name or '').casefold(): row.symbol
             for row in ledger.read_events(store) if row.symbol and row.name}
    held = _held_by_day(store, account_id)

    rows = []
    for line in lines:
        if line.event is None:
            rows.append(Row(line.n, UNREADABLE, reason=line.reason))
            continue
        event = replace(line.event, account=account_id)
        if event.event_type not in SECURITY_TYPES:
            rows.append(_matched(line, event, held, 'date'))
            continue
        symbol = chosen.get(line.n) or event.symbol
        via = 'isin' if line.isin else 'symbol'
        if not symbol and line.isin:
            symbol = isins.get(line.isin)
        if not symbol and event.name:
            symbol, via = names.get(event.name.casefold()), 'symbol'
        if not symbol:
            rows.append(Row(line.n, UNKNOWN_SECURITY, event, line.isin))
            continue
        rows.append(_matched(line, replace(event, symbol=symbol), held, via))
    return rows


def _chosen(associate: Mapping[int, str], lines: Sequence[Line]) -> Dict[int, str]:
    numbers = {line.n for line in lines}
    chosen = {}
    for n, security in associate.items():
        symbol = canonical_symbol(security)
        if n not in numbers:
            raise InvalidResolution(f"row {n} is not a row of this file")
        if not symbol or not is_ascii_symbol(symbol):
            raise InvalidResolution(f"{security!r} is not a ticker")
        chosen[n] = symbol
    return chosen


def _held_by_day(store, account_id: str) -> Dict:
    held: Dict = {}
    for event in ledger.read_events(store):
        if (event.account or DEFAULT_ACCOUNT) == account_id:
            held.setdefault((event.event_type, event.date), []).append(event)
    return held


def _close(a: Optional[float], b: Optional[float], tolerance: float) -> bool:
    return a is not None and b is not None and math.isclose(a, b, abs_tol=tolerance)


def _matched(line: Line, event: Event, held: Mapping, via: str) -> Row:
    """``event`` as a duplicate of a held event of the same day, or as new."""
    kind = event.event_type
    for other in held.get((kind, event.date), ()):
        if kind in (EventType.BUY, EventType.SELL, EventType.GRANT):
            if other.symbol != event.symbol or not _close(
                    other.quantity, event.quantity, 1e-6):
                continue
            if kind != EventType.GRANT and not _close(
                    other.unit_price, event.unit_price, TOLERANCE):
                continue
            on = [via, 'date', 'quantity', 'price']
        elif kind == EventType.DIVIDEND:
            if other.symbol != event.symbol or not _close(
                    other.amount, event.amount, TOLERANCE):
                continue
            on = [via, 'date', 'amount']
        else:
            if not _close(other.amount, event.amount, TOLERANCE):
                continue
            on = ['date', 'amount']
        return Row(line.n, DUPLICATE, event, line.isin,
                   matched_event_id=other.id, matched_on=on)
    return Row(line.n, NEW, event, line.isin)


def remember_isins(store, rows: Sequence[Row]) -> None:
    """Tie each ISIN of the rows written to the symbol it was written under."""
    for row in rows:
        if row.isin and row.event and row.event.symbol:
            store.execute(
                'INSERT INTO symbol_isin (isin, symbol) VALUES (?, ?) '
                'ON CONFLICT DO NOTHING', [row.isin, row.event.symbol])


__all__ = [
    'NEW', 'DUPLICATE', 'UNKNOWN_SECURITY', 'UNREADABLE', 'InvalidResolution',
    'Row', 'judge', 'keep', 'recall', 'release', 'remember_isins',
]
