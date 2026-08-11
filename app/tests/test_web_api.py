"""Tests for the /api blueprint (issue #659, design #655).

The routes themselves are thin — five lines each — so what is tested here is the
**contract**, which is not thin at all: #655 decision 8 split absence into three
states the scheduler's own reads collapse onto ``None``, and getting them back
onto one value is exactly how a UI ends up rendering "the database is dead" and
"you own nothing yet" identically. Since #700 the store is **real** here and the
three states are structural: a declared table nobody wrote answers ``200`` +
``[]``, an unwritten column reads ``NULL``, and only a fault raises.

Plus the one rule of the SPA catch-all that is load-bearing: it must not swallow
an ``/api`` 404.
"""
from datetime import date, datetime, timezone

import pytest

import advisories
import main
import perf_series
import quotes
import runtime_state
import settings_registry
import store
import web as web_module
from events import export as events_export
from events.schemas import AccountMetricPoint, PortfolioTotalPoint
from web import create_app


class FakeMetrics:
    """Stands in for SuiviBourseMetrics: the replay, and the dials.

    ``ingest`` is real rather than a spy (issue #697). It is the seam
    *"the replay follows the write"* lands on, so a route that forgets an
    import has to be observable through the snapshot it republished — which
    only a real reload gives. The scrape-job reconciliation the production
    method also does needs a scheduler and is not what these tests are about.

    The InfluxDB half is gone with #700: a route reads the **store**, which
    these tests give it for real, so there is nothing left here to stand in for.
    """

    #: The real one, borrowed rather than re-implemented: it is a loop over the
    #: registry and a ``setattr``, so a copy here would be the second list
    #: ADR-0014 forbids — and the one that stops matching first.
    apply_dials = main.SuiviBourseMetrics.apply_dials

    def __init__(self, config_manager=None):
        self._config_manager = config_manager
        self.ingest_calls = 0
        self.apply_dials(settings_registry.defaults())
        # What ``rearm_regular_scrapes`` answers here. Re-arming needs a live
        # jobstore, which these tests have no business standing up; the split
        # itself is pinned in ``test_scheduling.py`` and its wiring in
        # ``test_scheduling_wiring.py``.
        self.rearm_result = (3, 8)
        self.rearm_calls = 0
        # The reconstruction's progress, from the scheduler's own memory
        # (issue #709). A **pair**, always: the real method has no ``None`` to
        # answer, since a process holding a metrics object is a process that can
        # see the memory. ``(0, 0)`` is what these tests' empty ledgers hold —
        # nothing to reconstruct. *Unobservable* is a runtime with no metrics at
        # all (``runtime.metrics is None``), which is what ``with_scheduler``
        # below builds.
        self.reconstruction = (0, 0)

    def reconstruction_state(self):
        return self.reconstruction

    def rearm_regular_scrapes(self):
        self.rearm_calls += 1
        return self.rearm_result

    def ingest(self, import_files=True):
        self.ingest_calls += 1
        if self._config_manager is None:
            return
        if import_files:
            self._config_manager.reload()
        else:
            self._config_manager.replay()


def build_client(tmp_path, accounts=None, events=None, seed=None,
                 break_store=False, with_scheduler=True):
    """A Flask test client over a real manager **and a real store**."""
    return build_client_and_store(
        tmp_path, accounts, events, seed, break_store, with_scheduler)[0]


def build_client_and_store(tmp_path, accounts=None, events=None, seed=None,
                           break_store=False, with_scheduler=True):
    """As above, plus the open store so a test can read the rows back.

    ``with_scheduler=False`` leaves ``runtime.metrics`` **unset**, which is the
    shape of a worker whose ``start_runtime`` has not run: it is the one state in
    which the reconstruction is genuinely *unobservable* (issue #709), and it is
    a missing object rather than a metrics object answering ``None``.

    ``accounts`` is a **file in the drop folder** since #698, not a
    ``settings.yaml``: the declaration is user data with provenance, so the
    setup a test writes is the setup a user writes.

    ``seed`` runs **after** the first publication, and it has to: the replay
    rewrites ``position`` wholesale, so a row laid down before it would be
    swept away by it.

    ``break_store`` drops a table the read layer names. That is a genuine
    storage fault rather than a simulated one — the query raises, the blueprint
    answers ``503``, and nothing in between has to recognise an error message
    (which is exactly what ``_ABSENT_SCHEMA`` used to do, and why it is gone).
    """
    events_dir = tmp_path / 'events'
    events_dir.mkdir(exist_ok=True)
    if accounts is not None:
        (events_dir / 'accounts.csv').write_text(accounts, encoding='utf-8')
    if events is not None:
        (events_dir / '2024.csv').write_text(events, encoding='utf-8')

    # A real store under tmp_path, as ``post_fork`` would have opened (#696).
    # ``/health`` reaches it, and every other route here has to keep answering
    # with one present. Since #697 the ledger lives in it too, so the manager
    # is handed the **same** connection ``start_runtime`` hands it — two files
    # here would mean the routes read a different ledger from the one the
    # snapshot was published from.
    opened = store.open_store(tmp_path / 'store.duckdb')
    manager = main.ConfigurationManager(config_dir=str(tmp_path),
                                        opened_store=opened)
    runtime = main.Runtime(manager, None)
    runtime.store = opened
    # The first publication, as ``build_runtime`` performs it in the master.
    # Since #697 it is also the **first import**: the drop folder lands in the
    # store here, so a route that reads the ledger reads the same one the
    # snapshot was published from.
    manager.reload()
    if seed is not None:
        seed(opened)
    if break_store:
        opened.execute('DROP TABLE position')
        opened.execute('DROP TABLE account_metrics')
        opened.execute('DROP TABLE portfolio_totals')
        opened.execute('DROP TABLE price_point')
    if with_scheduler:
        runtime.metrics = FakeMetrics(manager)
    return create_app(runtime).test_client(), opened


# --------------------------------------------------------------------- #
# Seeding — the rows a page reads, written the way the jobs write them
# --------------------------------------------------------------------- #

def seed_position(opened, symbol='AAPL', name='Apple Inc', account='pea',
                  quantity=10.0, cost_basis=1500.0, realized_gain=0.0,
                  received_dividend=0.0):
    """One row of ``position`` — what the replay lays down."""
    opened.execute("INSERT INTO account (id, type, label) VALUES (?, 'CTO', ?) "
                   "ON CONFLICT (id) DO NOTHING", [account, account])
    opened.execute('INSERT INTO symbol (symbol) VALUES (?) '
                   'ON CONFLICT (symbol) DO NOTHING', [symbol])
    opened.execute(
        'INSERT INTO position (account, symbol, name, quantity, cost_basis, '
        '                      realized_gain, received_dividend) '
        'VALUES (?, ?, ?, ?, ?, ?, ?) '
        'ON CONFLICT (account, symbol) DO UPDATE SET '
        '  name = excluded.name, quantity = excluded.quantity, '
        '  cost_basis = excluded.cost_basis, '
        '  realized_gain = excluded.realized_gain, '
        '  received_dividend = excluded.received_dividend',
        [account, symbol, name, quantity, cost_basis, realized_gain,
         received_dividend])


def seed_quote(opened, symbol='AAPL', price=200.0,
               at=datetime(2024, 6, 1, 12, 0, tzinfo=timezone.utc),
               currency='USD', converted=None, rate=1.0, **attributes):
    """One observation — what the scrape writes, through the real writer.

    Converted as well as native (#702). `converted` defaults to the native
    price at a rate of 1: the pages read the converted column, because every
    money figure they draw is in the reporting currency. A point with only a
    native price is one whose conversion has not landed, and the tests that are
    about *that* say so by passing `converted=None, rate=None`.
    """
    opened.execute('INSERT INTO symbol (symbol) VALUES (?) '
                   'ON CONFLICT (symbol) DO NOTHING', [symbol])
    values = {'currency': currency, 'exchange': 'NMS', 'quote_type': 'EQUITY',
              'dividend_yield': 0.5, 'pe_ratio': 30.0, 'market_cap': 3.0e12}
    values.update(attributes)
    quotes.record_quote(opened, symbol, at, price, values,
                        price if converted is None and rate is not None
                        else converted, rate)


def seed_totals(opened, day=date(2026, 8, 5), **overrides):
    """One ``portfolio_totals`` row — the dashboard head's whole source."""
    values = {'cash_balance': 500.0, 'holdings_value': 12000.0,
              'total_value': 12500.0, 'net_contributed': 10000.0,
              'xirr': 0.12, 'gain_absolu': 2500.0, 'twr_index': 124.0}
    values.update(overrides)
    perf_series.write_portfolio_totals(
        opened, [PortfolioTotalPoint(day=day, **values)])


def seed_account_metrics(opened, account='pea', day=date(2026, 8, 5),
                         **overrides):
    """One ``account_metrics`` row, for the accounts comparison table."""
    values = {'cash_balance': 500.0, 'holdings_value': 12000.0,
              'total_value': 12500.0, 'net_contributed': 10000.0,
              'xirr': 0.12, 'gain_absolu': 2500.0, 'twr_index': 118.4}
    values.update(overrides)
    opened.execute("INSERT INTO account (id, type, label) VALUES (?, 'CTO', ?) "
                   "ON CONFLICT (id) DO NOTHING", [account, account])
    perf_series.write_account_metrics(opened, [AccountMetricPoint(
        account=account, account_type='CTO',
        day=day, **values)])


#: A declared setup — the `accounts` mode's precondition. An accounts **file**
#: in the drop folder (issue #698), in the events' own format.
ACCOUNTS_FILE = (
    "id,type,label\n"
    "pea,PEA,PEA Bourso\n"
)

ACCOUNTS_EVENTS = (
    "date,event_type,symbol,name,quantity,unit_price,account\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n"
)


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
    client = build_client(tmp_path, break_store=True)
    response = client.get('/api/shares')

    assert response.status_code == 503
    assert response.mimetype == 'application/problem+json'
    body = response.get_json()
    assert body['type'] == '/problems/storage-unavailable'
    assert 'position' in body['detail']


def test_absent_fields_stay_null_in_the_payload(tmp_path):
    """Trap 3: a missing fundamental is a normal state, never a zero."""
    def seed(opened):
        seed_position(opened)
        seed_quote(opened, pe_ratio=None)

    response = build_client(tmp_path, seed=seed).get('/api/shares')

    assert response.get_json()[0]['pe_ratio'] is None


# --------------------------------------------------------------------- #
# Shares
# --------------------------------------------------------------------- #

def test_shares_aggregates_across_accounts_and_keeps_the_breakdown(tmp_path):
    def seed(opened):
        seed_position(opened, account='pea', quantity=10.0, cost_basis=1500.0)
        seed_position(opened, account='cto', quantity=5.0, cost_basis=900.0)
        seed_quote(opened)

    payload = build_client(tmp_path, seed=seed).get('/api/shares').get_json()

    assert len(payload) == 1
    assert payload[0]['symbol'] == 'AAPL'
    assert payload[0]['quantity'] == 15.0
    assert payload[0]['unit_cost'] == pytest.approx(160.0)  # (1500+900)/15
    assert {a['account'] for a in payload[0]['accounts']} == {'pea', 'cto'}


def test_a_share_with_no_quote_and_a_finished_rebuild_is_carried_at_its_cost(
        tmp_path):
    """Issue #706 through the wire, both terms of it.

    The ledger names one purchase and the backward pass has reached it, so the
    convention applies: the price column stays ``null`` — the app does not
    invent a quote — while the value and the latent gain are computed from what
    the position cost. Nothing else on the payload says so; the em dash is the
    signal (ADR-0004).
    """
    def seed(opened):
        seed_position(opened, account='pea', quantity=10.0, cost_basis=1502.5)
        quotes.record_window_tried(opened, 'AAPL', date(2024, 1, 15))

    payload = build_client(
        tmp_path, accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS,
        seed=seed).get('/api/shares').get_json()

    assert payload[0]['price'] is None
    assert payload[0]['market_value'] == pytest.approx(1502.5)
    assert payload[0]['plus_value_latente'] == pytest.approx(0.0)


def test_a_share_whose_rebuild_is_still_running_keeps_its_em_dash(tmp_path):
    """The predicate's second term, on the same route.

    Nothing is tried yet, so the history may still be coming: value and latent
    stay absent rather than flat-at-cost, which is the four-year-long
    misreading ADR-0004 exists to prevent.
    """
    def seed(opened):
        seed_position(opened, account='pea', quantity=10.0, cost_basis=1502.5)

    payload = build_client(
        tmp_path, accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS,
        seed=seed).get('/api/shares').get_json()

    assert payload[0]['price'] is None
    assert payload[0]['market_value'] is None
    assert payload[0]['plus_value_latente'] is None


def test_a_share_waiting_for_a_rate_is_not_carried_at_its_cost(tmp_path):
    """The predicate's **first** term, on the wire (issue #706).

    The quote is known and its conversion is not — a base currency not answered
    yet, or a pair that does not resolve — and the backward pass has finished. A
    first term reading *the converted price is absent* would carry this row at
    its cost, answering a valuation where the app owes *waiting for a rate*
    (``CONTEXT.md`` § Absence; ``read-your-figures.mdx``'s absence table). The
    native price rides the payload so the page can say which of the two it is.
    """
    def seed(opened):
        seed_position(opened, account='pea', quantity=10.0, cost_basis=1502.5)
        seed_quote(opened, price=187.5, converted=None, rate=None)
        quotes.record_window_tried(opened, 'AAPL', date(2024, 1, 15))

    payload = build_client(
        tmp_path, accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS,
        seed=seed).get('/api/shares').get_json()

    assert payload[0]['price'] is None
    assert payload[0]['price_native'] == pytest.approx(187.5)
    assert payload[0]['market_value'] is None
    assert payload[0]['plus_value_latente'] is None


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
    client = build_client(
        tmp_path,
        seed=lambda opened: seed_quote(
            opened, price=200.0,
            at=datetime(2024, 6, 1, 12, 0, tzinfo=timezone.utc)))

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
    def seed(opened):
        seed_position(opened, account='default', quantity=10.0,
                      cost_basis=1502.5)
        seed_quote(opened)

    payload = build_client(tmp_path, seed=seed).get('/api/portfolio').get_json()

    assert payload['mode'] == 'titres'
    assert payload['plus_value_latente'] == pytest.approx(497.5)  # 2000−1502,5
    assert 'gain_absolu' not in payload


def test_the_head_states_the_reporting_currency_and_its_absence(tmp_path):
    """How the API says *"nothing here has a unit yet"* (#702, ADR-0021).

    Nothing new is published for it and no route changes: the head's `currency`
    is the field every figure on the page is labelled with, so an absent one is
    the condition itself, and the dial is already on `/api/config` for the
    banner to read. A fourth kind of absence would make every page depend on one
    preamble, and a landing route that varies with the data is the one thing a
    bookmark cannot survive.
    """
    def seed(opened):
        seed_position(opened, account='default')
        seed_quote(opened)

    client = build_client(tmp_path, seed=seed)

    assert client.get('/api/portfolio').get_json()['currency'] is None
    dial = _dials(client)['base_currency']
    assert dial['value'] is None and dial['default'] is None
    assert dial['stored'] is False

    assert client.put('/api/settings',
                      json={'base_currency': 'eur'}).status_code == 200

    assert client.get('/api/portfolio').get_json()['currency'] == 'EUR'
    assert _dials(client)['base_currency']['stored'] is True


def test_the_head_of_a_declared_install_speaks_gain(tmp_path):
    client = build_client(tmp_path, seed=seed_totals,
                          accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)
    payload = client.get('/api/portfolio').get_json()

    assert payload['mode'] == 'accounts'
    assert payload['gain_absolu'] == 2500.0
    assert payload['net_contributed'] == 10000.0
    assert payload['xirr'] == 0.12
    assert 'plus_value_latente' not in payload
    # `currency` is null and stays so until the reporting currency lands
    # (#702): a declaration has three columns since #698, and none is a
    # currency — a per-account one was never the right home for it (ADR-0002).
    assert payload['currency'] is None


def test_declared_accounts_whose_perf_job_has_not_run_stay_in_accounts_mode(tmp_path):
    """The collapse #655 déc. 8 refuses: "you have not declared accounts" and
    "the computation has not happened yet" must not be one screen. The mode is
    read from the configuration, so it survives an empty series."""
    client = build_client(tmp_path, accounts=ACCOUNTS_FILE,
                          events=ACCOUNTS_EVENTS)
    payload = client.get('/api/portfolio').get_json()

    assert payload['mode'] == 'accounts'
    assert payload['total_value'] is None
    assert payload['as_of'] is None


def test_two_declared_accounts_share_one_head_because_a_file_declares_no_currency(tmp_path):
    """The multi-currency head loses its trigger here, and that is #698's doing.

    A declaration is three columns — ``id``, ``type``, ``label`` — so there is
    nowhere left for a per-account currency to be written, and
    ``portfolio_mode`` therefore sees one currency (``None``) whatever the user
    declares. ``MODE_MULTI_CURRENCY`` is not reachable through the API from
    here on; it stays covered as a pure function in ``test_portfolio_view`` and
    dies with ``Account.currency`` when the reporting currency lands (#702,
    ADR-0002), which is the real answer to a mixed portfolio.
    """
    accounts = (
        "id,type,label\n"
        "pea,PEA,PEA\n"
        "cto,CTO,CTO\n"
    )
    events = (
        "date,event_type,symbol,name,quantity,unit_price,account\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n"
        "2024-01-16,BUY,MSFT,Microsoft,5,380.00,cto\n"
    )
    client, _ = build_client_and_store(
        tmp_path, accounts=accounts, events=events)
    payload = client.get('/api/portfolio').get_json()

    assert payload['mode'] == 'accounts'
    assert payload['currency'] is None


def test_the_relative_delta_reads_the_last_point_before_the_instant(tmp_path):
    """#652 déc. 2's UI preference, and the reason it is a baseline *instant*
    rather than a window: it is deliberately decoupled from the chart's zoom."""
    def seed(opened):
        seed_totals(opened, day=date(2026, 6, 1), total_value=10000.0)
        seed_totals(opened, day=date(2026, 8, 5), total_value=12500.0)

    client = build_client(tmp_path, seed=seed, accounts=ACCOUNTS_FILE,
                          events=ACCOUNTS_EVENTS)
    payload = client.get('/api/portfolio?since=2026-07-05T00:00:00Z').get_json()

    # "The last point at or **before** the instant": the exact day never exists,
    # the series carrying one point a day.
    assert payload['baseline']['since'] == '2026-07-05T00:00:00+00:00'
    assert payload['baseline']['total_value'] == 10000.0
    assert payload['baseline']['change'] == 2500.0


def test_the_head_rejects_an_unparseable_baseline_instant(tmp_path):
    client = build_client(tmp_path, accounts=ACCOUNTS_FILE,
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
    client = build_client(
        tmp_path, seed=lambda opened: seed_totals(opened, day=date.today()),
        accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)
    payload = client.get('/api/portfolio/history').get_json()

    assert payload['mode'] == 'accounts'
    assert payload['points'] == [{
        't': date.today().isoformat(), 'value': 12500.0,
        'contributed': 10000.0}]


def test_the_degraded_history_is_valuation_versus_investment(tmp_path):
    """The fallback of déc. 7, and the field names keep the two charts apart:
    `contributed` is money the investor put in, `invested` is what the positions
    cost. One name for both is how they would end up conflated."""
    events = (
        "date,event_type,symbol,name,quantity,unit_price,fee\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,0\n"
    )

    def seed(opened):
        seed_quote(opened, price=200.0,
                   at=datetime(2024, 6, 1, 17, 0, tzinfo=timezone.utc))

    client = build_client(tmp_path, events=events, seed=seed)
    payload = client.get(
        '/api/portfolio/history?from=2024-01-01&to=2024-12-31').get_json()

    assert payload['mode'] == 'titres'
    # The **join** #700 made explicit: the close comes from the price series,
    # the holding from the replay. They used to be the same row.
    assert payload['points'] == [{
        't': '2024-06-01', 'value': 2000.0, 'invested': 1500.0}]


def test_the_history_rejects_an_inverted_window(tmp_path):
    response = build_client(tmp_path).get(
        '/api/portfolio/history?from=2026-06-01&to=2026-01-01')

    assert response.status_code == 400


def test_the_history_defaults_to_a_year_because_the_series_is_daily(tmp_path):
    """One point per calendar day: the short presets that are natural on the
    shares page hold a single point here."""
    client = build_client(tmp_path, accounts=ACCOUNTS_FILE,
                          events=ACCOUNTS_EVENTS)
    body = client.get('/api/portfolio/history').get_json()

    span = datetime.fromisoformat(body['to']) - datetime.fromisoformat(body['from'])
    assert span.days == 365


# --------------------------------------------------------------------- #
# Movers
# --------------------------------------------------------------------- #

def test_movers_anchor_on_the_last_session_close_not_on_midnight_today(tmp_path):
    """#652 déc. 8's trap. The newest stored point is a Friday close; the
    baseline is midnight of *that* day, so a weekend still shows Friday's
    session instead of a column of zeros."""
    def seed(opened):
        seed_position(opened, quantity=10.0, cost_basis=1000.0)
        seed_quote(opened, price=100.0,
                   at=datetime(2026, 7, 30, 20, 0, tzinfo=timezone.utc))
        seed_quote(opened, price=110.0,
                   at=datetime(2026, 7, 31, 21, 0, tzinfo=timezone.utc))

    client = build_client(tmp_path, seed=seed)
    payload = client.get('/api/portfolio/movers').get_json()

    assert payload['since'] == '2026-07-31T00:00:00+00:00'
    # The cut and the session are two different instants, and only the second is
    # safe to put in front of a reader: naming the cut announced a close that
    # had not happened yet.
    assert payload['reference'] == '2026-07-30T20:00:00+00:00'
    assert payload['movers'][0]['change_pct'] == pytest.approx(0.1)
    assert payload['movers'][0]['contribution'] == pytest.approx(100.0)


def test_movers_on_a_fresh_install_is_empty_and_asks_nothing_further(tmp_path):
    """No observation means no session to anchor on, and nothing to compare."""
    client = build_client(tmp_path)
    payload = client.get('/api/portfolio/movers').get_json()

    assert payload == {'since': None, 'reference': None, 'movers': []}


# --------------------------------------------------------------------- #
# The v5 pair the front reads (contract #745, issue #763)
#
# `/api/positions` and `/api/portfolio-totals` were declared in `lib/api.ts`
# before the server served either, so what is pinned here is the **shape** as
# much as the arithmetic: a field the client reads and the server spells
# otherwise is a `404`'s worth of difference to a page that mounts both.
# --------------------------------------------------------------------- #

#: A ledger carrying a transfer fee, which no other fixture here has. The `BUY`
#: fee is the discriminating half: it is absorbed into the cost basis (ADR-0003)
#: and must **not** appear in ADR-0018's fourth term.
FEE_EVENTS = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,account\n"
    "2024-01-10,DEPOSIT,,,,,1.50,1000.00,pea\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,3.00,,pea\n"
    "2024-06-01,WITHDRAWAL,,,,,0.75,200.00,pea\n"
)


def test_positions_serves_the_frozen_shape_in_one_read(tmp_path):
    """The whole portfolio in one query, spelled as `lib/api.ts` reads it.

    The two market objects are the shape that carries a distinction a single
    nullable number cannot: `price` is the quote **in its own currency**, and
    `converted` is the same observation in the reporting one, with the rate that
    got it there — so the row can be read back as a journal rather than believed.
    """
    def seed(opened):
        seed_position(opened, account='pea', quantity=10.0, cost_basis=1500.0,
                      realized_gain=25.0, received_dividend=12.5)
        seed_quote(opened, price=200.0, currency='USD', converted=180.0,
                   rate=0.9)
        opened.execute(
            "INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR')")

    payload = build_client(tmp_path, seed=seed).get('/api/positions').get_json()

    assert payload['base_currency'] == 'EUR'
    assert len(payload['positions']) == 1
    row = payload['positions'][0]
    assert set(row) == {'account', 'symbol', 'name', 'quantity', 'cost_basis',
                        'realised', 'dividends', 'price', 'converted'}
    assert (row['account'], row['symbol'], row['name']) == (
        'pea', 'AAPL', 'Apple Inc')
    assert row['quantity'] == 10.0 and row['cost_basis'] == 1500.0
    assert row['realised'] == 25.0 and row['dividends'] == 12.5
    assert row['price'] == {'value': 200.0, 'currency': 'USD',
                            'at': '2024-06-01T12:00:00+00:00'}
    assert row['converted'] == {'value': 180.0, 'currency': 'EUR', 'rate': 0.9,
                                'rate_at': '2024-06-01T12:00:00+00:00'}


def test_a_sold_line_and_a_never_quoted_one_are_rows_and_never_absences(tmp_path):
    """Both halves of the second criterion, on the same payload.

    A sold position stays in the table (ADR-0017) — its realized gain is the
    figure it has left to say — and a position whose symbol was never fetched is
    a row with `null` market objects, which is P1's LEFT join: an inner one
    answers *"you own nothing"* to somebody who has just declared everything they
    own.
    """
    def seed(opened):
        seed_position(opened, symbol='AAPL', account='pea', quantity=0.0,
                      cost_basis=0.0, realized_gain=180.0)
        seed_position(opened, symbol='MSFT', name='Microsoft', account='pea',
                      quantity=4.0, cost_basis=800.0)
        seed_quote(opened, symbol='AAPL', price=200.0)

    payload = build_client(tmp_path, seed=seed).get('/api/positions').get_json()
    rows = {row['symbol']: row for row in payload['positions']}

    assert set(rows) == {'AAPL', 'MSFT'}
    assert rows['AAPL']['quantity'] == 0.0
    assert rows['AAPL']['realised'] == 180.0
    assert rows['MSFT']['price'] is None
    assert rows['MSFT']['converted'] is None


def test_a_quote_with_no_rate_keeps_its_price_and_loses_its_conversion(tmp_path):
    """*Waiting for a rate* and *no price at all* are two rows, not one.

    The first keeps the quote the reader's broker shows them and has no figure
    in the reporting currency; the second is carried at its cost (ADR-0004).
    """
    def seed(opened):
        seed_position(opened, account='pea')
        seed_quote(opened, price=200.0, currency='USD', converted=None,
                   rate=None)

    payload = build_client(tmp_path, seed=seed).get('/api/positions').get_json()
    row = payload['positions'][0]

    assert row['price']['value'] == 200.0
    assert row['price']['currency'] == 'USD'
    assert row['converted'] is None


def test_positions_on_a_fresh_install_is_200_and_an_empty_list(tmp_path):
    """The first of the three absences, envelope included."""
    response = build_client(tmp_path).get('/api/positions')

    assert response.status_code == 200
    assert response.get_json() == {'base_currency': None, 'positions': []}


def test_positions_storage_failure_is_503_and_never_an_empty_list(tmp_path):
    """The third absence, and the one that must not look like the first."""
    response = build_client(tmp_path, break_store=True).get('/api/positions')

    assert response.status_code == 503
    assert response.mimetype == 'application/problem+json'
    assert response.get_json()['type'] == '/problems/storage-unavailable'


def test_portfolio_totals_serves_the_eleven_members(tmp_path):
    """Eight columns and three derivations, under the names #745 froze."""
    payload = build_client(
        tmp_path, seed=seed_totals).get('/api/portfolio-totals').get_json()

    assert set(payload) == {'base_currency', 'totals'}
    assert set(payload['totals']) == {
        'day', 'total_value', 'holdings_value', 'cash_balance',
        'net_contributed', 'xirr', 'twr_index', 'twr_since', 'transfer_fees',
        'gain_absolu', 'ytd'}
    assert payload['totals']['day'] == '2026-08-05'
    assert payload['totals']['total_value'] == 12500.0
    # The index counts from the first day of the series, and there is one here.
    assert payload['totals']['twr_since'] == '2026-08-05'
    # An install whose broker moves money for free: a figure worth nothing, not
    # an absence — the page drops it for being zero.
    assert payload['totals']['transfer_fees'] == 0.0


def test_portfolio_totals_with_no_figures_at_all_is_200_and_null(tmp_path):
    """`totals: null`, never a `404` and never `[]`.

    Two causes and one shape: no ledger, or no reporting currency answered.
    """
    response = build_client(tmp_path).get('/api/portfolio-totals')

    assert response.status_code == 200
    assert response.get_json() == {'base_currency': None, 'totals': None}


def test_the_head_keeps_its_positions_while_the_currency_is_unanswered(tmp_path):
    """The direct benefit of ADR-0018, proved across the two resources.

    The perf job writes nothing at all until the reporting currency is answered,
    so `portfolio_totals` is empty — and three of the four terms of the gain are
    read off `/api/positions`, which is under no such constraint. A field absent
    for the global row can no longer blank the headline.
    """
    client = build_client(tmp_path, accounts=ACCOUNTS_FILE,
                          events=ACCOUNTS_EVENTS)

    positions = client.get('/api/positions').get_json()
    totals = client.get('/api/portfolio-totals').get_json()

    assert positions['base_currency'] is None
    assert [row['symbol'] for row in positions['positions']] == ['AAPL']
    assert totals['totals'] is None


def test_transfer_fees_are_negative_as_they_enter_the_sum(tmp_path):
    """ADR-0018's fourth term, signed where it is produced (issue #763).

    Naming it as a cost and subtracting it at the point of use is one inversion
    too many for a figure whose entire interest is that the four terms add up.
    And a `BUY`'s fee is **not** in it: that one is absorbed into the cost basis
    (ADR-0003) and would otherwise be counted twice.
    """
    client = build_client(tmp_path, accounts=ACCOUNTS_FILE, events=FEE_EVENTS,
                          seed=seed_totals)

    payload = client.get('/api/portfolio-totals').get_json()

    assert payload['totals']['transfer_fees'] == pytest.approx(-2.25)


def test_the_year_to_date_pins_a_positive_gain_against_a_negative_twr(tmp_path):
    """The configuration the pair exists to make readable, to the cent.

    `+40,69 €` of gain against `−1,25 %` of time-weighted return over the same
    period: opposite signs, both correct, because the portfolio grew by 6 673 €
    of deposits while its holdings lost 1,25 %. Subtracting the movement of
    contributions is what makes the first figure a performance rather than a
    receipt for a deposit — without that second term the gain would read
    `+6 713,69 €`, which is the misreading the couple exists to prevent.
    """
    def seed(opened):
        # The close of the previous exercise — the base the delta counts from.
        seed_totals(opened, day=date(2025, 12, 31), total_value=10000.00,
                    net_contributed=5000.00, twr_index=160.00)
        seed_totals(opened, day=date(2026, 3, 2), total_value=16713.69,
                    net_contributed=11673.00, twr_index=158.00)

    payload = build_client(
        tmp_path, seed=seed).get('/api/portfolio-totals').get_json()

    assert payload['totals']['day'] == '2026-03-02'
    assert payload['totals']['twr_since'] == '2025-12-31'
    assert payload['totals']['ytd']['gain'] == pytest.approx(40.69, abs=1e-9)
    assert payload['totals']['ytd']['twr'] == pytest.approx(-0.0125, abs=1e-9)


def test_the_year_to_date_base_is_the_close_of_the_previous_year(tmp_path):
    """The bound this ticket had to choose, and the day of market it turns on.

    *The first day on or after 1 January* would take 2026-01-02 as the base and
    leave that day's own move out of both figures; *the last day at or before
    31 December* is a state the measured year has not touched. The series being
    dense over calendar days (#707), both rows exist — so the choice cannot be
    settled by which one is there.
    """
    def seed(opened):
        seed_totals(opened, day=date(2025, 12, 31), total_value=10000.00,
                    net_contributed=5000.00, twr_index=160.00)
        seed_totals(opened, day=date(2026, 1, 2), total_value=12000.00,
                    net_contributed=5000.00, twr_index=176.00)
        seed_totals(opened, day=date(2026, 3, 2), total_value=16713.69,
                    net_contributed=11673.00, twr_index=158.00)

    ytd = build_client(
        tmp_path, seed=seed).get('/api/portfolio-totals').get_json()[
            'totals']['ytd']

    assert ytd['gain'] == pytest.approx(40.69, abs=1e-9)
    assert ytd['twr'] == pytest.approx(-0.0125, abs=1e-9)


def test_the_year_to_date_is_null_only_while_the_series_misses_its_base(tmp_path):
    """The **one** state the reconstruction degrades — never a failed sum."""
    payload = build_client(
        tmp_path,
        seed=lambda opened: seed_totals(opened, day=date(2026, 3, 2)),
    ).get('/api/portfolio-totals').get_json()

    assert payload['totals']['ytd'] is None
    # And everything above it is exact from the first cycle, which is what makes
    # the head *normal* during the twenty-five minutes of a reconstruction.
    assert payload['totals']['total_value'] == 12500.0


def test_a_base_before_the_thirty_first_still_counts(tmp_path):
    """*At or before* 31 December, not *on* it.

    An install whose series stops on the 29th has closed its year there. Asking
    for the 31st exactly would report *the series does not reach the base* about
    a series that plainly does.
    """
    def seed(opened):
        seed_totals(opened, day=date(2025, 12, 29), total_value=10000.00,
                    net_contributed=5000.00, twr_index=160.00)
        seed_totals(opened, day=date(2026, 3, 2), total_value=16713.69,
                    net_contributed=11673.00, twr_index=158.00)

    ytd = build_client(
        tmp_path, seed=seed).get('/api/portfolio-totals').get_json()[
            'totals']['ytd']

    assert ytd['gain'] == pytest.approx(40.69, abs=1e-9)


def test_portfolio_totals_storage_failure_is_503_problem_json(tmp_path):
    """A query error **propagates**; it is never rescued into an empty answer."""
    response = build_client(
        tmp_path, break_store=True).get('/api/portfolio-totals')

    assert response.status_code == 503
    assert response.mimetype == 'application/problem+json'
    assert 'portfolio_totals' in response.get_json()['detail']


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
    """Reading the declaration rather than a DISTINCT on the tag (#652 déc. 4)
    hands over label and type — fields the app writes and zero Grafana panels
    read — plus, since #698, where the row came from."""
    accounts = (
        "id,type,label\n"
        "pea,PEA,PEA Bourso\n"
    )
    events = (
        "date,event_type,symbol,name,quantity,unit_price,account\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,pea\n"
    )
    client = build_client(tmp_path, accounts=accounts, events=events)
    payload = client.get('/api/accounts').get_json()

    assert payload['declared'] is True
    row = payload['accounts'][0]
    assert (row['id'], row['label'], row['type']) == ('pea', 'PEA Bourso', 'PEA')
    # It came from a file, so the page must not offer to edit it: the gesture
    # on a file-provisioned row is forgetting its import (issue #698).
    assert row['source_id'] is not None
    assert row['editable'] is False
    # #661 enriched the resource with the newest perf figures. With nothing
    # written yet they are all null and `as_of` says so — a declared account
    # whose first perf cycle has not run is a row with em dashes, not a missing
    # line.
    assert row['as_of'] is None
    assert row['total_value'] is None
    assert row['xirr'] is None


def test_accounts_carries_the_newest_figures_of_each_account(tmp_path):
    """The enrichment #661 added: one resource, two consumers.

    `total_value` in particular is written since v4.1 and displayed nowhere —
    the ticket's smallest item and the table's first column.
    """
    client = build_client(tmp_path, seed=seed_account_metrics,
                          accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)
    row = client.get('/api/accounts').get_json()['accounts'][0]

    assert row['total_value'] == 12500.0
    assert row['gain_absolu'] == 2500.0
    assert row['twr_index'] == 118.4
    assert row['as_of'] == '2026-08-05'
    # The declaration drives the identity fields, and since #700 it is the only
    # thing that could: `account_type` and `account_currency` were InfluxDB
    # tags, and the store has no column for either.
    assert row['type'] == 'PEA'


def test_accounts_keeps_a_declared_account_that_has_no_series_yet(tmp_path):
    """A declared account whose perf cycle has not run is a row of em dashes.

    Not a missing line: the declaration drives the list (#652 déc. 4), so
    absence of data cannot remove an account the human declared.
    """
    accounts = ACCOUNTS_FILE + "cto,CTO,CTO Degiro\n"
    client = build_client(tmp_path, seed=seed_account_metrics,
                          accounts=accounts, events=ACCOUNTS_EVENTS)
    payload = client.get('/api/accounts').get_json()

    # Store order, which is `ORDER BY id` — stable across restarts and across a
    # re-drop, where the file's own order was neither.
    assert [a['id'] for a in payload['accounts']] == ['cto', 'pea']
    assert payload['accounts'][0]['as_of'] is None
    assert payload['accounts'][0]['total_value'] is None


def test_accounts_drops_a_series_left_by_an_undeclared_account(tmp_path):
    """Historical residue is not a row. The declaration is the list."""
    def seed(opened):
        seed_account_metrics(opened, account='pea')
        seed_account_metrics(opened, account='old', total_value=999.0)

    client = build_client(tmp_path, seed=seed, accounts=ACCOUNTS_FILE,
                          events=ACCOUNTS_EVENTS)
    payload = client.get('/api/accounts').get_json()

    assert [a['id'] for a in payload['accounts']] == ['pea']


# --------------------------------------------------------------------- #
# One account's history — the empty / absent / failed triad (#661)
# --------------------------------------------------------------------- #

def test_account_history_is_200_and_empty_before_the_first_point(tmp_path):
    """Declared, no series yet: the empty-collection state, not an error."""
    client = build_client(tmp_path, accounts=ACCOUNTS_FILE,
                          events=ACCOUNTS_EVENTS)
    response = client.get('/api/accounts/pea/history')

    assert response.status_code == 200
    payload = response.get_json()
    assert payload['account'] == 'pea'
    assert payload['points'] == []


def test_account_history_returns_the_series_with_its_nulls_intact(tmp_path):
    """Trap 3 on a series: `xirr`/`twr_index` are absent, never zero."""
    def seed(opened):
        seed_account_metrics(opened, day=date(2026, 8, 4), total_value=11500.0,
                             holdings_value=11000.0, twr_index=None, xirr=None,
                             gain_absolu=None)
        seed_account_metrics(opened, day=date(2026, 8, 5))

    client = build_client(tmp_path, seed=seed, accounts=ACCOUNTS_FILE,
                          events=ACCOUNTS_EVENTS)
    points = client.get('/api/accounts/pea/history').get_json()['points']

    assert [p['twr_index'] for p in points] == [None, 118.4]
    assert points[1]['total_value'] == 12500.0


def test_an_undeclared_account_history_is_404_problem_json(tmp_path):
    """Decided against the declaration, not against the data: a typo must not
    answer with an empty chart."""
    client = build_client(tmp_path, accounts=ACCOUNTS_FILE,
                          events=ACCOUNTS_EVENTS)
    response = client.get('/api/accounts/nope/history')

    assert response.status_code == 404
    assert response.mimetype == 'application/problem+json'
    assert response.get_json()['type'] == '/problems/not-found'


def test_account_history_without_any_declaration_is_404(tmp_path):
    """No `accounts:` block at all — every id is unknown."""
    response = build_client(tmp_path).get('/api/accounts/pea/history')

    assert response.status_code == 404


def test_account_history_storage_failure_is_503_problem_json(tmp_path):
    client = build_client(tmp_path, break_store=True,
                          accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)
    response = client.get('/api/accounts/pea/history')

    assert response.status_code == 503
    assert response.mimetype == 'application/problem+json'
    assert 'account_metrics' in response.get_json()['detail']


def test_account_history_rejects_an_inverted_window(tmp_path):
    client = build_client(tmp_path, accounts=ACCOUNTS_FILE,
                          events=ACCOUNTS_EVENTS)
    response = client.get(
        '/api/accounts/pea/history?from=2026-06-01&to=2026-01-01')

    assert response.status_code == 400
    assert response.get_json()['type'] == '/problems/bad-request'


# --------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------- #

def test_an_empty_ledger_is_an_empty_list_not_an_error(tmp_path):
    """A fresh install whose events/ folder is still empty owns nothing yet."""
    response = build_client(tmp_path).get('/api/events')

    assert response.status_code == 200
    assert response.get_json() == []


def test_events_are_returned_without_an_address(tmp_path):
    """#662's opaque id and etag left with the editor (#711).

    They existed because **the file was the address**; nothing here addresses a
    row any more, and no successor was put in their place. The rows are the ones
    the aggregator ran on, in the order it sorted them.
    """
    events = (
        "date,event_type,symbol,name,quantity,unit_price,amount\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,\n"
        "2024-03-01,DIVIDEND,AAPL,Apple Inc,,,8.50\n"
        "2024-02-01,BUY,MSFT,Microsoft,5,380.00,\n"
    )
    payload = build_client(tmp_path, events=events).get('/api/events').get_json()

    assert [row['date'] for row in payload] == [
        '2024-01-15', '2024-02-01', '2024-03-01']
    assert all(not {'etag', 'file'} & set(row) for row in payload)
    assert payload[0]['event_type'] == 'BUY'
    assert payload[2]['amount'] == 8.50


def test_an_event_carries_its_provenance_all_the_way_to_the_wire(tmp_path):
    """"row 14 of 2024.csv" reaches the client (issue #697, user story n°13).

    The triplet is a **display**, so what the API owes is the rendered sentence
    as well as the three columns behind it: a client grouping by import needs
    ``source_id``, and a client showing a user where to go and fix a line needs
    the label. Neither is an address — the row has a primary key now.
    """
    events = (
        "date,event_type,symbol,name,quantity,unit_price,amount\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,\n"
        "2024-02-01,BUY,MSFT,Microsoft,5,380.00,\n"
    )
    payload = build_client(tmp_path, events=events).get('/api/events').get_json()

    # Row 2 is the first data row: row 1 is the header, and the number shown
    # has to be the one the user's editor shows them.
    assert [row['source_row'] for row in payload] == [2, 3]
    assert [row['source_sheet'] for row in payload] == [None, None]
    assert [row['provenance'] for row in payload] == [
        '2024.csv, row 2', '2024.csv, row 3']
    # One file, so one source id, and it is the same on both rows.
    assert len({row['source_id'] for row in payload}) == 1


def test_events_can_be_narrowed_to_one_symbol_for_the_chart_markers(tmp_path):
    events = (
        "date,event_type,symbol,name,quantity,unit_price,amount\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,\n"
        "2024-02-01,BUY,MSFT,Microsoft,5,380.00,\n"
    )
    client = build_client(tmp_path, events=events)
    payload = client.get('/api/events?symbol=AAPL').get_json()

    assert [row['symbol'] for row in payload] == ['AAPL']


# --------------------------------------------------------------------- #
# Export (issue #710)
# --------------------------------------------------------------------- #

_EXPORTABLE = (
    "date,event_type,account,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-15,BUY,pea,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
    "2024-03-01,DIVIDEND,pea,AAPL,Apple Inc,,,,8.50,\n"
)

_EXPORTABLE_ACCOUNTS = "id,type,label\npea,PEA,PEA Boursorama\n"


def test_the_export_is_reachable_over_http(tmp_path):
    """The gesture is on the API, so a headless install has it too.

    *Headless means without an interface, not without HTTP* — the same argument
    that keeps ``PUT /api/settings`` a route. One ``curl`` is a complete backup.
    """
    client, opened = build_client_and_store(
        tmp_path, accounts=_EXPORTABLE_ACCOUNTS, events=_EXPORTABLE,
        seed=lambda opened: opened.execute(
            "INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR')"))

    response = client.get('/api/export/events.csv')

    assert response.status_code == 200
    assert response.headers['Content-Type'] == 'text/csv; charset=utf-8'
    assert 'attachment' in response.headers['Content-Disposition']
    body = response.get_data(as_text=True)
    assert body.splitlines()[0].split(',') == list(events_export.EVENT_COLUMNS)
    # The reporting currency rides on every row, or a round trip reinterprets
    # every amount in the file.
    assert body.count(',EUR\n') == 2
    opened.close()


def test_the_accounts_export_serves_the_declaration(tmp_path):
    """The other half of a round trip that is round for a multi-account install."""
    client, opened = build_client_and_store(
        tmp_path, accounts=_EXPORTABLE_ACCOUNTS, events=_EXPORTABLE)

    body = client.get('/api/export/accounts.csv').get_data(as_text=True)

    assert body == "id,type,label\npea,PEA,PEA Boursorama\n"
    opened.close()


def test_an_install_that_declared_nothing_exports_a_header_only(tmp_path):
    """The seeded ``default`` is not a declaration and does not leave (ADR-0013)."""
    client, opened = build_client_and_store(tmp_path)

    body = client.get('/api/export/accounts.csv').get_data(as_text=True)

    assert body == "id,type,label\n"
    opened.close()


def test_an_empty_ledger_exports_the_header_and_no_row(tmp_path):
    """Emptiness is a state, not an error: the file is valid and carries nothing."""
    client, opened = build_client_and_store(tmp_path)

    body = client.get('/api/export/events.csv').get_data(as_text=True)

    assert body == ','.join(events_export.EVENT_COLUMNS) + '\n'
    opened.close()


def test_an_unreadable_store_fails_the_export_rather_than_emptying_it(tmp_path):
    """A backup that silently comes back empty is worse than one that fails.

    Same contract as every other route in this blueprint: a query error
    propagates and becomes a ``503``, never an empty collection.
    """
    client, opened = build_client_and_store(tmp_path, events=_EXPORTABLE)
    opened.execute('DROP TABLE event')

    response = client.get('/api/export/events.csv')

    assert response.status_code == 503
    opened.close()


# --------------------------------------------------------------------- #
# The catch-all
# --------------------------------------------------------------------- #
#
# The bundle's location is resolved from the package and reads no environment
# variable since #740 — the environment says six things and this was never one
# of them. The seam is therefore the resolver itself rather than
# ``SB_STATIC_DIR``, which is what a test seam should have been all along: the
# variable existed for an operator who does not exist.

def _serve_bundle_from(monkeypatch, directory):
    """Point the SPA resolver at ``directory`` for the duration of a test."""
    monkeypatch.setattr(web_module, '_static_dir', lambda: directory)


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
    _serve_bundle_from(monkeypatch, bundle)

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
    _serve_bundle_from(monkeypatch, tmp_path / 'no-bundle-here')
    response = build_client(tmp_path).get('/')

    assert response.status_code == 404
    assert 'API' in response.get_json()['detail']


def test_the_spa_is_served_for_an_unknown_client_route(tmp_path, monkeypatch):
    bundle = tmp_path / 'bundle'
    bundle.mkdir()
    (bundle / 'index.html').write_text('<!doctype html><div id=root>', encoding='utf-8')
    _serve_bundle_from(monkeypatch, bundle)

    response = build_client(tmp_path).get('/titres/AAPL')

    assert response.status_code == 200
    assert b'id=root' in response.data


def test_the_window_bounds_the_series_it_says_it_does(tmp_path):
    """The whole ``utc_z`` / ``escape_literal`` apparatus left with #700.

    v4 formatted a bound into the SQL string because InfluxDB 3's client took
    one, and getting it wrong was a class of defect on its own: ``isoformat()``
    alone yields ``+00:00Z`` for an aware datetime, which InfluxDB rejected
    outright. DuckDB **binds**, so the trap has no expression left and what is
    worth asserting is the only thing a reader cares about — the window keeps
    what it says and drops the rest.
    """
    def seed(opened):
        for day in (14, 15, 17):
            seed_quote(opened, price=100.0 + day,
                       at=datetime(2024, 1, day, 12, 0, tzinfo=timezone.utc))

    client = build_client(tmp_path, seed=seed)
    body = client.get(
        '/api/shares/AAPL/prices'
        '?from=2024-01-15T09:30:00Z&to=2024-01-16T17:00:00Z').get_json()

    assert [point['t'] for point in body['points']] == [
        '2024-01-15T12:00:00+00:00']


def test_a_naive_instant_is_read_as_utc_not_local_time(tmp_path):
    """A bare date from the front must not shift by the server's timezone."""
    def seed(opened):
        seed_quote(opened, price=100.0,
                   at=datetime(2024, 1, 15, 0, 0, tzinfo=timezone.utc))

    client = build_client(tmp_path, seed=seed)
    body = client.get(
        '/api/shares/AAPL/prices?from=2024-01-15&to=2024-01-16').get_json()

    # Midnight UTC exactly: an hour either way is a server-local reading, and it
    # would drop this point on any machine east of Greenwich.
    assert [point['t'] for point in body['points']] == [
        '2024-01-15T00:00:00+00:00']


# --------------------------------------------------------------------------- #
# The configuration resource
# --------------------------------------------------------------------------- #
#
# #662's write path — the row edit, the opaque token, the ETag, the 409, and
# `PUT /api/accounts` — is gone with `config_writer.py` and `events/editor.py`
# (#711), and so are the six problem types that only it raised. What is left of
# this resource is a read and the one toggle that was never a file.

LEDGER_CSV = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes,account\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase,\n"
)


def ledger_client(tmp_path):
    return build_client(tmp_path, events=LEDGER_CSV)


def test_a_malformed_body_is_400_not_503(tmp_path):
    """The blueprint's catch-all renders every exception as a storage 503.

    Flask's own `get_json` raises on a bad body, so without `silent=True` a
    client that sent broken JSON would be told the database is down.
    """
    response = ledger_client(tmp_path).put(
        '/api/config/log-level', data='{not json',
        content_type='application/json')

    assert response.status_code == 400


def test_the_config_route_carries_the_declared_portfolio(tmp_path):
    """What the ledger *declares*, as opposed to what has been observed of it.

    No `mode`, no `editable`, no `read_only_reason`: there is one loading path
    and no write path left for either to be about.
    """
    body = ledger_client(tmp_path).get('/api/config').get_json()

    assert body['shares'][0]['symbol'] == 'AAPL'
    assert 'mode' not in body
    assert 'editable' not in body
    assert 'read_only_reason' not in body


def test_the_log_level_toggle_answers_with_what_it_set(tmp_path):
    client = ledger_client(tmp_path)
    try:
        assert client.put('/api/config/log-level',
                          json={'level': 'debug'}).get_json() == {'log_level': 'DEBUG'}
        assert client.put('/api/config/log-level',
                          json={'level': 'nope'}).status_code == 400
    finally:
        main.set_log_level('INFO')


def test_the_event_write_routes_are_gone_rather_than_refusing(tmp_path):
    """Demolition, not a stub: the methods do not exist on the collection.

    A route answering 403/409 would keep the gesture alive in the front and in
    the contract. #711 removes it, and the front loses its editing gestures —
    a known, accepted consequence.
    """
    client = ledger_client(tmp_path)

    assert client.post('/api/events', json={'date': '2024-06-01'}).status_code == 405
    assert client.patch('/api/events/anything', json={}).status_code == 405
    assert client.delete('/api/events/anything').status_code == 405
    assert client.get('/api/events/files').status_code == 404
    assert client.put('/api/accounts', json={'accounts': []}).status_code == 405


# --------------------------------------------------------------------------- #
# The app's own runtime state (issue #668, design #656)
#
# One case here is specific to this resource and is the reason it exists: it
# must answer 200 while the store is unreadable. That is decision 6's whole
# point, and it is the one thing a test can prove that looking cannot — on a
# healthy stack the two designs are indistinguishable.
# --------------------------------------------------------------------------- #

def test_the_runtime_resource_answers_200_with_the_store_unreadable(tmp_path):
    """#656 decision 6, and the reason #659's `status` slot was retired.

    `/api/shares` is a query and this blueprint answers 503 when one fails, so a
    pill riding on that payload would **disappear exactly when it is the only
    thing able to explain the empty table** — #655's error contract turned
    against itself one storey up, and worse than the original, because the
    diagnostic dies with what it diagnoses.
    """
    client = build_client(
        tmp_path, break_store=True,
        accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)

    # The table is dead...
    assert client.get('/api/shares').status_code == 503
    # ...and the thing that explains why is not.
    response = client.get('/api/runtime')

    assert response.status_code == 200
    assert response.get_json()['symbols'][0]['symbol'] == 'AAPL'


def test_the_runtime_says_whether_the_reconstruction_still_has_windows(tmp_path):
    """`rebuilding` (contract #745, issue #763), read from process memory.

    It is on the app-state resource and not beside the figures because it is a
    fact about *this process*, and what it decides on screen is one thing: the
    time-weighted return carries its base date **only while that date is still
    moving**. It says nothing about the year-to-date, which becomes computable
    long before the reconstruction concludes and has its own carrier.
    """
    client, _ = build_client_and_store(
        tmp_path, accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)
    runtime = web_module.current_runtime()

    # Nothing to reconstruct is an observation, and it is not a rebuild.
    runtime.metrics.reconstruction = (0, 0)
    assert client.get('/api/runtime').get_json()['rebuilding'] is False

    runtime.metrics.reconstruction = (1, 2)
    assert client.get('/api/runtime').get_json()['rebuilding'] is True

    runtime.metrics.reconstruction = (2, 2)
    assert client.get('/api/runtime').get_json()['rebuilding'] is False


def test_a_runtime_with_no_scheduler_does_not_claim_a_rebuild(tmp_path):
    """A process that cannot see the scheduler asserts nothing about it.

    A boolean has no room for #709's third answer, and `false` is the safe
    reading: what the member enables is the *claim* that a date is still moving.
    """
    client = build_client(tmp_path, with_scheduler=False,
                          accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)

    assert client.get('/api/runtime').get_json()['rebuilding'] is False


def test_the_runtime_resource_issues_no_query_at_all(tmp_path, mocker):
    """Not merely tolerant of a dead store — it never asks it anything.

    Decision 4 makes that free: the backfill job already *reads* the oldest
    stored point, so it *remembers* it, and the progress bar survives an
    unreadable store rather than merely degrading politely.
    """
    client, opened = build_client_and_store(
        tmp_path, accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)
    queried = mocker.spy(opened, 'query')
    arrow = mocker.spy(opened, 'arrow')

    assert client.get('/api/runtime').status_code == 200

    assert queried.call_count == 0
    assert arrow.call_count == 0


def test_a_never_scraped_symbol_is_a_row_rather_than_a_missing_line(tmp_path):
    """The row set comes from the configuration snapshot (#656 déc. 3).

    Driving it from the recorder would race the scrape threads *and* drop this
    row; driving it from the declaration gives the honest answer for free — the
    position exists, nothing has been observed about it yet.
    """
    client = build_client(
        tmp_path, accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)

    body = client.get('/api/runtime').get_json()

    assert [s['symbol'] for s in body['symbols']] == ['AAPL']
    assert body['symbols'][0]['pill'] == 'unknown'
    # The accounts are a plain list of names since #700: nothing per-account is
    # measured about a series that has no account dimension.
    assert body['symbols'][0]['accounts'] == ['pea']


def test_a_sold_line_publishes_its_backward_progress_and_says_it_is_not_polled(
        tmp_path):
    """The reconstruction the owner is waiting for is the sold one (issue #703).

    The backfill is driven by the replay now, so a closed position has a
    backward pass of its own. Its row was filtered out of this payload while the
    two sets were one; leaving it out today hides the only progress there is to
    show — and the banner's bar would count 1 series out of 1 with a second one
    still walking back through five years.
    """
    events = ACCOUNTS_EVENTS + "2025-02-03,SELL,AAPL,Apple Inc,10,180.00,pea\n"
    client, _ = build_client_and_store(
        tmp_path, accounts=ACCOUNTS_FILE, events=events)
    runtime = web_module.current_runtime()
    runtime.recorder.record_backfill(runtime_state.BackfillRecord(
        symbol='AAPL', direction=runtime_state.BACKWARD,
        at=datetime(2026, 8, 5, 15, 0, tzinfo=timezone.utc),
        target=datetime(2024, 1, 15, tzinfo=timezone.utc),
        oldest=datetime(2024, 6, 1, tzinfo=timezone.utc), written=42))

    body = client.get('/api/runtime').get_json()
    row = body['symbols'][0]

    assert row['symbol'] == 'AAPL'
    assert row['held'] is False
    assert row['next_run_state'] == 'not_held'
    assert row['backward']['written'] == 42
    assert body['backfill']['in_scope'] == 1


def test_a_published_record_reaches_the_payload_with_its_pill(tmp_path):
    client, _ = build_client_and_store(
        tmp_path, accounts=ACCOUNTS_FILE, events=ACCOUNTS_EVENTS)
    runtime = web_module.current_runtime()
    runtime.recorder.record_scrape(runtime_state.ScrapeRecord(
        symbol='AAPL', at=datetime(2026, 8, 5, 15, 0, tzinfo=timezone.utc),
        market_state='CLOSED', closed=True, price_present=True,
        verdict=runtime_state.SCRAPE_CLOSED, failure_count=0,
        next_delay=3600.0))

    body = client.get('/api/runtime').get_json()

    assert body['symbols'][0]['pill'] == 'closed'
    assert body['symbols'][0]['market_state'] == 'CLOSED'
    assert body['symbols'][0]['last_pass'] == '2026-08-05T15:00:00+00:00'
    # No scheduler in a test process, and that is not trap 1's ambiguity.
    assert body['symbols'][0]['next_run_state'] == 'unavailable'


def test_the_shares_payload_no_longer_carries_the_retired_status_slot(tmp_path):
    """#659 reserved it; #656 decision 6 retired it rather than filling it."""
    def seed(opened):
        seed_position(opened)
        seed_quote(opened)

    body = build_client(tmp_path, seed=seed).get('/api/shares').get_json()

    assert 'status' not in body[0]


def _dials(client):
    """The dials `/api/config` publishes, by key.

    By key and never by position: the registry's order is not a contract, and a
    test that indexes `[0]` starts asserting about a different dial the day one
    is inserted above it — silently, and still green.
    """
    return {row['key']: row for row in client.get('/api/config').get_json()['settings']}


def test_the_config_route_carries_what_the_process_had_to_know_first(
        tmp_path, monkeypatch):
    """#654's one survivor, on `/api/config` rather than `/api/runtime`.

    #661's argument: one noun, two consumers. "What is this container running?"
    is a question about the configuration, and the data page is already the
    screen that asks it — while putting it on the runtime resource would start
    that resource down the road to a junk drawer.

    What is left in the list is ADR-0014's line: what the process must know
    **before** it can open the store. The three ``INFLUXDB_*`` names left with
    the database (#700) and are reported as set-and-unread instead, which is
    what stops an operator concluding their token is wrong.
    """
    monkeypatch.setenv('INFLUXDB_TOKEN', 'apiv3_supersecret')
    client = build_client(tmp_path)

    body = client.get('/api/config').get_json()
    env = {s['name']: s for s in body['environment']}

    assert 'INFLUXDB_TOKEN' not in env
    assert 'INFLUXDB_TOKEN' in body['unread_environment']
    assert env['SB_STORE_DIR']['value'] is not None
    # Compose-only variables are not app settings (#654 trap 13).
    assert 'SB_VERSION' not in env


def test_the_config_route_lists_the_dials_through_the_registry(tmp_path):
    """#701: the content of ``setting``, and not a second enumeration of it.

    The bounds ride along, so the form validates on the rule the write path
    enforces rather than on a copy of it — and a dial added to the registry
    appears here with no route to edit.
    """
    body = build_client(tmp_path).get('/api/config').get_json()

    dials = {row['key']: row for row in body['settings']}

    assert list(dials) == [spec.key for spec in settings_registry.SETTINGS]
    assert dials['regular_interval']['value'] == 120
    assert dials['regular_interval']['minimum'] == 10
    assert dials['regular_interval']['effect'] == settings_registry.REARM_SCRAPE
    # A dial has no environment form at all, not even a reported one.
    assert 'SB_REGULAR_INTERVAL' not in {
        row['name'] for row in body['environment']}


def test_the_config_route_names_what_is_set_and_no_longer_read(
        tmp_path, monkeypatch):
    """ADR-0014's gesture, published where the page that explains it can show it."""
    monkeypatch.setenv('SB_REGULAR_INTERVAL', '600')

    body = build_client(tmp_path).get('/api/config').get_json()

    assert 'SB_REGULAR_INTERVAL' in body['unread_environment']


# --------------------------------------------------------------------- #
# PUT /api/settings — the only writer of a dial (issue #701)
# --------------------------------------------------------------------- #

def test_a_dial_is_written_and_read_back_in_the_same_request(tmp_path):
    """Reachable with one ``curl``: headless means without an interface, not
    without HTTP."""
    client = build_client(tmp_path)

    response = client.put('/api/settings', json={'regular_interval': 600})

    assert response.status_code == 200
    body = response.get_json()
    assert body['changed'] == ['regular_interval']
    dials = {row['key']: row for row in body['settings']}
    assert dials['regular_interval']['value'] == 600
    assert _dials(client)['regular_interval']['value'] == 600


def test_saving_a_dial_takes_effect_with_no_restart(tmp_path):
    """The attribute every cycle re-reads is assigned by the write path itself."""
    client = build_client(tmp_path)

    client.put('/api/settings', json={'backfill_chunk_days': 90})

    assert web_module.current_runtime().metrics.backfill_chunk_days == 90


def test_the_answer_quantifies_what_the_change_reached(tmp_path):
    """"3 symbols now, 8 more when their market opens" — never a bare 200.

    A portfolio-wide dial that reaches three symbols out of eleven has to say
    so, or the reader concludes the other eight are misconfigured.
    """
    client = build_client(tmp_path)

    body = client.put(
        '/api/settings', json={'regular_interval': 600}).get_json()

    assert body['effect']['symbols_rescheduled'] == 3
    assert body['effect']['symbols_at_market_open'] == 8
    assert web_module.current_runtime().metrics.rearm_calls == 1


def test_a_value_out_of_bounds_is_a_422_and_writes_nothing(tmp_path):
    """Well formed, and the content is what cannot be processed.

    ``400`` would read as "fix your encoding", and a client that retried on that
    reading would retry forever.
    """
    client = build_client(tmp_path)

    response = client.put('/api/settings', json={'regular_interval': 0})

    assert response.status_code == 422
    assert response.mimetype == 'application/problem+json'
    # The field is named, so a form marks the input rather than the page.
    assert response.get_json()['key'] == 'regular_interval'
    assert _dials(client)['regular_interval']['value'] == 120


def test_an_unknown_dial_is_a_422_rather_than_a_new_dial(tmp_path):
    response = build_client(tmp_path).put('/api/settings', json={'colour': 'blue'})

    assert response.status_code == 422


def test_a_rejected_body_writes_none_of_its_valid_keys(tmp_path):
    """A half-applied ``PUT`` is a state nobody asked for."""
    client = build_client(tmp_path)

    client.put('/api/settings',
               json={'regular_interval': 600, 'backfill_delay': -1})

    assert _dials(client)['regular_interval']['value'] == 120


def test_a_body_that_is_not_an_object_is_a_400(tmp_path):
    """Malformed syntax, not a refused value — and never a 503 (#655)."""
    response = build_client(tmp_path).put('/api/settings', json=[1, 2])

    assert response.status_code == 400


def test_reposting_the_same_value_re_arms_nothing(tmp_path):
    """``reschedule_job`` recomputes ``next_run_time`` from now.

    A save button that rewrote every row would put every timer back to zero on
    every click — including the timers of the dials nobody touched.
    """
    client = build_client(tmp_path)

    body = client.put(
        '/api/settings', json={'regular_interval': 120}).get_json()

    assert body['changed'] == []
    assert body['effect']['symbols_rescheduled'] == 0
    assert web_module.current_runtime().metrics.rearm_calls == 0


# --------------------------------------------------------------------- #
# Imports: the unit of revocation (issue #697)
# --------------------------------------------------------------------- #

_ONE_BUY = (
    "date,event_type,symbol,name,quantity,unit_price,amount\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,\n"
)


def test_imports_are_listed_with_what_each_one_carried(tmp_path):
    """The count sits next to the gesture that would destroy it."""
    payload = build_client(tmp_path, events=_ONE_BUY).get('/api/imports').get_json()

    (record,) = payload
    assert record['filename'] == '2024.csv'
    assert record['kind'] == 'events'
    assert record['events'] == 1
    assert record['imported_at'] is not None
    assert record['fingerprint']


def test_an_install_that_imported_nothing_is_an_empty_collection(tmp_path):
    """``200`` + ``[]``, never a 404 and never a 503 (#695 user story 69)."""
    response = build_client(tmp_path).get('/api/imports')

    assert response.status_code == 200
    assert response.get_json() == []


def test_forgetting_an_import_revokes_it_in_bulk_and_replays(tmp_path):
    """The one destructive gesture, and the replay follows it synchronously.

    The user has just changed the ledger; they must not wait for a timer to see
    the effect of their own gesture, which is the 300-second wait #695's user
    story n°20 asks to be rid of.
    """
    client = build_client(tmp_path, events=_ONE_BUY)
    (record,) = client.get('/api/imports').get_json()

    response = client.delete(f"/api/imports/{record['id']}")

    assert response.status_code == 200
    assert response.get_json() == {'id': record['id'], 'events_removed': 1}
    # In bulk, and the replay already happened: the ledger the API serves and
    # the snapshot the shares come from are both empty, in the same request.
    assert client.get('/api/imports').get_json() == []
    assert client.get('/api/events').get_json() == []


def test_forgetting_an_unknown_import_is_a_404_not_a_503(tmp_path):
    """Asking to revoke something absent is a client error, not a broken store."""
    response = build_client(tmp_path, events=_ONE_BUY).delete('/api/imports/4242')

    assert response.status_code == 404


def test_forgetting_an_accounts_import_an_event_rests_on_is_a_409(tmp_path):
    """The cascade refusal, on the wire (issue #698).

    ``409`` and not ``400``: the request is well formed and the client did
    nothing wrong — the store's state is what refuses, and the answer says
    which gesture has to come first.
    """
    client = build_client(tmp_path, accounts=ACCOUNTS_FILE,
                          events=ACCOUNTS_EVENTS)
    declaring = next(r for r in client.get('/api/imports').get_json()
                     if r['kind'] == 'accounts')

    response = client.delete(f"/api/imports/{declaring['id']}")

    assert response.status_code == 409
    assert response.mimetype == 'application/problem+json'
    assert 'pea' in response.get_json()['detail']
    # Nothing was half-forgotten on the way to the refusal.
    assert len(client.get('/api/imports').get_json()) == 2
    assert len(client.get('/api/events').get_json()) == 1


# --------------------------------------------------------------------- #
# The advisories (issue #709)
# --------------------------------------------------------------------- #

def test_an_install_with_nothing_to_say_answers_an_empty_collection(tmp_path):
    """``200`` + ``[]``. Silence is the ordinary state, not a missing resource."""
    response = build_client(tmp_path).get('/api/advisories')

    assert response.status_code == 200
    assert response.get_json() == []


def test_an_advisory_is_listed_with_what_it_names(tmp_path):
    client, opened = build_client_and_store(tmp_path)
    (tmp_path / 'config.yaml').write_text('shares: []\n', encoding='utf-8')
    advisories.refresh(opened, advisories.Context(config_dir=tmp_path))

    (advisory,) = client.get('/api/advisories').get_json()

    assert advisory['key'] == advisories.LEGACY_CONFIG_FILE
    assert advisory['acknowledged'] is False
    assert advisory['acknowledged_at'] is None
    assert advisory['first_seen_at'] is not None
    # The detail is **re-derived** by the read: the table has three columns.
    assert advisory['detail']['path'] == str(tmp_path / 'config.yaml')
    assert 'config.yaml' in advisory['message']


def test_a_get_never_arms_an_advisory(tmp_path):
    """The observation belongs to the jobs, never to somebody opening a page.

    A ``GET`` that armed them would date every advisory with the moment a
    browser arrived — and log it there too.
    """
    client, opened = build_client_and_store(tmp_path)
    (tmp_path / 'config.yaml').write_text('shares: []\n', encoding='utf-8')

    assert client.get('/api/advisories').get_json() == []
    assert opened.query('SELECT count(*) FROM advisory')[0][0] == 0


def test_a_request_never_drops_what_a_running_scheduler_armed(tmp_path):
    """A runtime with no scheduler cannot see the reconstruction, and says so.

    ``UNOBSERVED`` rather than *finished*: the row stands, its detail is ``null``,
    and nothing is written — otherwise opening a page would take away the notice
    the backfill armed a minute earlier.

    *No scheduler* is a runtime with **no metrics object**, and that is the only
    shape it has: a metrics object always answers a pair, ``(0, 0)`` included,
    and ``(0, 0)`` is an observation that disarms rather than a silence.
    """
    client, opened = build_client_and_store(tmp_path, with_scheduler=False)
    advisories.refresh(opened, advisories.Context(reconstruction=(1, 3)))

    (advisory,) = client.get('/api/advisories').get_json()

    assert advisory['key'] == advisories.RECONSTRUCTION_RUNNING
    assert advisory['detail'] is None
    assert opened.query('SELECT count(*) FROM advisory')[0][0] == 1


def test_acknowledging_hides_it_and_the_acknowledgement_persists(tmp_path):
    client, opened = build_client_and_store(tmp_path)
    (tmp_path / 'config.yaml').write_text('shares: []\n', encoding='utf-8')
    advisories.refresh(opened, advisories.Context(config_dir=tmp_path))

    response = client.post(
        f'/api/advisories/{advisories.LEGACY_CONFIG_FILE}/acknowledgement')

    assert response.status_code == 200
    assert response.get_json()['acknowledged'] is True
    assert client.get('/api/advisories').get_json() == []
    # The row stays — that is what survives a restart, and what a toast cannot.
    assert opened.query(
        'SELECT acknowledged_at FROM advisory')[0][0] is not None


def test_acknowledging_an_unknown_advisory_is_a_404_not_a_503(tmp_path):
    response = build_client(tmp_path).post(
        '/api/advisories/no_such_notice/acknowledgement')

    assert response.status_code == 404
    assert response.mimetype == 'application/problem+json'


def test_acknowledging_one_that_is_not_standing_is_a_404(tmp_path):
    """The key is real and nothing stands under it: same answer to the client."""
    response = build_client(tmp_path).post(
        f'/api/advisories/{advisories.LEGACY_CONFIG_FILE}/acknowledgement')

    assert response.status_code == 404


# --------------------------------------------------------------------- #
# Declaring an account from the app (issue #698)
# --------------------------------------------------------------------- #

def test_an_account_can_be_declared_here_and_is_editable(tmp_path):
    """The UI's half of the declaration: ``source_id`` null, so it is editable."""
    client = build_client(tmp_path)

    created = client.post('/api/accounts',
                          json={'id': 'pea', 'type': 'PEA', 'label': 'PEA Bourso'})

    assert created.status_code == 201
    assert created.get_json() == {'id': 'pea', 'type': 'PEA',
                                  'label': 'PEA Bourso', 'source_id': None,
                                  'editable': True}
    # The replay followed the write: the declaration is already published.
    listed = client.get('/api/accounts').get_json()
    assert listed['declared'] is True
    assert [a['id'] for a in listed['accounts']] == ['pea']

    renamed = client.patch('/api/accounts/pea', json={'label': 'PEA Fortuneo'})
    assert renamed.get_json()['label'] == 'PEA Fortuneo'

    assert client.delete('/api/accounts/pea').status_code == 200
    assert client.get('/api/accounts').get_json()['declared'] is False


def test_declaring_an_id_twice_is_a_409(tmp_path):
    client = build_client(tmp_path)
    client.post('/api/accounts', json={'id': 'pea', 'type': 'PEA'})

    response = client.post('/api/accounts', json={'id': 'pea', 'type': 'CTO'})

    assert response.status_code == 409


def test_an_account_from_a_file_refuses_the_edit_and_the_delete(tmp_path):
    """Read-only means read-only: the gesture on it is forgetting its import."""
    client = build_client(tmp_path, accounts=ACCOUNTS_FILE)

    assert client.patch('/api/accounts/pea',
                        json={'label': 'Renamed'}).status_code == 409
    assert client.delete('/api/accounts/pea').status_code == 409


def test_deleting_an_account_an_event_names_is_a_409(tmp_path):
    """ADR-0013's construction, on the wire: no orphan historical residue."""
    client = build_client(tmp_path, events=ACCOUNTS_EVENTS,
                          accounts=ACCOUNTS_FILE)

    response = client.delete('/api/accounts/pea')

    assert response.status_code == 409
    assert 'event' in response.get_json()['detail']


def test_deleting_an_unknown_account_is_a_404(tmp_path):
    assert build_client(tmp_path).delete('/api/accounts/nope').status_code == 404


def test_no_route_edits_a_single_event(tmp_path):
    """Read-only forbids the pointwise edit; the absence is the decision.

    Without it a line provisioned by a file would be at once unalterable and
    indestructible — so the API offers revocation in bulk and nothing else, and
    that is asserted on the URL map rather than left to good intentions.
    """
    client = build_client(tmp_path, events=_ONE_BUY)
    rules = [
        (rule.rule, method)
        for rule in client.application.url_map.iter_rules()
        for method in (rule.methods or set())
        if method in {'PUT', 'PATCH', 'DELETE', 'POST'}
    ]

    assert not [r for r, _ in rules if r.startswith('/api/events')]
    assert ('/api/imports/<int:source_id>', 'DELETE') in rules
