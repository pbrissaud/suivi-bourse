"""The PIN's gate: one ASGI layer in front of the whole socket (#1203).

It sees every request before Flask, the agent's Starlette app or ``/mcp``, and
it is **default-closed** while a PIN is set: what it does not name as open needs
a credential, so a route added later is unreachable without one whatever its
path. With the PIN off it forwards everything untouched and answers ``/auth/*``
only.

It also owns ``auth_secret``, the one row it reads and writes: the state lives
in an immutable snapshot, loaded at startup and swapped under an
``asyncio.Lock`` only once the store has taken the write (one uvicorn worker
assumed). The rules themselves — hashing, the throttle, the purge — are
``auth_rules``.
"""
import asyncio
import hashlib
import json
import secrets
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from types import MappingProxyType
from typing import Awaitable, Callable, Iterable, Mapping, Optional, Tuple

from itsdangerous import BadSignature, TimestampSigner
from werkzeug.http import parse_cookie
from logfmt_logger import getLogger

from application import auth_rules
from application import instants

logger = getLogger('auth')

COOKIE = 'sb_session'
SESSION_SECONDS = auth_rules.SESSION_DAYS * 24 * 3600
#: The sliding expiry re-signs a cookie at most this often.
RESIGN_AFTER = timedelta(days=1)

#: At most this many scrypt checks at once: each holds 16 MiB and a core.
VERIFICATIONS = 2
MAX_BODY = 4096

PROBLEM = 'application/problem+json'

Headers = Iterable[Tuple[bytes, bytes]]


# --------------------------------------------------------------------------- #
# The row
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class AuthState:
    """One reading of ``auth_secret``. No PIN hash is the PIN off."""

    pin_hash: Optional[str] = None
    session_secret: Optional[str] = None
    token_hash: Optional[str] = None
    token_created_at: Optional[datetime] = None
    revoked: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))

    @property
    def enabled(self) -> bool:
        return self.pin_hash is not None


OFF = AuthState()


def read_state(store) -> AuthState:
    """The stored row, or :data:`OFF` when there is none."""
    rows = store.query(
        'SELECT pin_hash, session_secret, token_hash, token_created_at, revoked '
        'FROM auth_secret WHERE id = 1')
    if not rows:
        return OFF
    pin_hash, secret, token_hash, created_at, revoked = rows[0]
    return AuthState(pin_hash, secret, token_hash,
                     instants.utc(created_at) if created_at else None,
                     MappingProxyType(json.loads(revoked or '{}')))


def write_state(store, state: AuthState) -> None:
    """Replace the row with ``state``, or delete it when the PIN is off."""
    with store.transaction():
        store.execute('DELETE FROM auth_secret')
        if not state.enabled:
            return
        store.execute(
            'INSERT INTO auth_secret (id, pin_hash, session_secret, token_hash, '
            'token_created_at, revoked, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
            [state.pin_hash, state.session_secret, state.token_hash,
             state.token_created_at, json.dumps(dict(state.revoked)),
             datetime.now(timezone.utc)])


def reset(store) -> None:
    """``SB_RESET_AUTH=1``: the PIN, the session secret and the MCP token, gone."""
    write_state(store, OFF)
    logger.warning(
        'SB_RESET_AUTH is set: the PIN, the session secret and the MCP token '
        'were cleared, and will be on every start until the variable is removed')


# --------------------------------------------------------------------------- #
# The gate
# --------------------------------------------------------------------------- #

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Gate:
    """``Gate(inner, store, index_html)`` is an ASGI app wrapping ``inner``."""

    def __init__(self, inner, store, index_html: Optional[bytes],
                 clock: Callable[[], float] = time.monotonic,
                 now: Callable[[], datetime] = _utcnow):
        self.inner = inner
        self.store = store
        self.index_html = index_html
        self.now = now
        self.state = read_state(store)
        self.throttle = auth_rules.Throttle(clock)
        self._lock = asyncio.Lock()
        self._checks = asyncio.Semaphore(VERIFICATIONS)

    async def __call__(self, scope, receive, send) -> None:
        state = self.state
        if scope['type'] != 'http':
            if state.enabled:
                await send({'type': 'websocket.close', 'code': 1008})
                return
            await self.inner(scope, receive, send)
            return

        path = scope.get('path', '')
        if path == '/auth' or path.startswith('/auth/'):
            await self._auth(scope, receive, send, path)
            return
        if not state.enabled:
            await self.inner(scope, receive, send)
            return

        reading = scope.get('method') in ('GET', 'HEAD')
        public = path in ('/health', '/api/theme.css') or path.startswith('/assets/')
        if reading and public:
            await self.inner(scope, receive, send)
            return

        if path.startswith('/mcp'):
            if auth_rules.token_matches(_bearer(scope), state.token_hash):
                await self.inner(scope, receive, send)
                return
            await _problem(send, 401, 'Unauthorized',
                           'A bearer token is needed here.',
                           headers=[(b'www-authenticate', b'Bearer')])
            return

        session = self._session(scope, state)
        if session is not None:
            sid, signed_at = session
            if self.now() - signed_at >= RESIGN_AFTER:
                send = _with_cookie(send, self._cookie(scope, state, sid))
            await self.inner(scope, receive, send)
            return

        if path == '/api' or path.startswith('/api/') or not reading:
            await _unauthorized(send)
            return
        await self._index(send)

    # ------------------------------------------------------------------ #
    # Credentials
    # ------------------------------------------------------------------ #

    def _signer(self, state: AuthState) -> TimestampSigner:
        return TimestampSigner(state.session_secret, salt='sb-session',
                               digest_method=hashlib.sha256)

    def _session(self, scope, state: AuthState):
        """``(session id, signed at)`` for a valid, unrevoked cookie, else ``None``."""
        raw = _cookie(scope, COOKIE)
        if not raw or not state.enabled:
            return None
        try:
            sid, signed_at = self._signer(state).unsign(
                raw, max_age=SESSION_SECONDS, return_timestamp=True)
        except BadSignature:
            return None
        sid = sid.decode()
        if sid in state.revoked:
            return None
        return sid, signed_at

    def _cookie(self, scope, state: AuthState, sid: str) -> bytes:
        signed = self._signer(state).sign(sid).decode()
        return _set_cookie(scope, signed, SESSION_SECONDS)

    def _fresh_cookie(self, scope, state: AuthState) -> bytes:
        return self._cookie(scope, state, secrets.token_urlsafe(16))

    async def _verify(self, pin, stored: Optional[str]) -> bool:
        async with self._checks:
            return await asyncio.to_thread(auth_rules.verify_pin, pin, stored)

    async def _commit(self, change: Callable[[AuthState], Awaitable[AuthState]]):
        """Store first, then the snapshot: a write the store refused changes nothing."""
        async with self._lock:
            before = self.state
            after = await change(before)
            if after is before:
                return after
            await asyncio.to_thread(write_state, self.store, after)
            self.state = after
            return after

    # ------------------------------------------------------------------ #
    # /auth/*
    # ------------------------------------------------------------------ #

    async def _auth(self, scope, receive, send, path: str) -> None:
        method = scope.get('method')
        route = {
            ('GET', '/auth/status'): self._status,
            ('POST', '/auth/pin'): self._sign_in,
            ('POST', '/auth/logout'): self._logout,
            ('POST', '/auth/enable'): self._enable,
            ('POST', '/auth/change'): self._change,
            ('POST', '/auth/disable'): self._disable,
            ('POST', '/auth/token'): self._regenerate,
        }.get((method, path))
        if route is None:
            await _problem(send, 404, 'Not found', f'No such route: {method} {path}')
            return
        state = self.state
        session = self._session(scope, state)
        guarded = route in (self._change, self._disable, self._regenerate)
        if guarded:
            if not state.enabled:
                await _problem(send, 409, 'No code is set')
                return
            if session is None:
                await _unauthorized(send)
                return
            # The current code is throttled like a sign-in, session or not: a
            # copied cookie must not be a way to guess the PIN at leisure.
            admission = self.throttle.enter(_client(scope))
            if not admission.admitted:
                await _too_many(send, admission.retry_after)
                return
        try:
            body = await _json_body(receive) if method == 'POST' else {}
        except ValueError as exc:
            await _problem(send, 400, 'Bad request', str(exc))
            return
        try:
            await route(scope, send, state, session, body)
            if guarded:
                self.throttle.succeeded(_client(scope))
        except _WrongCode:
            await _wrong_current(send, admission.remaining, self.throttle.wait(_client(scope)))
        except Exception as exc:  # noqa: BLE001 - the store refused: nothing changed
            logger.error(f'An auth write failed, the previous state stands: {exc}')
            await _problem(send, 503, 'Storage unavailable',
                           'The change could not be saved; nothing changed.')

    async def _status(self, scope, send, state, session, body) -> None:
        signed_in = state.enabled and session is not None
        await _json(send, 200, {
            'enabled': state.enabled,
            'authenticated': signed_in,
            'token_created_at': instants.iso(state.token_created_at)
            if signed_in and state.token_created_at else None,
        })

    async def _sign_in(self, scope, send, state, session, body) -> None:
        if not state.enabled:
            await _problem(send, 409, 'No code is set')
            return
        # Every attempt is counted, session or not: a copied cookie must not be
        # a way to test PINs here without limit, as on the current-code routes.
        ip = _client(scope)
        admission = self.throttle.enter(ip)
        if not admission.admitted:
            await _too_many(send, admission.retry_after)
            return
        if not await self._verify(body.get('pin'), state.pin_hash):
            wait = self.throttle.wait(ip)
            await _problem(
                send, 401, 'Wrong code', remaining=admission.remaining,
                retry_after=wait or None,
                headers=[(b'retry-after', str(wait).encode())] if wait else ())
            return
        self.throttle.succeeded(ip)
        # Signed with the state the code was checked against: a PIN changed in
        # the meantime rotated the secret, and this cookie dies with the old one.
        await _json(send, 200, {'enabled': True, 'authenticated': True},
                    headers=[(b'set-cookie', self._fresh_cookie(scope, state))])

    async def _logout(self, scope, send, state, session, body) -> None:
        if session is not None:
            sid = session[0]

            async def revoke(current: AuthState) -> AuthState:
                if not current.enabled:
                    return current
                now = self.now()
                revoked = auth_rules.purge_revoked(current.revoked, now)
                revoked[sid] = instants.iso(now)
                return replace(current, revoked=MappingProxyType(revoked))
            await self._commit(revoke)
        await _empty(send, [(b'set-cookie', _set_cookie(scope, '', 0))])

    async def _enable(self, scope, send, state, session, body) -> None:
        pin = body.get('pin')
        if not auth_rules.is_pin(pin):
            await _problem(send, 400, 'Bad request', 'A code is six digits.')
            return
        token = auth_rules.new_token()

        async def enable(current: AuthState) -> AuthState:
            if current.enabled:
                return current
            return AuthState(
                pin_hash=await asyncio.to_thread(auth_rules.hash_pin, pin),
                session_secret=secrets.token_hex(32),
                token_hash=auth_rules.hash_token(token),
                token_created_at=self.now())
        after = await self._commit(enable)
        if after.token_hash != auth_rules.hash_token(token):
            await _problem(send, 409, 'A code is already set')
            return
        logger.info('A PIN was set')
        await _json(send, 200, _token_body(token, after),
                    headers=[(b'set-cookie', self._fresh_cookie(scope, after))])

    async def _change(self, scope, send, state, session, body) -> None:
        pin = body.get('pin')
        if not auth_rules.is_pin(pin):
            await _problem(send, 400, 'Bad request', 'A code is six digits.')
            return

        async def change(current: AuthState) -> AuthState:
            if not await self._verify(body.get('current'), current.pin_hash):
                raise _WrongCode()
            return replace(
                current,
                pin_hash=await asyncio.to_thread(auth_rules.hash_pin, pin),
                session_secret=secrets.token_hex(32),
                revoked=MappingProxyType({}))
        after = await self._commit(change)
        logger.info('The PIN was changed; every other session was signed out')
        await _json(send, 200, {'enabled': True},
                    headers=[(b'set-cookie', self._fresh_cookie(scope, after))])

    async def _disable(self, scope, send, state, session, body) -> None:
        async def disable(current: AuthState) -> AuthState:
            if not await self._verify(body.get('current'), current.pin_hash):
                raise _WrongCode()
            return OFF
        await self._commit(disable)
        logger.info('The PIN was removed, and the MCP token with it')
        await _json(send, 200, {'enabled': False},
                    headers=[(b'set-cookie', _set_cookie(scope, '', 0))])

    async def _regenerate(self, scope, send, state, session, body) -> None:
        token = auth_rules.new_token()

        async def regenerate(current: AuthState) -> AuthState:
            if not await self._verify(body.get('current'), current.pin_hash):
                raise _WrongCode()
            return replace(current, token_hash=auth_rules.hash_token(token),
                           token_created_at=self.now())
        after = await self._commit(regenerate)
        logger.info('The MCP token was regenerated')
        await _json(send, 200, _token_body(token, after))

    async def _index(self, send) -> None:
        if self.index_html is None:
            await _problem(send, 404, 'Not found',
                           'No web UI bundle in this build; the API is available under /api')
            return
        await _respond(send, 200, self.index_html,
                       [(b'content-type', b'text/html; charset=utf-8'),
                        (b'cache-control', b'no-cache')])


class _WrongCode(Exception):
    """The current PIN a change asked for was not the right one."""


def _token_body(token: str, state: AuthState) -> dict:
    return {'token': token,
            'token_created_at': instants.iso(state.token_created_at)}


# --------------------------------------------------------------------------- #
# The protocol, by hand: the gate stands in front of every framework
# --------------------------------------------------------------------------- #

def _header(scope, name: bytes) -> Optional[str]:
    for key, value in scope.get('headers') or ():
        if key == name:
            return value.decode('latin1')
    return None


def _cookie(scope, name: str) -> Optional[str]:
    """Werkzeug's lenient parser: ``SimpleCookie`` stops at the first cookie it
    cannot read, so another app's JSON cookie on the same host hid ours."""
    raw = _header(scope, b'cookie')
    return parse_cookie(raw).get(name) if raw else None


def _bearer(scope) -> Optional[str]:
    raw = _header(scope, b'authorization') or ''
    scheme, _, token = raw.partition(' ')
    return token.strip() if scheme.lower() == 'bearer' else None


def _client(scope) -> str:
    client = scope.get('client')
    return client[0] if client else ''


def _set_cookie(scope, value: str, max_age: int) -> bytes:
    secure = '; Secure' if scope.get('scheme') == 'https' else ''
    return (f'{COOKIE}={value}; Path=/; Max-Age={max_age}; HttpOnly; '
            f'SameSite=Strict{secure}').encode()


def _with_cookie(send, cookie: bytes):
    async def sending(message):
        if message['type'] == 'http.response.start':
            message = {**message, 'headers': [*message.get('headers', ()),
                                              (b'set-cookie', cookie)]}
        await send(message)
    return sending


async def _json_body(receive) -> dict:
    body = b''
    while True:
        message = await receive()
        if message['type'] == 'http.disconnect':
            break
        body += message.get('body', b'')
        if len(body) > MAX_BODY:
            raise ValueError('The body is too large.')
        if not message.get('more_body'):
            break
    if not body:
        return {}
    try:
        parsed = json.loads(body)
    except ValueError:
        raise ValueError('The body is not JSON.') from None
    if not isinstance(parsed, dict):
        raise ValueError('The body is not a JSON object.')
    return parsed


async def _respond(send, status: int, body: bytes, headers: Headers) -> None:
    await send({'type': 'http.response.start', 'status': status,
                'headers': [*headers, (b'content-length', str(len(body)).encode())]})
    await send({'type': 'http.response.body', 'body': body})


async def _json(send, status: int, payload: dict, headers: Headers = ()) -> None:
    await _respond(send, status, json.dumps(payload).encode(),
                   [(b'content-type', b'application/json'), *headers])


async def _empty(send, headers: Headers = ()) -> None:
    await send({'type': 'http.response.start', 'status': 204,
                'headers': list(headers)})
    await send({'type': 'http.response.body', 'body': b''})


async def _problem(send, status: int, title: str, detail: Optional[str] = None,
                   headers: Headers = (), **extra) -> None:
    body = {'type': '/problems/auth', 'title': title, 'status': status, **extra}
    if detail:
        body['detail'] = detail
    await _respond(send, status, json.dumps(body).encode(),
                   [(b'content-type', PROBLEM.encode()), *headers])


async def _unauthorized(send) -> None:
    await _problem(send, 401, 'Unauthorized', 'The code is needed to go on.')


async def _wrong_current(send, remaining: int, wait: int) -> None:
    # 403, not 401: a 401 is the front's *your session ended*.
    await _problem(send, 403, 'Wrong code', 'The current code is not this one.',
                   remaining=remaining, retry_after=wait or None,
                   headers=[(b'retry-after', str(wait).encode())] if wait else ())


async def _too_many(send, retry_after: int) -> None:
    await _problem(send, 429, 'Too many attempts', retry_after=retry_after,
                   headers=[(b'retry-after', str(retry_after).encode())])


__all__ = ['Gate', 'AuthState', 'OFF', 'COOKIE', 'read_state', 'write_state', 'reset']
