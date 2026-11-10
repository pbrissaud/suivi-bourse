"""Probes answer JSON, never the SPA; every response carries the security headers (PP-4)."""
import asyncio

import api
from application import boot
from test_web_api import build_client_and_store


def test_healthz_is_json_and_alive(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    response = client.get('/healthz')
    assert response.status_code == 200
    assert response.get_json() == {'status': 'ok'}


def test_readyz_is_503_while_the_scheduler_is_not_running(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    response = client.get('/readyz')
    assert response.status_code == 503
    assert response.get_json()['status'] == 503


def test_readyz_is_200_once_the_scheduler_runs(tmp_path, monkeypatch):
    client, _ = build_client_and_store(tmp_path)
    monkeypatch.setattr(api.current_runtime(), 'scheduler', object())
    response = client.get('/readyz')
    assert response.status_code == 200
    assert response.get_json() == {'status': 'ready'}


def test_every_response_carries_the_security_headers():
    sent = []

    async def inner(scope, receive, send):
        await send({'type': 'http.response.start', 'status': 200,
                    'headers': [(b'x-frame-options', b'SAMEORIGIN')]})
        await send({'type': 'http.response.body', 'body': b''})

    async def collect(message):
        sent.append(message)

    wrapped = boot._with_security_headers(collect)
    asyncio.run(inner({'type': 'http'}, None, wrapped))
    headers = dict(sent[0]['headers'])
    assert headers[b'x-content-type-options'] == b'nosniff'
    assert headers[b'referrer-policy'] == b'same-origin'
    # What a response already says is kept, not doubled.
    assert [h for h in sent[0]['headers'] if h[0] == b'x-frame-options'] \
        == [(b'x-frame-options', b'SAMEORIGIN')]
