"""Flask application for SuiviBourse — the web half of a single process (#651)."""
import os
from pathlib import Path
from typing import Optional

from flask import Flask, abort, request, send_from_directory
from werkzeug.exceptions import HTTPException

from application import boot_env
from application import main
from application import tweakcn
from application import update_check
from application import uploads
from api import problem
from api.api import api_bp, refused
from api.health import health_bp

_runtime: Optional[main.Runtime] = None


def create_app(runtime: main.Runtime) -> Flask:
    """Build the WSGI application on an already-built runtime."""
    global _runtime
    _runtime = runtime

    flask_app = Flask(__name__, static_folder=None)
    flask_app.config['MAX_CONTENT_LENGTH'] = uploads.MAX_BODY_BYTES
    flask_app.config['TWEAKCN_THEME'] = boot_env.text(os.environ, boot_env.THEME)
    flask_app.config['TWEAKCN_CACHE_DIR'] = boot_env.directory(
        os.environ, boot_env.STORE_DIR, boot_env.DEFAULT_STORE_DIR) / 'theme'
    flask_app.config['TWEAKCN_FETCH'] = tweakcn.http_fetch
    flask_app.config['RELEASE_CHECKER'] = update_check.Checker(update_check.http_fetch)
    flask_app.register_blueprint(health_bp)
    flask_app.register_blueprint(api_bp)

    @flask_app.errorhandler(HTTPException)
    def _on_routing_refusal(exc: HTTPException):
        """What werkzeug decides **before** a blueprint exists (#856).

        A routing failure has no endpoint and therefore no blueprint, so
        ``api_bp``'s own handler cannot see one: ``POST /api/anything`` matches
        the catch-all's path and not its method, and came back as werkzeug's
        HTML ``405`` — which the front reads as *not even the app answered*,
        about a routing mistake the app answered perfectly well. Under ``/api``
        it goes through the same translation as a refusal raised inside a view.

        Everywhere else werkzeug's own page stands: returning ``exc`` is Flask's
        way of saying *the default was right* — the ``404`` on ``/metrics`` is a
        door closed to a scraper, not a problem+json for a reader.

        ``/api`` is read as a **path segment**, which is the whole of the test
        below it: a prefix match claims ``/apiary`` too, and the SPA serves
        every path this app does not know, so that is a page of the front being
        answered in the API's vocabulary.
        """
        if request.path != '/api' and not request.path.startswith('/api/'):
            return exc
        return refused(exc)

    @flask_app.get('/')
    @flask_app.get('/<path:path>')
    def _serve_spa(path: str = ''):
        """Serve the built front, falling back to index.html for SPA routes."""
        if path.startswith('api/'):
            return problem.not_found(f"No such API endpoint: /{path}")

        if path == 'metrics' or path.startswith('metrics/'):
            abort(404)

        static_dir = _static_dir()
        if not static_dir.is_dir():
            return problem.not_found(
                "No web UI bundle in this build; the API is available under /api")

        if path and (static_dir / path).is_file():
            return send_from_directory(static_dir, path)
        return send_from_directory(static_dir, 'index.html')

    return flask_app


def current_runtime() -> main.Runtime:
    """The Runtime this process booted with, for request handlers."""
    if _runtime is None:
        raise RuntimeError(
            "create_app() has not run; there is no runtime to serve from")
    return _runtime


def _static_dir() -> Path:
    """Where the built SPA lives — inside the package, so the wheel carries it."""
    return Path(__file__).resolve().parent / 'static'


__all__ = ['create_app', 'current_runtime']
