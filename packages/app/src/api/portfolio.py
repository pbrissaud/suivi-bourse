"""The portfolio under ``/api``: positions, totals, prices, rhythm, benchmark."""
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request

from application import benchmark_view
from application import instants
from application import market
from application import portfolio_facts
from application import portfolio_view
from application import quotes
from application import rhythm
from application.events.aggregator import EventAggregator
from application.store_reads import chart_window
from api.problem import (
    bad_request,
    unprocessable_request,
)
from api.common import (
    DEFAULT_HISTORY_WINDOW,
    _reader,
    _snapshot,
    _carried,
    _store,
    _InvalidParameter,
    _argument,
    _day_argument,
    _base_currency,
    _parse_window,
)

bp = Blueprint('portfolio', __name__)


@bp.get('/portfolio/movers')
def get_portfolio_movers():
    """What moved since each line's previous close (#652 déc. 8, #1142)."""
    reader = _reader()
    movers = portfolio_view.build_movers(
        portfolio_view.build_shares(reader.positions(), _carried()),
        reader.previous_closes())
    return jsonify({'movers': [mover.to_dict() for mover in movers]})


@bp.get('/positions')
def list_positions():
    """The hot read of the portfolio — one query for the whole of it."""
    return jsonify(portfolio_facts.positions_payload(
        _store(), _snapshot(), datetime.now(timezone.utc)))


@bp.get('/portfolio-totals')
def get_portfolio_totals():
    """The newest day of the global perf series, plus three derived members."""
    return jsonify(portfolio_facts.totals_payload(_store()))


@bp.get('/portfolio-totals/history')
def get_portfolio_totals_history():
    """The global perf series — ``/api/accounts/<id>/history`` one level up (#721)."""
    try:
        start, stop = _parse_window(DEFAULT_HISTORY_WINDOW)
    except ValueError as exc:
        return bad_request(str(exc))

    return jsonify({
        'from': instants.iso(start),
        'to': instants.iso(stop),
        'points': [
            {
                't': instants.iso(row.get('day')),
                'cash_balance': row.get('cash_balance'),
                'holdings_value': row.get('holdings_value'),
                'total_value': row.get('total_value'),
                'net_contributed': row.get('net_contributed'),
                'twr_index': row.get('twr_index'),
            }
            for row in _reader().totals_series(start, stop)
        ],
    })


@bp.get('/positions/history')
def get_positions_history():
    """What the holdings were worth day by day, against what they cost (#727)."""
    try:
        start, stop = _parse_window(DEFAULT_HISTORY_WINDOW)
    except ValueError as exc:
        return bad_request(str(exc))

    reader = _reader()
    events = _snapshot().events
    timeline = EventAggregator().replay(events)
    return jsonify({
        'from': instants.iso(start),
        'to': instants.iso(stop),
        'points': portfolio_view.valuation_series(
            reader.daily_closes(start, stop), timeline.at,
            carried_in={row['symbol']: row['price']
                        for row in reader.prices_at(start)},
            carried=_carried(),
            first_quoted=quotes.first_quoted_days(_store()),
            # The ledger's symbols, the same scope `perf_job` values on.
            symbols={event.symbol for event in events if event.symbol}),
    })


@bp.get('/prices/<symbol>')
def get_prices(symbol: str):
    """One symbol's series over a **rung of the retention ladder** (#719, #763).

    With ``?at=<day>`` it answers **one close** instead, the last one at or
    before that day, and says which day it belongs to (#1007). That is not a
    narrower window: the grant form needs a single figure to suggest, and the
    narrowest rung here is a month of points to find it in — 1 623 of them on
    `MAX`, pulled on every keystroke, to read one.
    """
    try:
        at = _day_argument('at')
    except _InvalidParameter as exc:
        return unprocessable_request(str(exc), key=exc.key)

    if at is not None:
        close = _reader().close_on_or_before(symbol, at)
        return jsonify({
            'symbol': symbol,
            'base_currency': _base_currency(),
            # **Both members are `null` together, and the pair is the answer.**
            # No close before that day is a state of a fresh install and of a
            # symbol nobody scraped yet; the form has nothing to suggest and
            # says nothing, which is the field it was already offering.
            'day': instants.iso(close['day']) if close else None,
            'price': close['price'] if close else None,
        })

    try:
        span_days, bucket, resolution = chart_window(request.args.get('window'))
    except ValueError as exc:
        return unprocessable_request(str(exc), key='window')

    start = (None if span_days is None
             else datetime.now(timezone.utc) - timedelta(days=span_days))

    return jsonify(portfolio_view.build_price_series(
        symbol,
        _reader().chart_series(symbol, bucket, start),
        resolution,
        _base_currency()))


@bp.get('/securities')
def search_securities():
    """Yahoo's securities for what the event form's ticker field holds (#1268).

    ``securities`` has three states, like ``/prices/<s>?at=``: a list, ``[]``
    for *Yahoo answered nothing*, and ``null`` for *Yahoo did not answer* --
    the form still works then. The browser never talks to Yahoo; the server
    does, and keeps no cache (the front holds each query for five minutes).
    """
    query = _argument('q')
    if query is None or not 2 <= len(query) <= 64:
        return unprocessable_request(
            'q must be 2 to 64 characters', key='q')
    return jsonify({'query': query,
                    'securities': market.search_securities(query)})


@bp.get('/investment-rhythm')
def get_investment_rhythm():
    """How much the owner buys in a month, and how often — derived, never stored."""
    return jsonify({
        'base_currency': _base_currency(),
        **rhythm.measure(_snapshot().events,
                         datetime.now(timezone.utc)).to_dict(),
    })


@bp.get('/benchmark')
def get_benchmark():
    """The comparison of #760 — the figure and the right to display it, together.

    One route and one payload, because the two cannot be allowed to disagree:
    the gap, the period it covers and ``terminal`` arrive in the same read, so
    the screen can never draw a number over a series that is still being
    fetched. A second read for terminality would be a second chance to be
    wrong.

    No MCP tool beside it yet. The milestone orders #958 and the surface it
    guards in that order, and this is the one screen of the product carrying a
    tax figure — a description nothing checks is exactly the defect #958 exists
    to catch.
    """
    return jsonify({
        'base_currency': _base_currency(),
        **benchmark_view.comparison(_store(), _snapshot(),
                                    datetime.now(timezone.utc)),
    })
