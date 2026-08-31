"""Flask application for SuiviBourse — the web half of a single process (#651).

The API lives *inside* the scraper process: one container, one process, one
scheduler. So this package is not only a web app, it is the third step of the
boot sequence — and since ADR-0039 that sequence is linear and lives in one
file, ``boot.py``. There is no ``fork()`` to be on one side of any more: this
module builds a Flask application on a runtime that has already been built, and
that is all it does.
"""
from pathlib import Path
from typing import Optional

from flask import Flask, abort, send_from_directory

from application import main
from application import uploads
from api import problem
from api.api import api_bp
from api.health import health_bp

# The Runtime the process booted with. Module-level because the routes cannot
# take it as an argument: ``boot.sequence`` hands it here once, and every
# request handler reaches it through :func:`current_runtime`.
_runtime: Optional[main.Runtime] = None


def create_app(runtime: main.Runtime) -> Flask:
    """Build the WSGI application on an already-built runtime.

    The runtime is **required** (ADR-0039). It used to be optional, and the
    absent case was gunicorn's: the factory was named on the command line, so it
    had to be able to build the runtime itself, in the master, under
    ``preload_app``. ``boot.py`` is the caller now and it builds the runtime as
    its own step — which is what leaves this function with a single job and
    ``create_app(runtime)``, the seam the whole Python suite already used, as the
    only shape there is.
    """
    global _runtime
    _runtime = runtime

    # static_folder=None: Flask's built-in /static/ route is not what the SPA
    # needs. Vite emits index.html plus hashed assets/ at the *root* of the
    # bundle, and every unknown path has to fall through to index.html for
    # client-side routing — which is `_serve_spa` below, not a static mount.
    flask_app = Flask(__name__, static_folder=None)
    # **The one bound that can stop bytes already in flight** (issue #811).
    # ``POST /api/events/import`` refuses a declared ``Content-Length`` before
    # touching the body, and bounds the file when it reads it — but both of those
    # run *after* werkzeug has parsed the multipart payload, and a body that
    # declares no length at all (a chunked upload) is spooled to disk in full
    # before either can speak. This is the limit werkzeug itself enforces while
    # reading, and it is stated on the envelope rather than on the file, which is
    # what ``MAX_BODY_BYTES`` is for.
    flask_app.config['MAX_CONTENT_LENGTH'] = uploads.MAX_BODY_BYTES
    flask_app.register_blueprint(health_bp)
    flask_app.register_blueprint(api_bp)

    @flask_app.get('/')
    @flask_app.get('/<path:path>')
    def _serve_spa(path: str = ''):
        """Serve the built front, falling back to index.html for SPA routes.

        The one rule that is load-bearing: **the catch-all must not swallow an
        /api 404**. Without the guard below, a typo'd endpoint would return the
        HTML shell with a 200, and the front's ``fetch`` would fail on a JSON
        parse error somewhere far from the cause — the single most confusing
        failure this arrangement can produce.
        """
        if path.startswith('api/'):
            return problem.not_found(f"No such API endpoint: /{path}")

        # /metrics is gone (ADR-0033) and the catch-all is what would hide it:
        # a client-side route that does not exist is answered with the shell, so
        # without this line a leftover scraper would read **200 with HTML** and
        # go on reporting nothing wrong — the one answer that is worse than the
        # endpoint's absence. `abort` and not `problem.not_found`: the endpoint
        # is not disabled by a setting, it does not exist, and Flask's own 404
        # is what says exactly that with nothing added.
        if path == 'metrics' or path.startswith('metrics/'):
            abort(404)

        static_dir = _static_dir()
        if not static_dir.is_dir():
            # A Python-only run (tests, or a container built before the front
            # existed) is a legitimate state: the API still serves. Say so
            # plainly rather than 404-ing an empty path.
            return problem.not_found(
                "No web UI bundle in this build; the API is available under /api")

        if path and (static_dir / path).is_file():
            return send_from_directory(static_dir, path)
        return send_from_directory(static_dir, 'index.html')

    # No second mount under this app, and therefore no middleware: `/metrics`
    # went with the second interface (ADR-0033). A request for it is now an
    # ordinary unknown path — it is not recognised, not redirected, and not
    # answered with a 404 written specially for it.
    return flask_app


def current_runtime() -> main.Runtime:
    """The Runtime this process booted with, for request handlers.

    The routes cannot capture it at import — the module is imported before there
    is a runtime to capture — so the module global is the channel, written once
    by :func:`create_app` and read by every handler.
    """
    if _runtime is None:
        raise RuntimeError(
            "create_app() has not run; there is no runtime to serve from")
    return _runtime


def _static_dir() -> Path:
    """Where the built SPA lives — one path, resolved from the package.

    ``<parent of this package>/static`` is one path in both worlds:
    ``src/static`` in a checkout (Vite's ``build.outDir``) and
    ``/home/appuser/src/static`` in the image, since the Dockerfile copies the
    two packages under ``/home/appuser/src`` and lands the built SPA beside
    them.

    **It reads no environment variable** (issue #740). ``SB_STATIC_DIR`` used to
    override it for "anyone serving the bundle from elsewhere", and that person
    has no existence left: there is one image and it carries the bundle at that
    path. The environment says four things and this was never one of them — a
    fifth name would have to be documented, and the sentence it earns
    ("normally you leave this alone") is the sentence that says to delete it.
    """
    return Path(__file__).resolve().parent.parent / 'static'


__all__ = ['create_app', 'current_runtime']
