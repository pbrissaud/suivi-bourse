"""Tests for the legacy Prometheus exporter (/metrics backward compatibility).

Since #699 the gauges have **two feeders and two lives**: the replay publishes
what the events say about a position, the scrape publishes what the market says
about its price — and only the second half leaves when a symbol's job departs.
"""
import pytest
from prometheus_client import CollectorRegistry, generate_latest

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
        'volume': 123456,
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
        'sb_dividend_yield', 'sb_pe_ratio', 'sb_market_cap', 'sb_volume',
        'sb_price_staleness',
    ):
        assert f'# HELP {name} ' in text


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
    assert _val(exporter, 'sb_volume') == 123456
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


def test_dividend_yield_is_scaled_to_percentage(exporter):
    exporter.update_quote(_share(), 150.0, _info(dividendYield=0.5))
    assert _val(exporter, 'sb_dividend_yield') == 50.0


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
    assert _val(exporter, 'sb_volume') is None
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


# --- None handling ----------------------------------------------------------

def test_none_optional_fields_are_not_set(exporter):
    exporter.update_quote(
        _share(), 150.0,
        _info(dividendYield=None, peRatio=None, marketCap=None, volume=None))
    assert _val(exporter, 'sb_dividend_yield') is None
    assert _val(exporter, 'sb_pe_ratio') is None
    assert _val(exporter, 'sb_market_cap') is None
    assert _val(exporter, 'sb_volume') is None
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
