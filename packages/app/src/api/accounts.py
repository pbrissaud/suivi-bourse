"""The accounts under ``/api``, and the taxation models they carry (#752)."""
from dataclasses import asdict
from datetime import date, datetime, timezone
from typing import Optional

from flask import Blueprint, jsonify

from application import account_facts
from application import accounts as accounts_module
from application import instants
from application import main
from application import reassignment
from application import taxation
from application.events.aggregator import AggregationError
from api.problem import (
    GESTURE_WRITE,
    bad_request,
    conflict,
    not_found,
    unprocessable_request,
    model_in_use,
)
from api.common import (
    DEFAULT_HISTORY_WINDOW,
    _ISO_DAY,
    _reader,
    _snapshot,
    _store,
    current_runtime,
    _unreplayable,
    _InvalidBody,
    _json_object,
    _flag,
    _parse_window,
)

bp = Blueprint('accounts', __name__)


@bp.get('/accounts')
def list_accounts():
    """The **declared** accounts, each with its newest perf figures.

    The payload itself is :mod:`application.account_facts`, because the MCP
    tool serves the same one (#920) and re-assembling it twice is how eight
    members came to reach one reader and not the other.
    """
    return jsonify(account_facts.accounts_payload(
        _store(), _snapshot(), datetime.now(timezone.utc)))


@bp.get('/accounts/<account_id>/history')
def get_account_history(account_id: str):
    """One account's perf series — the TWR chart and the detail sheet's curve."""
    accounts = _snapshot().accounts
    if accounts is not None:
        known = accounts.get(account_id) is not None
    else:
        known = any(row.id == account_id
                    for row in accounts_module.seeded_only(_store()))
    if not known:
        return not_found(f"No declared account {account_id!r}")

    try:
        start, stop = _parse_window(DEFAULT_HISTORY_WINDOW)
    except ValueError as exc:
        return bad_request(str(exc))

    return jsonify({
        'account': account_id,
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
            for row in _reader().account_series(account_id, start, stop)
        ],
    })


@bp.post('/accounts')
def create_account():
    """Declare an account — the one place one is born."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    try:
        day = _opening_day(body)
    except _InvalidBody as exc:
        return unprocessable_request(str(exc), key=exc.field)

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            with opened.transaction():
                account = accounts_module.create_account(
                    opened, body.get('id'), body.get('label'))
                # What the form **proposed** is not what is written: the offer
                # is interface, and the row takes what was submitted (#752,
                # #918) — the opening date included, which the form pre-fills
                # from the first payment and never re-derives afterwards.
                model = accounts_module.set_taxation_model(
                    opened, account.id, body.get('taxation_model'))
                opened_on = accounts_module.set_opened_on(
                    opened, account.id, day)
                if _flag(body.get('reassign')):
                    reassignment.reassign_unassigned(opened, account.id)
    except accounts_module.DuplicateAccount as exc:
        return conflict(str(exc))
    except accounts_module.UnknownTaxationModel as exc:
        return unprocessable_request(str(exc), key='taxation_model')
    except accounts_module.AccountSourceError as exc:
        return bad_request(str(exc))
    except AggregationError as exc:
        return _unreplayable(exc, GESTURE_WRITE)

    main.replay_after_write(runtime)
    return jsonify(_account_to_dict(account, model, opened_on)), 201


@bp.post('/accounts/<account_id>/reassignment')
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


@bp.patch('/accounts/<account_id>')
def update_account(account_id: str):
    """Relabel an account created in the app — since #916 there is nothing else
    to change, and since #926 no second column to change it in."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    try:
        day = _opening_day(body)
    except _InvalidBody as exc:
        return unprocessable_request(str(exc), key=exc.field)

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            # A `type` member is **read by nothing** rather than refused (#916): `/api` is the front's interface and not a contract held
            # for anybody else, so a refusal written for a client that
            # does not exist is code for nobody.
            # **One transaction**, since #752 put a second write in here: a model
            # reference matching nothing is refused *after* the rename has been
            # applied, and a request answered `422` must leave nothing behind.
            with opened.transaction():
                account = accounts_module.update_account(
                    opened, account_id, label=body.get('label'))
                # **Absent is *leave it alone*, `null` is *detach it***, and the
                # two are two gestures: a `PATCH` sent to rename an account would
                # otherwise silently drop the model it carries.
                model = (
                    accounts_module.taxation_models_by_account(opened).get(account_id)
                    if 'taxation_model' not in body
                    else accounts_module.set_taxation_model(
                        opened, account_id, body.get('taxation_model')))
                # The opening date is read the same way, and for the same
                # reason (#918): a `PATCH` that renames an account must not
                # take away a date nobody mentioned.
                opened_on = (
                    accounts_module.opening_dates_by_account(opened).get(account_id)
                    if 'opened_on' not in body
                    else accounts_module.set_opened_on(opened, account_id, day))
    except accounts_module.UnknownAccount as exc:
        return not_found(str(exc))
    except accounts_module.UnknownTaxationModel as exc:
        return unprocessable_request(str(exc), key='taxation_model')

    main.replay_after_write(runtime)
    return jsonify(_account_to_dict(account, model, opened_on))


@bp.delete('/accounts/<account_id>')
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


def _account_to_dict(account, taxation_model: Optional[str] = None,
                     opened_on: Optional[date] = None) -> dict:
    """One :class:`events.schemas.Account`, on the wire.

    The two facts it may carry are **absent where it carries none** (#752,
    #918): the front tells an absence from a value, and never from a sentinel.
    """
    return {
        'id': account.id,
        'label': account.label,
        **account_facts.declared_only({
            'taxation_model': taxation_model,
            'opened_on': instants.iso(opened_on),
        }),
    }


def _opening_day(body: dict) -> Optional[date]:
    """The ``opened_on`` member as a **day**, or a refusal naming the field.

    ``None`` covers the two sentences the routes tell apart themselves — the
    member absent, and the member sent as `null` to take the declaration away —
    because neither of them is a date to parse.
    """
    raw = body.get('opened_on')
    if raw is None:
        return None
    if not isinstance(raw, str) or not _ISO_DAY.fullmatch(raw.strip()):
        raise _InvalidBody(
            f"opened_on {raw!r} is not a calendar day (YYYY-MM-DD)",
            'opened_on')
    try:
        return date.fromisoformat(raw.strip())
    except ValueError:
        raise _InvalidBody(f"opened_on {raw!r} is not a day that exists",
                           'opened_on')


# --------------------------------------------------------------------------- #
# The taxation models — the owner's own, and the catalogue that is code (#752)
# --------------------------------------------------------------------------- #

@bp.get('/taxation-models')
def list_taxation_models():
    """The models their owner wrote, and the shape a model may take.

    **The catalogue rides on this read** rather than living a second time in the
    front: the kinds are a closed enumeration in code. What the front holds is
    the *words* — one message key per kind, in both catalogues.
    """
    return jsonify({
        **taxation.catalogue(),
        'models': [asdict(model)
                   for model in accounts_module.read_models(_store())],
    })


@bp.post('/taxation-models')
def create_taxation_model():
    """Write a taxation model. Its kind is checked here, once, on the way in."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            model = accounts_module.create_model(
                opened, body.get('name'), body.get('kind'),
                body.get('parameters'))
    except taxation.ModelRejected as exc:
        return unprocessable_request(str(exc))

    return jsonify(asdict(model)), 201


@bp.patch('/taxation-models/<model_id>')
def update_taxation_model(model_id: str):
    """Correct a model — and every account carrying it reads the correction."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            model = accounts_module.update_model(
                opened, model_id,
                name=body.get('name'), kind=body.get('kind'),
                parameters=body.get('parameters'))
    except accounts_module.UnknownTaxationModel as exc:
        return not_found(str(exc))
    except taxation.ModelRejected as exc:
        return unprocessable_request(str(exc))

    return jsonify(asdict(model))


@bp.delete('/taxation-models/<model_id>')
def delete_taxation_model(model_id: str):
    """Remove a model, unless an account carries it — and then say which."""
    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            accounts_module.delete_model(opened, model_id)
    except accounts_module.UnknownTaxationModel as exc:
        return not_found(str(exc))
    except accounts_module.TaxationModelInUse as exc:
        return model_in_use(str(exc), exc.accounts)

    return jsonify({'id': model_id, 'removed': True})
