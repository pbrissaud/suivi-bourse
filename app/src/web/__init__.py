"""Flask application for SuiviBourse — the web half of a single process (#651).

The API lives *inside* the scraper process: one container, one process, one
scheduler. So this package is not only a web app, it is the front half of the
boot sequence, and it is split across gunicorn's ``fork()``:

* :func:`create_app` runs in the **master**, under ``preload_app`` — pure work
  only, plus the configuration load whose failure must stay a single clean exit.
* :func:`start_background` runs in ``post_fork``, in the **one** worker that
  owns the scheduler.
* :func:`stop_background` runs in ``worker_exit``.

``gunicorn.conf.py`` wires the three and explains why the split is load-bearing.
"""
import os
import sys
from pathlib import Path
from typing import Optional

from flask import Flask, send_from_directory
from prometheus_client import make_wsgi_app
from werkzeug.middleware.dispatcher import DispatcherMiddleware

import main
from web import problem
from web.api import api_bp
from web.health import health_bp

# The Runtime built in the master and inherited by the worker through ``fork()``.
# Module-level on purpose: ``create_app`` (master) and the two gunicorn hooks
# (worker) must reach the *same* object, and the fork hands them that for free —
# there is no other channel, since the hooks receive only gunicorn's own
# arbiter/worker objects.
_runtime: Optional[main.Runtime] = None


def create_app(runtime: Optional[main.Runtime] = None) -> Flask:
    """Build the WSGI application. Runs in the gunicorn master (``preload_app``).

    Import-time work only: nothing built here may hold a thread, a socket or a
    file descriptor, because only the calling thread survives ``fork()``.
    Loading and validating the configuration *is* import-time work, and
    deliberately so — it is the only place left where a bad config still exits
    the process once and cleanly, before the arbiter has anything to respawn.

    Args:
        runtime: an already-built :class:`main.Runtime`, for tests. Absent — the
            gunicorn path — one is built here, and a configuration failure ends
            the process rather than propagating.
    """
    global _runtime
    if runtime is None:
        try:
            runtime = main.build_runtime()
        except Exception as exc:
            main.log_fatal(exc)
            sys.exit(1)
    _runtime = runtime

    # static_folder=None: Flask's built-in /static/ route is not what the SPA
    # needs. Vite emits index.html plus hashed assets/ at the *root* of the
    # bundle, and every unknown path has to fall through to index.html for
    # client-side routing — which is `_serve_spa` below, not a static mount.
    flask_app = Flask(__name__, static_folder=None)
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

        # /metrics is server-owned too. When SB_PROMETHEUS_ENABLED is false the
        # DispatcherMiddleware mount is absent, and without this guard the
        # request would fall through to index.html and answer **200 with HTML**
        # — which is worse than the 404 it used to get, because a scraper reads
        # a 200 as a healthy target and goes on reporting nothing wrong.
        if path == 'metrics' or path.startswith('metrics/'):
            return problem.not_found(
                "The Prometheus endpoint is disabled (SB_PROMETHEUS_ENABLED=false)")

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

    # /metrics moves out of the exporter's own ThreadingHTTPServer and into this
    # app (#651); gunicorn's `bind` list keeps it answering on its usual port, so
    # existing scrapers see no change. `make_wsgi_app` must be handed the
    # exporter's registry explicitly — PrometheusExporter uses a dedicated
    # CollectorRegistry, and the global one is empty here.
    #
    # SB_PROMETHEUS_ENABLED therefore narrows in meaning: it no longer decides
    # whether an HTTP server runs, only whether /metrics is mounted.
    if runtime.prometheus is not None:
        flask_app.wsgi_app = DispatcherMiddleware(
            flask_app.wsgi_app,
            {'/metrics': make_wsgi_app(runtime.prometheus.registry)})

    return flask_app


def current_runtime() -> main.Runtime:
    """The Runtime this process booted with, for request handlers.

    The routes cannot capture it at import: ``create_app`` runs in the master
    and the InfluxDB client is only created in ``post_fork``, so a handler must
    reach the *same* object after the fork rather than a copy taken before it.
    The module global is that channel — the fork hands the worker the identical
    object for free.
    """
    if _runtime is None:
        raise RuntimeError(
            "create_app() has not run; there is no runtime to serve from")
    return _runtime


def _static_dir() -> Path:
    """Where the built SPA lives.

    Defaults to ``<parent of this package>/static``, which is one path in both
    worlds: ``app/src/static`` in a checkout (Vite's ``build.outDir``) and
    ``/home/appuser/static`` in the image, since the Dockerfile copies ``./src``
    to the home directory. ``SB_STATIC_DIR`` overrides it for anyone serving the
    bundle from elsewhere.
    """
    override = (os.getenv('SB_STATIC_DIR') or '').strip()
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parent.parent / 'static'


def start_background() -> None:
    """``post_fork`` hook body — start everything the fork would have broken."""
    if _runtime is None:
        raise RuntimeError(
            "create_app() has not run before the fork: preload_app must stay on")
    try:
        main.start_runtime(_runtime)
    except Exception as exc:
        # Logged here, re-raised on purpose. Gunicorn turns an exception raised
        # in post_fork into WORKER_BOOT_ERROR and halts the whole arbiter, which
        # is the clean process-wide exit the old ``__main__`` got from
        # ``sys.exit(1)``. A ``sys.exit`` here would instead read as an ordinary
        # worker death and be respawned forever, failing identically each time.
        main.log_fatal(exc)
        raise


def stop_background() -> None:
    """``worker_exit`` hook body — the heir of ``__main__``'s ``finally``."""
    if _runtime is not None:
        main.shutdown_runtime(_runtime)


__all__ = ['create_app', 'current_runtime', 'start_background', 'stop_background']
