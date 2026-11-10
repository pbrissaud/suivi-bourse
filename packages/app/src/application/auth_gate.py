"""The PIN's gate: one ASGI layer in front of the whole socket (#1203).

It sees every request before Flask, the agent's Starlette app or ``/mcp``, and
it is **default-closed** while a PIN is set: what it does not name as open needs
a credential, so a route added later is unreachable without one whatever its
path. With the PIN off it forwards everything untouched and answers ``/auth/*``
only.

Two credentials. The **session cookie** opens the app. An **access token**, a
bearer shown once, opens the mount its scopes name: ``/mcp`` for ``mcp``, every
method on ``/api`` for ``api`` (#1313). Never ``/auth/*`` nor ``/api/tokens``: a
leaked token cannot mint another, change the lifetime or turn the code off. A session lives the **stored lifetime** (30 days unless the owner
chose less) after it was last signed; any request re-signs a cookie older than
a minute, except one marked ``X-SB-Background: 1`` — a poll from a tab nobody
touches does not keep the session alive.

It also owns ``auth_secret``, the one row it reads and writes: the state lives
in an immutable snapshot, loaded at startup and swapped under an
``asyncio.Lock`` only once the store has taken the write (one uvicorn worker
assumed). The tokens are ``access_tokens``' rows, looked up per bearer request.
The rules themselves — hashing, the throttle, the purge — are ``auth_rules``.
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

from application import access_tokens
from application import auth_rules
from application import instants
from application import store_steps

logger = getLogger('auth')

COOKIE = 'sb_session'
#: The sliding expiry re-signs a cookie at most this often, so a session locks
#: between L - 60 s and L after the last activity (#1313).
RESIGN_AFTER = timedelta(seconds=60)
#: What the front sets on a request sent long after the tab's last input.
BACKGROUND = b'x-sb-background'

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
    revoked: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))
    #: As stored: ``None`` is the default. Read :attr:`lifetime`.
    session_seconds: Optional[int] = None
    #: When the code was first set: « Actif depuis le … » (kept across changes).
    enabled_at: Optional[datetime] = None

    @property
    def enabled(self) -> bool:
        return self.pin_hash is not None

    @property
    def lifetime(self) -> int:
        """Seconds a session lives after it was last signed."""
        return auth_rules.session_seconds(self.session_seconds)


OFF = AuthState()


def read_state(store) -> AuthState:
    """The stored row, or :data:`OFF` when there is none."""
    rows = store.query(
        'SELECT pin_hash, session_secret, revoked, session_seconds, '
        'enabled_at, updated_at FROM auth_secret WHERE id = 1')
    if not rows:
        return OFF
    pin_hash, secret, revoked, seconds, enabled_at, updated_at = rows[0]
    # A code set before the column existed: its last write is the best date known.
    since = enabled_at or updated_at
    return AuthState(pin_hash, secret,
                     MappingProxyType(json.loads(revoked or '{}')), seconds,
                     instants.utc(since) if since else None)


def write_state(store, state: AuthState) -> None:
    """Replace the row with ``state``, or delete it when the PIN is off, and the
    access tokens with it."""
    with store.transaction():
        store.execute('DELETE FROM auth_secret')
        if not state.enabled:
            access_tokens.clear(store)
            return
        store.execute(
            'INSERT INTO auth_secret (id, pin_hash, session_secret, revoked, '
            'session_seconds, enabled_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
            [state.pin_hash, state.session_secret, json.dumps(dict(state.revoked)),
             state.session_seconds, state.enabled_at, datetime.now(timezone.utc)])


def add_session_seconds(connection) -> None:
    """The schema step giving an existing ``auth_secret`` its lifetime (#1313).

    Here and not in ``schema_steps``: the gate stays the one module that names
    its row. ``CREATE TABLE IF NOT EXISTS`` does not reach a table it finds; the
    column stays ``NULL``, which reads as the default. A no-op on a new store.
    """
    store_steps.add_column(connection, 'auth_secret', 'session_seconds', 'INTEGER')


def add_enabled_at(connection) -> None:
    """The schema step giving an existing ``auth_secret`` its first-set date.

    ``NULL`` on a code set before it: read as ``updated_at``. A no-op on a new store.
    """
    store_steps.add_column(connection, 'auth_secret', 'enabled_at', 'TIMESTAMPTZ')


def move_token_to_access_tokens(connection) -> None:
    """The schema step turning the single access token into a row of
    ``access_tokens`` (#1313): both scopes, never expiring, so the clients that
    hold it keep working. The legacy columns stay, unread. A no-op on a store
    with no token."""
    row = connection.execute(
        'SELECT token_hash, token_created_at FROM auth_secret '
        'WHERE id = 1 AND token_hash IS NOT NULL').fetchone()
    if row:
        access_tokens.adopt(connection, row[0], row[1])


def reset(store) -> None:
    """``SB_RESET_AUTH=1``: the PIN, the session secret and the access tokens, gone."""
    write_state(store, OFF)
    logger.warning(
        'SB_RESET_AUTH is set: the PIN, the session secret and the access token '
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
        # The product's icons (#1337) are read by the browser's tab before the
        # PIN screen has a session: without them it caches the index page as
        # the favicon and keeps it after login.
        public = path.startswith('/assets/') or path in (
            '/health', '/healthz', '/readyz', '/api/theme.css', '/favicon.svg', '/favicon-32.png',
            '/apple-touch-icon.png')
        if reading and public:
            await self.inner(scope, receive, send)
            return

        bearer = _bearer(scope)
        if path.startswith('/mcp'):
            if await self._token_opens(bearer, 'mcp'):
                await self.inner(scope, receive, send)
                return
            await _problem(send, 401, 'Unauthorized',
                           'A bearer token is needed here.',
                           headers=[(b'www-authenticate', b'Bearer')])
            return

        api = path == '/api' or path.startswith('/api/')
        # A token with the ``api`` scope opens /api for scripts, every method
        # (#1313), but not the tokens themselves. A wrong one is no answer yet:
        # the cookie beside it may still be good.
        tokens = path == '/api/tokens' or path.startswith('/api/tokens/')
        if api and not tokens and await self._token_opens(bearer, 'api'):
            await self.inner(scope, receive, send)
            return

        session = self._session(scope, state)
        if session is not None:
            sid, signed_at = session
            stale = self.now() - signed_at >= RESIGN_AFTER
            if stale and _header(scope, BACKGROUND) != '1':
                send = _with_cookie(send, self._cookie(scope, state, sid))
            await self.inner(scope, receive, send)
            return

        if api or not reading:
            await _unauthorized(send)
            return
        await self._index(send)

    # ------------------------------------------------------------------ #
    # Credentials
    # ------------------------------------------------------------------ #

    def _signer(self, state: AuthState) -> TimestampSigner:
        return _Signer(self.now, state.session_secret, salt='sb-session',
                       digest_method=hashlib.sha256)

    def _session(self, scope, state: AuthState):
        """``(session id, signed at)`` for a valid, unrevoked cookie, else ``None``."""
        raw = _cookie(scope, COOKIE)
        if not raw or not state.enabled:
            return None
        try:
            sid, signed_at = self._signer(state).unsign(
                raw, max_age=state.lifetime, return_timestamp=True)
        except BadSignature:
            return None
        sid = sid.decode()
        if sid in state.revoked:
            return None
        return sid, signed_at

    def _cookie(self, scope, state: AuthState, sid: str) -> bytes:
        signed = self._signer(state).sign(sid).decode()
        return _set_cookie(scope, signed, state.lifetime)

    def _fresh_cookie(self, scope, state: AuthState) -> bytes:
        return self._cookie(scope, state, secrets.token_urlsafe(16))

    async def _token_opens(self, bearer: Optional[str], scope: str) -> bool:
        if not bearer:
            return False
        return await asyncio.to_thread(
            access_tokens.authenticate, self.store, bearer, scope, self.now())

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
            ('POST', '/auth/lifetime'): self._lifetime,
        }.get((method, path))
        if route is None:
            await _problem(send, 404, 'Not found', f'No such route: {method} {path}')
            return
        state = self.state
        session = self._session(scope, state)
        guarded = route in (self._change, self._disable)
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
            'session_seconds': state.lifetime if signed_in else None,
            'enabled_since': (instants.iso(state.enabled_at)
                              if signed_in and state.enabled_at else None),
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
        created = False

        async def enable(current: AuthState) -> AuthState:
            nonlocal created
            if current.enabled:
                return current
            created = True
            return AuthState(
                pin_hash=await asyncio.to_thread(auth_rules.hash_pin, pin),
                session_secret=secrets.token_hex(32),
                enabled_at=self.now())
        after = await self._commit(enable)
        if not created:
            await _problem(send, 409, 'A code is already set')
            return
        logger.info('A PIN was set')
        await _json(send, 200, {'enabled': True},
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
        logger.info('The PIN was removed, and the access tokens with it')
        await _json(send, 200, {'enabled': False},
                    headers=[(b'set-cookie', _set_cookie(scope, '', 0))])

    async def _lifetime(self, scope, send, state, session, body) -> None:
        """Store how long a session lives, and re-sign the caller's cookie.

        Not guarded: no current code, no throttle. A stolen cookie can already
        keep itself alive by polling; a longer lifetime gives it nothing more.
        Lowering it refuses every other cookie older than the new lifetime at
        once, but not the caller's, who may have read the page for a while.
        """
        if not state.enabled:
            await _problem(send, 409, 'No code is set')
            return
        if session is None:
            await _unauthorized(send)
            return
        seconds = body.get('seconds')
        offered = type(seconds) is int and seconds in auth_rules.SESSION_PRESETS
        if not offered:
            await _problem(send, 400, 'Bad request',
                           'A lifetime is one of the offered durations.',
                           allowed=list(auth_rules.SESSION_PRESETS))
            return

        # The session was checked against ``state``, before the body was read. A
        # PIN change landing in between rotated the secret: that session is
        # over, and must be neither obeyed nor re-signed with the new secret.
        async def store(current: AuthState) -> AuthState:
            if not current.enabled or current.session_secret != state.session_secret:
                return current
            return replace(current, session_seconds=seconds)
        after = await self._commit(store)
        if not after.enabled:
            await _problem(send, 409, 'No code is set')
            return
        if after.session_secret != state.session_secret or session[0] in after.revoked:
            await _unauthorized(send)
            return
        logger.info(f'The session lifetime is now {seconds} s')
        await _json(send, 200, {'session_seconds': after.lifetime},
                    headers=[(b'set-cookie', self._cookie(scope, after, session[0]))])

    async def _index(self, send) -> None:
        if self.index_html is None:
            await _problem(send, 404, 'Not found',
                           'No web UI bundle in this build; the API is available under /api')
            return
        await _respond(send, 200, self.index_html,
                       [(b'content-type', b'text/html; charset=utf-8'),
                        (b'cache-control', b'no-cache')])


class _Signer(TimestampSigner):
    """Signs and ages a cookie on the gate's clock, not the wall's: one clock."""

    def __init__(self, now: Callable[[], datetime], *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._now = now

    def get_timestamp(self) -> int:
        return int(self._now().timestamp())


class _WrongCode(Exception):
    """The current PIN a change asked for was not the right one."""


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
