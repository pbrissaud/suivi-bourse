"""The two registers and the outbound channels (§ 3.6).

Real store, real routes; the only fakes are the senders' transports (a channel
is I/O to somebody else's server) and the clock.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

from application import advisories
from application import notification_senders as senders
from application import notifications
from application import runtime_state
from application import update_check
from conftest import PerfConfigManager
from test_web_api import build_client_and_store

NOW = datetime(2026, 11, 9, 16, 40, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# The late price: user register, named, only while the market is open
# --------------------------------------------------------------------------- #

def _held(opened, symbol='PUST.PA', name='Amundi PEA Nasdaq-100',
          last=NOW - timedelta(minutes=45)):
    opened.execute('INSERT INTO symbol (symbol) VALUES (?) ON CONFLICT DO NOTHING',
                   [symbol])
    opened.execute('INSERT INTO symbol_quote (symbol, long_name) VALUES (?, ?)',
                   [symbol, name])
    if last is not None:
        opened.execute('INSERT INTO price_point (symbol, ts, price_native, '
                       'price_converted) VALUES (?, ?, 82.09, 82.09)',
                       [symbol, last])


def _recorder(symbol='PUST.PA', closed=False):
    recorder = runtime_state.RuntimeRecorder()
    recorder.record_scrape(runtime_state.ScrapeRecord(
        symbol=symbol, at=NOW, market_state='CLOSED' if closed else 'REGULAR',
        closed=closed, price_present=True, verdict=runtime_state.SCRAPE_WROTE,
        failure_count=0, next_delay=120))
    return recorder


def test_a_late_price_is_a_user_advisory_named_after_the_security(store):
    _held(store)

    (late,) = advisories.standing(store, NOW, recorder=_recorder())

    assert (late.key, late.kind, late.register) == (
        'late_price:PUST.PA', 'late_price', 'user')
    assert 'Amundi PEA Nasdaq-100' in late.texts['fr']['title']
    assert 'Amundi PEA Nasdaq-100' in late.texts['en']['title']
    assert 'PUST.PA' not in late.texts['fr']['title']
    assert late.detail['symbol'] == 'PUST.PA'


def test_nothing_is_late_while_the_market_is_closed_or_the_quote_is_fresh(store):
    _held(store)
    assert advisories.standing(store, NOW, recorder=_recorder(closed=True)) == []
    assert advisories.standing(store, NOW, recorder=None) == []

    fresh = NOW - timedelta(minutes=2)
    store.execute('UPDATE price_point SET ts = ?', [fresh])
    assert advisories.standing(store, NOW, recorder=_recorder()) == []


def test_every_advisory_has_a_register_and_the_filter_splits_them(store):
    _held(store)
    store.execute("INSERT INTO account (id, label) VALUES ('cto', 'CTO')")
    store.execute("INSERT INTO account_metrics (account, day, cash_balance, "
                  "holdings_value, total_value) VALUES ('cto', '2026-11-09', 50, 50, 100)")
    release = {'version': '5.3.0', 'url': update_check.NOTES + 'v5.3.0'}
    both = advisories.standing(store, NOW, recorder=_recorder(), release=release)

    assert {one.register for one in both} == {'user', 'system'}
    user = advisories.standing(store, NOW, register='user',
                               recorder=_recorder(), release=release)
    assert {one.kind for one in user} == {'late_price', 'update_available'}
    system = advisories.standing(store, NOW, register='system',
                                 recorder=_recorder(), release=release)
    assert {one.register for one in system} == {'system'}
    assert all('register' in one.to_dict() for one in both)


def test_the_route_filters_by_register_and_refuses_another(tmp_path):
    client, _ = build_client_and_store(tmp_path)

    assert client.get('/api/advisories?register=user').get_json() == []
    assert client.get('/api/advisories?register=system').status_code == 200
    assert client.get('/api/advisories?register=nobody').status_code == 422


def test_the_update_check_remembers_without_asking():
    asked = []
    checker = update_check.Checker(lambda url: asked.append(url) or b'{}')
    assert checker.known('5.2.0') is None and asked == []


# --------------------------------------------------------------------------- #
# The channels: CRUD, and the secret never leaves
# --------------------------------------------------------------------------- #

NTFY = {'kind': 'ntfy', 'target': 'https://ntfy.sh/suivi-bourse-x8k2',
        'scopes': ['late_price', 'job_failed'], 'secret': 'tk-secret-1234'}


def test_a_channel_lives_through_the_four_routes_and_hides_its_secret(tmp_path):
    client, opened = build_client_and_store(tmp_path)

    created = client.post('/api/notification-channels', json=NTFY)
    assert created.status_code == 201
    channel = created.get_json()
    assert channel['secret_last4'] == '1234' and channel['has_secret'] is True
    assert 'tk-secret' not in json.dumps(channel)
    assert [row[0] for row in opened.query(
        'SELECT secret FROM notification_channel')] == ['tk-secret-1234']

    listed = client.get('/api/notification-channels').get_json()
    assert [one['id'] for one in listed] == [channel['id']]
    assert 'tk-secret' not in json.dumps(listed)

    url = f"/api/notification-channels/{channel['id']}"
    patched = client.patch(url, json={'enabled': False, 'scopes': ['update_available']})
    assert patched.get_json()['enabled'] is False
    assert patched.get_json()['scopes'] == ['update_available']
    assert patched.get_json()['secret_last4'] == '1234'   # left out: kept

    forgotten = client.patch(url, json={'secret': None}).get_json()
    assert forgotten['has_secret'] is False

    assert client.delete(url).status_code == 204
    assert client.get('/api/notification-channels').get_json() == []
    assert client.delete(url).status_code == 404
    assert client.patch(url, json={'enabled': True}).status_code == 404


@pytest.mark.parametrize('body, field', [
    ({**NTFY, 'kind': 'fax'}, 'kind'),
    ({**NTFY, 'target': 'ntfy.sh/topic'}, 'target'),
    ({**NTFY, 'scopes': ['cash_share']}, 'scopes'),
    ({'kind': 'email', 'target': 'nobody', 'scopes': []}, 'target'),
    ({'kind': 'email', 'target': 'a@b.fr', 'scopes': []}, 'options'),
    ({**NTFY, 'options': {'lang': 'de'}}, 'options'),
    ({**NTFY, 'enabled': 'yes'}, 'enabled'),
])
def test_a_channel_that_cannot_be_kept_names_the_field(tmp_path, body, field):
    client, _ = build_client_and_store(tmp_path)

    response = client.post('/api/notification-channels', json=body)

    assert response.status_code == 422
    assert response.get_json()['key'] == field


def test_a_channel_does_not_change_kind(tmp_path):
    client, _ = build_client_and_store(tmp_path)
    channel = client.post('/api/notification-channels', json=NTFY).get_json()

    response = client.patch(f"/api/notification-channels/{channel['id']}",
                            json={'kind': 'webhook'})

    assert response.status_code == 422


def test_testing_a_channel_sends_a_notice_or_says_why_not(tmp_path, monkeypatch):
    client, _ = build_client_and_store(tmp_path)
    channel = client.post('/api/notification-channels', json=NTFY).get_json()
    url = f"/api/notification-channels/{channel['id']}/test"
    sent = []
    monkeypatch.setitem(senders.SENDERS, 'ntfy',
                        lambda *args: sent.append(args))

    assert client.post(url).get_json() == {'ok': True}
    assert sent[0][0] == NTFY['target'] and sent[0][1] == 'tk-secret-1234'

    def refuse(*args):
        raise senders.SendError('HTTP 403')
    monkeypatch.setitem(senders.SENDERS, 'ntfy', refuse)
    refused = client.post(url)
    assert refused.status_code == 424
    body = refused.get_json()
    assert body['type'] == '/problems/channel-refused'
    assert (body['host'], body['reason']) == ('ntfy.sh', 'refused')
    assert 'tk-secret' not in refused.get_data(as_text=True)
    assert client.post('/api/notification-channels/nope/test').status_code == 404


# --------------------------------------------------------------------------- #
# The senders
# --------------------------------------------------------------------------- #

class _Response:
    def __init__(self, status=200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_ntfy_and_webhook_post_with_the_bearer(monkeypatch):
    seen = []
    monkeypatch.setattr(senders.urllib.request, 'urlopen',
                        lambda request, timeout: seen.append(request) or _Response())
    notice = senders.Notice('Titre', 'Corps', 'https://x/y', 'late_price')

    senders.send('ntfy', 'https://ntfy.sh/t', 'tok', {}, notice)
    senders.send('webhook', 'https://hook/h', 'tok', {}, notice)

    ntfy, hook = seen
    assert ntfy.data == b'Corps' and ntfy.get_header('Authorization') == 'Bearer tok'
    assert ntfy.get_header('Click') == 'https://x/y'
    assert json.loads(hook.data) == {'title': 'Titre', 'body': 'Corps',
                                     'url': 'https://x/y', 'kind': 'late_price'}


def test_a_refusing_server_is_a_send_error_without_the_secret(monkeypatch):
    monkeypatch.setattr(senders.urllib.request, 'urlopen',
                        lambda request, timeout: _Response(500))
    with pytest.raises(senders.SendError) as raised:
        senders.send('webhook', 'https://hook/h', 'tok', {}, senders.Notice('t'))
    assert 'tok' not in str(raised.value)

    with pytest.raises(senders.SendError):
        senders.send('webhook', 'ftp://hook/h', None, {}, senders.Notice('t'))


def test_email_logs_in_and_sends_through_the_named_server(monkeypatch):
    calls = []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            calls.append(('connect', host, port))

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def starttls(self, context):
            calls.append(('starttls',))

        def login(self, user, password):
            calls.append(('login', user, password))

        def send_message(self, message):
            calls.append(('send', message['To'], message['Subject']))

    monkeypatch.setattr(senders.smtplib, 'SMTP', FakeSMTP)
    options = {'host': 'smtp.example.org', 'port': 587, 'username': 'paul',
               'sender': 'bourse@example.org'}

    senders.send('email', 'paul@example.org', 'pw', options, senders.Notice('Hello', 'x'))

    assert calls == [('connect', 'smtp.example.org', 587), ('starttls',),
                     ('login', 'paul', 'pw'), ('send', 'paul@example.org', 'Hello')]


def test_apprise_answers_not_available_when_it_is_not_installed(monkeypatch):
    import builtins
    real = builtins.__import__

    def without_apprise(name, *args, **kwargs):
        if name == 'apprise':
            raise ImportError(name)
        return real(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', without_apprise)

    assert senders.apprise_available() is False
    with pytest.raises(senders.SendError, match='not available'):
        senders.send('apprise', 'json://x', None, {}, senders.Notice('t'))


# --------------------------------------------------------------------------- #
# The dispatch: once per standing, a failing job at most every six hours
# --------------------------------------------------------------------------- #

@pytest.fixture
def wired(store, monkeypatch):
    """A manager over a real store, one ntfy channel wanting everything, and the
    list of what the transport was handed."""
    manager = PerfConfigManager(store)
    sent = []
    monkeypatch.setitem(senders.SENDERS, 'ntfy',
                        lambda target, secret, options, notice: sent.append(notice))
    notifications.create(store, {
        'kind': 'ntfy', 'target': 'https://ntfy.sh/t',
        'scopes': ['late_price', 'update_available', 'job_failed']})
    return manager, store, sent


def test_a_late_price_is_pushed_once_then_again_after_it_recovered(wired):
    manager, store, sent = wired
    _held(store)
    recorder = _recorder()

    assert [one.key for one in notifications.sweep(manager, recorder, now=NOW)] == [
        'late_price:PUST.PA']
    assert notifications.sweep(manager, recorder, now=NOW) == []
    assert len(sent) == 1
    assert 'Amundi PEA Nasdaq-100' in sent[0].title

    store.execute('UPDATE price_point SET ts = ?', [NOW])   # it recovered
    assert notifications.sweep(manager, recorder, now=NOW) == []
    assert store.query('SELECT count(*) FROM advisory_dispatch') == [(0,)]

    later = NOW + timedelta(hours=2)                       # and froze again
    assert len(notifications.sweep(manager, recorder, now=later)) == 1
    assert len(sent) == 2


def test_a_channel_added_later_does_not_replay_what_already_stood(wired):
    manager, store, sent = wired
    _held(store)
    store.execute('DELETE FROM notification_channel')

    notifications.sweep(manager, _recorder(), now=NOW)
    notifications.create(store, {'kind': 'ntfy', 'target': 'https://ntfy.sh/t',
                                 'scopes': ['late_price']})
    notifications.sweep(manager, _recorder(), now=NOW)

    assert sent == []


def test_a_channel_gets_only_its_scopes_and_its_language(wired):
    manager, store, sent = wired
    store.execute('DELETE FROM notification_channel')
    notifications.create(store, {'kind': 'ntfy', 'target': 'https://ntfy.sh/a',
                                 'scopes': ['update_available']})
    notifications.create(store, {'kind': 'ntfy', 'target': 'https://ntfy.sh/b',
                                 'scopes': ['late_price'],
                                 'options': {'lang': 'en'}})
    _held(store)

    notifications.sweep(manager, _recorder(), now=NOW)

    since = (NOW - timedelta(minutes=45)).astimezone().strftime('%H:%M')
    assert [one.title for one in sent] == [
        f'The price of Amundi PEA Nasdaq-100 has not moved since {since}']


def test_an_update_is_pushed_once_per_version(wired):
    manager, store, sent = wired
    release = {'version': '5.3.0', 'url': update_check.NOTES + 'v5.3.0'}

    notifications.sweep(manager, runtime_state.RuntimeRecorder(), release=release, now=NOW)
    notifications.sweep(manager, runtime_state.RuntimeRecorder(), release=release, now=NOW)
    # A scrape-pass sweep does not know the release and must not forget it.
    notifications.sweep(manager, runtime_state.RuntimeRecorder(), now=NOW)
    notifications.sweep(manager, runtime_state.RuntimeRecorder(), release=release, now=NOW)

    assert [one.title for one in sent] == ['Mise à jour 5.3.0 disponible']


def test_a_failing_job_is_pushed_at_most_once_per_cooldown(wired):
    manager, store, sent = wired

    assert notifications.job_failed(manager, 'scrape', 'AI.PA', 'Boom', now=NOW)
    assert not notifications.job_failed(manager, 'scrape', 'AI.PA', 'Boom',
                                        now=NOW + timedelta(minutes=5))
    assert notifications.job_failed(manager, 'scrape', 'CW8.PA', 'Boom', now=NOW)
    assert notifications.job_failed(manager, 'scrape', 'AI.PA', 'Boom',
                                    now=NOW + notifications.JOB_COOLDOWN)

    assert len(sent) == 3
    assert sent[0].title == 'Échec : Mise à jour des cours · AI.PA'
    assert sent[0].body == 'Boom'


def test_a_refusing_channel_never_raises_into_the_job(wired, monkeypatch):
    manager, store, sent = wired

    def refuse(*args):
        raise senders.SendError('HTTP 500')
    monkeypatch.setitem(senders.SENDERS, 'ntfy', refuse)

    assert notifications.job_failed(manager, 'backfill', None, 'x', now=NOW)
