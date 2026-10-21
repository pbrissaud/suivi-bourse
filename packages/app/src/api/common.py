"""What the ``/api`` blueprints share: the reads, the parsing, the refusals."""
from datetime import date, datetime, timedelta, timezone
from typing import Optional, Tuple

from flask import request

from application import instants
from application.event_body import ISO_DAY as _ISO_DAY
from application import quotes
from application import runtime_view
from application.events.aggregator import AggregationError
from application.store_reads import PortfolioReader
from api.problem import (
    unreplayable,
)

DEFAULT_WINDOW = timedelta(days=30)

DEFAULT_HISTORY_WINDOW = timedelta(days=365)


def _reader() -> PortfolioReader:
    """A reader over the worker's open store."""
    return PortfolioReader(_store())


def _snapshot():
    """The published configuration snapshot — the lock-free read (issue #658)."""
    return current_runtime().config_manager.current()


def _carried():
    """The symbols a position may be carried at cost on (issue #706)."""
    return quotes.terminal_symbols(
        _store(), _snapshot().backfill_windows(), datetime.now(timezone.utc))


def _store():
    """The worker's **read view** on the open store (issues #697, #967).

    Every read in the ``/api`` blueprints goes through here, and none of them writes —
    the writes take ``config_manager.writing()``, which stays on the store's own
    connection. So the reads get a connection of their own and stop waiting
    behind a background pass that holds a transaction for seconds.
    """
    runtime = current_runtime()
    if runtime.store is None:
        raise RuntimeError("the store is not open in this process")
    return runtime.store.reader()


def current_runtime():
    """The process's runtime, imported late to avoid a cycle at import time."""
    from api import current_runtime as _current
    return _current()


def _rebuilding() -> bool:
    """Is the reconstruction still covering windows? — process memory, no query."""
    runtime = current_runtime()
    return runtime_view.is_rebuilding(
        runtime.workloads.reconstruction_state()
        if runtime.workloads is not None else None)


def _unreplayable(exc: AggregationError, gesture: str):
    """The one answer every route gives an oversell (issue #824)."""
    return unreplayable(
        str(exc), gesture,
        symbol=exc.symbol, wanted=exc.wanted, owned=exc.owned,
        day=exc.day.isoformat() if exc.day is not None else None,
        account=exc.account)


class _InvalidParameter(Exception):
    """A query parameter carrying a value the product does not know."""

    def __init__(self, message: str, key: str):
        super().__init__(message)
        self.key = key


def _argument(name: str) -> Optional[str]:
    """One query parameter, ``None`` when it is absent **or blank**."""
    value = request.args.get(name)
    return value.strip() if value and value.strip() else None


def _day_argument(name: str) -> Optional[date]:
    """One bound of the period, ``None`` when it is absent **or blank**."""
    value = _argument(name)
    if value is None:
        return None
    if not _ISO_DAY.fullmatch(value):
        raise _InvalidParameter(
            f"{name} {value!r} is not a calendar day (YYYY-MM-DD)", name)
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise _InvalidParameter(
            f"{name} {value!r} is not a day that exists", name)


def _json_object() -> Optional[dict]:
    """The request body as a JSON object, or ``None`` if it is not one."""
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else None


def _flag(value) -> bool:
    """One optional boolean out of a JSON body, and never a truthiness test."""
    return value is True


def _base_currency() -> Optional[str]:
    """The reporting currency, or ``None`` while the question is unanswered."""
    return _store().setting('base_currency')


def _parse_window(default: timedelta = DEFAULT_WINDOW) -> Tuple[datetime, datetime]:
    """Resolve ``?from=``/``?to=`` into a UTC window, defaulting to ``default``."""
    stop = _parse_instant(request.args.get('to')) or datetime.now(timezone.utc)
    start = _parse_instant(request.args.get('from')) or (stop - default)
    if start >= stop:
        raise ValueError("'from' must be earlier than 'to'")
    return start, stop


def _parse_instant(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO-8601 date or datetime, always returning UTC-aware.

    *Always*, including the value that arrives carrying an offset of its own:
    ``?from=2024-01-15T00:00:00+02:00`` used to come back in ``+02:00`` and be
    echoed as such beside points whose ``t`` is in ``+00:00`` (issue #861).
    :func:`instants.utc` is the one repair, and it holds both halves — a naive
    instant means UTC, an aware one is converted to it.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        raise ValueError(f"Not an ISO-8601 instant: {value!r}")
    return instants.utc(parsed)
