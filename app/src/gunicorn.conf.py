"""Gunicorn configuration — SuiviBourse's container entrypoint (issue #651).

The web API lives inside the scraper process, so this file is not merely a
server configuration: it *is* the boot sequence. ``preload_app`` runs the
application factory in the master before any fork, which keeps an unreadable
store (issue #696) or a broken ledger a single clean exit rather than an arbiter
respawn loop; ``post_fork`` then starts everything a fork would have broken, and
``worker_exit`` tears it back down.

Local run, from ``app/``::

    uv run gunicorn -c src/gunicorn.conf.py 'web:create_app()'
"""
import os
import sys

# Gunicorn exec's this file before it honours ``--chdir``, so make the
# application modules importable from wherever it was launched. In the container
# this is a no-op — WORKDIR is already the source directory — but it is what lets
# ``gunicorn -c src/gunicorn.conf.py`` work from ``app/`` during development.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import boot_env  # noqa: E402

# --- The socket --------------------------------------------------------------
# One, and there is no condition left to evaluate (ADR-0033). The second socket
# existed for one reason — keeping /metrics answering on a port of its own for
# the scrapers that read it — and it went with the endpoint. ``bind`` still
# takes a list because that is gunicorn's shape, not because there is a choice
# to make here.
#
# Read here, in the master, **before the application is imported**: that is one
# half of why the port stays in the environment rather than becoming a dial
# (issue #740, ADR-0014). The other half is that a port changed from the
# interface would cut the connection the interface arrived by.
_boot = boot_env.read(os.environ)
bind = [f'0.0.0.0:{_boot.web_port}']

# --- Workers ---------------------------------------------------------------
# Exactly one worker, always — see ``on_starting`` for why it is a hard guard and
# not a default. Concurrency comes from threads instead; ``gthread`` handles its
# own arbiter heartbeat from the accept loop, so a slow request cannot get the
# worker (and with it the scheduler) killed on ``timeout``.
workers = 1
threads = 4
worker_class = 'gthread'
preload_app = True

# Explicit, and it is a **boot** budget rather than a request budget (issue
# #701). `gthread` answers the arbiter's heartbeat from its accept loop, so a
# slow request cannot get this worker killed; what the timeout actually governs
# here is the window between `fork()` and the worker entering that loop — and
# `post_fork` does the whole of `start_runtime` in it: the store connection,
# the first replay, and since #701 the pre-scheduler exchange capture,
# which is no longer optional and is itself bounded at 30 s. On gunicorn's
# default of 30 s a portfolio large enough to spend that capture budget is
# SIGABRTed mid-boot and respawned to fail identically — a container that never
# becomes reachable, with nothing in the logs naming a timeout.
timeout = 120

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
_log_level = _boot.log_level.lower()
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
            f"second scraper: duplicate price points and doubled Yahoo "
            f"Finance traffic. Raise `threads` instead of `workers`.")


def post_fork(server, worker):
    """Open the store and start the scheduler and the watcher."""
    from web import start_background
    start_background()


def worker_exit(server, worker):
    """Stop the scheduler, the watcher, and close the store."""
    from web import stop_background
    stop_background()
