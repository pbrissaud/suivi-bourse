"""The ``/api`` blueprint — the disposable half (issue #659, design #655)."""
import re
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional, Sequence, Tuple
from urllib.parse import urlsplit

import duckdb
from flask import Blueprint, Response, jsonify, request
from logfmt_logger import getLogger

from application import accounts as accounts_module
from application import advisories
from application import entries
from application import installation_facts
from application import instants
from application import ledger
from application import main
from application import portfolio_view
from application import positions as positions_module
from application import quotes
from application import reassignment
from application import rhythm
from application import runtime_view
from application import settings as settings_module
from application import settings_registry
from application import store as store_module
from application import uploads
from application.events.aggregator import EventAggregator
from application.events.schemas import Event, EventType
from application.events import export as events_export
from application.events.aggregator import AggregationError
from application.store_reads import PortfolioReader, chart_window
from api.problem import (
    GESTURE_REMOVE,
    GESTURE_WRITE,
    bad_request,
    conflict,
    entry_gone,
    foreign_origin,
    internal_error,
    not_found,
    storage_unavailable,
    too_large,
    unprocessable,
    unprocessable_entry,
    unprocessable_file,
    unprocessable_parameter,
    unreplayable,
)

logger = getLogger("api.api")

api_bp = Blueprint('api', __name__, url_prefix='/api')

DEFAULT_WINDOW = timedelta(days=30)

DEFAULT_HISTORY_WINDOW = timedelta(days=365)

SAFE_METHODS = frozenset({'GET', 'HEAD', 'OPTIONS'})

_ISO_DAY = re.compile(r'\d{4}-\d{2}-\d{2}')


def _reader() -> PortfolioReader:
    """A reader over the worker's open store."""
    return PortfolioReader(_store())


def _snapshot():
    """The published configuration snapshot — the lock-free read (issue #658)."""
    return current_runtime().config_manager.current()


def _carried():
    """The symbols a position may be carried at cost on (issue #706, ADR-0004)."""
    return quotes.terminal_symbols(
        _store(), _snapshot().backfill_windows(), datetime.now(timezone.utc))


def _store():
    """The worker's open store (issue #697)."""
    runtime = current_runtime()
    if runtime.store is None:
        raise RuntimeError("the store is not open in this process")
    return runtime.store


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


@api_bp.before_request
def _refuse_a_foreign_origin():
    """No page but this app's own writes through ``/api``."""
    if request.method in SAFE_METHODS:
        return None
    origin = request.headers.get('Origin')
    if not origin:
        return None
    if urlsplit(origin).netloc.lower() == request.host.lower():
        return None
    return foreign_origin(
        f"this write came from {origin}, which is not the page this app "
        f"serves; /api is the front's interface and the front is served from "
        f"the same address")


@api_bp.errorhandler(Exception)
def _on_error(exc: Exception):
    """Turn anything a route raises into problem+json."""
    logger.error(f"API error on {request.path}: {exc}", exc_info=True)
    if isinstance(exc, (store_module.StoreUnavailable, duckdb.Error)):
        return storage_unavailable(str(exc))
    return internal_error(str(exc))


@api_bp.get('/portfolio/movers')
def get_portfolio_movers():
    """What moved since the last session close (#652 déc. 8)."""
    reader = _reader()
    rows = reader.positions()

    times = [row['price_time'] for row in rows
             if isinstance(row.get('price_time'), datetime)]
    if not times:
        return jsonify({'since': None, 'reference': None, 'movers': []})

    since = portfolio_view.session_baseline_instant(max(times))
    baseline = reader.prices_at(since)
    movers = portfolio_view.build_movers(
        portfolio_view.build_shares(rows, _carried()), baseline)

    return jsonify({
        'since': since.isoformat(),
        'reference': instants.iso(portfolio_view.baseline_reference(baseline)),
        'movers': [mover.to_dict() for mover in movers],
    })


@api_bp.get('/positions')
def list_positions():
    """The hot read of the portfolio — one query for the whole of it."""
    currency = _base_currency()
    return jsonify({
        'base_currency': currency,
        'positions': portfolio_view.build_positions(
            _reader().positions(), currency, _carried()),
    })


@api_bp.get('/portfolio-totals')
def get_portfolio_totals():
    """The newest day of the global perf series, plus three derived members."""
    reader = _reader()
    latest = reader.latest_totals()

    totals = None
    if latest is not None:
        day = latest['day']
        totals = portfolio_view.build_portfolio_totals(
            latest,
            reader.totals_on_or_before(portfolio_view.ytd_base_day(day)),
            reader.twr_origin(),
            reader.transfer_fees(day))

    return jsonify({'base_currency': _base_currency(), 'totals': totals})


@api_bp.get('/portfolio-totals/history')
def get_portfolio_totals_history():
    """The global perf series — ``/api/accounts/<id>/history`` one level up (#721)."""
    try:
        start, stop = _parse_window(DEFAULT_HISTORY_WINDOW)
    except ValueError as exc:
        return bad_request(str(exc))

    return jsonify({
        'from': start.isoformat(),
        'to': stop.isoformat(),
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


@api_bp.get('/positions/history')
def get_positions_history():
    """What the holdings were worth day by day, against what they cost (#727)."""
    try:
        start, stop = _parse_window(DEFAULT_HISTORY_WINDOW)
    except ValueError as exc:
        return bad_request(str(exc))

    reader = _reader()
    timeline = EventAggregator().replay(_snapshot().events)
    return jsonify({
        'from': start.isoformat(),
        'to': stop.isoformat(),
        'points': portfolio_view.valuation_series(
            reader.daily_closes(start, stop), timeline.at,
            carried_in={row['symbol']: row['price']
                        for row in reader.prices_at(start)},
            carried=_carried(),
            first_quoted=quotes.first_quoted_days(_store())),
    })


@api_bp.get('/prices/<symbol>')
def get_prices(symbol: str):
    """One symbol's series over a **rung of the retention ladder** (#719, #763)."""
    try:
        span_days, bucket, resolution = chart_window(request.args.get('window'))
    except ValueError as exc:
        return unprocessable_parameter(str(exc), key='window')

    start = (None if span_days is None
             else datetime.now(timezone.utc) - timedelta(days=span_days))

    return jsonify(portfolio_view.build_price_series(
        symbol,
        _reader().chart_series(symbol, bucket, start),
        resolution,
        _base_currency()))


@api_bp.get('/accounts')
def list_accounts():
    """The **declared** accounts, each with its newest perf figures."""
    accounts = _snapshot().accounts
    declaration = accounts.accounts if accounts is not None else _seeded_only()
    declaration = [accounts_module.as_declared(row) for row in declaration]
    reader = _reader()
    rows = reader.latest_account_metrics()
    through = {
        row['account']: row['day'] for row in rows
        if row.get('account') is not None and row.get('day') is not None
    }
    return jsonify({
        'declared': accounts is not None,
        'accounts': [
            summary.to_dict()
            for summary in portfolio_view.build_accounts(
                declaration, rows, reader.transfer_fees_by_account(through))
        ],
    })


def _seeded_only():
    """The ``default`` row as the store holds it — the whole declaration."""
    return [row for row in accounts_module.read_accounts(_store())
            if row.id == accounts_module.DEFAULT_ACCOUNT]


@api_bp.get('/accounts/<account_id>/history')
def get_account_history(account_id: str):
    """One account's perf series — the TWR chart and the detail sheet's curve."""
    accounts = _snapshot().accounts
    if accounts is not None:
        known = accounts.get(account_id) is not None
    else:
        known = any(row.id == account_id for row in _seeded_only())
    if not known:
        return not_found(f"No declared account {account_id!r}")

    try:
        start, stop = _parse_window(DEFAULT_HISTORY_WINDOW)
    except ValueError as exc:
        return bad_request(str(exc))

    return jsonify({
        'account': account_id,
        'from': start.isoformat(),
        'to': stop.isoformat(),
        'points': [
            {
                't': instants.iso(row.get('day')),
                'cash_balance': row.get('cash_balance'),
                'holdings_value': row.get('holdings_value'),
                'total_value': row.get('total_value'),
                'net_contributed': row.get('net_contributed'),
                'twr_index': row.get('twr_index'),
            }
            for row in _reader().account_series(account_id, start, stop)
        ],
    })


@api_bp.post('/accounts')
def create_account():
    """Declare an account — the one place one is born (ADR-0034)."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            with opened.transaction():
                account = accounts_module.create_account(
                    opened, body.get('id'), body.get('type'), body.get('label'))
                if _flag(body.get('reassign')):
                    reassignment.reassign_unassigned(opened, account.id)
    except accounts_module.DuplicateAccount as exc:
        return conflict(str(exc))
    except accounts_module.AccountSourceError as exc:
        return bad_request(str(exc))
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_WRITE)

    main.replay_after_write(runtime)
    return jsonify(_account_to_dict(account)), 201


@api_bp.post('/accounts/<account_id>/reassignment')
def reassign_unassigned_events(account_id: str):
    """Move every event naming the seeded row onto a declared account (#725)."""
    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            with opened.transaction():
                moved = reassignment.reassign_unassigned(opened, account_id)
    except accounts_module.UnknownAccount as exc:
        return not_found(str(exc))
    except reassignment.NotReassignable as exc:
        return conflict(str(exc))
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_WRITE)

    main.replay_after_write(runtime)
    return jsonify({'account': account_id, 'reassigned': moved})


@api_bp.patch('/accounts/<account_id>')
def update_account(account_id: str):
    """Relabel or retype an account created in the app."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            account = accounts_module.update_account(
                opened, account_id,
                account_type=body.get('type'), label=body.get('label'))
    except accounts_module.UnknownAccount as exc:
        return not_found(str(exc))

    main.replay_after_write(runtime)
    return jsonify(_account_to_dict(account))


@api_bp.delete('/accounts/<account_id>')
def delete_account(account_id: str):
    """Remove an account created in the app."""
    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            accounts_module.delete_account(opened, account_id)
    except accounts_module.UnknownAccount as exc:
        return not_found(str(exc))
    except accounts_module.AccountInUse as exc:
        return conflict(str(exc))

    main.replay_after_write(runtime)
    return jsonify({'id': account_id, 'removed': True})


def _account_to_dict(account) -> dict:
    """One :class:`events.schemas.Account`, on the wire."""
    return {
        'id': account.id,
        'type': account.type,
        'label': account.label,
    }


@api_bp.get('/events')
def list_events():
    """The event ledger, as the published snapshot holds it."""
    events = _snapshot().events

    symbol = request.args.get('symbol')
    if symbol:
        events = [event for event in events if event.symbol == symbol]

    return jsonify([_event_to_dict(event) for event in events])


def _event_to_dict(event) -> dict:
    """One :class:`events.schemas.Event`, on the wire."""
    return {key: store_module.finite(value) for key, value in {
        'id': str(event.id) if event.id is not None else None,
        'date': event.date.isoformat() if event.date else None,
        'event_type': event.event_type.value,
        'symbol': event.symbol,
        'name': event.name,
        'quantity': event.quantity,
        'unit_price': event.unit_price,
        'fee': event.fee,
        'amount': event.amount,
        'notes': event.notes,
        'account': event.account,
    }.items()}


@api_bp.post('/events')
def create_event():
    """Record one event typed in the app (issue #764, ADR-0005)."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    try:
        draft = _event_from_body(body)
    except _InvalidBody as exc:
        return unprocessable_entry(str(exc), key=exc.field)

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            created = entries.create(opened, draft)
    except entries.InvalidEntry as exc:
        return unprocessable_entry(str(exc), key=exc.field)
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_WRITE)

    main.replay_after_write(runtime)
    return jsonify(_event_to_dict(created)), 201


@api_bp.post('/events/import')
def import_events():
    """One file handed over, read once, and written as ordinary events (#811)."""
    if uploads.oversize(request.content_length):
        return too_large(uploads.too_large_detail(), uploads.MAX_UPLOAD_BYTES)

    upload = request.files.get('file')
    if upload is None:
        return bad_request(
            "a file is required, as the 'file' part of a multipart/form-data "
            "body")

    dry_run = _asked('dry_run')
    write_duplicates = _asked('write_duplicates')
    adopt_currency = _unless_declined('adopt_currency')

    try:
        parsed = uploads.read(upload.filename or '', upload.stream)
        correspondence = uploads.mapping(request.args.get('map'),
                                         request.args.getlist('declare'))
    except uploads.UploadTooLarge as exc:
        return too_large(str(exc), uploads.MAX_UPLOAD_BYTES)
    except uploads.UploadRefused as exc:
        return unprocessable_file(str(exc))

    census = uploads.census(parsed.events)

    runtime = current_runtime()
    try:
        if dry_run:
            opened = runtime.config_manager.store
            settled = _settled_mapping(opened, correspondence, census)
            declared = ledger.currency_to_adopt(opened,
                                                parsed.declared_currency)
            stated = _stated_currency(parsed.declared_currency)
            rows = settled.applied(parsed.events)
            fresh, duplicates = _to_write(opened, rows, write_duplicates)
            entries.judge(opened, fresh, declaring=settled.declaring,
                          accounts_pending=settled.stated)
            written = len(fresh)
        else:
            with runtime.config_manager.writing() as opened:
                settled = _settled_mapping(opened, correspondence, census)
                declared = ledger.currency_to_adopt(opened,
                                                    parsed.declared_currency)
                stated = _stated_currency(parsed.declared_currency)
                rows = settled.applied(parsed.events)
                fresh, duplicates = _to_write(opened, rows, write_duplicates)
                written = len(entries.create_many(
                    opened, fresh,
                    base_currency=declared if adopt_currency else None,
                    declare_accounts=settled.declaring))
    except uploads.UploadRefused as exc:
        return unprocessable_file(str(exc))
    except accounts_module.AccountSourceError as exc:
        return unprocessable_file(str(exc))
    except settings_registry.InvalidSetting as exc:
        return unprocessable_file(str(exc))
    except entries.InvalidEntry as exc:
        return unprocessable_file(str(exc))
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_WRITE)

    if not dry_run:
        main.replay_after_write(runtime)
    return jsonify(_receipt_to_dict(
        uploads.receipt(parsed.filename, rows,
                        written=written, duplicates=len(duplicates),
                        file_accounts=census),
        duplicates=duplicates,
        currency=declared if adopt_currency else None,
        declared_currency=stated,
    )), 200 if dry_run else 201


def _stated_currency(declared: Optional[str]) -> Optional[str]:
    """What the file declares, in the one spelling this app stores (#835)."""
    if not declared:
        return None
    return settings_registry.validate('base_currency', declared)


def _settled_mapping(opened, correspondence, census):
    """The correspondence read against the declaration, or a named refusal."""
    named = {account.name for account in census}
    declared = accounts_module.account_ids(opened)

    unknown = sorted(set(correspondence.targets.values()) - declared)
    if unknown:
        raise uploads.UploadRefused(
            f"the correspondence sends rows to {', '.join(unknown)}, which "
            f"{'are' if len(unknown) > 1 else 'is'} not declared; an account is "
            f"declared in the app, and a file's account is sent to one that is")

    answered = set(correspondence.targets) | set(correspondence.declaring)
    stray = sorted(answered - named)
    if stray:
        raise uploads.UploadRefused(
            f"the correspondence answers for {', '.join(stray)}, which this "
            f"file does not name; it answers for the accounts the file carries")

    return replace(correspondence,
                   declaring=tuple(label for label in correspondence.declaring
                                   if label not in declared))


def _to_write(opened, events, write_duplicates: bool):
    """The file cut in two, or not cut at all because the owner said so."""
    if write_duplicates:
        return list(events), []
    return entries.split_duplicates(opened, events)


def _asked(name: str) -> bool:
    """One query parameter read as *the caller asked for this*."""
    value = request.args.get(name)
    return value is not None and value.strip().lower() not in ('', '0', 'false')


def _unless_declined(name: str) -> bool:
    """:func:`_asked` upside down: **yes unless the caller said no** (#835)."""
    value = request.args.get(name)
    return value is None or value.strip().lower() not in ('0', 'false')


def _receipt_to_dict(receipt: uploads.Receipt, *,
                     duplicates: Sequence[entries.Duplicate] = (),
                     currency: Optional[str] = None,
                     declared_currency: Optional[str] = None) -> dict:
    """One :class:`uploads.Receipt`, on the wire."""
    return {
        'filename': receipt.filename,
        'rows': receipt.rows,
        'written': receipt.written,
        'duplicates': receipt.duplicates,
        'period': None if receipt.first_day is None else {
            'from': receipt.first_day.isoformat(),
            'to': receipt.last_day.isoformat(),
        },
        'accounts': list(receipt.accounts),
        'symbols': list(receipt.symbols),
        'file_accounts': [{'name': account.name, 'rows': account.rows}
                          for account in receipt.file_accounts],
        'duplicate_rows': [
            dict(_event_to_dict(duplicate.event),
                 duplicate_of=(None if duplicate.held is None
                               else str(duplicate.held.id)))
            for duplicate in duplicates],
        'currency': None if not declared_currency else {
            'declared': declared_currency,
            'adopting': currency is not None,
        },
    }


@api_bp.patch('/events/<event_id>')
def update_event(event_id: str):
    """Rewrite one event — **whatever laid it down** (ADR-0032, #816)."""
    key = _entry_key(event_id)
    if key is None:
        return not_found(f"No event with id {event_id!r}")

    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")
    try:
        draft = _event_from_body(body)
    except _InvalidBody as exc:
        return unprocessable_entry(str(exc), key=exc.field)

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            updated = entries.update(opened, key, draft)
    except entries.UnknownEntry as exc:
        return entry_gone(str(exc))
    except entries.InvalidEntry as exc:
        return unprocessable_entry(str(exc), key=exc.field)
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_WRITE)

    main.replay_after_write(runtime)
    return jsonify(_event_to_dict(updated))


@api_bp.delete('/events/<event_id>')
def delete_event(event_id: str):
    """Remove one event — **whatever laid it down** (ADR-0032, #816)."""
    key = _entry_key(event_id)
    if key is None:
        return not_found(f"No event with id {event_id!r}")

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            entries.remove(opened, key)
    except entries.UnknownEntry as exc:
        return entry_gone(str(exc))
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_REMOVE)

    main.replay_after_write(runtime)
    return jsonify({'id': event_id, 'removed': True})


@api_bp.delete('/events')
def delete_events():
    """Remove every event the ledger's own reduction retains (#814, ADR-0032)."""
    try:
        selection = _selection()
    except _InvalidParameter as exc:
        return unprocessable_parameter(str(exc), key=exc.key)

    if not selection.reduces:
        return unprocessable_parameter(
            "a bulk delete takes the ledger's own reduction: one of q, type, "
            "account, symbol, since or until. Reduce on something that covers "
            "the whole ledger to empty it")

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            removed = entries.remove_selection(opened, selection)
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_REMOVE)

    main.replay_after_write(runtime)
    return jsonify({'events_removed': removed})


def _entry_key(event_id: str) -> Optional[int]:
    """The path segment as the ``event`` table's key, or ``None``."""
    try:
        return int(event_id)
    except (TypeError, ValueError):
        return None


class _InvalidBody(Exception):
    """A member of the body is not a value an event can carry."""

    def __init__(self, message: str, field: str):
        super().__init__(message)
        self.field = field


_EVENT_TEXT_FIELDS = ('symbol', 'name', 'notes', 'account')
_EVENT_NUMBER_FIELDS = ('quantity', 'unit_price', 'fee', 'amount')


def _event_from_body(body: Optional[dict]) -> Any:
    """One JSON object as an :class:`events.schemas.Event`, or a named refusal."""
    if not isinstance(body, dict):
        raise _InvalidBody("a JSON object is required", 'date')

    raw_type = body.get('event_type')
    try:
        event_type = EventType(str(raw_type).upper())
    except (ValueError, AttributeError):
        allowed = ", ".join(kind.value for kind in EventType)
        raise _InvalidBody(
            f"event_type {raw_type!r} is not one of {allowed}", 'event_type')

    fields = {name: _text_member(body, name) for name in _EVENT_TEXT_FIELDS}
    fields.update({name: _number_member(body, name)
                   for name in _EVENT_NUMBER_FIELDS})

    return Event(date=_day_member(body), event_type=event_type, **fields)


def _day_member(body: dict) -> date:
    raw = body.get('date')
    if not isinstance(raw, str) or not _ISO_DAY.fullmatch(raw.strip()):
        raise _InvalidBody(
            f"date {raw!r} is not a calendar day (YYYY-MM-DD)", 'date')
    try:
        return date.fromisoformat(raw.strip())
    except ValueError:
        raise _InvalidBody(f"date {raw!r} is not a day that exists", 'date')


def _text_member(body: dict, name: str) -> Optional[str]:
    """A string member, blank read as absent — the empty cell of a CSV."""
    raw = body.get(name)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise _InvalidBody(f"{name} must be text", name)
    return raw.strip() or None


def _number_member(body: dict, name: str) -> Optional[float]:
    """A numeric member, or ``None``."""
    raw = body.get(name)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise _InvalidBody(f"{name} must be a number", name)
    return float(raw)


EXPORT_FILENAMES = {
    'events.csv': 'suivi-bourse-events.csv',
    'events.xlsx': 'suivi-bourse-events.xlsx',
    'selection.csv': 'suivi-bourse-selection.csv',
    'selection.xlsx': 'suivi-bourse-selection.xlsx',
    'portfolio.csv': 'suivi-bourse-portfolio.csv',
}

XLSX_MIME = ('application/vnd.openxmlformats-officedocument'
             '.spreadsheetml.sheet')


@api_bp.get('/export/events.csv')
def export_events():
    """Every event, as a file this app imports."""
    try:
        selection = _selection()
    except _InvalidParameter as exc:
        return unprocessable_parameter(str(exc), key=exc.key)

    opened = _store()
    return _file_response(
        events_export.render_events(
            events_export.select(ledger.read_events(opened), selection),
            opened.setting('base_currency')),
        _export_name('csv', selection),
        'text/csv; charset=utf-8')


@api_bp.get('/export/events.xlsx')
def export_events_workbook():
    """The same ledger, as a workbook with **one sheet per year** (issue #796)."""
    try:
        selection = _selection()
    except _InvalidParameter as exc:
        return unprocessable_parameter(str(exc), key=exc.key)

    opened = _store()
    return _file_response(
        events_export.render_events_workbook(
            events_export.select(ledger.read_events(opened), selection),
            opened.setting('base_currency')),
        _export_name('xlsx', selection),
        XLSX_MIME)


@api_bp.get('/export/portfolio.csv')
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


class _InvalidParameter(Exception):
    """A query parameter carrying a value the product does not know."""

    def __init__(self, message: str, key: str):
        super().__init__(message)
        self.key = key


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


@api_bp.get('/runtime')
def get_runtime():
    """What the scheduler is doing — the one thing Grafana cannot do at all."""
    from api import current_runtime

    runtime = current_runtime()
    recorder = runtime.recorder
    snapshot = runtime.config_manager.current()

    scrape, backfill = recorder.records_for(snapshot.shares)

    return jsonify(runtime_view.build_runtime(
        shares=snapshot.shares,
        scrape=scrape,
        backfill=backfill,
        next_runs=_next_runs(runtime.scheduler),
        ingest=recorder.ingest(),
        perf=recorder.perf(),
        now=datetime.now(timezone.utc),
        scheduler_running=runtime.scheduler is not None,
        reconstruction=(runtime.workloads.reconstruction_state()
                        if runtime.workloads is not None else None),
        persistence=runtime.store_persistence,
        build=runtime.build,
        store_path=(str(runtime.store_path)
                    if runtime.store_path is not None else None),
    ))


def _next_runs(scheduler) -> dict:
    """``symbol -> next_run_time`` for the live per-symbol scrape jobs."""
    from application.scrape import scrape_next_runs

    return scrape_next_runs(scheduler)


@api_bp.get('/store')
def get_store():
    """What the installation's store *is*: its size, its last write, its orphans."""
    runtime = current_runtime()
    opened = _store()
    return jsonify({
        'size_bytes': store_module.file_size(opened.path),
        'ledger_last_write': instants.iso(ledger.last_write(opened)),
        'orphans': [
            {'symbol': orphan.symbol, 'points': orphan.points}
            for orphan in ledger.orphan_symbols(opened)
        ],
        'persistence': runtime.store_persistence,
    })


@api_bp.delete('/store/orphans')
def purge_store_orphans():
    """Purge every orphan symbol: its price series, its quote row, itself."""
    runtime = current_runtime()
    with runtime.config_manager.writing() as opened:
        symbols, points = ledger.purge_orphan_symbols(opened)
    return jsonify({'symbols': symbols, 'points_removed': points})


@api_bp.get('/installation-facts')
def list_installation_facts():
    """What this installation has been told, and has not yet acknowledged."""
    runtime = current_runtime()
    return jsonify([
        fact.to_dict() for fact in installation_facts.listing(
            _store(),
            installation_facts.observe(runtime.workloads))
    ])


@api_bp.post('/installation-facts/<key>/acknowledgement')
def acknowledge_installation_fact(key: str):
    """Acknowledge one installation fact — the table's only gesture, and the reason it exists."""
    runtime = current_runtime()
    context = installation_facts.observe(runtime.workloads)
    try:
        with runtime.config_manager.writing() as opened:
            fact = installation_facts.acknowledge(opened, key, context)
    except installation_facts.UnknownFact:
        return not_found(f"No installation fact is named {key!r}")
    except installation_facts.FactNotStanding:
        return not_found(
            f"Nothing is standing under the installation fact {key!r}")

    return jsonify(fact.to_dict())


@api_bp.get('/advisories')
def list_advisories():
    """What this portfolio says about itself — the inventory, or the reading."""
    read = (advisories.standing
            if request.args.get('asleep') == 'include'
            else advisories.listing)
    return jsonify([one.to_dict()
                    for one in read(_store(), rebuilding=_rebuilding())])


@api_bp.post('/advisories/<key>/acknowledgement')
def acknowledge_advisory(key: str):
    """Put one advisory to sleep for thirty days — and never for good."""
    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            advisory, acknowledged = advisories.acknowledge(
                opened, key, rebuilding=_rebuilding())
    except advisories.UnknownAdvisory:
        return not_found(f"No advisory is standing under {key!r}")

    return jsonify({
        **advisory.to_dict(),
        'acknowledged_until': acknowledged.to_dict()['expires_at'],
    })


@api_bp.get('/investment-rhythm')
def get_investment_rhythm():
    """How much the owner buys in a month, and how often — derived, never stored."""
    return jsonify({
        'base_currency': _base_currency(),
        **rhythm.measure(_snapshot().events,
                         datetime.now(timezone.utc)).to_dict(),
    })


@api_bp.get('/config')
def get_config():
    """What this installation is configured with."""
    from application import main

    return jsonify({
        'log_level': main.current_log_level(),
        'settings': settings_module.describe(_store()),
        'environment': main.effective_environment(),
        'unread_environment': installation_facts.unread_environment(),
        'shares': _snapshot().shares,
    })


@api_bp.get('/settings')
def get_settings():
    """The dials, on the resource that writes them."""
    return jsonify({'settings': settings_module.describe(_store())})


@api_bp.put('/settings')
def put_settings():
    """Change one or more dials. The **only** writer of a setting (issue #701)."""
    from application import main

    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            changes = settings_module.save(opened, body)
    except settings_registry.InvalidSetting as exc:
        return unprocessable(str(exc), key=exc.key or None)

    effect = main.apply_settings(runtime, changes)

    return jsonify({
        'settings': settings_module.describe(_store()),
        'changed': [change.key for change in changes],
        'effect': effect,
    })


@api_bp.put('/config/log-level')
def put_log_level():
    """Change the log level for the life of this process."""
    from application import main

    values = _json_object()
    if values is None or 'level' not in values:
        return bad_request("Expected a JSON object with a 'level' field.")

    try:
        level = main.set_log_level(values['level'])
    except ValueError as exc:
        return bad_request(str(exc))
    return jsonify({'log_level': level})


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
    """Parse an ISO-8601 date or datetime, always returning UTC-aware."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        raise ValueError(f"Not an ISO-8601 instant: {value!r}")
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


__all__ = ['api_bp']
