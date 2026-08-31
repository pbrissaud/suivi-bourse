"""SuiviBourse's boot sequence and container entrypoint (issue #838, ADR-0039).

One process, and therefore one file. The sequence is linear and reads top to
bottom — the environment, the store, the application, the jobs, the socket —
because there is no longer a ``fork()`` cutting it in half and no hook to hang
the second half on.

What that removes is not only a file. gunicorn always forks: ``workers = 1`` and
``preload_app`` shaped the fork rather than removed it, and on macOS the worker
segfaulted the moment a scrape job ran — measured in ADR-0039, twice per respawn
cycle, against none here. It also removes the two guards that existed to forbid a
second worker (``on_starting`` and ``control_socket_disable``): there is no
arbiter left to raise a worker count against, and the ``--workers`` door is shut
by there being no command line in the image at all. The ``ENTRYPOINT`` is
``python boot.py``, and :func:`serve` calls ``uvicorn.run`` in process.

Run it by hand, from the repository root::

    PYTHONPATH=src uv run python -m application.boot

``pythonpath = ["src"]`` in ``pyproject.toml`` is pytest's alone, and the project
is not installable (``package = false``), so the import root is named here.
"""
import os
import sys
from functools import partial
from typing import Callable, Mapping

import uvicorn
from a2wsgi import WSGIMiddleware

from application import boot_env
from application import main
import api

#: The size of the pool the WSGI application is called in. It is the
#: ``threads = 4`` gunicorn's ``gthread`` worker carried — the number moved, it
#: was not re-chosen.
WSGI_THREADS = 4

#: The levels uvicorn's own logger understands. ``LOG_LEVEL`` is an app-wide
#: dial that predates any server (ADR-0014), so a value it does not recognise
#: falls back rather than failing the boot — the application's own loggers read
#: the variable directly and are unaffected either way.
_UVICORN_LEVELS = ('critical', 'error', 'warning', 'info', 'debug', 'trace')


class Serving:
    """The ASGI application uvicorn is handed: the Flask app, and the teardown.

    The Flask application is served **unchanged**, behind a WSGI-to-ASGI adapter:
    no route is rewritten, and ``create_app()`` stays the seam the whole Python
    suite is written against (ADR-0039).

    The teardown hangs off the **lifespan shutdown**, and that is not a matter of
    taste. uvicorn catches ``SIGTERM``, shuts down gracefully, restores the
    handler it replaced and then re-raises the signal — so the process dies of
    ``SIGTERM`` the instant ``uvicorn.run`` returns, and anything written after
    that call does not run. ``docker stop`` sends exactly that signal. The
    lifespan shutdown is the last thing uvicorn drives while the process is still
    alive, which makes it the exact heir of gunicorn's ``worker_exit``.

    a2wsgi answers the lifespan protocol itself, and correctly; it is intercepted
    here rather than delegated to because there is something to do in it.
    """

    def __init__(self, app, on_shutdown: Callable[[], None]):
        self.wsgi = WSGIMiddleware(app, workers=WSGI_THREADS)
        self._on_shutdown = on_shutdown

    async def __call__(self, scope, receive, send) -> None:
        if scope['type'] != 'lifespan':
            await self.wsgi(scope, receive, send)
            return

        while True:
            message = await receive()
            if message['type'] == 'lifespan.startup':
                await send({'type': 'lifespan.startup.complete'})
            elif message['type'] == 'lifespan.shutdown':
                self._on_shutdown()
                await send({'type': 'lifespan.shutdown.complete'})
                return


def serve(app, environment: boot_env.BootEnvironment,
          on_shutdown: Callable[[], None]) -> None:
    """Bind the one socket and serve until a signal says otherwise.

    ``uvicorn.run`` and not a command line, which is the whole of how the
    multiprocess door stays shut: there is no flag to pass because there is no
    CLI in the image to pass it to.
    """
    level = environment.log_level.lower()
    uvicorn.run(
        Serving(app, on_shutdown),
        host='0.0.0.0',
        port=environment.web_port,
        log_level=level if level in _UVICORN_LEVELS else 'info',
        # Off, as gunicorn's was: nothing logged a request line before, and the
        # container's own probe would be two lines a minute of them.
        access_log=False,
    )


def sequence(env: Mapping[str, str]) -> None:
    """The boot, in order, raising rather than exiting — :func:`run` owns the code.

    Five steps and no branch:

    1. the environment, read **once** and as a whole (issue #740);
    2. the store, opened, brought to its schema, seeded, and the ledger replayed
       — the connection stays open for the life of the process, because nothing
       has to survive a fork any more (ADR-0039);
    3. the Flask application, built on that runtime;
    4. the scheduler and its jobs;
    5. the socket.

    The teardown is named **twice**, and the two are not redundant.
    :class:`Serving` runs it on the lifespan shutdown, which is the graceful path
    and the only one a ``SIGTERM`` leaves time for; the ``finally`` here covers
    the boot that never reached a lifespan at all — a port already taken, a step
    that raised. :func:`main.shutdown_runtime` is written to be called twice and
    the second call finds nothing left to do.
    """
    environment = boot_env.read(env)
    runtime = main.build_runtime()
    teardown = partial(main.shutdown_runtime, runtime)
    try:
        app = api.create_app(runtime)
        main.start_runtime(runtime)
        serve(app, environment, teardown)
    finally:
        teardown()


def run(env: Mapping[str, str] = None) -> int:
    """The exit code. A failure at any step is **one** exit, non-zero.

    There is no arbiter to respawn anything, which is what lets this be the
    whole of the failure handling: the process that cannot boot says why and
    dies, the container exits, and the restart policy decides in the open
    (ADR-0039). ``preload_app`` existed to keep an unreadable store (#696) a
    single clean exit rather than a respawn loop — a defence against a failure
    mode the arbiter itself introduced, and it goes with it.
    """
    try:
        sequence(os.environ if env is None else env)
    except Exception as exc:
        main.log_fatal(exc)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(run())
