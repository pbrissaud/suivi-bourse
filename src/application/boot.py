"""SuiviBourse's boot sequence and container entrypoint (issue #838, ADR-0039)."""
import contextlib
import os
import sys
from functools import partial
from typing import Callable, Mapping, Optional

import uvicorn
from a2wsgi import WSGIMiddleware
from mcp.server.transport_security import TransportSecuritySettings

from application import boot_env
from application import main
from application import mcp_server
import api

WSGI_THREADS = 4

MCP_PATH = '/mcp'

NO_HOST_ALLOWLIST = TransportSecuritySettings(
    enable_dns_rebinding_protection=False)

_UVICORN_LEVELS = ('critical', 'error', 'warning', 'info', 'debug', 'trace')


class Serving:
    """The ASGI application uvicorn is handed: the Flask app, the agent's, and the teardown."""

    def __init__(self, app, on_shutdown: Callable[[], None], mcp=None):
        """Wrap the two applications, and build the agent's one **now**."""
        self.wsgi = WSGIMiddleware(app, workers=WSGI_THREADS)
        self._on_shutdown = on_shutdown
        self._mcp = mcp
        self._mcp_app = (
            mcp.streamable_http_app(streamable_http_path=MCP_PATH,
                                    transport_security=NO_HOST_ALLOWLIST)
            if mcp is not None else None)
        self._sessions: Optional[contextlib.AsyncExitStack] = None

    async def __call__(self, scope, receive, send) -> None:
        """Three ways out: the lifespan, the agent's interface, the front."""
        if scope['type'] == 'lifespan':
            await self._lifespan(receive, send)
            return

        if self._mcp_app is not None and _is_mcp(scope.get('path', '')):
            await self._mcp_app(scope, receive, send)
            return

        await self.wsgi(scope, receive, send)

    async def _lifespan(self, receive, send) -> None:
        """Startup arms the session manager; shutdown disarms it, then the runtime."""
        while True:
            message = await receive()
            if message['type'] == 'lifespan.startup':
                try:
                    await self._start()
                except Exception as exc:  # noqa: BLE001 - reported, then re-raised by uvicorn
                    await send({'type': 'lifespan.startup.failed',
                                'message': str(exc)})
                    return
                await send({'type': 'lifespan.startup.complete'})
            elif message['type'] == 'lifespan.shutdown':
                await self._stop()
                self._on_shutdown()
                await send({'type': 'lifespan.shutdown.complete'})
                return

    async def _start(self) -> None:
        """Enter the MCP session manager and hold it for the life of the socket."""
        if self._mcp is None:
            return
        sessions = contextlib.AsyncExitStack()
        await sessions.enter_async_context(self._mcp.session_manager.run())
        self._sessions = sessions

    async def _stop(self) -> None:
        """Close it, once, and before the runtime's own teardown."""
        if self._sessions is None:
            return
        sessions, self._sessions = self._sessions, None
        await sessions.aclose()


def _is_mcp(path: str) -> bool:
    """Is this path the agent's interface?"""
    return path == MCP_PATH or path.startswith(MCP_PATH + '/')


def serve(app, environment: boot_env.BootEnvironment,
          on_shutdown: Callable[[], None], mcp=None) -> None:
    """Bind the one socket and serve until a signal says otherwise."""
    level = environment.log_level.lower()
    uvicorn.run(
        Serving(app, on_shutdown, mcp),
        host='0.0.0.0',
        port=environment.web_port,
        log_level=level if level in _UVICORN_LEVELS else 'info',
        access_log=False,
    )


def sequence(env: Mapping[str, str]) -> None:
    """The boot, in order, raising rather than exiting — :func:`run` owns the code."""
    environment = boot_env.read(env)
    runtime = main.build_runtime()
    teardown = partial(main.shutdown_runtime, runtime)
    try:
        app = api.create_app(runtime)
        mcp = mcp_server.build_server(runtime)
        main.start_runtime(runtime)
        serve(app, environment, teardown, mcp)
    finally:
        teardown()


def run(env: Mapping[str, str] = None) -> int:
    """The exit code. A failure at any step is **one** exit, non-zero."""
    try:
        sequence(os.environ if env is None else env)
    except Exception as exc:
        main.log_fatal(exc)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(run())
