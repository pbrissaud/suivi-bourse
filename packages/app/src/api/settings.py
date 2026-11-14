"""The dials under ``/api``, and the dashboard layout and theme they sit beside."""
import json
from datetime import datetime, timezone

import duckdb
from flask import Blueprint, Response, current_app, jsonify
from logfmt_logger import getLogger

from application import access_tokens
from application import auth_rules
from application import benchmark_view
from application import settings as settings_module
from application import settings_registry
from application import tweakcn
from api.problem import (
    bad_request,
    not_found,
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


# --------------------------------------------------------------------------- #
# The access tokens (#1313). The gate keeps a bearer away from these routes.
# --------------------------------------------------------------------------- #

MAX_LABEL = 60


def _token_form(body: dict):
    """``(label, scopes, lifetime)`` of a token form, or the 422 that refuses it."""
    label = body.get('label')
    label = label.strip() if isinstance(label, str) else ''
    scopes = body.get('scopes')
    lifetime = body.get('expires')
    if not label or len(label) > MAX_LABEL:
        return unprocessable_request(
            f'a token has a label of 1 to {MAX_LABEL} characters', key='label')
    known = isinstance(scopes, list) and all(
        scope in auth_rules.TOKEN_SCOPES for scope in scopes)
    if not known or not scopes:
        return unprocessable_request(
            'a token opens api, mcp or both', key='scopes')
    if lifetime not in auth_rules.TOKEN_LIFETIMES:
        return unprocessable_request(
            'a token expires in 90d, 1y or never', key='expires')
    return label, scopes, lifetime


@bp.get('/tokens')
def get_tokens():
    """The tokens, oldest first: never their secret."""
    return jsonify({'tokens': access_tokens.list_all(_store())})


@bp.post('/tokens')
def post_token():
    """Make a token. Its secret is in this answer and nowhere else, ever."""
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")
    form = _token_form(body)
    if not isinstance(form, tuple):
        return form
    label, scopes, lifetime = form
    with current_runtime().config_manager.writing() as opened:
        token, secret = access_tokens.create(
            opened, label, scopes, lifetime, datetime.now(timezone.utc))
    response = jsonify({'token': token, 'secret': secret})
    response.status_code = 201
    return response


@bp.post('/tokens/<token_id>/regenerate')
def regenerate_token(token_id: str):
    """A new secret for the token, its clock started again; the old one is dead."""
    with current_runtime().config_manager.writing() as opened:
        made = access_tokens.regenerate(opened, token_id, datetime.now(timezone.utc))
    if made is None:
        return not_found(f'No such token: {token_id}')
    return jsonify({'token': made[0], 'secret': made[1]})


@bp.delete('/tokens/<token_id>')
def delete_token(token_id: str):
    with current_runtime().config_manager.writing() as opened:
        found = access_tokens.delete(opened, token_id)
    if not found:
        return not_found(f'No such token: {token_id}')
    return Response(status=204)
