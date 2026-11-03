"""The PIN's gate in front of the whole socket (#1203).

Two harnesses. Most tests put the gate in front of a recording stand-in, so the
assertion is *was the app reached*; the route sweeps put it in front of the
real ``Serving`` — Flask, the agent's Starlette app and ``/mcp`` — so that every
route the product mounts is covered, a future one included.
"""
import asyncio
import hashlib
import io
import logging
import re
import zipfile
from datetime import datetime, timedelta, timezone

import httpx2
import pytest
from itsdangerous import TimestampSigner
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from api import create_app
from application import agent_routes, auth_gate, auth_rules, boot, boot_env
from application import installation_facts, mcp_server, store as store_module
from application.auth_gate import COOKIE, Gate
from test_mcp_server import rich_runtime

PIN = '123456'
INDEX = b'<!doctype html><div id=root>'


@pytest.fixture
def opened(tmp_path):
    s = store_module.open_store(tmp_path / 'auth.duckdb')
    yield s
    s.close()


class Inner:
    """The app behind the gate: says it was reached, and by what."""

    def __init__(self):
        self.reached = []

    async def __call__(self, scope, receive, send):
        self.reached.append((scope['method'], scope['path']))
        await send({'type': 'http.response.start', 'status': 200,
                    'headers': [(b'content-type', b'text/plain')]})
        await send({'type': 'http.response.body', 'body': b'inner'})


def client(app, ip='192.168.1.20'):
    return httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app, client=(ip, 5000)),
                              base_url='http://app')


def run(work):
    return asyncio.run(work())


def cookie_of(response):
    found = re.search(rf'{COOKIE}=([^;]*)', response.headers.get('set-cookie', ''))
    return found.group(1) if found else None


async def enable(gate, pin=PIN):
    async with client(gate) as c:
        answer = await c.post('/auth/enable', json={'pin': pin})
    assert answer.status_code == 200, answer.text
    return answer.json()['token'], cookie_of(answer)


async def sign_in(gate, pin=PIN, ip='192.168.1.20'):
    async with client(gate, ip) as c:
        return await c.post('/auth/pin', json={'pin': pin})


def with_cookie(value):
    return {'cookie': f'{COOKIE}={value}'}


# --------------------------------------------------------------------------- #
# PIN off: nothing changes
# --------------------------------------------------------------------------- #

def test_a_store_from_before_the_pin_boots_unlocked(opened):
    inner = Inner()
    gate = Gate(inner, opened, INDEX)

    async def work():
        async with client(gate) as c:
            return [await c.request(m, p) for m, p in (
                ('GET', '/api/positions'), ('POST', '/api/events'),
                ('POST', '/mcp'), ('GET', '/agent'))] + [await c.get('/auth/status')]
    *answers, status = run(work)

    assert [a.text for a in answers] == ['inner'] * 4
    assert status.json() == {'enabled': False, 'authenticated': False,
                             'token_created_at': None, 'session_seconds': None}


# --------------------------------------------------------------------------- #
# PIN on: default-closed
# --------------------------------------------------------------------------- #

def test_without_a_credential_only_the_allowlist_reaches_the_app(opened):
    inner = Inner()
    gate = Gate(inner, opened, INDEX)

    async def work():
        await enable(gate)
        async with client(gate) as c:
            return {(m, p): await c.request(m, p) for m, p in (
                ('GET', '/health'), ('GET', '/api/theme.css'),
                ('GET', '/assets/index-abc.js'), ('GET', '/favicon.svg'),
                ('GET', '/favicon-32.png'), ('GET', '/apple-touch-icon.png'),
                ('GET', '/api/positions'), ('POST', '/api/events'),
                ('GET', '/api/agent/threads'), ('POST', '/api/agent/chat'),
                ('POST', '/mcp'), ('GET', '/mcp'),
                ('GET', '/'), ('GET', '/agent'), ('GET', '/agent/abc'),
                ('GET', '/some-future-page'), ('DELETE', '/some-future-page'),
                ('POST', '/health'), ('GET', '/api'))}
    answers = run(work)

    assert inner.reached == [('GET', '/health'), ('GET', '/api/theme.css'),
                             ('GET', '/assets/index-abc.js'),
                             ('GET', '/favicon.svg'), ('GET', '/favicon-32.png'),
                             ('GET', '/apple-touch-icon.png')]
    for key in (('GET', '/'), ('GET', '/agent'), ('GET', '/agent/abc'),
                ('GET', '/some-future-page')):
        assert answers[key].status_code == 200
        assert answers[key].content == INDEX
    for key in (('GET', '/api/positions'), ('POST', '/api/events'),
                ('GET', '/api/agent/threads'), ('POST', '/api/agent/chat'),
                ('POST', '/mcp'), ('GET', '/mcp'), ('DELETE', '/some-future-page'),
                ('POST', '/health'), ('GET', '/api')):
        assert answers[key].status_code == 401, key
    assert answers[('POST', '/mcp')].headers['www-authenticate'] == 'Bearer'


def test_the_cookie_opens_the_app_and_the_token_opens_mcp_and_api_not_auth(opened):
    inner = Inner()
    gate = Gate(inner, opened, INDEX)

    async def work():
        token, cookie = await enable(gate)
        bearer = {'authorization': f'Bearer {token}'}
        async with client(gate) as c:
            return [
                (await c.get('/api/positions', headers=with_cookie(cookie))).status_code,
                (await c.post('/api/agent/chat', headers=with_cookie(cookie))).status_code,
                (await c.post('/mcp', headers=with_cookie(cookie))).status_code,
                (await c.post('/mcp', headers=bearer)).status_code,
                (await c.get('/api/positions', headers=bearer)).status_code,
                (await c.post('/api/agent/chat', headers=bearer)).status_code,
                (await c.delete('/api/events/x', headers=bearer)).status_code,
                (await c.get('/api', headers=bearer)).status_code,
                (await c.post('/mcp', headers={'authorization': 'Bearer nope'})).status_code,
                (await c.get('/api/positions',
                             headers={'authorization': 'Bearer nope'})).status_code,
            ], [
                (await c.post(path, json=body, headers=bearer)).status_code
                for path, body in (('/auth/token', {'current': PIN}),
                                   ('/auth/change', {'current': PIN, 'pin': '222222'}),
                                   ('/auth/disable', {'current': PIN}),
                                   ('/auth/lifetime', {'seconds': 900}))
            ], (await c.get('/auth/status', headers=bearer)).json()

    gates, auth, status = run(work)
    assert gates == [200, 200, 401, 200, 200, 200, 200, 200, 401, 401]
    assert auth == [401, 401, 401, 401]
    assert status['authenticated'] is False
    assert gate.state.enabled and gate.state.session_seconds is None


def test_a_wrong_bearer_beside_a_good_cookie_goes_through_on_the_cookie(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        _, cookie = await enable(gate)
        async with client(gate) as c:
            return (await c.post('/api/events', headers={
                **with_cookie(cookie), 'authorization': 'Bearer nope'})).status_code

    assert run(work) == 200


def test_a_right_pin_gives_a_cookie_and_a_wrong_one_says_what_is_left(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        await enable(gate)
        wrong = await sign_in(gate, '000000')
        right = await sign_in(gate)
        async with client(gate) as c:
            status = await c.get('/auth/status', headers=with_cookie(cookie_of(right)))
        return wrong, right, status
    wrong, right, status = run(work)

    assert wrong.status_code == 401
    assert wrong.json()['remaining'] == 4
    assert right.status_code == 200
    header = right.headers['set-cookie']
    assert 'HttpOnly' in header and 'SameSite=Strict' in header
    assert 'Secure' not in header
    assert status.json()['authenticated'] is True
    assert status.json()['token_created_at'] is not None


def test_the_cookie_is_secure_when_the_trusted_scheme_is_https(opened):
    gate = Gate(Inner(), opened, INDEX)
    proxied = ProxyHeadersMiddleware(gate, trusted_hosts='10.0.0.1')

    async def work():
        async with client(proxied, '10.0.0.1') as c:
            return await c.post('/auth/enable', json={'pin': PIN},
                                headers={'x-forwarded-proto': 'https',
                                         'x-forwarded-for': '192.168.1.5'})
    assert 'Secure' in run(work).headers['set-cookie']


@pytest.mark.parametrize('forge', ['tampered', 'expired', 'old secret'])
def test_a_forged_cookie_is_refused(opened, forge):
    inner = Inner()
    gate = Gate(inner, opened, INDEX)

    async def work():
        await enable(gate)
        state = gate.state
        signer = auth_gate.TimestampSigner(state.session_secret, salt='sb-session',
                                           digest_method=hashlib.sha256)
        if forge == 'tampered':
            good = signer.sign('someone').decode()
            value = good[:-2] + ('AA' if not good.endswith('AA') else 'BB')
        elif forge == 'expired':
            class Old(TimestampSigner):
                def get_timestamp(self):
                    return int(datetime.now(timezone.utc).timestamp()) - 31 * 86400
            value = Old(state.session_secret, salt='sb-session',
                        digest_method=hashlib.sha256).sign('someone').decode()
        else:
            value = TimestampSigner('the-secret-before', salt='sb-session',
                                    digest_method=hashlib.sha256).sign('x').decode()
        async with client(gate) as c:
            return await c.get('/api/positions', headers=with_cookie(value))

    assert run(work).status_code == 401
    assert inner.reached == []


def test_a_cookie_seen_after_a_minute_is_signed_again_unless_in_the_background(opened):
    later = [datetime.now(timezone.utc)]
    gate = Gate(Inner(), opened, INDEX, now=lambda: later[0])
    background = {'x-sb-background': '1'}

    async def work():
        _, cookie = await enable(gate)
        async with client(gate) as c:
            later[0] += timedelta(seconds=59)
            young = await c.get('/api/positions', headers=with_cookie(cookie))
            later[0] += timedelta(seconds=2)
            polled = await c.get('/api/positions',
                                 headers={**with_cookie(cookie), **background})
            clicked = await c.get('/api/positions', headers=with_cookie(cookie))
        return young, polled, clicked
    young, polled, clicked = run(work)

    assert young.status_code == polled.status_code == clicked.status_code == 200
    assert 'set-cookie' not in young.headers
    assert 'set-cookie' not in polled.headers
    assert cookie_of(clicked)
    assert f'Max-Age={auth_rules.DEFAULT_SESSION_SECONDS}' in clicked.headers['set-cookie']


def test_polling_alone_lets_the_session_lapse_and_activity_keeps_it(opened):
    later = [datetime.now(timezone.utc)]
    gate = Gate(Inner(), opened, INDEX, now=lambda: later[0])

    async def work():
        _, cookie = await enable(gate)
        async with client(gate) as c:
            polled = active = cookie_of(await c.post(
                '/auth/lifetime', json={'seconds': 900}, headers=with_cookie(cookie)))
            for _ in range(16):
                later[0] += timedelta(minutes=1)
                answer = await c.get('/api/x', headers={**with_cookie(polled),
                                                        'x-sb-background': '1'})
                polled = cookie_of(answer) or polled
                answer = await c.get('/api/x', headers=with_cookie(active))
                active = cookie_of(answer) or active
            return ((await c.get('/api/x', headers=with_cookie(polled))).status_code,
                    (await c.get('/api/x', headers=with_cookie(active))).status_code)

    assert run(work) == (401, 200)


# --------------------------------------------------------------------------- #
# Logout, change, disable, regenerate
# --------------------------------------------------------------------------- #

def test_a_logged_out_cookie_opens_nothing_and_another_device_stays_in(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        await enable(gate)
        mine = cookie_of(await sign_in(gate))
        other = cookie_of(await sign_in(gate))
        async with client(gate) as c:
            out = await c.post('/auth/logout', headers=with_cookie(mine))
            return (out, (await c.get('/api/x', headers=with_cookie(mine))).status_code,
                    (await c.get('/api/x', headers=with_cookie(other))).status_code)
    out, copied, still = run(work)

    assert out.status_code == 204
    assert 'Max-Age=0' in out.headers['set-cookie']
    assert (copied, still) == (401, 200)
    # Stored, so a restart does not forgive it.
    assert len(auth_gate.read_state(opened).revoked) == 1


def test_changing_or_disabling_without_the_current_pin_is_refused(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        _, cookie = await enable(gate)
        async with client(gate) as c:
            return [
                (await c.post('/auth/change', json={'current': '999999', 'pin': '222222'},
                              headers=with_cookie(cookie))).status_code,
                (await c.post('/auth/disable', json={'current': '999999'},
                              headers=with_cookie(cookie))).status_code,
                (await c.post('/auth/token', json={'current': '999999'},
                              headers=with_cookie(cookie))).status_code,
                (await c.post('/auth/change', json={'current': PIN, 'pin': '222222'})).status_code,
            ]

    assert run(work) == [403, 403, 403, 401]
    assert auth_rules.verify_pin(PIN, gate.state.pin_hash)


def test_a_change_signs_the_others_out_keeps_this_device_and_the_token(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        token, acting = await enable(gate)
        other = cookie_of(await sign_in(gate))
        async with client(gate) as c:
            changed = await c.post('/auth/change', json={'current': PIN, 'pin': '222222'},
                                   headers=with_cookie(acting))
            fresh = cookie_of(changed)
            return (changed.status_code,
                    (await c.get('/api/x', headers=with_cookie(fresh))).status_code,
                    (await c.get('/api/x', headers=with_cookie(other))).status_code,
                    (await c.get('/api/x', headers=with_cookie(acting))).status_code,
                    (await c.post('/mcp', headers={'authorization': f'Bearer {token}'})).status_code)

    assert run(work) == (200, 200, 401, 401, 200)
    assert auth_rules.verify_pin('222222', auth_gate.read_state(opened).pin_hash)


def test_disabling_deletes_the_token_and_regenerating_refuses_the_old_one(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        first, cookie = await enable(gate)
        async with client(gate) as c:
            regenerated = await c.post('/auth/token', json={'current': PIN},
                                       headers=with_cookie(cookie))
            second = regenerated.json()['token']
            old = (await c.post('/mcp', headers={'authorization': f'Bearer {first}'})).status_code
            new = (await c.post('/mcp', headers={'authorization': f'Bearer {second}'})).status_code
            off = await c.post('/auth/disable', json={'current': PIN},
                               headers=with_cookie(cookie))
            return old, new, off.status_code

    assert run(work) == (401, 200, 200)
    assert auth_gate.read_state(opened) == auth_gate.OFF
    assert opened.query('SELECT count(*) FROM auth_secret') == [(0,)]


def test_a_store_that_refuses_the_write_keeps_the_previous_state(opened, monkeypatch):
    gate = Gate(Inner(), opened, INDEX)

    def broken(store, state):
        raise store_module.StoreUnavailable('the disk is full')

    async def work():
        _, cookie = await enable(gate)
        before = gate.state
        monkeypatch.setattr(auth_gate, 'write_state', broken)
        async with client(gate) as c:
            answer = await c.post('/auth/change', json={'current': PIN, 'pin': '222222'},
                                  headers=with_cookie(cookie))
            still = (await c.get('/api/x', headers=with_cookie(cookie))).status_code
        return before, answer.status_code, still

    before, status, still = run(work)
    assert status == 503
    assert gate.state is before
    assert still == 200


# --------------------------------------------------------------------------- #
# Attempts
# --------------------------------------------------------------------------- #

def test_after_five_failures_the_sixth_waits_unchecked_and_another_ip_signs_in(
        opened, monkeypatch):
    gate = Gate(Inner(), opened, INDEX)
    checked = []
    real = auth_rules.verify_pin

    def counting(pin, stored):
        checked.append(pin)
        return real(pin, stored)

    async def work():
        await enable(gate)
        monkeypatch.setattr(auth_rules, 'verify_pin', counting)
        failures = [await sign_in(gate, '000000') for _ in range(5)]
        sixth = await sign_in(gate)
        elsewhere = await sign_in(gate, ip='192.168.1.99')
        return failures, sixth, elsewhere
    failures, sixth, elsewhere = run(work)

    assert [f.json()['remaining'] for f in failures] == [4, 3, 2, 1, 0]
    assert failures[-1].headers['retry-after'] == '30'
    assert failures[-1].json()['retry_after'] == 30
    assert sixth.status_code == 429 and sixth.headers['retry-after'] == '30'
    assert len(checked) == 6, 'the sixth from that IP was never checked'
    assert elsewhere.status_code == 200


def test_fifty_parallel_attempts_check_five_and_refuse_the_rest(opened, monkeypatch):
    gate = Gate(Inner(), opened, INDEX)
    checked = []
    real = auth_rules.verify_pin

    def counting(pin, stored):
        checked.append(pin)
        return real(pin, stored)

    async def work():
        await enable(gate)
        monkeypatch.setattr(auth_rules, 'verify_pin', counting)
        return await asyncio.gather(*(sign_in(gate, '000000') for _ in range(50)))
    answers = run(work)

    codes = sorted(a.status_code for a in answers)
    assert codes == [401] * 5 + [429] * 45
    assert all('retry-after' in a.headers for a in answers if a.status_code == 429)
    assert len(checked) == 5


def test_behind_a_trusted_proxy_the_forwarded_address_is_the_one_counted(opened):
    gate = Gate(Inner(), opened, INDEX)
    proxied = ProxyHeadersMiddleware(gate, trusted_hosts='10.0.0.1')

    async def attempt(pin, forwarded):
        async with client(proxied, '10.0.0.1') as c:
            return await c.post('/auth/pin', json={'pin': pin},
                                headers={'x-forwarded-for': forwarded})

    async def work():
        await enable(gate)
        for _ in range(5):
            await attempt('000000', '192.168.1.66')
        return (await attempt(PIN, '192.168.1.66')).status_code, \
            (await attempt(PIN, '192.168.1.67')).status_code

    assert run(work) == (429, 200)


def test_an_untrusted_peer_cannot_choose_its_address(opened):
    gate = Gate(Inner(), opened, INDEX)
    proxied = ProxyHeadersMiddleware(gate, trusted_hosts='')

    async def work():
        await enable(gate)
        for n in range(5):
            async with client(proxied, '192.168.1.66') as c:
                await c.post('/auth/pin', json={'pin': '000000'},
                             headers={'x-forwarded-for': f'1.1.1.{n}'})
        async with client(proxied, '192.168.1.66') as c:
            return (await c.post('/auth/pin', json={'pin': PIN},
                                 headers={'x-forwarded-for': '1.1.1.99'})).status_code

    assert run(work) == 429


# --------------------------------------------------------------------------- #
# The reset, and the environment
# --------------------------------------------------------------------------- #

def test_the_reset_clears_the_three_secrets_and_says_so_each_boot(opened, caplog):
    async def work():
        await enable(Gate(Inner(), opened, INDEX))
    run(work)
    runtime = type('R', (), {'store': opened})()
    environment = boot_env.read({'SB_RESET_AUTH': '1'})

    for _ in range(2):
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger='auth'):
            boot.build_gate(runtime, environment)
        assert any('SB_RESET_AUTH' in r.getMessage() for r in caplog.records)
    assert opened.query('SELECT count(*) FROM auth_secret') == [(0,)]
    assert boot.build_gate(runtime, environment)(Inner()).state == auth_gate.OFF


def test_a_misspelt_reset_is_named_at_boot(monkeypatch):
    monkeypatch.setenv('SB_RESET_AUHT', '1')
    assert 'SB_RESET_AUHT' in installation_facts.unread_environment()
    assert 'SB_RESET_AUTH' in boot_env.READ
    assert 'SB_FORWARDED_ALLOW_IPS' in boot_env.READ
    assert boot_env.read({'SB_FORWARDED_ALLOW_IPS': '10.0.0.1'}).forwarded_allow_ips == '10.0.0.1'


def test_serve_trusts_no_proxy_unless_told(mocker):
    served = mocker.patch.object(boot.uvicorn, 'run')
    boot.serve('the app', boot_env.read({}), lambda: None)
    assert served.call_args.kwargs['forwarded_allow_ips'] == ''
    assert served.call_args.kwargs['proxy_headers'] is True


# --------------------------------------------------------------------------- #
# Every mounted route, through the real Serving
# --------------------------------------------------------------------------- #

def _routes(flask_app):
    """``(method, path)`` for every Flask rule, the agent's routes and ``/mcp``."""
    found = set()
    for rule in flask_app.url_map.iter_rules():
        path = re.sub(r'<(?:[^:>]+:)?([^>]+)>', 'x', rule.rule)
        for method in rule.methods - {'OPTIONS'}:
            found.add((method, path))
    for path in (boot.AGENT_CHAT_PATH, boot.AGENT_THREADS_PATH,
                 boot.AGENT_THREADS_PATH + '/x', boot.MCP_PATH):
        for method in ('GET', 'POST', 'DELETE'):
            found.add((method, path))
    return sorted(found)


OPEN = {('GET', '/health'), ('HEAD', '/health'),
        ('GET', '/api/theme.css'), ('HEAD', '/api/theme.css')}


def _serving(runtime, wrap):
    mcp = mcp_server.build_server(runtime)
    return boot.Serving(create_app(runtime), lambda: None, mcp,
                        agent_routes.build_app(runtime, mcp), wrap)


def test_pin_on_no_route_is_reached_without_a_credential(tmp_path, monkeypatch):
    runtime = rich_runtime(tmp_path)
    reached = []

    def wrap(inner):
        async def recording(scope, receive, send):
            reached.append((scope['method'], scope['path']))
            await inner(scope, receive, send)
        return Gate(recording, runtime.store, INDEX)
    serving = _serving(runtime, wrap)
    # A route outside /api, /agent and /mcp, added the way a future one would be.
    serving.wsgi.app.add_url_rule('/a-future-route', 'future', lambda: 'secret')
    routes = _routes(serving.wsgi.app)

    async def work():
        token, _ = await enable(serving._entry)
        answers = {}
        async with client(serving) as c:
            for method, path in routes:
                answers[(method, path)] = await c.request(method, path)
        return token, answers
    token, answers = run(work)

    assert set(reached) <= OPEN
    for key, answer in answers.items():
        if key in OPEN:
            assert answer.status_code == 200, key
        elif 200 <= answer.status_code < 300 and key[0] == 'GET':
            assert answer.content == INDEX, key
    assert answers[('GET', '/a-future-route')].content == INDEX
    assert ('GET', '/a-future-route') not in reached

    # The access token alone (#1313): every /api route is reached, whatever
    # its method, and no guarded /auth route accepts it.
    reached.clear()
    bearer = {'authorization': f'Bearer {token}'}
    api = [r for r in routes if r[1] == '/api' or r[1].startswith('/api/')]
    guarded = [('POST', p) for p in (
        '/auth/change', '/auth/disable', '/auth/token', '/auth/lifetime')]

    async def with_token():
        async with client(serving) as c:
            for method, path in api:
                await c.request(method, path, headers=bearer)
            return [(await c.post(path, json={'current': PIN, 'pin': '222222',
                                              'seconds': 900},
                                  headers=bearer)).status_code
                    for _, path in guarded]
    refused = run(with_token)

    assert api, 'the sweep found no /api route'
    assert sorted(set(reached)) == sorted(set(api))
    assert refused == [401] * len(guarded)


INSTANT = re.compile(r'\d{4}-\d\d-\d\dT[\d:.]+\+00:00')


def _said(answer):
    """What a route said, with the clock taken out of it.

    An instant in a text body is the second it was asked, and so is an
    ``.xlsx``: openpyxl stamps ``docProps/core.xml`` and every zip member's
    date with *now*. Two sweeps of the same app that straddle a second then
    differ in bytes and in nothing a gate could have changed, so a workbook
    is compared by its parts' contents, the stamped properties left out. A
    ``HEAD`` carries the workbook's type and no body, so it stays text.
    """
    if answer.content and answer.headers.get('content-type', '').startswith(
            'application/vnd.openxmlformats'):
        with zipfile.ZipFile(io.BytesIO(answer.content)) as book:
            return answer.status_code, tuple(
                (name, book.read(name)) for name in sorted(book.namelist())
                if name != 'docProps/core.xml')
    return answer.status_code, INSTANT.sub('<now>', answer.text)


def test_pin_off_every_route_answers_as_it_did_without_the_gate(tmp_path):
    runtime = rich_runtime(tmp_path)
    plain = _serving(runtime, None)
    gated = _serving(runtime, lambda inner: Gate(inner, runtime.store, INDEX))
    routes = [r for r in _routes(plain.wsgi.app)
              if r[0] in ('GET', 'HEAD') and not r[1].startswith('/mcp')
              and r[1] != '/health']

    async def sweep(app):
        said = []
        async with client(app) as c:
            for method, path in routes:
                said.append(_said(await c.request(method, path)))
        return said

    async def work():
        return await sweep(plain), await sweep(gated)
    without, with_ = run(work)

    assert [s for s, _ in without] == [s for s, _ in with_]
    assert without == with_


def test_no_route_hands_out_an_auth_secret(tmp_path):
    runtime = rich_runtime(tmp_path)
    serving = _serving(runtime, lambda inner: Gate(inner, runtime.store, INDEX))
    gets = [r for r in _routes(serving.wsgi.app)
            if r[0] == 'GET' and not r[1].startswith('/mcp')]

    async def work():
        token, cookie = await enable(serving._entry)
        bodies = []
        async with client(serving) as c:
            for _, path in gets:
                bodies.append((await c.get(path, headers=with_cookie(cookie))).text)
        return token, bodies
    token, bodies = run(work)

    state = auth_gate.read_state(runtime.store)
    for secret in (token, state.pin_hash, state.session_secret, state.token_hash):
        assert not any(secret in body for body in bodies)


def test_only_the_gate_reads_the_auth_row():
    """Settings, MCP tools and exports never select it: one reader, one writer."""
    from pathlib import Path
    root = Path(__file__).resolve().parents[1] / 'packages'
    readers = sorted(str(p.relative_to(root)) for p in root.rglob('*.py')
                     if 'auth_secret' in p.read_text(encoding='utf-8'))
    assert readers == ['app/src/application/auth_gate.py',
                       'store/src/application/store_ddl.py']


def test_the_current_code_is_throttled_even_with_a_session(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        _, cookie = await enable(gate)
        async with client(gate) as c:
            answers = [await c.post('/auth/disable', json={'current': '999999'},
                                    headers=with_cookie(cookie)) for _ in range(6)]
        return answers
    answers = run(work)

    assert [a.status_code for a in answers] == [403] * 5 + [429]
    assert answers[4].json()['retry_after'] == 30
    assert gate.state.enabled


def test_a_foreign_cookie_beside_ours_does_not_hide_it(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        _, cookie = await enable(gate)
        async with client(gate) as c:
            return (await c.get('/api/x', headers={
                'cookie': f'other={{"a":1}}; {COOKIE}={cookie}'})).status_code

    assert run(work) == 200


def test_sign_in_is_throttled_even_with_a_session(opened):
    gate = Gate(Inner(), opened, INDEX)

    async def work():
        _, cookie = await enable(gate)
        async with client(gate) as c:
            return [await c.post('/auth/pin', json={'pin': '000000'},
                                 headers=with_cookie(cookie)) for _ in range(6)]
    answers = run(work)

    assert [a.status_code for a in answers] == [401] * 5 + [429]
    assert [a.json()['remaining'] for a in answers[:5]] == [4, 3, 2, 1, 0]


# --------------------------------------------------------------------------- #
# The session lifetime (#1313)
# --------------------------------------------------------------------------- #

def test_the_lifetime_needs_a_session_a_code_and_an_offered_duration(opened, monkeypatch):
    gate = Gate(Inner(), opened, INDEX)

    def broken(store, state):
        raise store_module.StoreUnavailable('the disk is full')

    async def work():
        async with client(gate) as c:
            off = await c.post('/auth/lifetime', json={'seconds': 900})
        token, cookie = await enable(gate)
        async with client(gate) as c:
            bare = await c.post('/auth/lifetime', json={'seconds': 900})
            bearer = await c.post('/auth/lifetime', json={'seconds': 900},
                                  headers={'authorization': f'Bearer {token}'})
            wrong = [(await c.post('/auth/lifetime', json={'seconds': seconds},
                                   headers=with_cookie(cookie))).status_code
                     for seconds in (1234, 2592001, 31 * 86400, True, '900', None, 0)]
            before = gate.state
            monkeypatch.setattr(auth_gate, 'write_state', broken)
            refused = await c.post('/auth/lifetime', json={'seconds': 900},
                                   headers=with_cookie(cookie))
        return off, bare, bearer, wrong, before, refused
    off, bare, bearer, wrong, before, refused = run(work)

    assert off.status_code == 409
    assert (bare.status_code, bearer.status_code) == (401, 401)
    assert wrong == [400] * 7
    assert refused.status_code == 503
    assert 'set-cookie' not in refused.headers
    assert gate.state is before
    assert gate.state.lifetime == auth_rules.DEFAULT_SESSION_SECONDS


def test_lowering_the_lifetime_keeps_the_caller_and_locks_the_others(opened):
    later = [datetime.now(timezone.utc)]
    gate = Gate(Inner(), opened, INDEX, now=lambda: later[0])

    async def work():
        _, caller = await enable(gate)
        other = cookie_of(await sign_in(gate))
        later[0] += timedelta(minutes=20)
        async with client(gate) as c:
            lowered = await c.post('/auth/lifetime', json={'seconds': 900},
                                   headers=with_cookie(caller))
            status = (await c.get('/auth/status',
                                  headers=with_cookie(cookie_of(lowered)))).json()
            return (lowered,
                    (await c.get('/api/x', headers=with_cookie(cookie_of(lowered)))).status_code,
                    (await c.get('/api/x', headers=with_cookie(other))).status_code,
                    (await c.get('/api/x', headers=with_cookie(caller))).status_code,
                    status)
    lowered, caller, other, old_caller, status = run(work)

    assert lowered.status_code == 200
    assert lowered.json() == {'session_seconds': 900}
    assert 'Max-Age=900' in lowered.headers['set-cookie']
    assert (caller, other, old_caller) == (200, 401, 401)
    assert status['session_seconds'] == 900


def test_a_cookie_older_than_the_stored_lifetime_is_refused(opened):
    later = [datetime.now(timezone.utc)]
    gate = Gate(Inner(), opened, INDEX, now=lambda: later[0])

    async def work():
        _, cookie = await enable(gate)
        async with client(gate) as c:
            fresh = cookie_of(await c.post('/auth/lifetime', json={'seconds': 3600},
                                           headers=with_cookie(cookie)))
            later[0] += timedelta(minutes=59)
            inside = (await c.get('/api/x', headers={**with_cookie(fresh),
                                                     'x-sb-background': '1'})).status_code
            later[0] += timedelta(minutes=2)
            beyond = (await c.get('/api/x', headers=with_cookie(fresh))).status_code
        return inside, beyond

    assert run(work) == (200, 401)


def test_a_revoked_cookie_stays_refused_when_the_lifetime_goes_down_then_up(opened):
    later = [datetime.now(timezone.utc)]
    gate = Gate(Inner(), opened, INDEX, now=lambda: later[0])

    async def work():
        _, mine = await enable(gate)
        gone = cookie_of(await sign_in(gate))
        async with client(gate) as c:
            await c.post('/auth/logout', headers=with_cookie(gone))
            mine = cookie_of(await c.post('/auth/lifetime', json={'seconds': 900},
                                          headers=with_cookie(mine)))
            later[0] += timedelta(minutes=10)
            mine = cookie_of(await c.get('/api/x', headers=with_cookie(mine))) or mine
            later[0] += timedelta(minutes=10)
            await c.post('/auth/lifetime', json={'seconds': 2592000},
                         headers=with_cookie(mine))
            return (await c.get('/api/x', headers=with_cookie(gone))).status_code

    assert run(work) == 401


def test_the_lifetime_survives_a_restart_and_a_change_and_not_a_disable(opened):
    async def work():
        gate = Gate(Inner(), opened, INDEX)
        _, cookie = await enable(gate)
        async with client(gate) as c:
            cookie = cookie_of(await c.post('/auth/lifetime', json={'seconds': 604800},
                                            headers=with_cookie(cookie)))
        restarted = Gate(Inner(), opened, INDEX)
        read_back = restarted.state.session_seconds
        async with client(restarted) as c:
            changed = await c.post('/auth/change', json={'current': PIN, 'pin': '222222'},
                                   headers=with_cookie(cookie))
            kept = auth_gate.read_state(opened).lifetime
            await c.post('/auth/disable', json={'current': '222222'},
                         headers=with_cookie(cookie_of(changed)))
        again = Gate(Inner(), opened, INDEX)
        await enable(again)
        return read_back, kept, auth_gate.read_state(opened)

    restarted, kept, after = run(work)
    assert restarted == 604800
    assert kept == 604800
    assert after.session_seconds is None
    assert after.lifetime == auth_rules.DEFAULT_SESSION_SECONDS


@pytest.mark.parametrize('stored, read', [
    (None, 2592000), (900, 900), (0, 2592000), (-5, 2592000), (40 * 86400, 2592000)])
def test_a_stored_lifetime_never_outlives_thirty_days(stored, read):
    assert auth_rules.session_seconds(stored) == read
    assert auth_gate.AuthState(pin_hash='x', session_seconds=stored).lifetime == read


def test_a_lifetime_racing_a_pin_change_does_not_outlive_it(opened, monkeypatch):
    """The session is checked before the body is read; a PIN change landing in
    between rotates the secret, and the lifetime must not re-sign the old
    session with the new one."""
    gate = Gate(Inner(), opened, INDEX)
    real = auth_gate._json_body
    raced = []

    async def racing(receive):
        body = await real(receive)
        if 'seconds' in body and not raced:
            raced.append(True)
            async with client(gate) as c:
                changed = await c.post('/auth/change',
                                       json={'current': PIN, 'pin': '222222'},
                                       headers=with_cookie(acting))
            assert changed.status_code == 200
        return body

    async def work():
        nonlocal acting
        _, acting = await enable(gate)
        other = cookie_of(await sign_in(gate))
        monkeypatch.setattr(auth_gate, '_json_body', racing)
        async with client(gate) as c:
            answer = await c.post('/auth/lifetime', json={'seconds': 900},
                                  headers=with_cookie(other))
            after = (await c.get('/api/x', headers=with_cookie(
                cookie_of(answer) or other))).status_code
        return answer, after

    acting = None
    answer, after = run(work)
    assert raced
    assert answer.status_code == 401
    assert 'set-cookie' not in answer.headers
    assert after == 401
    assert gate.state.session_seconds is None
