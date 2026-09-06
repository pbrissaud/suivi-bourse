"""Flask application for SuiviBourse — the web half of a single process (#651)."""
from pathlib import Path
from typing import Optional

from flask import Flask, abort, send_from_directory

from application import main
from application import uploads
from api import problem
from api.api import api_bp
from api.health import health_bp

_runtime: Optional[main.Runtime] = None


def create_app(runtime: main.Runtime) -> Flask:
    """Build the WSGI application on an already-built runtime."""
    global _runtime
    _runtime = runtime

    flask_app = Flask(__name__, static_folder=None)
    flask_app.config['MAX_CONTENT_LENGTH'] = uploads.MAX_BODY_BYTES
    flask_app.register_blueprint(health_bp)
    flask_app.register_blueprint(api_bp)

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
    """Where the built SPA lives — one path, resolved from the package."""
    return Path(__file__).resolve().parent.parent / 'static'


__all__ = ['create_app', 'current_runtime']
