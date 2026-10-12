"""The four gain terms at the day a window opens — ``GET /api/portfolio/gain-baseline`` (#1156).

The card « D'où vient le gain » decomposes the gain since inception from
``/api/positions``. Over a window it draws ``term(now) − term(B)``, where **B is
the baseline day**: the close of the day before the window starts. This module
answers the four terms at B; the front subtracts them from the ones it already
holds, so « since inception » makes no request at all.

**The anchor is the series, not the wall clock**, as for ``totals.ytd``: the
window ends on the newest ``portfolio_totals`` day. The latent term at B is the
perf job's own ``holdings_value`` (converted closes, carried symbols at their
carrying price) minus the replayed cost basis, which is what makes the four
terms at B sum to ``gain_absolu(B)``.
"""
from datetime import date, timedelta
from typing import Any, Dict, Optional

from application import accounts as accounts_module
from application import instants
from application import portfolio_view
from application.events.aggregator import EventAggregator
from application.store_reads import PortfolioReader

PERIODS = ('ytd', '12m')

REBUILDING = 'rebuilding'


def baseline_day(period: str, last_day: date) -> date:
    """The close the window counts from: ``ytd`` the previous 31 December,
    ``12m`` the day before the same day a year earlier (29 February → 28)."""
    if period == 'ytd':
        return portfolio_view.ytd_base_day(last_day)
    try:
        year_ago = last_day.replace(year=last_day.year - 1)
    except ValueError:
        year_ago = last_day.replace(year=last_day.year - 1, day=28)
    return year_ago - timedelta(days=1)


def _payload(period: str, day: Optional[date], since: Optional[date],
             clamped: bool, terms: Dict[str, Any]) -> Dict[str, Any]:
    return {'period': period, 'day': instants.iso(day),
            'since': instants.iso(since), 'clamped': clamped, 'terms': terms}


def _zero(unknown: Optional[str]) -> Dict[str, Any]:
    return {'unrealised': None if unknown else 0.0,
            'unrealised_unknown': unknown, 'realised': 0.0, 'dividends': 0.0,
            'transfer_fees': 0.0, 'holds_position': False}


def measure(store, events, period: str) -> Dict[str, Any]:
    """The payload of ``GET /api/portfolio/gain-baseline``. Reads, never writes."""
    reader = PortfolioReader(store)
    latest = reader.latest_totals()
    if latest is None or not events:
        return _payload(period, None, None, False, _zero(REBUILDING))

    day = baseline_day(period, latest['day'])
    first_event = min(event.date for event in events)
    if first_event > day:
        return _payload(period, None, first_event, True, _zero(None))

    first_day = reader.first_totals_day()
    clamped = first_day > day
    if clamped:
        day = first_day

    timeline = EventAggregator().replay(events)
    declared = {account.id for account in accounts_module.read_accounts(store)}
    realised = dividends = cost_basis = 0.0
    holds = False
    for account, symbol in timeline.snapshots:
        if account not in declared:
            continue
        state = timeline.position_at(account, symbol, day)
        if state is None:
            continue
        realised += state['realized_gain']
        dividends += state['received_dividend']
        cost_basis += state['cost_basis']
        holds = holds or state['quantity'] > 0

    point = reader.totals_on_or_before(day)
    unrealised = None
    at_b = point is not None and point['day'] == day
    if at_b and point['holdings_value'] is not None:
        unrealised = point['holdings_value'] - cost_basis

    return _payload(period, day, day + timedelta(days=1), clamped, {
        'unrealised': unrealised,
        'unrealised_unknown': None if unrealised is not None else REBUILDING,
        'realised': realised,
        'dividends': dividends,
        'transfer_fees': reader.transfer_fees(day),
        'holds_position': holds,
    })
