"""The access tokens: the bearers that open ``/api`` and ``/mcp`` without a PIN (#1313).

Each is a row in ``access_tokens`` with the scopes it opens, an expiry and the
instant it last opened anything. Only the SHA-256 of the secret is stored, and
the secret is returned once, by :func:`create` and :func:`regenerate`. The
``prefix`` is a public id drawn apart from the secret, there so the list can
say which token is which. The rules (scopes, lifetimes) are ``auth_rules``;
the gate calls :func:`authenticate` and the ``/api/tokens`` routes the rest.
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

from application import auth_rules
from application import instants

#: ``last_used_at`` moves at most this often: a script polling in a loop is
#: one read, not a write a request.
TOUCH_EVERY = timedelta(seconds=60)

#: The label a token carried over from the single-token days is given.
LEGACY_LABEL = 'Jeton existant'

_COLUMNS = ('id, label, scopes, lifetime, prefix, created_at, expires_at, '
            'last_used_at')


def _row(row) -> dict:
    id_, label, scopes, lifetime, prefix, created, expires, used = row
    return {'id': id_, 'label': label, 'scopes': scopes.split(','),
            'lifetime': lifetime, 'prefix': prefix,
            'created_at': instants.iso(created),
            'expires_at': instants.iso(expires),
            'last_used_at': instants.iso(used)}


def create(store, label: str, scopes, lifetime: str,
           now: datetime) -> Tuple[dict, str]:
    """A new token: its row as the list shows it, and the secret, never stored."""
    prefix, secret = auth_rules.new_token()
    id_ = uuid.uuid4().hex
    kept = [scope for scope in auth_rules.TOKEN_SCOPES if scope in scopes]
    store.execute(
        'INSERT INTO access_tokens (id, label, scopes, lifetime, prefix, '
        'token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id_, label, ','.join(kept), lifetime, prefix,
         auth_rules.hash_token(secret), now,
         auth_rules.token_expiry(lifetime, now)])
    return get(store, id_), secret


def get(store, id_: str) -> Optional[dict]:
    rows = store.query(f'SELECT {_COLUMNS} FROM access_tokens WHERE id = ?', [id_])
    return _row(rows[0]) if rows else None


def list_all(store) -> list:
    return [_row(r) for r in store.query(
        f'SELECT {_COLUMNS} FROM access_tokens ORDER BY created_at, id')]


def regenerate(store, id_: str, now: datetime) -> Optional[Tuple[dict, str]]:
    """A new secret and prefix for the same label, scopes and lifetime, whose
    clock starts again; the old secret stops opening anything. ``None`` when
    there is no such token."""
    current = get(store, id_)
    if current is None:
        return None
    prefix, secret = auth_rules.new_token()
    store.execute(
        'UPDATE access_tokens SET prefix = ?, token_hash = ?, created_at = ?, '
        'expires_at = ?, last_used_at = NULL WHERE id = ?',
        [prefix, auth_rules.hash_token(secret), now,
         auth_rules.token_expiry(current['lifetime'], now), id_])
    return get(store, id_), secret


def delete(store, id_: str) -> bool:
    found = get(store, id_) is not None
    store.execute('DELETE FROM access_tokens WHERE id = ?', [id_])
    return found


def clear(store) -> None:
    """Every token gone: the PIN they hung from is."""
    store.execute('DELETE FROM access_tokens')


def authenticate(store, bearer: Optional[str], scope: str, now: datetime) -> bool:
    """Whether ``bearer`` is a live token that opens the ``scope`` mount.

    Looked up by the hash of the whole bearer, so a token from before the
    prefix existed is found the same way. Notes the use, at most once a
    :data:`TOUCH_EVERY`.
    """
    if not bearer:
        return False
    rows = store.query(
        'SELECT id, scopes, expires_at, last_used_at FROM access_tokens '
        'WHERE token_hash = ?', [auth_rules.hash_token(bearer)])
    if not rows:
        return False
    id_, scopes, expires, used = rows[0]
    if not auth_rules.token_opens(scopes.split(','),
                                  instants.utc(expires) if expires else None,
                                  scope, now):
        return False
    if used is None or now - instants.utc(used) >= TOUCH_EVERY:
        store.execute('UPDATE access_tokens SET last_used_at = ? WHERE id = ?',
                      [now, id_])
    return True


def adopt(connection, token_hash: str, created_at: Optional[datetime]) -> None:
    """Carry the single token of the PIN's row over, so the clients
    holding it keep working: both scopes, never expiring. A no-op once any
    token exists. ``connection`` is the schema step's raw one."""
    if connection.execute('SELECT count(*) FROM access_tokens').fetchone()[0]:
        return
    connection.execute(
        'INSERT INTO access_tokens (id, label, scopes, lifetime, prefix, '
        'token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid.uuid4().hex, LEGACY_LABEL, ','.join(auth_rules.TOKEN_SCOPES),
         'never', auth_rules.new_token()[0], token_hash,
         created_at or datetime.now(timezone.utc)])
