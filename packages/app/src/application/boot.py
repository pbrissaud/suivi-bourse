"""SuiviBourse's boot sequence and container entrypoint (issue #838)."""
import contextlib
import os
import sys
from functools import partial
from typing import Callable, Mapping, Optional

import uvicorn
from a2wsgi import WSGIMiddleware
from mcp.server.transport_security import TransportSecuritySettings

from application import agent_routes
from application import auth_gate
from application import boot_env
from application import main
from application import mcp_server
import api

WSGI_THREADS = 4

MCP_PATH = '/mcp'

AGENT_CHAT_PATH = '/api/agent/chat'

AGENT_THREADS_PATH = '/api/agent/threads'

AGENT_STATEMENTS_PATH = '/api/agent/statements'

NO_HOST_ALLOWLIST = TransportSecuritySettings(
    enable_dns_rebinding_protection=False)

_UVICORN_LEVELS = ('critical', 'error', 'warning', 'info', 'debug', 'trace')


class Serving:
    """The ASGI application uvicorn is handed: the Flask app, the agent's, and the teardown."""

    def __init__(self, app, on_shutdown: Callable[[], None], mcp=None,
                 agent=None, gate=None):
        """Wrap the two applications, and build the agent's one **now**.

        ``agent`` is the in-app agent's Starlette app (#1114), async beside
        ``/mcp`` so that a turn waiting on a provider holds no WSGI worker.
        ``gate`` wraps the routing below in the PIN's gate (#1203): given the
        router, it returns the ASGI app every request goes through first.
        """
        self.wsgi = WSGIMiddleware(app, workers=WSGI_THREADS)
        self._agent = agent
        self._on_shutdown = on_shutdown
        self._mcp = mcp
        self._mcp_app = (
            mcp.streamable_http_app(streamable_http_path=MCP_PATH,
                                    transport_security=NO_HOST_ALLOWLIST)
            if mcp is not None else None)
        self._sessions: Optional[contextlib.AsyncExitStack] = None
        self._entry = gate(self._route) if gate is not None else self._route

    async def __call__(self, scope, receive, send) -> None:
        """The lifespan here; every request through the gate, then routed."""
        if scope['type'] == 'lifespan':
            await self._lifespan(receive, send)
            return
        await self._entry(scope, receive, send)

    async def _route(self, scope, receive, send) -> None:
        """Three ways out: the agent's interface, the in-app agent, the front."""
        if self._mcp_app is not None and _is_mcp(scope.get('path', '')):
            await self._mcp_app(scope, receive, send)
            return

        if self._agent is not None and _is_agent(scope.get('path', '')):
            await self._agent(scope, receive, send)
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


def _is_agent(path: str) -> bool:
    """Is this path the in-app agent's? ``/api/agent/config`` is Flask's."""
    return any(path == prefix or path.startswith(prefix + '/')
               for prefix in (AGENT_CHAT_PATH, AGENT_THREADS_PATH,
                              AGENT_STATEMENTS_PATH))


def serve(app, environment: boot_env.BootEnvironment,
          on_shutdown: Callable[[], None], mcp=None, agent=None,
          gate=None) -> None:
    """Bind the one socket and serve until a signal says otherwise.

    ``forwarded_allow_ips`` is passed even when empty: uvicorn's own default
    trusts ``X-Forwarded-For`` from localhost, and the throttle counts by IP.
    """
    level = environment.log_level.lower()
    uvicorn.run(
        Serving(app, on_shutdown, mcp, agent, gate),
        host='0.0.0.0',
        port=environment.web_port,
        log_level=level if level in _UVICORN_LEVELS else 'info',
        access_log=False,
        proxy_headers=True,
        forwarded_allow_ips=environment.forwarded_allow_ips,
    )


def build_gate(runtime: main.Runtime, environment: boot_env.BootEnvironment):
    """The PIN's gate over this runtime's store, after the reset if one is asked for."""
    if environment.reset_auth:
        auth_gate.reset(runtime.store)
    index = api._static_dir() / 'index.html'
    index_html = index.read_bytes() if index.is_file() else None
    return partial(auth_gate.Gate, store=runtime.store, index_html=index_html)


def sequence(env: Mapping[str, str]) -> None:
    """The boot, in order, raising rather than exiting — :func:`run` owns the code."""
    environment = boot_env.read(env)
    runtime = main.build_runtime(env)
    teardown = partial(main.shutdown_runtime, runtime)
    try:
        app = api.create_app(runtime)
        mcp = mcp_server.build_server(runtime)
        agent = agent_routes.build_app(runtime, mcp)
        gate = build_gate(runtime, environment)
        main.start_runtime(runtime)
        serve(app, environment, teardown, mcp, agent, gate)
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
