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
import sys
from typing import Optional

from flask import Flask
from prometheus_client import make_wsgi_app
from werkzeug.middleware.dispatcher import DispatcherMiddleware

import main
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

    flask_app = Flask(__name__)
    flask_app.register_blueprint(health_bp)

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


__all__ = ['create_app', 'start_background', 'stop_background']
