"""The dials under ``/api``, and the dashboard layout they sit beside."""

from flask import Blueprint, Response, jsonify

from application import dashboard_layout
from application import settings as settings_module
from application import settings_registry
from api.problem import (
    bad_request,
    unprocessable,
    unprocessable_request,
)
from api.common import (
    _store,
    current_runtime,
    _json_object,
)

bp = Blueprint('settings', __name__)


@bp.get('/settings')
def get_settings():
    """The dials, on the resource that writes them."""
    return jsonify({'settings': settings_module.describe(_store())})


@bp.put('/settings')
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


@bp.get('/dashboard/layout')
def get_dashboard_layout():
    """The dashboard's saved layout, or ``null`` when none was ever saved."""
    return jsonify(dashboard_layout.read(_store()))


@bp.put('/dashboard/layout')
def put_dashboard_layout():
    """Keep the dashboard's layout. The shape is checked, the cards are not."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")
    try:
        layout = dashboard_layout.validate(body)
    except dashboard_layout.InvalidLayout as exc:
        return unprocessable_request(str(exc))

    runtime = current_runtime()
    with runtime.config_manager.writing() as opened:
        dashboard_layout.write(opened, layout)
    return jsonify(layout)


@bp.delete('/dashboard/layout')
def delete_dashboard_layout():
    """Forget the layout: the dashboard goes back to its default."""
    runtime = current_runtime()
    with runtime.config_manager.writing() as opened:
        dashboard_layout.delete(opened)
    return Response(status=204)
