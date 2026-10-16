"""The ``/api`` blueprint — the disposable half (issue #659, design #655)."""
import threading
from typing import Optional
from urllib.parse import urlsplit

import duckdb
from flask import Blueprint, Response, current_app, request
from werkzeug.exceptions import HTTPException
from logfmt_logger import getLogger

from application import tweakcn
from application import store as store_module
from application import uploads
from api.problem import (
    TYPE_REFUSED,
    foreign_origin,
    internal_error,
    problem,
    storage_unavailable,
    too_large,
)
from api import (
    accounts, agent, events, export, jobs, portfolio, profile, settings,
    system,
)

logger = getLogger("api.api")

api_bp = Blueprint('api', __name__, url_prefix='/api')

SAFE_METHODS = frozenset({'GET', 'HEAD', 'OPTIONS'})

# Nested, never siblings: a child of `api_bp` inherits its origin guard and
# its problem+json handler, and a sibling would silently have neither.
for _domain in (portfolio, accounts, events, export, system, jobs, settings,
                agent, profile):
    api_bp.register_blueprint(_domain.bp)


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
    """Turn anything a route raises into problem+json.

    **Three answers, not two** (#856). *A fault of the store* and *a fault of
    ours* were the whole of it, and a third thing reaches here: a refusal
    werkzeug itself decided, which is neither. Flask looks an ``HTTPException``
    up by code and then by MRO, so with nothing registered for ``413`` the walk
    landed on the ``Exception`` below and answered *an unexpected error* — the
    invitation to file a bug report — about the one bound that can stop a
    chunked upload, whose sentence was already written
    (:func:`uploads.too_large_detail`).

    The ``HTTPException`` branch therefore comes first, and it does not log a
    traceback: a refusal by design is not an incident.

    **What werkzeug raises while *routing* cannot arrive here at all**, and that
    is why :func:`refused` is a function rather than a branch: a routing failure
    has no endpoint, so it has no blueprint, so a blueprint handler is
    structurally unable to see it. ``GET /api/nothing`` is answered by the SPA
    catch-all in :mod:`api` — ``problem.not_found``, the ``/problems/not-found``
    the front knows — because that rule matches the path; ``POST`` on the same
    path matches no method and is werkzeug's ``405``, which :mod:`api` hands to
    :func:`refused` from an **app-level** handler. Every ``/api`` answer is
    problem+json, and the two halves of that sentence are held in two places
    because Flask's dispatch puts them there.
    """
    if isinstance(exc, HTTPException):
        return refused(exc)
    logger.error(f"API error on {request.path}: {exc}", exc_info=True)
    if isinstance(exc, (store_module.StoreUnavailable, duckdb.Error)):
        return storage_unavailable(str(exc))
    return internal_error(str(exc))


def refused(exc: HTTPException):
    """An ``HTTPException`` as the status it already is (#856).

    ``413`` on the upload is the one this app *arranged* — ``MAX_CONTENT_LENGTH``
    is the third of the three bounds ``uploads`` names, the only one that sees a
    body making no length declaration — so it is answered with the same problem
    the route's own check answers, ``limit`` member included. The bound is
    app-wide and the *sentence* is not: **a file may carry at most 8 MiB** about
    an oversized JSON body would name a limit that body never crossed, so
    anywhere but the upload the generic translation answers.

    Everything else keeps its status under :data:`TYPE_REFUSED` (#971). It
    first wore ``/problems/internal-error`` because the front branches on
    ``type`` alone and has no sentence for a refusal nothing here arranged —
    but the log two lines up says *refusal* and declines to write a traceback,
    so the body calling the same event a fault is the wire contradicting
    itself. The front is unchanged and needs no translation: an unknown
    ``type`` already falls back to *an unexpected error*
    (``problemMessageKey``), so the sentence a reader meets is the one they met
    before, byte for byte, over an identifier that is now true. Like
    ``/problems/foreign-origin``, no page this app serves can reach it: the
    reader is driving the API by hand.

    ``exc.code`` and ``exc.description`` are read straight: Flask returns an
    ``HTTPException`` whose code is ``None`` before any handler is consulted,
    and werkzeug carries a description on the class.
    """
    logger.warning(f"API refusal on {request.path}: {exc}")
    if exc.code == 413 and request.endpoint == 'api.events.import_events':
        return too_large(uploads.too_large_detail(), uploads.MAX_UPLOAD_BYTES)
    return problem(exc.code, exc.name, exc.description, TYPE_REFUSED)


#: The theme stylesheet, computed on the first request. Per process, not per
#: theme id: ``SB_TWEAKCN_THEME`` cannot change without a restart, so a process
#: fetches at most once.
_served: Optional[str] = None
_serving = threading.Lock()


@api_bp.get('/theme.css')
def get_theme_css():
    """The tweakcn theme ``SB_TWEAKCN_THEME`` names, over the bundled Atelier (#1130)."""
    global _served
    # ponytail: the first request waits on tweakcn (5 s per socket operation);
    # a background warm-up at boot if a slow first paint ever shows.
    with _serving:
        if _served is None:
            _served = _theme_css()
    response = Response(_served, mimetype='text/css')
    response.headers['Cache-Control'] = 'no-cache'
    return response


def _theme_css() -> str:
    """The stylesheet body, logging once why the theme fell back."""
    theme_id = current_app.config.get('TWEAKCN_THEME')
    if not theme_id:
        return '/* default theme */'
    entry, reason = tweakcn.load(theme_id, current_app.config['TWEAKCN_CACHE_DIR'],
                                 current_app.config['TWEAKCN_FETCH'])
    if reason:
        logger.warning("tweakcn theme %s: %s", theme_id, reason)
    if entry is None:
        return '/* default theme */'
    return '\n'.join(tweakcn.font_imports(entry) + [tweakcn.render_css(entry)])


__all__ = ['api_bp']
