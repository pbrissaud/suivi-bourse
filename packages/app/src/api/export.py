"""The exports under ``/api``: the ledger and the portfolio as files (#796, #836)."""

from flask import Blueprint, Response, request

from application import accounts as accounts_module
from application import ledger
from application import positions as positions_module
from application.events.schemas import EventType
from application.events import export as events_export
from application.store_reads import PortfolioReader
from api.problem import (
    unprocessable_request,
)
from api.common import (
    _store,
    _InvalidParameter,
    _argument,
    _day_argument,
)

bp = Blueprint('export', __name__)


EXPORT_FILENAMES = {
    'events.csv': 'suivi-bourse-events.csv',
    'events.xlsx': 'suivi-bourse-events.xlsx',
    'selection.csv': 'suivi-bourse-selection.csv',
    'selection.xlsx': 'suivi-bourse-selection.xlsx',
    'portfolio.csv': 'suivi-bourse-portfolio.csv',
}

XLSX_MIME = ('application/vnd.openxmlformats-officedocument'
             '.spreadsheetml.sheet')


@bp.get('/export/events.csv')
def export_events():
    """Every event, as a file this app imports."""
    try:
        selection = _selection()
    except _InvalidParameter as exc:
        return unprocessable_request(str(exc), key=exc.key)

    opened = _store()
    return _file_response(
        events_export.render_events(
            events_export.select(ledger.read_events(opened), selection),
            opened.setting('base_currency')),
        _export_name('csv', selection),
        'text/csv; charset=utf-8')


@bp.get('/export/events.xlsx')
def export_events_workbook():
    """The same ledger, as a workbook with **one sheet per year** (issue #796)."""
    try:
        selection = _selection()
    except _InvalidParameter as exc:
        return unprocessable_request(str(exc), key=exc.key)

    opened = _store()
    return _file_response(
        events_export.render_events_workbook(
            events_export.select(ledger.read_events(opened), selection),
            opened.setting('base_currency')),
        _export_name('xlsx', selection),
        XLSX_MIME)


@bp.get('/export/portfolio.csv')
def export_portfolio():
    """The accounts and their positions — **the entry that is a report** (#836)."""
    opened = _store()
    return _file_response(
        events_export.render_portfolio(
            accounts_module.read_accounts(opened),
            positions_module.read_account_states(opened),
            PortfolioReader(opened).positions(),
            opened.setting('base_currency')),
        EXPORT_FILENAMES['portfolio.csv'],
        'text/csv; charset=utf-8')


def _selection() -> events_export.Selection:
    """The reduction the ledger's chips hold, off the query string (issue #796)."""
    event_type = _argument('type')
    if event_type is not None:
        try:
            event_type = EventType(event_type.upper()).value
        except ValueError:
            raise _InvalidParameter(
                f"{event_type!r} is not an event type; "
                f"the six are {', '.join(kind.value for kind in EventType)}",
                'type')

    symbols = tuple(symbol for symbol in request.args.getlist('symbol')
                    if symbol.strip())
    return events_export.Selection(
        query=request.args.get('q', ''),
        event_type=event_type,
        account=_argument('account'),
        symbols=symbols or None,
        since=_day_argument('since'),
        until=_day_argument('until'))


def _export_name(suffix: str, selection: events_export.Selection) -> str:
    """What the browser saves the file as — and a reduction is not a backup."""
    subject = 'selection' if selection.reduces else 'events'
    return EXPORT_FILENAMES[f'{subject}.{suffix}']


def _file_response(body, filename: str, content_type: str) -> Response:
    """One exported file on the wire."""
    return Response(body, headers={
        'Content-Type': content_type,
        'Content-Disposition': f'attachment; filename="{filename}"',
    })
