"""
Prometheus Exporter Module for SuiviBourse

Exposes the legacy ``sb_*`` Prometheus gauges on an HTTP ``/metrics`` endpoint,
kept for backward compatibility with pre-InfluxDB deployments. It runs in
parallel with the InfluxDB writer and only reflects the current snapshot of
each share (no historical backfill — Prometheus is a scrape/current-value model).
"""
import os

from prometheus_client import CollectorRegistry, Gauge, start_http_server
from logfmt_logger import getLogger

from events.schemas import DEFAULT_ACCOUNT

LOG_LEVEL = os.getenv('LOG_LEVEL', default='INFO')
logger = getLogger("prometheus_exporter", level=LOG_LEVEL)

# 'account' is part of every series identity: without it a symbol held in two
# accounts would collapse onto the same series and silently overwrite itself.
COMMON_LABELS = ['share_name', 'share_symbol', 'account']


class PrometheusExporter:
    """
    Exposes portfolio metrics as Prometheus gauges.

    Uses a dedicated :class:`~prometheus_client.CollectorRegistry` so multiple
    instances (e.g. in tests) never clash on the global default registry.
    """

    def __init__(self, registry: CollectorRegistry = None):
        self.registry = registry or CollectorRegistry()

        self.share_price = Gauge(
            "sb_share_price", "Price of the share", COMMON_LABELS,
            registry=self.registry)
        self.purchased_quantity = Gauge(
            "sb_purchased_quantity", "Quantity of purchased share", COMMON_LABELS,
            registry=self.registry)
        self.purchased_price = Gauge(
            "sb_purchased_price", "Price of purchased share", COMMON_LABELS,
            registry=self.registry)
        self.purchased_fee = Gauge(
            "sb_purchased_fee", "Fees", COMMON_LABELS,
            registry=self.registry)
        self.owned_quantity = Gauge(
            "sb_owned_quantity", "Owned quantity of the share", COMMON_LABELS,
            registry=self.registry)
        self.received_dividend = Gauge(
            "sb_received_dividend", "Sum of received dividend for the share",
            COMMON_LABELS, registry=self.registry)
        self.share_info = Gauge(
            "sb_share_info", "Share informations as label",
            COMMON_LABELS + ['share_currency', 'share_exchange', 'quote_type'],
            registry=self.registry)
        self.dividend_yield = Gauge(
            "sb_dividend_yield", "Dividend yield percentage of the share",
            COMMON_LABELS, registry=self.registry)
        self.pe_ratio = Gauge(
            "sb_pe_ratio", "Price to earnings ratio of the share", COMMON_LABELS,
            registry=self.registry)
        self.market_cap = Gauge(
            "sb_market_cap", "Market capitalization of the share", COMMON_LABELS,
            registry=self.registry)
        # Not present in the original Prometheus export; exposed here as a bonus
        # now that volume is collected.
        self.volume = Gauge(
            "sb_volume", "Trading volume of the share", COMMON_LABELS,
            registry=self.registry)

    def start(self, port: int) -> None:
        """Start the HTTP server exposing this exporter's registry."""
        start_http_server(port, registry=self.registry)
        logger.info(f"Prometheus metrics server started on port {port}")

    def update_share(self, share: dict, last_quote, info) -> None:
        """
        Update the gauges for a single share.

        Portfolio gauges (purchased/owned/dividend) are always set from the
        share configuration. Market gauges (price, info labels, yield, P/E,
        market cap, volume) are only set when a live quote was fetched, matching
        the original behaviour.

        Args:
            share: Share configuration dict (name, symbol, purchase, estate).
            last_quote: Latest price, or None if the fetch failed.
            info: Enriched ticker info dict, or None if the fetch failed.
        """
        account = share.get('account', DEFAULT_ACCOUNT)
        labels = (share['name'], share['symbol'], account)

        self.purchased_quantity.labels(*labels).set(share['purchase']['quantity'])
        self.purchased_price.labels(*labels).set(share['purchase']['cost_price'])
        self.purchased_fee.labels(*labels).set(share['purchase']['fee'])
        self.owned_quantity.labels(*labels).set(share['estate']['quantity'])
        self.received_dividend.labels(*labels).set(share['estate']['received_dividend'])

        if last_quote is None or info is None:
            return

        self.share_price.labels(*labels).set(last_quote)
        self.share_info.labels(
            share['name'], share['symbol'], account,
            info['currency'], info['exchange'], info['quoteType']).set(1)

        if info.get('dividendYield') is not None:
            # Match the InfluxDB write: yield is stored as a percentage.
            self.dividend_yield.labels(*labels).set(info['dividendYield'] * 100)
        if info.get('peRatio') is not None:
            self.pe_ratio.labels(*labels).set(info['peRatio'])
        if info.get('marketCap') is not None:
            self.market_cap.labels(*labels).set(info['marketCap'])
        if info.get('volume') is not None:
            self.volume.labels(*labels).set(info['volume'])
