"""The event ledger under ``/api``: one row, many rows, and a file (#811, #816)."""
import re
from dataclasses import replace
from datetime import date
from typing import Any, Optional, Sequence

from flask import Blueprint, jsonify, request

from application import accounts as accounts_module
from application import entries
from application import import_currency
from application import ledger
from application import main
from application import settings_registry
from application import store as store_module
from application import uploads
from application.events.schemas import Event, EventType
from application.events.aggregator import AggregationError
from api.problem import (
    GESTURE_REMOVE,
    GESTURE_WRITE,
    bad_request,
    currency_unconvertible,
    entry_gone,
    not_found,
    too_large,
    unprocessable_file,
    unprocessable_request,
)
from api.common import (
    _ISO_DAY,
    _snapshot,
    _store,
    current_runtime,
    _unreplayable,
    _InvalidBody,
    _json_object,
)

bp = Blueprint('events', __name__)


@bp.get('/events')
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


@bp.post('/events')
def create_event():
    """Record one event typed in the app (issue #764)."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    try:
        draft = _event_from_body(body)
    except _InvalidBody as exc:
        return unprocessable_request(str(exc), key=exc.field)

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            created = entries.create(opened, draft)
    except entries.InvalidEntry as exc:
        return unprocessable_request(str(exc), key=exc.field)
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_WRITE)

    main.replay_after_write(runtime)
    return jsonify(_event_to_dict(created)), 201


@bp.post('/events/import')
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
    amounts_in = request.args.get('amounts_in')
    if amounts_in not in (None, 'base', 'quote'):
        return bad_request("amounts_in is either 'base' or 'quote'")

    try:
        parsed = uploads.read(upload.filename or '', upload.stream)
        correspondence = uploads.mapping(request.args.get('map'),
                                         request.args.getlist('declare'))
        write_repeats = _write_repeats()
    except uploads.UploadTooLarge as exc:
        return too_large(str(exc), uploads.MAX_UPLOAD_BYTES)
    except uploads.UploadRefused as exc:
        return unprocessable_file(str(exc))

    census = uploads.census(parsed.events)

    runtime = current_runtime()
    foreign: Sequence[import_currency.ForeignLine] = ()
    unverified: Sequence[str] = ()
    try:
        # The rates are fetched **before** the writer lock: a slow Yahoo must
        # not hold every read behind it. The write below finds them cached.
        warmed = (_warm_rates(parsed, runtime, _question_base(_store(), parsed))
                  if not dry_run and amounts_in == 'quote' else None)
        if dry_run:
            opened = _store()   # a dry run reads and nothing else (#967)
            settled = _settled_mapping(opened, correspondence, census)
            declared = ledger.currency_to_adopt(opened,
                                                parsed.declared_currency)
            stated = _stated_currency(parsed.declared_currency)
            rows = settled.applied(parsed.events)
            base = _question_base(opened, parsed)
            if base:
                found = import_currency.survey(opened, rows, base)
                foreign, unverified = found.lines, found.unverified
                rows = _answered(rows, amounts_in, found.pairs, runtime, base)
            fresh, duplicates = entries.split_duplicates(
                opened, rows, write_held=write_duplicates,
                write_repeats=write_repeats)
            entries.judge(opened, fresh, declaring=settled.declaring,
                          accounts_pending=settled.stated)
            written = len(fresh)
        else:
            while True:
                try:
                    with runtime.config_manager.writing() as opened:
                        settled = _settled_mapping(opened, correspondence, census)
                        declared = ledger.currency_to_adopt(
                            opened, parsed.declared_currency)
                        stated = _stated_currency(parsed.declared_currency)
                        rows = settled.applied(parsed.events)
                        base = _question_base(opened, parsed)
                        if amounts_in == 'quote' and base != warmed:
                            # The base moved between the warm-up and the lock:
                            # the cached rates are for another pair. Leave the
                            # lock, fetch the right ones, and come back.
                            raise _RatesStale(base)
                        says = {}
                        if base:
                            sent = import_currency.pairs(
                                rows, request.args.getlist('foreign'), base)
                            foreign = import_currency.lines(rows, sent)
                            rows = _answered(rows, amounts_in, sent, runtime, base)
                            if amounts_in:
                                says = {symbol: base if amounts_in == 'base' else code
                                        for symbol, code in sent.items()}
                        fresh, duplicates = entries.split_duplicates(
                            opened, rows, write_held=write_duplicates,
                            write_repeats=write_repeats)
                        written = len(entries.create_many(
                            opened, fresh,
                            base_currency=declared if adopt_currency else None,
                            declare_accounts=settled.declaring,
                            stated=says))
                    break
                except _RatesStale as stale:
                    warmed = _warm_rates(parsed, runtime, stale.base)
    except import_currency.BadPair as exc:
        return bad_request(str(exc))
    except import_currency.Unconvertible as exc:
        return currency_unconvertible(
            str(exc), exc.symbol, exc.currency, exc.base, exc.day.isoformat())
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
        foreign=foreign,
        unverified=unverified,
    )), 200 if dry_run else 201


def _question_base(opened, parsed) -> Optional[str]:
    """The base currency when the file's amounts have no stated unit, else ``None``.

    A file that declares a ``base_currency`` column has stated the unit of its
    amounts (the app's own export does), so nothing is asked of it (#1261).
    """
    if parsed.declared_currency:
        return None
    return opened.setting('base_currency') or None


class _RatesStale(Exception):
    """The base currency changed after the rates were fetched for another one."""

    def __init__(self, base: Optional[str]):
        super().__init__(base)
        self.base = base


def _warm_rates(parsed, runtime, base: Optional[str]) -> Optional[str]:
    """Fetch (and cache) the rates the write will convert with, outside the lock.

    Answers the base currency they were fetched for, which the write checks again
    once it holds the lock.
    """
    if base:
        sent = import_currency.pairs(
            parsed.events, request.args.getlist('foreign'), base)
        _answered(parsed.events, 'quote', sent, runtime, base)
    return base


def _answered(rows, amounts_in: Optional[str], chosen, runtime, base: str):
    """``rows`` with the foreign securities' amounts in ``base`` if asked to."""
    if amounts_in != 'quote' or not chosen:
        return rows
    running = getattr(runtime, 'workloads', None)
    return import_currency.convert(
        rows, chosen, getattr(running, 'rates', None), base)


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


def _write_repeats() -> frozenset:
    """The ``write_repeat`` form fields: first copies of the groups to write whole.

    A form field and not a query parameter: a file pasted twice carries about a
    thousand groups, past the 16 KiB h11 caps on the request line (see
    :func:`delete_events`).
    """
    raw = request.form.getlist('write_repeat')
    # Bounded: ``int()`` refuses past 4300 digits, and no file has that many rows.
    if not all(_DIGITS.fullmatch(value) and len(value) <= 12 for value in raw):
        raise uploads.UploadRefused(
            "write_repeat is the index of the first copy of a repeated line, "
            "an integer")
    return frozenset(int(value) for value in raw)


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
                     declared_currency: Optional[str] = None,
                     foreign: Sequence[import_currency.ForeignLine] = (),
                     unverified: Sequence[str] = ()) -> dict:
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
                               else str(duplicate.held.id)),
                 repeat_of=duplicate.repeat_of)
            for duplicate in duplicates],
        'currency': None if not declared_currency else {
            'declared': declared_currency,
            'adopting': currency is not None,
        },
        'foreign_lines': [{'symbol': line.symbol, 'currency': line.currency,
                           'rows': line.rows} for line in foreign],
        'unverified': list(unverified),
    }


@bp.patch('/events/<event_id>')
def update_event(event_id: str):
    """Rewrite one event — **whatever laid it down** (#816)."""
    key = _entry_key(event_id)
    if key is None:
        return not_found(f"No event with id {event_id!r}")

    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")
    try:
        draft = _event_from_body(body)
    except _InvalidBody as exc:
        return unprocessable_request(str(exc), key=exc.field)

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            updated = entries.update(opened, key, draft)
    except entries.UnknownEntry as exc:
        return entry_gone(str(exc)) if exc.issued else not_found(str(exc))
    except entries.InvalidEntry as exc:
        return unprocessable_request(str(exc), key=exc.field)
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_WRITE)

    main.replay_after_write(runtime)
    return jsonify(_event_to_dict(updated))


@bp.delete('/events/<event_id>')
def delete_event(event_id: str):
    """Remove one event — **whatever laid it down** (#816)."""
    key = _entry_key(event_id)
    if key is None:
        return not_found(f"No event with id {event_id!r}")

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            entries.remove(opened, key)
    except entries.UnknownEntry as exc:
        return entry_gone(str(exc)) if exc.issued else not_found(str(exc))
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_REMOVE)

    main.replay_after_write(runtime)
    return jsonify({'id': event_id, 'removed': True})


@bp.delete('/events')
def delete_events():
    """Remove the events the reader ticked (#1113).

    The ids travel in a JSON body, ``{"ids": ["12", "13"]}``, and never in the
    query string: a few thousand of them overflow a proxy's URL limit. An id
    that no longer exists is skipped, and the answer counts what actually left.
    """
    body = _json_object()
    raw = body.get('ids') if body is not None else None
    if not isinstance(raw, list) or not raw:
        return unprocessable_request(
            "a bulk delete takes a non-empty list of event ids", key='ids')
    keys = [_ticked_key(item) for item in raw]
    if None in keys:
        return unprocessable_request(
            "every event id must be an integer", key='ids')

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            removed = entries.remove_keys(opened, keys)
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_REMOVE)

    main.replay_after_write(runtime)
    return jsonify({'events_removed': removed})


def _ticked_key(item: Any) -> Optional[int]:
    """One member of ``ids`` as a key: an integer, or a string of digits only."""
    if isinstance(item, bool):
        return None
    if isinstance(item, int):
        return item
    if isinstance(item, str) and _DIGITS.fullmatch(item):
        return int(item)
    return None


_DIGITS = re.compile(r'[0-9]+')


def _entry_key(event_id: str) -> Optional[int]:
    """The path segment as the ``event`` table's key, or ``None``."""
    try:
        return int(event_id)
    except (TypeError, ValueError):
        return None


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
