"""Gunicorn configuration — SuiviBourse's container entrypoint (issue #651).

The web API lives inside the scraper process, so this file is not merely a
server configuration: it *is* the boot sequence. ``preload_app`` runs the
application factory in the master before any fork, which keeps a fatal
configuration error a single clean exit rather than an arbiter respawn loop;
``post_fork`` then starts everything a fork would have broken, and
``worker_exit`` tears it back down.

Local run, from ``app/``::

    INFLUXDB_TOKEN=... uv run gunicorn -c src/gunicorn.conf.py 'web:create_app()'
"""
import os
import sys

# Gunicorn exec's this file before it honours ``--chdir``, so make the
# application modules importable from wherever it was launched. In the container
# this is a no-op — WORKDIR is already the source directory — but it is what lets
# ``gunicorn -c src/gunicorn.conf.py`` work from ``app/`` during development.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import main  # noqa: E402

# --- Sockets ---------------------------------------------------------------
# One master, two sockets, one application: ``bind`` takes a list, so this is not
# two servers. The UI port is new; :8081 keeps answering /metrics exactly as the
# retired ThreadingHTTPServer did, and that zero regression for existing
# Prometheus scrapers is the whole reason for the second socket. It is dropped
# when the endpoint is off, which is what the old exporter did by never starting
# — and when both dials name the same port, one socket serves both.
_web_port = main.env_int('SB_WEB_PORT', 8080)
bind = [f'0.0.0.0:{_web_port}']
if main.env_flag('SB_PROMETHEUS_ENABLED', True):
    _metrics_port = main.env_int('SB_METRICS_PORT', 8081)
    if _metrics_port != _web_port:
        bind.append(f'0.0.0.0:{_metrics_port}')

# --- Workers ---------------------------------------------------------------
# Exactly one worker, always — see ``on_starting`` for why it is a hard guard and
# not a default. Concurrency comes from threads instead; ``gthread`` handles its
# own arbiter heartbeat from the accept loop, so a slow request cannot get the
# worker (and with it the scheduler) killed on ``timeout``.
workers = 1
threads = 4
worker_class = 'gthread'
preload_app = True

# The `on_starting` guard is not the only door to a second worker: gunicorn's
# control socket (25.1+) lets `gunicornc -c "worker add 2"` raise `num_workers`
# on a *running* arbiter, past every check made at boot. Nothing here needs
# runtime management, so the socket is closed rather than guarded — which also
# spares the image a $HOME/.gunicorn/ directory it would never read.
control_socket_disable = True

# Gunicorn's own logs follow LOG_LEVEL when it names a level it understands, and
# fall back to its default otherwise: LOG_LEVEL is an app-wide dial that predates
# this file, and an unknown value must not turn into a boot failure. The
# application's loggers read it directly (`logfmt_logger`), unaffected either way.
_gunicorn_levels = ('debug', 'info', 'warning', 'error', 'critical')
_log_level = (os.getenv('LOG_LEVEL') or '').strip().lower()
loglevel = _log_level if _log_level in _gunicorn_levels else 'info'


def on_starting(server):
    """Refuse to boot with more than one worker (issue #651).

    APScheduler 3's ``MemoryJobStore`` has no cross-process coordination, so N
    workers are N schedulers: duplicate points on the same series identity, N×
    yfinance pressure, and the in-memory state the app's correctness rests on
    (#617's backoff counters, #628's consecutive-cycle sonde memory, #618's perf
    gate, the events cache) split N ways. Nothing about it looks broken from
    outside — the app stays healthy while it corrupts its own series — and
    "raise the workers" is the reflex on a slow web app. A silent-corruption
    failure mode earns a hard guard.

    This hook, not the module body above: the command line is applied *after*
    the configuration file, so ``--workers 4`` would sail past a check written
    there. Raising here still happens before the first fork, and gunicorn turns
    a RuntimeError out of ``on_starting`` into a one-line message and exit 1.
    """
    if server.cfg.workers != 1:
        raise RuntimeError(
            f"SuiviBourse must run with exactly one worker (configured: "
            f"{server.cfg.workers}). The scheduler lives in the worker process "
            f"and all of its state is in memory, so every extra worker is a "
            f"second scraper: duplicate InfluxDB points and doubled Yahoo "
            f"Finance traffic. Raise `threads` instead of `workers`.")


def post_fork(server, worker):
    """Start the scheduler, the InfluxDB client and the watcher in the worker."""
    from web import start_background
    start_background()


def worker_exit(server, worker):
    """Stop the scheduler and close the InfluxDB connection."""
    from web import stop_background
    stop_background()
