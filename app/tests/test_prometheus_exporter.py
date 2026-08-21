"""Tests for the legacy Prometheus exporter (/metrics backward compatibility).

Since #699 the gauges have **two feeders and two lives**: the replay publishes
what the events say about a position, the scrape publishes what the market says
about its price — and only the second half leaves when a symbol's job departs.
"""
import re
from datetime import date
from pathlib import Path

import pytest
from prometheus_client import CollectorRegistry, generate_latest

from events.schemas import AccountMetricPoint, PortfolioTotalPoint
from prometheus_exporter import PrometheusExporter


def _share(quantity=18.0, cost_basis=2587.5, realized_gain=0.0):
    return {
        'name': 'Apple',
        'symbol': 'AAPL',
        'quantity': quantity,
        'cost_basis': cost_basis,
        'realized_gain': realized_gain,
        'received_dividend': 2.4,
    }


def _info(**overrides):
    info = {
        'currency': 'USD',
        'exchange': 'NMS',
        'quoteType': 'EQUITY',
        'dividendYield': 0.5,
        'peRatio': 30.0,
        'marketCap': 3_000_000_000.0,
    }
    info.update(overrides)
    return info


# A share without an 'account' key resolves to the 'default' account label.
AAPL = {'share_name': 'Apple', 'share_symbol': 'AAPL', 'account': 'default'}
AAPL_INFO = dict(AAPL, share_currency='USD', share_exchange='NMS',
                 quote_type='EQUITY')


@pytest.fixture
def exporter():
    # Dedicated registry so tests never touch the global default registry.
    return PrometheusExporter(registry=CollectorRegistry())


def _val(exp, name, **extra_labels):
    labels = dict(AAPL)
    labels.update(extra_labels)
    return exp.registry.get_sample_value(name, labels)


# --- registration -----------------------------------------------------------

def test_all_expected_gauges_are_registered(exporter):
    text = generate_latest(exporter.registry).decode()
    for name in (
        'sb_share_price', 'sb_cost_basis', 'sb_owned_quantity',
        'sb_received_dividend', 'sb_realized_gain', 'sb_share_info',
        'sb_dividend_yield', 'sb_pe_ratio', 'sb_market_cap',
        'sb_price_staleness',
    ):
        assert f'# HELP {name} ' in text


def test_a_gauge_whose_field_is_absent_is_not_published(exporter):
    """Criterion 8 of #708 — and *the asymmetry is the message*.

    An account with no cash ledger publishes ``sb_account_holdings_value`` and
    ``sb_account_gain_absolu`` and **nothing else**. Neither a zero nor a NaN
    will do: a zero makes *"no ledger"* and *"a ledger at zero"* the same series,
    so an alert on ``< 100`` fires on an empty account, and a NaN propagates
    through every aggregation that touches it. An absent series is how Prometheus
    itself says *no value*.
    """
    exporter.update_account(AccountMetricPoint(
        account='PEA', account_type='PEA', day=date(2024, 1, 1),
        holdings_value=220.0, gain_absolu=20.0))

    labels = {'account': 'PEA'}
    get = exporter.registry.get_sample_value
    assert get('sb_account_holdings_value', labels) == 220.0
    assert get('sb_account_gain_absolu', labels) == 20.0
    for name in ('sb_account_cash_balance', 'sb_account_total_value',
                 'sb_account_net_contributed', 'sb_account_xirr',
                 'sb_account_twr_index'):
        assert get(name, labels) is None
    # The account still exists as far as the scraper is concerned.
    assert get('sb_account_info', {'account': 'PEA', 'account_type': 'PEA'}) == 1


def test_a_field_that_stops_being_writable_takes_its_series_away(exporter):
    """A *retract*, not a skip: the previous cycle's value would otherwise sit
    there for the life of the process, exactly as a departed symbol's price
    would without ``forget_quotes``."""
    labels = {'account': 'PEA'}
    exporter.update_account(AccountMetricPoint(
        account='PEA', account_type='PEA', day=date(2024, 1, 1),
        cash_balance=800.0, holdings_value=220.0, total_value=1020.0,
        net_contributed=1000.0, gain_absolu=20.0, twr_index=100.0))
    assert exporter.registry.get_sample_value(
        'sb_account_total_value', labels) == 1020.0

    exporter.update_account(AccountMetricPoint(
        account='PEA', account_type='PEA', day=date(2024, 1, 2),
        holdings_value=230.0, gain_absolu=30.0))

    assert exporter.registry.get_sample_value(
        'sb_account_total_value', labels) is None
    assert exporter.registry.get_sample_value(
        'sb_account_holdings_value', labels) == 230.0


def test_the_global_gauges_are_absent_until_something_is_written(exporter):
    """The unlabelled half of the same rule, and the one that cost a mechanism.

    A gauge with no labels exposes ``0`` from the instant it is constructed, so a
    fresh install with no reporting currency answered was publishing
    ``sb_portfolio_total_value 0`` — the exact reading the rule exists against,
    on the series a headless dashboard puts on its front page. They are held out
    of the registry until they carry a real value.
    """
    text = generate_latest(exporter.registry).decode()
    assert 'sb_portfolio_total_value' not in text
    assert 'sb_portfolio_holdings_value' not in text

    exporter.update_portfolio(PortfolioTotalPoint(
        day=date(2024, 1, 1), holdings_value=220.0, gain_absolu=20.0))

    get = exporter.registry.get_sample_value
    assert get('sb_portfolio_holdings_value', {}) == 220.0
    assert get('sb_portfolio_gain_absolu', {}) == 20.0
    assert get('sb_portfolio_total_value', {}) is None
    assert get('sb_portfolio_cash_balance', {}) is None

    # And a field that comes back joins the registry again.
    exporter.update_portfolio(PortfolioTotalPoint(
        day=date(2024, 1, 2), holdings_value=230.0, total_value=1030.0,
        gain_absolu=30.0))
    assert get('sb_portfolio_total_value', {}) == 1030.0


def test_an_account_that_stops_being_computed_loses_its_series(exporter):
    """The row-level half of criterion 8, and the counterpart of
    ``retain_positions``.

    ``update_account`` is only ever reached for a row a cycle produced, so an
    account that stops producing one — its import forgotten, its events
    withdrawn — is never visited, and a loop that only ever sets would leave its
    seven gauges reporting the last values they ever had for the life of the
    process. ``prune_account_metrics`` takes its days out of the store in the
    same cycle; a stale real figure on ``/metrics`` is worse than the zero the
    rule was written against, a scraper having no way to tell it from a current
    one.
    """
    for account in ('PEA', 'CTO'):
        exporter.update_account(AccountMetricPoint(
            account=account, account_type=account, day=date(2024, 1, 1),
            cash_balance=800.0, holdings_value=220.0, total_value=1020.0,
            net_contributed=1000.0, gain_absolu=20.0, twr_index=100.0))

    exporter.retain_accounts(['PEA'])

    get = exporter.registry.get_sample_value
    assert get('sb_account_total_value', {'account': 'PEA'}) == 1020.0
    assert get('sb_account_info',
               {'account': 'PEA', 'account_type': 'PEA'}) == 1
    for name in ('sb_account_cash_balance', 'sb_account_holdings_value',
                 'sb_account_total_value', 'sb_account_net_contributed',
                 'sb_account_xirr', 'sb_account_gain_absolu',
                 'sb_account_twr_index'):
        assert get(name, {'account': 'CTO'}) is None
    assert get('sb_account_info',
               {'account': 'CTO', 'account_type': 'CTO'}) is None


def test_a_cycle_with_no_global_series_takes_the_seven_away(exporter):
    """``update_portfolio(None)`` — *this cycle produced no global series at
    all*, which an emptied ledger makes and which is not the same call as a
    point whose fields are absent.

    Without it ``sb_portfolio_total_value`` reports the value of a portfolio
    that no longer exists, for the life of the process — the unlabelled twin of
    the defect ``forget_quotes`` exists against.
    """
    exporter.update_portfolio(PortfolioTotalPoint(
        day=date(2024, 1, 1), cash_balance=800.0, holdings_value=220.0,
        total_value=1020.0, net_contributed=1000.0, gain_absolu=20.0,
        twr_index=100.0))
    assert exporter.registry.get_sample_value(
        'sb_portfolio_total_value', {}) == 1020.0

    exporter.update_portfolio(None)

    text = generate_latest(exporter.registry).decode()
    for name in ('sb_portfolio_cash_balance', 'sb_portfolio_holdings_value',
                 'sb_portfolio_total_value', 'sb_portfolio_net_contributed',
                 'sb_portfolio_xirr', 'sb_portfolio_gain_absolu',
                 'sb_portfolio_twr_index'):
        assert name not in text


def test_the_three_purchased_gauges_are_gone(exporter):
    """Renamed rather than redefined: a dashboard sees a gauge *leave* (#695 §12).

    ``sb_purchased_quantity`` counted "ever bought" and v5 has no such state;
    ``sb_purchased_fee`` counted a fee that now lives inside the cost basis;
    ``sb_purchased_price`` went from fee-excluded to fee-included. Keeping any
    of the three names would change what the number means without saying so.
    """
    text = generate_latest(exporter.registry).decode()
    assert 'sb_purchased_quantity' not in text
    assert 'sb_purchased_fee' not in text
    assert 'sb_purchased_price' not in text


def test_uses_dedicated_registry_by_default():
    exp = PrometheusExporter()
    assert isinstance(exp.registry, CollectorRegistry)
    # Two exporters must not clash on a shared/global registry.
    PrometheusExporter()


# --- update_position: the gauges the replay feeds ---------------------------

def test_update_position_sets_the_position_gauges(exporter):
    exporter.update_position(_share(realized_gain=-335.89))

    assert _val(exporter, 'sb_owned_quantity') == 18.0
    # An *amount*: the unit average is this divided by the quantity, a division
    # the scraper does and which stays undefined where it should.
    assert _val(exporter, 'sb_cost_basis') == 2587.5
    assert _val(exporter, 'sb_received_dividend') == 2.4
    assert _val(exporter, 'sb_realized_gain') == -335.89


def test_update_position_needs_no_quote(exporter):
    """The events say what a position is; the market has no say in it."""
    exporter.update_position(_share())

    assert _val(exporter, 'sb_owned_quantity') == 18.0
    assert _val(exporter, 'sb_share_price') is None


def test_a_sold_position_publishes_zeros_and_keeps_its_realized_gain(exporter):
    """Zero invested by construction — and a zero is a figure, not an absence."""
    exporter.update_position(_share(quantity=0.0, cost_basis=0.0,
                                    realized_gain=-335.89))

    assert _val(exporter, 'sb_owned_quantity') == 0.0
    assert _val(exporter, 'sb_cost_basis') == 0.0
    assert _val(exporter, 'sb_realized_gain') == -335.89
    assert _val(exporter, 'sb_received_dividend') == 2.4


def test_selling_out_brings_a_published_cost_basis_back_to_zero(exporter):
    exporter.update_position(_share())
    assert _val(exporter, 'sb_cost_basis') == 2587.5

    exporter.update_position(_share(quantity=0.0, cost_basis=0.0))

    assert _val(exporter, 'sb_cost_basis') == 0.0


# --- retain_positions: the replay's set, not just its rows -------------------

def test_retain_positions_publishes_every_position_it_is_given(exporter):
    exporter.retain_positions([_share(), dict(_share(), symbol='MSFT',
                                              name='Microsoft')])

    assert _val(exporter, 'sb_owned_quantity') == 18.0
    assert exporter.registry.get_sample_value('sb_owned_quantity', {
        'share_name': 'Microsoft', 'share_symbol': 'MSFT',
        'account': 'default'}) == 18.0


def test_a_position_that_leaves_the_ledger_takes_its_gauges_with_it(exporter):
    """A forgotten import, and the half of /metrics that carries money.

    Nothing else would ever touch these four again: ``forget_quotes`` covers the
    market series, and a loop that only sets would leave a cost basis standing
    for a holding nobody declares — quietly counted by every `sum()` over the
    metric until the process restarts.
    """
    exporter.retain_positions([_share(), dict(_share(), symbol='ALO',
                                              name='Alstom')])

    exporter.retain_positions([_share()])

    for gauge in ('sb_owned_quantity', 'sb_cost_basis', 'sb_realized_gain',
                  'sb_received_dividend'):
        assert exporter.registry.get_sample_value(gauge, {
            'share_name': 'Alstom', 'share_symbol': 'ALO',
            'account': 'default'}) is None
        assert _val(exporter, gauge) is not None


def test_a_sold_position_is_retained_because_it_is_still_declared(exporter):
    """Zero quantity is not what takes a series away — leaving the ledger is."""
    exporter.retain_positions([_share(quantity=0.0, cost_basis=0.0,
                                      realized_gain=-335.89)])

    assert _val(exporter, 'sb_realized_gain') == -335.89
    assert _val(exporter, 'sb_owned_quantity') == 0.0


def test_retaining_nothing_clears_every_position_series(exporter):
    exporter.retain_positions([_share()])

    exporter.retain_positions([])

    assert _val(exporter, 'sb_owned_quantity') is None
    assert _val(exporter, 'sb_cost_basis') is None


# --- update_quote on a successful fetch -------------------------------------

def test_update_quote_sets_the_market_gauges(exporter):
    exporter.update_quote(_share(), 150.0, _info(), 138.0, 0.92)

    assert _val(exporter, 'sb_share_price') == 138.0
    assert _val(exporter, 'sb_share_price_native') == 150.0
    assert _val(exporter, 'sb_fx_rate') == 0.92
    assert _val(exporter, 'sb_pe_ratio') == 30.0
    assert _val(exporter, 'sb_market_cap') == 3_000_000_000.0
    # And touches nothing the replay owns.
    assert _val(exporter, 'sb_owned_quantity') is None
    assert _val(exporter, 'sb_realized_gain') is None


def test_the_converted_price_is_absent_while_the_currency_is_unanswered(exporter):
    """*Never a gauge whose unit depends on a setting* (#702, spec #695 § 12).

    One `sb_share_price` would mean dollars on one install, euros on another and
    euros *from Tuesday* on a third — not a metric, a trap with a
    plausible-looking value in it. So the native price is always published and
    the converted one only when there is a rate. Absent, never zero: a zero is a
    figure and every `sum()` would count it.
    """
    exporter.update_quote(_share(), 150.0, _info())

    assert _val(exporter, 'sb_share_price_native') == 150.0
    assert _val(exporter, 'sb_share_price') is None
    assert _val(exporter, 'sb_fx_rate') is None


def test_the_dividend_yield_is_published_as_yfinance_hands_it_over(exporter):
    """No scaling: `dividendYield` is already a percentage.

    yfinance answers 5.32 for a 5,32 % yield — the *ratio* is a different key,
    `trailingAnnualDividendYield`. Both write paths scaled it by 100 anyway, so
    `/metrics` and the API agreed on a figure a hundred times too large: a real
    portfolio published `sb_dividend_yield 532` for a 5,32 % yield.
    """
    exporter.update_quote(_share(), 150.0, _info(dividendYield=5.32))
    assert _val(exporter, 'sb_dividend_yield') == pytest.approx(5.32)


def test_share_info_gauge_carries_tag_labels(exporter):
    exporter.update_quote(_share(), 150.0, _info())
    assert exporter.registry.get_sample_value('sb_share_info', AAPL_INFO) == 1.0


# --- account label ----------------------------------------------------------

def test_same_symbol_in_two_accounts_produces_distinct_series(exporter):
    """A symbol held in two accounts must not collapse onto one series."""
    exporter.update_position(dict(_share(quantity=10.0), account='PEA'))
    exporter.update_position(dict(_share(quantity=5.0), account='CTO'))

    assert exporter.registry.get_sample_value('sb_owned_quantity', {
        'share_name': 'Apple', 'share_symbol': 'AAPL', 'account': 'PEA'}) == 10.0
    assert exporter.registry.get_sample_value('sb_owned_quantity', {
        'share_name': 'Apple', 'share_symbol': 'AAPL', 'account': 'CTO'}) == 5.0


# --- price-freshness sonde (#628) -------------------------------------------

def test_update_price_staleness_sets_one_when_stale(exporter):
    exporter.update_price_staleness(_share(), True)
    assert _val(exporter, 'sb_price_staleness') == 1


def test_update_price_staleness_clears_to_zero_when_fresh(exporter):
    # A gauge: it clears when the writer recovers.
    exporter.update_price_staleness(_share(), True)
    exporter.update_price_staleness(_share(), False)
    assert _val(exporter, 'sb_price_staleness') == 0


def test_price_staleness_labelled_per_account(exporter):
    pea = dict(_share(), account='PEA')
    exporter.update_price_staleness(pea, True)
    assert exporter.registry.get_sample_value('sb_price_staleness', {
        'share_name': 'Apple', 'share_symbol': 'AAPL', 'account': 'PEA'}) == 1


# --- forget_quotes: an absent gauge is readable, a frozen one is not --------

def test_forget_quotes_removes_every_market_series_of_the_symbol(exporter):
    exporter.update_quote(_share(), 11.93, _info())
    exporter.update_price_staleness(_share(), False)

    exporter.forget_quotes('AAPL')

    assert _val(exporter, 'sb_share_price') is None
    assert _val(exporter, 'sb_dividend_yield') is None
    assert _val(exporter, 'sb_pe_ratio') is None
    assert _val(exporter, 'sb_market_cap') is None
    assert _val(exporter, 'sb_price_staleness') is None
    assert exporter.registry.get_sample_value('sb_share_info', AAPL_INFO) is None


def test_forget_quotes_keeps_what_the_replay_feeds(exporter):
    """The realized gain survives its scrape job — it is the figure left to read."""
    exporter.update_position(_share(quantity=0.0, cost_basis=0.0,
                                    realized_gain=-335.89))
    exporter.update_quote(_share(), 11.93, _info())

    exporter.forget_quotes('AAPL')

    assert _val(exporter, 'sb_share_price') is None
    assert _val(exporter, 'sb_realized_gain') == -335.89
    assert _val(exporter, 'sb_received_dividend') == 2.4
    assert _val(exporter, 'sb_owned_quantity') == 0.0


def test_forget_quotes_leaves_another_symbol_alone(exporter):
    exporter.update_quote(_share(), 150.0, _info(), 150.0, 1.0)
    exporter.update_quote(dict(_share(), symbol='MSFT', name='Microsoft'),
                          380.0, _info(), 380.0, 1.0)

    exporter.forget_quotes('AAPL')

    assert _val(exporter, 'sb_share_price') is None
    assert _val(exporter, 'sb_share_price_native') is None
    assert _val(exporter, 'sb_fx_rate') is None
    assert exporter.registry.get_sample_value('sb_share_price', {
        'share_name': 'Microsoft', 'share_symbol': 'MSFT',
        'account': 'default'}) == 380.0


def test_forget_quotes_removes_every_account_of_the_symbol(exporter):
    """The scrape job is per symbol, so its departure takes every holding with it."""
    exporter.update_quote(dict(_share(), account='PEA'), 150.0, _info())
    exporter.update_quote(dict(_share(), account='CTO'), 150.0, _info())

    exporter.forget_quotes('AAPL')

    for account in ('PEA', 'CTO'):
        assert exporter.registry.get_sample_value('sb_share_price', {
            'share_name': 'Apple', 'share_symbol': 'AAPL',
            'account': account}) is None


def test_forget_quotes_on_a_symbol_never_published_is_a_no_op(exporter):
    exporter.forget_quotes('NOSUCH')


# --- sb_store_ephemeral: the headless install's only notice (#741) ----------

def test_the_store_gauge_is_published_at_one_when_nothing_is_kept(exporter):
    """**The only form of notice a headless installation receives** (#741). The
    three start-up lines go to a terminal nobody is watching, and without this
    ADR-0012's *"Prometheus stays"* would serve the portfolio's figures and
    never the state of the installation itself."""
    exporter.update_store_persistence(True)

    assert exporter.registry.get_sample_value('sb_store_ephemeral') == 1.0
    assert '# HELP sb_store_ephemeral ' in \
        generate_latest(exporter.registry).decode()


def test_the_store_gauge_is_published_at_zero_when_the_store_is_kept(exporter):
    """**Present in both cases.** A series that disappears does not read as
    *off*, it reads as a scraper that lost its target — so ``0`` is written
    explicitly rather than left to the absence of the series."""
    exporter.update_store_persistence(False)

    assert exporter.registry.get_sample_value('sb_store_ephemeral') == 0.0


def test_the_store_gauge_goes_out_when_the_container_is_remounted(exporter):
    """A gauge and not a counter, so it can be *cleared*: the same process
    observing a volume next time publishes ``0`` over the ``1``. A counter would
    only ever be able to say that it was ephemeral once."""
    exporter.update_store_persistence(True)
    exporter.update_store_persistence(False)

    assert exporter.registry.get_sample_value('sb_store_ephemeral') == 0.0


def test_the_store_gauge_is_absent_while_the_mount_is_unobservable(exporter):
    """``None`` is :data:`mounts.UNKNOWN`, and it leaves the series **absent** —
    this module's own rule (a gauge whose field could not be computed is not
    published) rather than an exception to it. A ``0`` here would state that the
    store *is* kept, on the machine of a developer who has no ``/proc`` to read
    (#657)."""
    exporter.update_store_persistence(None)

    assert exporter.registry.get_sample_value('sb_store_ephemeral') is None
    assert 'sb_store_ephemeral' not in \
        generate_latest(exporter.registry).decode()


# --- None handling ----------------------------------------------------------

def test_none_optional_fields_are_not_set(exporter):
    exporter.update_quote(
        _share(), 150.0,
        _info(dividendYield=None, peRatio=None, marketCap=None))
    assert _val(exporter, 'sb_dividend_yield') is None
    assert _val(exporter, 'sb_pe_ratio') is None
    assert _val(exporter, 'sb_market_cap') is None
    # The price is still present.
    assert _val(exporter, 'sb_share_price_native') == 150.0


def test_failed_fetch_sets_no_market_gauge_at_all(exporter):
    exporter.update_quote(_share(), None, None)

    assert _val(exporter, 'sb_share_price') is None
    assert _val(exporter, 'sb_dividend_yield') is None
    assert exporter.registry.get_sample_value('sb_share_info', AAPL_INFO) is None


# The exporter no longer serves anything: since issue #651 its registry is
# mounted on the Flask app and served by gunicorn. That it is *this* registry
# behind /metrics is asserted in test_web_boot.py.


# --- wiring through SuiviBourseMetrics ---------------------------------------

def test_scrape_publishes_the_price_and_ingest_the_position(
        monkeypatch, fake_ticker, store):
    """The two feeders, each doing its own half (#699)."""
    from contextlib import contextmanager

    import main
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', lambda symbol: fake_ticker(close=150.0))
    store.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")

    class FakeConfigManager:
        store = None

        @contextmanager
        def writing(self):
            yield self.store

        def current(self):
            return main.ConfigSnapshot(shares=[_share()], events=[],
                                       accounts=None, cache_key=None)

        def reload(self, force=False):
            return self.current()

        def replay(self):
            return self.current()

        def load_shares(self, force=False):
            return [_share()]

        def get_first_buy_date(self, symbol):
            return None

        def get_events(self):
            return None

        def load_accounts(self):
            return None

    exporter = PrometheusExporter(registry=CollectorRegistry())
    manager = FakeConfigManager()
    manager.store = store
    metrics = main.SuiviBourseMetrics(manager, prometheus_exporter=exporter)
    # The fake quotes in USD and the install reports in USD, so the conversion
    # is the identity and needs no pair — which is what makes the whole chain
    # assertable without a second faked fetch (#702).
    metrics.base_currency = 'USD'

    metrics.scrape()
    assert exporter.registry.get_sample_value('sb_share_price', AAPL) == 150.0
    assert exporter.registry.get_sample_value(
        'sb_share_price_native', AAPL) == 150.0
    # The scrape knows nothing of the position any more.
    assert exporter.registry.get_sample_value('sb_owned_quantity', AAPL) is None

    metrics.ingest()
    assert exporter.registry.get_sample_value('sb_owned_quantity', AAPL) == 18.0
    assert exporter.registry.get_sample_value('sb_realized_gain', AAPL) == 0.0

    # And the point landed in the store as well (the gauges are a mirror),
    # carrying the three columns #702 gives it.
    assert store.query(
        "SELECT price_native, price_converted, fx_rate FROM price_point "
        "WHERE symbol = 'AAPL'") == [(150.0, 150.0, 1.0)]


# --- the documented contract ------------------------------------------------

_GAUGES_PAGE = (Path(__file__).resolve().parents[2]
                / 'website' / 'docs' / 'headless-gauges.mdx')

#: A row of one of the page's **labelled** gauge tables: a backticked `sb_*`
#: name, then a cell that is *nothing but* a list of backticked label names (or
#: `_(none)_`). The second condition is what keeps the `sb_account_*` table out:
#: its second column answers *published when* in prose, and prose containing a
#: backtick is not a label list. A row it cannot read is a row this test says
#: nothing about, which is the honest failure mode — the assertions below then
#: catch a gauge that has left the table altogether.
_ROW = re.compile(
    r'^\| `(sb_\w+)` \| (_\(none\)_|`\w+`(?:, `\w+`)*|the same three[^|]*) \|', re.M)
_LABEL = re.compile(r'`(\w+)`')


def _documented_labels():
    """`{gauge: {labels}}` as the page's own table states them."""
    documented = {}
    for name, cell in _ROW.findall(_GAUGES_PAGE.read_text(encoding='utf-8')):
        if '_(none)_' in cell:
            documented[name] = set()
            continue
        labels = set(_LABEL.findall(cell))
        # `sb_share_info`'s row says "the same three, plus …" rather than
        # repeating them, which is how the page reads and how it should stay.
        if cell.startswith('the same three'):
            labels |= {'share_name', 'share_symbol', 'account'}
        documented[name] = labels
    return documented


def test_the_documented_labels_are_the_published_ones(exporter):
    """#762's criterion, and the reason it was a ticket rather than a typo.

    The page and the exporter described two different label sets, and the
    divergence survived three tickets: the documentation gave `share_symbol`
    alone on every price gauge, under a sentence explaining that a market price
    belongs to no account, while the code published `share_name`,
    `share_symbol` and `account` on all of them — deliberately, since #700, so a
    headless dashboard can join a price to a per-account position.

    **A headless install is driven by the documentation alone**, so one of the
    two had to become the other and then be held. The decision was to keep the
    three labels and correct the page; this is the holding. It reads the page's
    own table rather than a copy of it, which is what makes the table the source
    it claims to be.
    """
    # Populated first, and through the **public** writers: a fresh registry
    # emits no sample at all, so a test reading `collect()` off one would pass
    # over an empty mapping and attest nothing. What is compared is therefore
    # what a scraper would actually receive.
    exporter.update_quote(_share(), 150.0, _info(), 138.0, 0.92)
    exporter.update_position(_share())
    exporter.update_price_staleness(_share(), True)
    exporter.update_store_persistence(False)
    exporter.update_account(AccountMetricPoint(
        account='PEA', account_type='PEA', day=date(2024, 1, 1),
        holdings_value=220.0, gain_absolu=20.0, cash_balance=10.0,
        net_contributed=200.0, total_value=230.0, twr_index=110.0, xirr=0.1))
    exporter.update_portfolio(PortfolioTotalPoint(
        day=date(2024, 1, 1), holdings_value=220.0, gain_absolu=20.0,
        cash_balance=10.0, net_contributed=200.0, total_value=230.0,
        twr_index=110.0, xirr=0.1))

    documented = _documented_labels()
    published = {
        metric.name: set(sample.labels)
        for metric in exporter.registry.collect()
        for sample in metric.samples
    }

    assert documented, "no gauge row parsed out of the page"
    assert len(published) > 15, f"only {len(published)} gauges published"

    # Both directions, over the population the page gives a **Labels column**
    # for — the market and position families, and the install's own gauge. The
    # `sb_account_*` / `sb_portfolio_*` tables answer a different question
    # (*published when*) and state their one label in the prose above them,
    # which no parser should pretend to read.
    for name, labels in sorted(documented.items()):
        assert name in published, f"{name} is documented and not published"
        assert labels == published[name], (
            f"{name}: the page says {sorted(labels)}, "
            f"the exporter publishes {sorted(published[name])}")

    for name, labels in sorted(published.items()):
        if 'share_symbol' in labels:
            assert name in documented, f"{name} is published and undocumented"
