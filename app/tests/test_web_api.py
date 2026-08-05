"""Tests for the /api blueprint (issue #659, design #655).

The routes themselves are thin — five lines each — so what is tested here is the
**contract**, which is not thin at all: #655 decision 8 split absence into three
states that ``influxdb_writer`` collapses onto ``None``, and getting them back
onto one value is exactly how a UI ends up rendering "the database is dead" and
"you own nothing yet" identically.

Plus the one rule of the SPA catch-all that is load-bearing: it must not swallow
an ``/api`` 404.
"""
from datetime import datetime, timezone

import pandas as pd
import pytest

import main
from web import create_app


class FakeClient:
    def __init__(self, frame=None, error=None, frames=None):
        self._frame = frame if frame is not None else pd.DataFrame()
        # A route that issues *two* different reads (the movers block: P1, then
        # the session baseline) needs a different answer per call, which a single
        # canned frame cannot give. `frames` is consumed in order; anything past
        # the end comes back empty.
        self._frames = list(frames) if frames is not None else None
        self._error = error
        self.queries = []

    def query(self, query, language=None):
        self.queries.append(query)
        if self._error is not None:
            raise self._error

        frame = self._frame
        if self._frames is not None:
            frame = self._frames.pop(0) if self._frames else pd.DataFrame()

        class Table:
            def __init__(self, frame):
                self._frame = frame

            def __len__(self):
                return len(self._frame)

            def to_pandas(self):
                return self._frame

        return Table(frame)


class FakeWriter:
    def __init__(self, client):
        self._client = client

    def connect(self):
        pass


class FakeMetrics:
    def __init__(self, client):
        self.influxdb = FakeWriter(client)


def build_client(tmp_path, frame=None, error=None, settings=None, events=None,
                 frames=None):
    """A Flask test client over a real ConfigurationManager on ``tmp_path``."""
    return build_client_and_influx(
        tmp_path, frame, error, settings, events, frames)[0]


def build_client_and_influx(tmp_path, frame=None, error=None, settings=None,
                            events=None, frames=None):
    """As above, plus the fake InfluxDB client so a test can read the SQL back."""
    if settings is not None:
        (tmp_path / 'settings.yaml').write_text(settings, encoding='utf-8')
    if events is not None:
        events_dir = tmp_path / 'events'
        events_dir.mkdir(exist_ok=True)
        (events_dir / '2024.csv').write_text(events, encoding='utf-8')
    else:
        (tmp_path / 'config.yaml').write_text("shares: []\n", encoding='utf-8')

    manager = main.ConfigurationManager(config_dir=str(tmp_path))
    runtime = main.Runtime(manager, manager.validator, None)
    influx = FakeClient(frame, error, frames)
    runtime.metrics = FakeMetrics(influx)
    return create_app(runtime).test_client(), influx


#: A declared, single-currency setup — the `accounts` mode's precondition. Both
#: halves are needed: `update_account_metrics` gates on a declared `Portfolio`
#: *and* on the snapshot carrying events, so events mode is not decoration here.
ACCOUNTS_SETTINGS = (
    "mode: events\n"
    "accounts:\n"
    "- id: pea\n"
    "  type: PEA\n"
    "  currency: EUR\n"
    "  label: PEA Bourso\n"
)

ACCOUNTS_EVENTS = (
    "date,event_type,symbol,name,quantity,unit_price,account\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n"
)


def totals_frame(**overrides):
    """One ``portfolio_totals`` row — the dashboard head's whole source."""
    base = {
        'time': pd.Timestamp('2026-08-05 00:00:00'),
        'cash_balance': 500.0,
        'holdings_value': 12000.0,
        'total_value': 12500.0,
        'net_contributed': 10000.0,
        'xirr': 0.12,
        'gain_absolu': 2500.0,
        'twr_index': 124.0,
    }
    base.update(overrides)
    return pd.DataFrame([base])


def influx_row(**overrides):
    base = {
        'share_symbol': 'AAPL',
        'share_name': 'Apple Inc',
        'account': 'pea',
        'share_currency': 'USD',
        'share_exchange': 'NMS',
        'quote_type': 'EQUITY',
        'time': pd.Timestamp('2024-06-01 12:00:00'),
        'share_price': 200.0,
        'purchased_quantity': 10.0,
        'purchased_price': 150.0,
        'purchased_fee': 2.5,
        'owned_quantity': 10.0,
        'received_dividend': 0.0,
        'dividend_yield': 0.5,
        'pe_ratio': 30.0,
        'market_cap': 3.0e12,
    }
    base.update(overrides)
    return base


# --------------------------------------------------------------------- #
# The three states of absence
# --------------------------------------------------------------------- #

def test_empty_portfolio_is_200_and_an_empty_list(tmp_path):
    """A fresh install owns nothing. That is not a 404 and not an error."""
    response = build_client(tmp_path).get('/api/shares')

    assert response.status_code == 200
    assert response.get_json() == []


def test_a_storage_failure_is_503_problem_json(tmp_path):
    """The distinctly *non*-empty answer — the whole point of the sibling module."""
    client = build_client(tmp_path, error=Exception("connection refused"))
    response = client.get('/api/shares')

    assert response.status_code == 503
    assert response.mimetype == 'application/problem+json'
    body = response.get_json()
    assert body['type'] == '/problems/storage-unavailable'
    assert 'connection refused' in body['detail']


def test_absent_fields_stay_null_in_the_payload(tmp_path):
    """Trap 3: a missing fundamental is a normal state, never a zero."""
    frame = pd.DataFrame([influx_row(pe_ratio=float('nan'))])
    response = build_client(tmp_path, frame=frame).get('/api/shares')

    assert response.get_json()[0]['pe_ratio'] is None


# --------------------------------------------------------------------- #
# Shares
# --------------------------------------------------------------------- #

def test_shares_aggregates_across_accounts_and_keeps_the_breakdown(tmp_path):
    frame = pd.DataFrame([
        influx_row(account='pea', owned_quantity=10.0, purchased_quantity=10.0,
                   purchased_price=150.0),
        influx_row(account='cto', owned_quantity=5.0, purchased_quantity=5.0,
                   purchased_price=180.0),
    ])
    payload = build_client(tmp_path, frame=frame).get('/api/shares').get_json()

    assert len(payload) == 1
    assert payload[0]['symbol'] == 'AAPL'
    assert payload[0]['owned_quantity'] == 15.0
    assert payload[0]['cost_price'] == pytest.approx(160.0)  # (1500+900)/15
    assert {a['account'] for a in payload[0]['accounts']} == {'pea', 'cto'}


def test_an_unknown_symbol_is_404_problem_json(tmp_path):
    client = build_client(tmp_path)
    response = client.get('/api/shares/NOPE')

    assert response.status_code == 404
    assert response.mimetype == 'application/problem+json'


def test_prices_rejects_an_inverted_window(tmp_path):
    client = build_client(tmp_path)
    response = client.get('/api/shares/AAPL/prices?from=2024-06-01&to=2024-01-01')

    assert response.status_code == 400
    assert response.get_json()['type'] == '/problems/bad-request'


def test_prices_rejects_an_unparseable_instant(tmp_path):
    response = build_client(tmp_path).get('/api/shares/AAPL/prices?from=yesterday')

    assert response.status_code == 400


def test_prices_reports_the_bucket_it_used(tmp_path):
    """A chart that silently downsamples is a chart that lies about its
    resolution, so the choice is part of the payload."""
    frame = pd.DataFrame([{
        'time': pd.Timestamp('2024-06-01 12:00:00'), 'share_price': 200.0}])
    client = build_client(tmp_path, frame=frame)

    narrow = client.get(
        '/api/shares/AAPL/prices?from=2024-06-01&to=2024-06-05').get_json()
    wide = client.get(
        '/api/shares/AAPL/prices?from=2020-06-01&to=2024-06-05').get_json()

    assert narrow['bucket'] is None
    assert wide['bucket'] == '1 day'
    assert narrow['points'][0]['t'] == '2024-06-01T12:00:00+00:00'


# --------------------------------------------------------------------- #
# Portfolio — the dashboard head as a discriminated union (issue #660)
# --------------------------------------------------------------------- #

def test_the_head_of_a_default_install_speaks_plus_value_latente(tmp_path):
    """No declared accounts is what every default install runs, so this is the
    *designed* mode and not a degraded one. Its head has no `gain_absolu` key at
    all — #652 déc. 6's two terms cannot be conflated if they never coexist."""
    frame = pd.DataFrame([influx_row(account='default')])
    payload = build_client(tmp_path, frame=frame).get('/api/portfolio').get_json()

    assert payload['mode'] == 'titres'
    assert payload['plus_value_latente'] == pytest.approx(497.5)  # 2000−1500−2.5
    assert 'gain_absolu' not in payload


def test_the_head_of_a_declared_single_currency_install_speaks_gain(tmp_path):
    client = build_client(tmp_path, frame=totals_frame(),
                          settings=ACCOUNTS_SETTINGS, events=ACCOUNTS_EVENTS)
    payload = client.get('/api/portfolio').get_json()

    assert payload['mode'] == 'accounts'
    assert payload['gain_absolu'] == 2500.0
    assert payload['net_contributed'] == 10000.0
    assert payload['xirr'] == 0.12
    assert payload['currency'] == 'EUR'
    assert 'plus_value_latente' not in payload


def test_declared_accounts_whose_perf_job_has_not_run_stay_in_accounts_mode(tmp_path):
    """The collapse #655 déc. 8 refuses: "you have not declared accounts" and
    "the computation has not happened yet" must not be one screen. The mode is
    read from the configuration, so it survives an empty series."""
    client = build_client(tmp_path, settings=ACCOUNTS_SETTINGS,
                          events=ACCOUNTS_EVENTS)
    payload = client.get('/api/portfolio').get_json()

    assert payload['mode'] == 'accounts'
    assert payload['total_value'] is None
    assert payload['as_of'] is None


def test_a_mixed_currency_portfolio_states_the_condition_without_reading_storage(tmp_path):
    """`portfolio_totals` is not written at all for a mixed portfolio, so there
    is nothing to query and nothing to invent. #655 déc. 8's third case: the API
    *says* so, and what a consolidated mixed view should show stays the open
    product question it has been since #650."""
    settings = (
        "mode: events\n"
        "accounts:\n"
        "- id: pea\n  type: PEA\n  currency: EUR\n  label: PEA\n"
        "- id: cto\n  type: CTO\n  currency: USD\n  label: CTO\n"
    )
    events = (
        "date,event_type,symbol,name,quantity,unit_price,account\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n"
        "2024-01-16,BUY,MSFT,Microsoft,5,380.00,cto\n"
    )
    client, influx = build_client_and_influx(
        tmp_path, settings=settings, events=events)
    payload = client.get('/api/portfolio').get_json()

    assert payload['mode'] == 'multi_currency'
    assert payload['currencies'] == ['EUR', 'USD']
    assert {a['id'] for a in payload['accounts']} == {'pea', 'cto'}
    # Not one query: the condition is a property of the declaration.
    assert influx.queries == []


def test_the_relative_delta_reads_the_last_point_before_the_instant(tmp_path):
    """#652 déc. 2's UI preference, and the reason it is a baseline *instant*
    rather than a window: it is deliberately decoupled from the chart's zoom."""
    client, influx = build_client_and_influx(
        tmp_path, frame=totals_frame(), settings=ACCOUNTS_SETTINGS,
        events=ACCOUNTS_EVENTS)
    payload = client.get('/api/portfolio?since=2026-07-05T00:00:00Z').get_json()

    # Two reads, and which one runs first is not the contract — that the
    # baseline is asked for as "the last point ≤ t" is.
    issued = " ".join(" ".join(q.split()) for q in influx.queries)
    assert "time <= '2026-07-05T00:00:00Z'" in issued
    assert payload['baseline']['since'] == '2026-07-05T00:00:00+00:00'


def test_the_head_rejects_an_unparseable_baseline_instant(tmp_path):
    client = build_client(tmp_path, settings=ACCOUNTS_SETTINGS,
                          events=ACCOUNTS_EVENTS)
    response = client.get('/api/portfolio?since=last-tuesday')

    assert response.status_code == 400
    assert response.get_json()['type'] == '/problems/bad-request'


def test_a_malformed_instant_is_rejected_in_every_mode(tmp_path):
    """Found while re-reading the route. Parsing inside the `accounts` branch
    made the same request a 400 there and a silent no-op in `titres` — the
    answer depending on a configuration the caller cannot see."""
    response = build_client(tmp_path).get('/api/portfolio?since=last-tuesday')

    assert response.status_code == 400


# --------------------------------------------------------------------- #
# The main chart
# --------------------------------------------------------------------- #

def test_the_history_of_a_declared_install_is_value_versus_contributed(tmp_path):
    """#652 déc. 7: the area between the two curves *is* the Gain. The chart has
    no equivalent at global level in the Grafana baseline."""
    client, influx = build_client_and_influx(
        tmp_path, frame=totals_frame(), settings=ACCOUNTS_SETTINGS,
        events=ACCOUNTS_EVENTS)
    payload = client.get('/api/portfolio/history').get_json()

    assert payload['mode'] == 'accounts'
    assert payload['points'] == [{
        't': '2026-08-05T00:00:00+00:00', 'value': 12500.0, 'contributed': 10000.0}]
    assert 'portfolio_totals' in influx.queries[-1]


def test_the_degraded_history_is_valuation_versus_investment(tmp_path):
    """The fallback of déc. 7, and the field names keep the two charts apart:
    `contributed` is money the investor put in, `invested` is what the positions
    cost. One name for both is how they would end up conflated."""
    frame = pd.DataFrame([{
        'day': pd.Timestamp('2024-06-01 00:00:00'),
        'share_symbol': 'AAPL',
        'account': 'default',
        'share_price': 200.0,
        'owned_quantity': 10.0,
        'purchased_quantity': 10.0,
        'purchased_price': 150.0,
    }])
    client, influx = build_client_and_influx(tmp_path, frame=frame)
    payload = client.get('/api/portfolio/history').get_json()

    assert payload['mode'] == 'titres'
    assert payload['points'] == [{
        't': '2024-06-01T00:00:00+00:00', 'value': 2000.0, 'invested': 1500.0}]
    assert 'portfolio_metrics' in influx.queries[-1]


def test_the_history_rejects_an_inverted_window(tmp_path):
    response = build_client(tmp_path).get(
        '/api/portfolio/history?from=2026-06-01&to=2026-01-01')

    assert response.status_code == 400


def test_the_history_defaults_to_a_year_because_the_series_is_daily(tmp_path):
    """One point per calendar day: the short presets that are natural on the
    shares page hold a single point here."""
    client, influx = build_client_and_influx(
        tmp_path, settings=ACCOUNTS_SETTINGS, events=ACCOUNTS_EVENTS)
    body = client.get('/api/portfolio/history').get_json()

    span = datetime.fromisoformat(body['to']) - datetime.fromisoformat(body['from'])
    assert span.days == 365
    assert 'DATE_BIN' not in influx.queries[-1]


# --------------------------------------------------------------------- #
# Movers
# --------------------------------------------------------------------- #

def test_movers_anchor_on_the_last_session_close_not_on_midnight_today(tmp_path):
    """#652 déc. 8's trap. The newest stored point is a Friday close; the
    baseline is midnight of *that* day, so a weekend still shows Friday's
    session instead of a column of zeros."""
    current = pd.DataFrame([influx_row(
        share_price=110.0, time=pd.Timestamp('2026-07-31 21:00:00'))])
    baseline = pd.DataFrame([{
        'share_symbol': 'AAPL', 'share_price': 100.0,
        'time': pd.Timestamp('2026-07-30 20:00:00')}])
    client, influx = build_client_and_influx(
        tmp_path, frames=[current, baseline])
    payload = client.get('/api/portfolio/movers').get_json()

    assert payload['since'] == '2026-07-31T00:00:00+00:00'
    # The cut and the session are two different instants, and only the second is
    # safe to put in front of a reader: naming the cut announced a close that
    # had not happened yet.
    assert payload['reference'] == '2026-07-30T20:00:00+00:00'
    assert "time <= '2026-07-31T00:00:00Z'" in " ".join(influx.queries[-1].split())
    assert payload['movers'][0]['change_pct'] == pytest.approx(0.1)
    assert payload['movers'][0]['contribution'] == pytest.approx(100.0)


def test_movers_on_a_fresh_install_is_empty_and_asks_nothing_further(tmp_path):
    """No observation means no session to anchor on — and no second query."""
    client, influx = build_client_and_influx(tmp_path)
    payload = client.get('/api/portfolio/movers').get_json()

    assert payload == {'since': None, 'reference': None, 'movers': []}
    assert len(influx.queries) == 1


# --------------------------------------------------------------------- #
# Accounts — the discriminator, not an empty list
# --------------------------------------------------------------------- #

def test_accounts_says_undeclared_rather_than_returning_nothing(tmp_path):
    """`declared: false` is the opt-out setup every default install runs.

    Letting the front infer it from `[]` is what would eventually make "no
    declared accounts" and "the config failed to load" render the same screen.
    """
    payload = build_client(tmp_path).get('/api/accounts').get_json()

    assert payload == {'declared': False, 'accounts': []}


def test_accounts_returns_the_declaration_with_its_labels(tmp_path):
    """Reading settings.yaml rather than a DISTINCT on the tag (#652 déc. 4)
    hands over label/type/currency — three fields the app writes and zero
    Grafana panels read."""
    settings = (
        "mode: events\n"
        "accounts:\n"
        "- id: pea\n"
        "  type: PEA\n"
        "  currency: EUR\n"
        "  label: PEA Bourso\n"
    )
    events = (
        "date,event_type,symbol,name,quantity,unit_price,account\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n"
    )
    client = build_client(tmp_path, settings=settings, events=events)
    payload = client.get('/api/accounts').get_json()

    assert payload['declared'] is True
    assert payload['accounts'] == [
        {'id': 'pea', 'label': 'PEA Bourso', 'type': 'PEA', 'currency': 'EUR'}]


# --------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------- #

def test_manual_mode_has_no_events_and_says_so_with_an_empty_list(tmp_path):
    response = build_client(tmp_path).get('/api/events')

    assert response.status_code == 200
    assert response.get_json() == []


def test_events_are_returned_with_an_opaque_id_and_etag(tmp_path):
    events = (
        "date,event_type,symbol,name,quantity,unit_price,amount\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,\n"
        "2024-03-01,DIVIDEND,AAPL,Apple Inc,,,8.50\n"
        "2024-02-01,BUY,MSFT,Microsoft,5,380.00,\n"
    )
    client = build_client(tmp_path, settings="mode: events\n", events=events)
    payload = client.get('/api/events').get_json()

    assert len(payload) == 3
    assert all(row['id'] and row['etag'] for row in payload)
    assert all('file' not in row and 'row' not in row for row in payload)


def test_events_can_be_narrowed_to_one_symbol_for_the_chart_markers(tmp_path):
    events = (
        "date,event_type,symbol,name,quantity,unit_price,amount\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,\n"
        "2024-02-01,BUY,MSFT,Microsoft,5,380.00,\n"
    )
    client = build_client(tmp_path, settings="mode: events\n", events=events)
    payload = client.get('/api/events?symbol=AAPL').get_json()

    assert [row['symbol'] for row in payload] == ['AAPL']


# --------------------------------------------------------------------- #
# The catch-all
# --------------------------------------------------------------------- #

def test_the_spa_catch_all_does_not_swallow_an_api_404(tmp_path):
    """Without this guard a typo'd endpoint returns the HTML shell with a 200,
    and the front fails on a JSON parse error far from the cause — the most
    confusing failure this arrangement can produce."""
    response = build_client(tmp_path).get('/api/does-not-exist')

    assert response.status_code == 404
    assert response.mimetype == 'application/problem+json'


def test_the_catch_all_does_not_serve_html_at_metrics(tmp_path, monkeypatch):
    """Found by an existing #651 test the moment the SPA landed.

    With SB_PROMETHEUS_ENABLED=false there is no /metrics mount, so the request
    fell through to index.html and answered 200 with HTML. That is strictly
    worse than the 404 it used to get: a Prometheus scraper reads 200 as a
    healthy target and keeps reporting nothing wrong.
    """
    bundle = tmp_path / 'bundle'
    bundle.mkdir()
    (bundle / 'index.html').write_text('<!doctype html>', encoding='utf-8')
    monkeypatch.setenv('SB_STATIC_DIR', str(bundle))

    response = build_client(tmp_path).get('/metrics')

    assert response.status_code == 404
    assert response.mimetype == 'application/problem+json'


def test_health_still_wins_over_the_catch_all(tmp_path):
    """The container healthcheck's only target (#651) must not become the SPA."""
    response = build_client(tmp_path).get('/health')

    assert response.status_code == 200
    assert response.get_json() == {'status': 'ok'}


def test_a_build_without_a_bundle_says_so_instead_of_404ing_blankly(tmp_path,
                                                                    monkeypatch):
    monkeypatch.setenv('SB_STATIC_DIR', str(tmp_path / 'no-bundle-here'))
    response = build_client(tmp_path).get('/')

    assert response.status_code == 404
    assert 'API' in response.get_json()['detail']


def test_the_spa_is_served_for_an_unknown_client_route(tmp_path, monkeypatch):
    bundle = tmp_path / 'bundle'
    bundle.mkdir()
    (bundle / 'index.html').write_text('<!doctype html><div id=root>', encoding='utf-8')
    monkeypatch.setenv('SB_STATIC_DIR', str(bundle))

    response = build_client(tmp_path).get('/titres/AAPL')

    assert response.status_code == 200
    assert b'id=root' in response.data


def test_the_window_reaches_influxdb_as_bare_utc_z_literals(tmp_path):
    """`isoformat()` alone yields `+00:00Z` for an aware datetime, which
    InfluxDB rejects outright — so the route's parsing and the writer's
    formatter have to agree all the way down to the SQL string."""
    client, influx = build_client_and_influx(tmp_path)
    client.get(
        '/api/shares/AAPL/prices'
        '?from=2024-01-15T09:30:00Z&to=2024-01-16T17:00:00Z')

    sql = " ".join(influx.queries[-1].split())
    assert "time >= '2024-01-15T09:30:00Z'" in sql
    assert "time <= '2024-01-16T17:00:00Z'" in sql
    assert '+00:00' not in sql


def test_a_naive_instant_is_read_as_utc_not_local_time(tmp_path):
    """A bare date from the front must not shift by the server's timezone."""
    client, influx = build_client_and_influx(tmp_path)
    client.get('/api/shares/AAPL/prices?from=2024-01-15&to=2024-01-16')

    sql = " ".join(influx.queries[-1].split())
    assert "time >= '2024-01-15T00:00:00Z'" in sql
    assert datetime(2024, 1, 15, tzinfo=timezone.utc).isoformat() == \
        '2024-01-15T00:00:00+00:00'
