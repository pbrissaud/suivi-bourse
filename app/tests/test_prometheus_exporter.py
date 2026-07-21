"""Tests for the legacy Prometheus exporter (/metrics backward compatibility)."""
import pytest
from prometheus_client import CollectorRegistry, generate_latest

from prometheus_exporter import PrometheusExporter


def _share():
    return {
        'name': 'Apple',
        'symbol': 'AAPL',
        'purchase': {'quantity': 20.0, 'cost_price': 143.75, 'fee': 7.5},
        'estate': {'quantity': 18.0, 'received_dividend': 2.4},
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
        'sb_share_price', 'sb_purchased_quantity', 'sb_purchased_price',
        'sb_purchased_fee', 'sb_owned_quantity', 'sb_received_dividend',
        'sb_share_info', 'sb_dividend_yield', 'sb_pe_ratio', 'sb_market_cap',
        'sb_volume',
    ):
        assert f'# HELP {name} ' in text


def test_uses_dedicated_registry_by_default():
    exp = PrometheusExporter()
    assert isinstance(exp.registry, CollectorRegistry)
    # Two exporters must not clash on a shared/global registry.
    PrometheusExporter()


# --- update_share on a successful fetch -------------------------------------

def test_update_share_sets_portfolio_and_market_gauges(exporter):
    exporter.update_share(_share(), 150.0, _info())

    assert _val(exporter, 'sb_purchased_quantity') == 20.0
    assert _val(exporter, 'sb_purchased_price') == 143.75
    assert _val(exporter, 'sb_purchased_fee') == 7.5
    assert _val(exporter, 'sb_owned_quantity') == 18.0
    assert _val(exporter, 'sb_received_dividend') == 2.4
    assert _val(exporter, 'sb_share_price') == 150.0
    assert _val(exporter, 'sb_pe_ratio') == 30.0
    assert _val(exporter, 'sb_market_cap') == 3_000_000_000.0
    assert _val(exporter, 'sb_volume') == 123456


def test_dividend_yield_is_scaled_to_percentage(exporter):
    exporter.update_share(_share(), 150.0, _info(dividendYield=0.5))
    assert _val(exporter, 'sb_dividend_yield') == 50.0


def test_share_info_gauge_carries_tag_labels(exporter):
    exporter.update_share(_share(), 150.0, _info())
    assert exporter.registry.get_sample_value('sb_share_info', {
        'share_name': 'Apple', 'share_symbol': 'AAPL', 'account': 'default',
        'share_currency': 'USD', 'share_exchange': 'NMS', 'quote_type': 'EQUITY',
    }) == 1.0


# --- account label ----------------------------------------------------------

def test_same_symbol_in_two_accounts_produces_distinct_series(exporter):
    """A symbol held in two accounts must not collapse onto one series."""
    pea = dict(_share(), account='PEA')
    pea['estate'] = {'quantity': 10.0, 'received_dividend': 0.0}
    cto = dict(_share(), account='CTO')
    cto['estate'] = {'quantity': 5.0, 'received_dividend': 0.0}

    exporter.update_share(pea, 150.0, _info())
    exporter.update_share(cto, 150.0, _info())

    assert exporter.registry.get_sample_value('sb_owned_quantity', {
        'share_name': 'Apple', 'share_symbol': 'AAPL', 'account': 'PEA'}) == 10.0
    assert exporter.registry.get_sample_value('sb_owned_quantity', {
        'share_name': 'Apple', 'share_symbol': 'AAPL', 'account': 'CTO'}) == 5.0


# --- None handling ----------------------------------------------------------

def test_none_optional_fields_are_not_set(exporter):
    exporter.update_share(
        _share(), 150.0,
        _info(dividendYield=None, peRatio=None, marketCap=None, volume=None))
    assert _val(exporter, 'sb_dividend_yield') is None
    assert _val(exporter, 'sb_pe_ratio') is None
    assert _val(exporter, 'sb_market_cap') is None
    assert _val(exporter, 'sb_volume') is None
    # Price and portfolio are still present.
    assert _val(exporter, 'sb_share_price') == 150.0
    assert _val(exporter, 'sb_owned_quantity') == 18.0


def test_failed_fetch_still_sets_portfolio_but_no_market(exporter):
    exporter.update_share(_share(), None, None)
    # Portfolio gauges available without a live quote (retro-compat behaviour).
    assert _val(exporter, 'sb_purchased_quantity') == 20.0
    assert _val(exporter, 'sb_owned_quantity') == 18.0
    assert _val(exporter, 'sb_received_dividend') == 2.4
    # No market data.
    assert _val(exporter, 'sb_share_price') is None
    assert _val(exporter, 'sb_dividend_yield') is None
    assert exporter.registry.get_sample_value('sb_share_info', {
        'share_name': 'Apple', 'share_symbol': 'AAPL', 'account': 'default',
        'share_currency': 'USD', 'share_exchange': 'NMS', 'quote_type': 'EQUITY',
    }) is None


# --- server -----------------------------------------------------------------

def test_start_serves_its_own_registry(monkeypatch, exporter):
    calls = {}

    def fake_start(port, registry=None):
        calls['port'] = port
        calls['registry'] = registry

    monkeypatch.setattr('prometheus_exporter.start_http_server', fake_start)
    exporter.start(8081)
    assert calls['port'] == 8081
    assert calls['registry'] is exporter.registry


# --- wiring through SuiviBourseMetrics.scrape() ------------------------------

def test_scrape_populates_injected_exporter(monkeypatch, mock_influx,
                                            shares_validator, fake_ticker):
    import main
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', lambda symbol: fake_ticker(close=150.0))

    class FakeConfigManager:
        def load_shares(self):
            return [_share()]

        def get_mode(self):
            return 'events'

        def get_first_buy_date(self, symbol):
            return None

        def get_events(self):
            return None

        def load_accounts(self):
            return None

    exporter = PrometheusExporter(registry=CollectorRegistry())
    metrics = main.SuiviBourseMetrics(
        FakeConfigManager(), shares_validator,
        influxdb_writer=mock_influx, prometheus_exporter=exporter)

    metrics.scrape()

    assert exporter.registry.get_sample_value('sb_share_price', AAPL) == 150.0
    assert exporter.registry.get_sample_value('sb_owned_quantity', AAPL) == 18.0
    # The InfluxDB write still happened too (dual export).
    assert mock_influx.write_metrics.called
