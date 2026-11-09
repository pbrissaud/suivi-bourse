"""The access tokens (#1313): rows with scopes and an expiry, a gate that checks the mount.

The gate's sweep over every route lives in ``test_auth_gate``; here the rows, the
``/api/tokens`` routes, the scope check and the migration of the single token.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from application import access_tokens, auth_rules, schema_steps
from application import store as store_module
from application.auth_gate import Gate
from test_auth_gate import INDEX, Inner, client, enable, with_cookie
from test_schema_steps import _before
from test_web_api import build_client_and_store

NOW = datetime(2026, 11, 9, 9, 0, tzinfo=timezone.utc)


@pytest.fixture
def opened(tmp_path):
    s = store_module.open_store(tmp_path / 'tokens.duckdb')
    yield s
    s.close()


def bearer(secret):
    return {'authorization': f'Bearer {secret}'}


def test_a_token_is_listed_without_its_secret_and_stored_as_a_hash(opened):
    row, secret = access_tokens.create(opened, 'Claude Desktop', ['mcp', 'api'], '1y', NOW)

    assert row['scopes'] == ['api', 'mcp']
    assert row['expires_at'] == (NOW + timedelta(days=365)).isoformat()
    assert row['last_used_at'] is None
    assert secret.startswith(f"sb_{row['prefix']}_")
    assert access_tokens.list_all(opened) == [row]
    assert opened.query('SELECT token_hash FROM access_tokens') == [
        (auth_rules.hash_token(secret),)]
    assert secret not in repr(opened.query('SELECT * FROM access_tokens'))


def test_the_gate_checks_the_scope_against_the_mount(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        await enable(gate)
        _, api_only = access_tokens.create(opened, 'script', ['api'], 'never', NOW)
        _, mcp_only = access_tokens.create(opened, 'desktop', ['mcp'], 'never', NOW)
        async with client(gate) as c:
            return [(await c.get(path, headers=bearer(secret))).status_code
                    for secret in (api_only, mcp_only)
                    for path in ('/api/positions', '/mcp')]

    assert asyncio.run(work()) == [200, 401, 401, 200]


def test_an_expired_token_opens_nothing_and_a_regenerated_one_replaces_the_old(opened):
    row, secret = access_tokens.create(
        opened, 'old', ['api'], '90d', datetime.now(timezone.utc) - timedelta(days=91))
    gate = Gate(Inner(), opened, INDEX)

    async def status(c, secret):
        return (await c.get('/api/positions', headers=bearer(secret))).status_code

    async def work():
        await enable(gate)
        async with client(gate) as c:
            expired = await status(c, secret)
            fresh_row, fresh = access_tokens.regenerate(
                opened, row['id'], datetime.now(timezone.utc))
            return (expired, await status(c, secret), await status(c, fresh),
                    fresh_row['label'], fresh_row['prefix'] != row['prefix'])

    assert asyncio.run(work()) == (401, 401, 200, 'old', True)


def test_the_use_of_a_token_is_noted_at_most_once_a_minute(opened):
    row, secret = access_tokens.create(opened, 'script', ['api'], 'never', NOW)

    assert access_tokens.authenticate(opened, secret, 'api', NOW)
    assert not access_tokens.authenticate(opened, secret, 'mcp', NOW)
    assert access_tokens.get(opened, row['id'])['last_used_at'] == NOW.isoformat()

    later = NOW + timedelta(seconds=30)
    assert access_tokens.authenticate(opened, secret, 'api', later)
    assert access_tokens.get(opened, row['id'])['last_used_at'] == NOW.isoformat()

    later = NOW + timedelta(minutes=2)
    assert access_tokens.authenticate(opened, secret, 'api', later)
    assert access_tokens.get(opened, row['id'])['last_used_at'] == later.isoformat()


def test_a_bearer_cannot_reach_the_tokens_but_the_cookie_can(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        _, cookie = await enable(gate)
        _, secret = access_tokens.create(opened, 'script', ['api', 'mcp'], 'never', NOW)
        async with client(gate) as c:
            return [(await c.request(m, p, headers=h)).status_code for m, p, h in (
                ('GET', '/api/tokens', bearer(secret)),
                ('POST', '/api/tokens', bearer(secret)),
                ('DELETE', '/api/tokens/x', bearer(secret)),
                ('POST', '/api/tokens/x/regenerate', bearer(secret)),
                ('GET', '/api/tokens', with_cookie(cookie)))]

    assert asyncio.run(work()) == [401, 401, 401, 401, 200]


def test_the_single_token_becomes_a_row_that_keeps_working(tmp_path):
    secret = 'legacy-bearer-from-before-the-prefix'
    path, connection = _before(tmp_path, 'move_token_to_access_tokens')
    connection.execute(
        "INSERT INTO auth_secret (id, pin_hash, session_secret, token_hash, "
        "token_created_at, revoked, updated_at) VALUES (1, 'scrypt$00$00', 's', ?, "
        "TIMESTAMPTZ '2026-10-01 00:00:00+00', '{}', TIMESTAMPTZ '2026-10-01 00:00:00+00')",
        [auth_rules.hash_token(secret)])
    connection.close()

    for _ in range(2):  # the second open runs nothing, and adds nothing
        opened = store_module.open_store(path, schema_steps.STEPS)
        try:
            [row] = access_tokens.list_all(opened)
            assert (row['label'], row['scopes'], row['expires_at']) == (
                'Jeton existant', ['api', 'mcp'], None)
            assert row['created_at'] == '2026-10-01T00:00:00+00:00'
            assert access_tokens.authenticate(opened, secret, 'mcp', NOW)
            assert access_tokens.authenticate(opened, secret, 'api', NOW)
        finally:
            opened.close()


# --------------------------------------------------------------------------- #
# The routes
# --------------------------------------------------------------------------- #

FORM = {'label': 'Claude Desktop', 'scopes': ['api', 'mcp'], 'expires': '90d'}


def test_the_routes_make_list_regenerate_and_delete(tmp_path):
    flask, opened = build_client_and_store(tmp_path)

    made = flask.post('/api/tokens', json=FORM)
    assert made.status_code == 201
    token, secret = made.get_json()['token'], made.get_json()['secret']
    assert (token['label'], token['scopes']) == ('Claude Desktop', ['api', 'mcp'])
    assert secret.startswith(f"sb_{token['prefix']}_")

    listed = flask.get('/api/tokens')
    assert listed.get_json() == {'tokens': [token]}
    assert secret not in listed.get_data(as_text=True)

    again = flask.post(f"/api/tokens/{token['id']}/regenerate")
    assert again.status_code == 200
    assert again.get_json()['secret'] != secret
    assert again.get_json()['token']['id'] == token['id']
    assert not access_tokens.authenticate(opened, secret, 'api', NOW)

    assert flask.delete(f"/api/tokens/{token['id']}").status_code == 204
    assert flask.get('/api/tokens').get_json() == {'tokens': []}
    assert flask.delete(f"/api/tokens/{token['id']}").status_code == 404
    assert flask.post(f"/api/tokens/{token['id']}/regenerate").status_code == 404


@pytest.mark.parametrize('change', [
    {'label': ''}, {'label': '  '}, {'label': 'x' * 61}, {'label': 3},
    {'scopes': []}, {'scopes': ['api', 'admin']}, {'scopes': 'api'},
    {'expires': '30d'}, {'expires': None}])
def test_a_form_that_is_no_token_is_refused(tmp_path, change):
    flask, opened = build_client_and_store(tmp_path)

    assert flask.post('/api/tokens', json={**FORM, **change}).status_code == 422
    assert access_tokens.list_all(opened) == []
