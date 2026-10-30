"""The dials under ``/api``, and the dashboard layout and theme they sit beside."""
import json
from datetime import datetime, timezone

import duckdb
from flask import Blueprint, Response, current_app, jsonify
from logfmt_logger import getLogger

from application import benchmark_view
from application import dashboard_layout
from application import settings as settings_module
from application import settings_registry
from application import tweakcn
from api.problem import (
    bad_request,
    provider_refused,
    unprocessable,
    unprocessable_request,
)
from api.common import (
    _store,
    current_runtime,
    _json_object,
)

logger = getLogger("api.settings")

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
    snapshot = runtime.config_manager.current()
    now = datetime.now(timezone.utc)
    try:
        with runtime.config_manager.writing() as opened:
            changes = settings_module.save(
                opened, body, lambda symbol: benchmark_view.ready(
                    opened, snapshot, symbol, now))
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


#: The theme's row in ``setting``: tweakcn's ``cssVars``, normalised (#1248).
THEME_KEY = 'theme'


def _read_theme(store):
    rows = store.query('SELECT value FROM setting WHERE key = ?', [THEME_KEY])
    return json.loads(rows[0][0]) if rows and rows[0][0] else None


def _store_theme(theme: dict):
    with current_runtime().config_manager.writing() as opened:
        opened.execute(
            'INSERT INTO setting (key, value) VALUES (?, ?) '
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            [THEME_KEY, json.dumps(theme, separators=(',', ':'))])
    return jsonify(theme)


def _refused(exc: tweakcn.InvalidTheme):
    return unprocessable_request(str(exc), key=exc.key)


@bp.get('/theme')
def get_theme():
    """The stored theme, or ``null``: Atelier as bundled."""
    try:
        return jsonify(_read_theme(_store()))
    except ValueError as exc:
        logger.warning("stored theme unreadable, answering null: %s", exc)
        return jsonify(None)


@bp.put('/theme')
def put_theme():
    """Keep a theme. A pasted registry entry (``cssVars``) is cleaned; a bare one is checked."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")
    try:
        theme = tweakcn.validate(
            tweakcn.normalize(body['cssVars']) if 'cssVars' in body else body)
    except tweakcn.InvalidTheme as exc:
        return _refused(exc)
    return _store_theme(theme)


@bp.post('/theme/import')
def import_theme():
    """Fetch a tweakcn theme by id and keep it: the only call to tweakcn.com."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")
    # Outside `writing()`: a slow tweakcn must not hold the store.
    try:
        css_vars = tweakcn.fetch(body.get('id'), current_app.config['TWEAKCN_FETCH'])
        theme = tweakcn.validate(tweakcn.normalize(css_vars))
    except tweakcn.InvalidId:
        return unprocessable_request("a tweakcn id is 1 to 64 of a-z, 0-9 and -", key='id')
    except tweakcn.FetchFailed as exc:
        return provider_refused(f'tweakcn: {exc.reason}', 'tweakcn', 'unreachable')
    except tweakcn.InvalidTheme as exc:
        return _refused(exc)
    return _store_theme(theme)


@bp.delete('/theme')
def delete_theme():
    """Forget the theme: Atelier as bundled."""
    with current_runtime().config_manager.writing() as opened:
        opened.execute('DELETE FROM setting WHERE key = ?', [THEME_KEY])
    return Response(status=204)


@bp.get('/theme.css')
def get_theme_css():
    """The stored theme over the bundled Atelier, read on every request.

    Public behind the PIN (``auth_gate``), and never fetches: a theme reaches
    tweakcn only through ``POST /api/theme/import``.
    """
    css = '/* default theme */'
    try:
        stored = _read_theme(_store())
        # Normalised again: a row is only ever as good as the code reading it.
        entry = None if stored is None else {'cssVars': tweakcn.normalize(stored)}
    except (RuntimeError, ValueError, duckdb.Error) as exc:
        logger.warning("theme unreadable, serving the default: %s", exc)
        entry = None
    if entry is not None:
        css = '\n'.join(tweakcn.font_imports(entry) + [tweakcn.render_css(entry)])
    response = Response(css, mimetype='text/css')
    response.headers['Cache-Control'] = 'no-cache'
    return response
