"""The ``/api`` blueprint — the disposable half (issue #659, design #655).

#655 decision 1 is what shapes this file: **the for-keeps boundary is Python,
not HTTP**. What must last is :mod:`influx_reads` and :mod:`portfolio_view` —
the SQL window, the weighted mean, the three states of absence. A route that
calls a primitive and ``jsonify``s is five lines, and is as throwaway as the
React on the other side of it.

So the rules here are thin on purpose. What the routes *do* own:

* **Shape.** RESTful, resource by resource, because resources deduplicate
  across pages: #652 déc. 8 serves the shares table *and* the dashboard's
  allocation + movers from one query, and a page-shaped endpoint would have
  re-split what that decision unified. ``/api/shares`` with two consumers and
  one client cache is the HTTP expression of it.
* **Windows on series sub-resources only.** #652 déc. 1 made stats absolute;
  the window drives charts alone, so it appears on ``/prices`` and nowhere else.
* **Symbols as identity.** Trap 9 / déc. 3 — ``share_name`` is display only.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

from flask import Blueprint, jsonify, request
from logfmt_logger import getLogger

import portfolio_view
from events.editor import EventEditorReader
from influx_reads import PortfolioReader, bucket_for_window
from web.problem import bad_request, not_found, storage_unavailable

logger = getLogger("web.api")

api_bp = Blueprint('api', __name__, url_prefix='/api')

#: Default chart window when the client asks for none. Short on purpose: the
#: ``REGULAR`` cadence is one point every 120 s, so a month is already a few
#: thousand points and a year is fifty thousand.
DEFAULT_WINDOW = timedelta(days=30)


def _reader() -> PortfolioReader:
    """A reader over the worker's InfluxDB client.

    Built per request, which is free — it holds nothing but the bound ``query``
    of the pool created in ``post_fork``. Raises when the runtime has not
    started, which under gunicorn cannot happen (the socket is not served until
    the worker is up) but does in tests.
    """
    from web import current_runtime
    runtime = current_runtime()
    if runtime.metrics is None:
        raise RuntimeError(
            "the scheduler runtime has not started; no InfluxDB client yet")
    return PortfolioReader.from_writer(runtime.metrics.influxdb)


def _snapshot():
    """The published configuration snapshot — the lock-free read (issue #658)."""
    from web import current_runtime
    return current_runtime().config_manager.current()


@api_bp.errorhandler(Exception)
def _on_error(exc: Exception):
    """Turn anything a route raises into problem+json.

    This is the point of the sibling read module: the writer swallows and
    returns ``None``, this blueprint lets the exception travel and answers
    ``503``. The two policies coexist in one process because they live in two
    modules (#655 decision 5).
    """
    logger.error(f"API error on {request.path}: {exc}", exc_info=True)
    return storage_unavailable(str(exc))


# --------------------------------------------------------------------- #
# Shares
# --------------------------------------------------------------------- #

@api_bp.get('/shares')
def list_shares():
    """The shares table — one row per share, aggregated across accounts.

    P1 generalised: **one** query for the whole portfolio (#652 déc. 8), folded
    by the pure module. Empty portfolio is ``200`` + ``[]``, never a 404.
    """
    rows = _reader().latest_per_account()
    shares = portfolio_view.build_shares(rows)
    return jsonify([share.to_dict() for share in shares])


@api_bp.get('/shares/<symbol>')
def get_share(symbol: str):
    """One share's detail sheet: the aggregate plus its per-account breakdown."""
    rows = _reader().latest_per_account(share_symbol=symbol)
    share = portfolio_view.build_share(rows, symbol)
    if share is None:
        return not_found(f"No stored data for symbol {symbol!r}")
    return jsonify(share.to_dict())


@api_bp.get('/shares/<symbol>/prices')
def get_share_prices(symbol: str):
    """The price series behind the chart, over ``?from=``/``?to=``.

    The one place a window exists. Wide windows are served downsampled — see
    :func:`influx_reads.bucket_for_window`; the response says which bucket it
    used so the chart is never silently lying about its resolution.

    Gaps are returned as gaps (#606): a weekend is missing rows, not zeros, and
    whether to bridge them is the chart's call — ``connectNulls`` is a
    per-series prop, and #650's trap 5 records that the two Grafana dashboards
    deliberately disagree about it.
    """
    try:
        start, stop = _parse_window()
    except ValueError as exc:
        return bad_request(str(exc))

    reader = _reader()
    bucket = bucket_for_window((stop - start).total_seconds() / 86400)
    if bucket is None:
        rows = reader.raw_series(symbol, start, stop)
    else:
        rows = reader.bucketed_series(symbol, bucket, start, stop)

    return jsonify({
        'symbol': symbol,
        'from': start.isoformat(),
        'to': stop.isoformat(),
        'bucket': bucket,
        'points': [
            {'t': _iso(row.get('time')), 'price': row.get('share_price')}
            for row in rows
        ],
    })


# --------------------------------------------------------------------- #
# Accounts — read-only in this slice
# --------------------------------------------------------------------- #

@api_bp.get('/accounts')
def list_accounts():
    """The **declared** accounts, from ``settings.yaml``.

    #652 déc. 4 corrects trap 12 here, and it matters for the page's global
    filter. The obvious source would be a ``DISTINCT`` on the ``account`` tag,
    but ``validator.py:128-138`` makes every event carry a *declared* account
    once any account is declared — so an account that holds shares without being
    declared cannot exist, and the two lists differ only on historical residue
    (an account since removed, the pre-v4.1 ``default`` bucket). Reading the
    declaration also hands over ``label``, ``type`` and ``currency``: three
    fields the app writes and **zero** Grafana panel reads (it hardcodes
    ``currencyEUR``).

    ``declared: false`` is a *designed* state, not an empty one — the opt-out
    setup every default install runs. Stating it explicitly rather than letting
    the front infer it from ``[]`` is #655 decision 8's discriminator rule.
    """
    accounts = _snapshot().accounts
    if accounts is None:
        return jsonify({'declared': False, 'accounts': []})
    return jsonify({
        'declared': True,
        'accounts': [
            {'id': a.id, 'label': a.label, 'type': a.type, 'currency': a.currency}
            for a in accounts.accounts
        ],
    })


# --------------------------------------------------------------------- #
# Events — read-only in this slice; the write half belongs to the Data page
# --------------------------------------------------------------------- #

@api_bp.get('/events')
def list_events():
    """The event ledger, addressable row by row.

    Two consumers already, which is why it is a resource and not a page
    endpoint: the data page's ledger (#652 déc. 14) and *this* slice's chart
    markers (déc. 11) — the single thing Grafana structurally cannot draw, since
    it reads one datasource and the events are files.

    ``?symbol=`` narrows to one share's events. Cash events (DEPOSIT /
    WITHDRAWAL) carry no symbol and are therefore excluded by that filter, which
    is what the chart wants.

    Manual mode has no events at all: ``200`` + ``[]``, the empty-collection
    state, not an error.
    """
    from web import current_runtime
    manager = current_runtime().config_manager
    if manager.get_mode() != manager.MODE_EVENTS:
        return jsonify([])

    source = manager.get_events_source()
    if not source:
        return jsonify([])

    records = EventEditorReader(source).list_records()

    symbol = request.args.get('symbol')
    if symbol:
        records = [
            r for r in records
            if r.event is not None and r.event.symbol == symbol
        ]

    return jsonify([record.to_dict() for record in records])


# --------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------- #

def _parse_window() -> Tuple[datetime, datetime]:
    """Resolve ``?from=``/``?to=`` into a UTC window, defaulting to 30 days."""
    stop = _parse_instant(request.args.get('to')) or datetime.now(timezone.utc)
    start = _parse_instant(request.args.get('from')) or (stop - DEFAULT_WINDOW)
    if start >= stop:
        raise ValueError("'from' must be earlier than 'to'")
    return start, stop


def _parse_instant(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO-8601 date or datetime, always returning UTC-aware.

    Accepts a bare date (``2024-01-15``) as midnight UTC, and tolerates the
    ``Z`` suffix ``fromisoformat`` rejected before Python 3.11 — the app targets
    3.10+, so the replacement stays.
    """
    if not value:
        return None
    text = value.strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(f"Not an ISO-8601 instant: {value!r}")
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _iso(value) -> Optional[str]:
    return value.isoformat() if isinstance(value, datetime) else None


__all__ = ['api_bp']
