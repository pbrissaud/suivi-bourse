"""
Prometheus Exporter Module for SuiviBourse

Holds the ``sb_*`` Prometheus gauges — **a first-class product** and not a
legacy half (ADR-0012): they are what makes the app usable headless, for
whoever wants something very simple. They run beside the store and reflect the
current snapshot of each share only (no historical backfill — Prometheus is a
scrape/current-value model).

This module owns the *registry*, not the server: since issue #651 the ``/metrics``
endpoint is mounted on the Flask app (``web``) and served by gunicorn on its own
socket, so the exporter no longer runs a ``ThreadingHTTPServer`` of its own.

Two rules the inventory obeys, and both are about what a scraper can trust:

* **Never a gauge whose unit depends on a setting** (issue #702). A single
  ``sb_share_price`` would mean dollars on one install, euros on another and
  euros *from Tuesday onwards* on a third — not a metric, a trap with a
  plausible-looking value in it. So the native price and the converted price are
  two gauges with fixed meanings, and while the reporting currency is unanswered
  the converted one is **absent**. The position and account gauges are not under
  the rule: their amounts come from events *recorded* in the reporting currency,
  so answering the dial names a unit they always had rather than changing one.
* **A gauge whose field is absent is not published.** A zero makes "no ledger"
  and "a ledger at zero" the same series; a ``NaN`` propagates through every
  aggregation that touches it. An absent series is how Prometheus itself says
  *no value*, and the asymmetry is the message.
"""
import os

from prometheus_client import CollectorRegistry, Gauge
from logfmt_logger import getLogger

from events.schemas import DEFAULT_ACCOUNT

LOG_LEVEL = (os.getenv('LOG_LEVEL') or '').strip() or 'INFO'
logger = getLogger("prometheus_exporter", level=LOG_LEVEL)

# 'account' is part of every series identity: without it a symbol held in two
# accounts would collapse onto the same series and silently overwrite itself.
COMMON_LABELS = ['share_name', 'share_symbol', 'account']

#: Where the label values sit in a sample, so a series can be removed without
#: reaching into ``Gauge._labelnames``.
SHARE_INFO_LABELS = COMMON_LABELS + ['share_currency', 'share_exchange',
                                     'quote_type']


class PrometheusExporter:
    """
    Exposes portfolio metrics as Prometheus gauges.

    Uses a dedicated :class:`~prometheus_client.CollectorRegistry` so multiple
    instances (e.g. in tests) never clash on the global default registry.
    """

    def __init__(self, registry: CollectorRegistry = None):
        self.registry = registry or CollectorRegistry()

        # **Two price gauges, never one** (issue #702, spec #695 § 12). The rule
        # is general and is the reason both exist: *never a gauge whose unit
        # depends on a setting*. A single ``sb_share_price`` would mean dollars
        # on one install, euros on another, and euros *from Tuesday* on a third
        # — not a metric, a trap with a plausible-looking value in it. So the
        # converted price and the native price are two series with fixed
        # meanings, and while the reporting currency is unanswered the converted
        # one is **absent** rather than zero (see :meth:`update_quote`).
        #
        # The position gauges below are not under that rule and stay one gauge
        # each: a cost basis comes from events that were *recorded* in the
        # reporting currency, so its unit does not change when the dial is
        # answered — the dial only names a unit those amounts always had.
        self.share_price = Gauge(
            "sb_share_price",
            "Price of the share, in the reporting currency. Absent until the "
            "base currency is answered",
            COMMON_LABELS, registry=self.registry)
        self.share_price_native = Gauge(
            "sb_share_price_native",
            "Price of the share as quoted, in the security's own currency",
            COMMON_LABELS, registry=self.registry)
        self.fx_rate = Gauge(
            "sb_fx_rate",
            "The rate that turned sb_share_price_native into sb_share_price",
            COMMON_LABELS, registry=self.registry)
        # The three ``sb_purchased_*`` gauges are **gone** (issue #699, spec
        # #695 § 12, `website/docs/headless-gauges.mdx`), and none of them was
        # renamed into a survivor: every one would have changed *meaning* under
        # its old name. "Ever bought" is not "held at this cost";
        # ``purchased_fee`` counted a fee that now lives inside the basis, so
        # the only value left to publish would be a zero reading as "no fees
        # paid"; and the unit average went from fee-excluded to fee-included. A
        # headless dashboard must see a series **leave**, never see a number
        # quietly start meaning something else.
        #
        # What replaces them is the state itself: ``sb_cost_basis`` is an
        # **amount**, and the unit average is that divided by
        # ``sb_owned_quantity`` — a division the scraper's own query language
        # does perfectly well, and which stays honestly undefined on a position
        # nobody holds instead of being published as a zero.
        self.cost_basis = Gauge(
            "sb_cost_basis",
            "What the held quantity cost, as an amount (acquisition fees "
            "included); the unit average is this divided by sb_owned_quantity",
            COMMON_LABELS, registry=self.registry)
        self.owned_quantity = Gauge(
            "sb_owned_quantity", "Owned quantity of the share", COMMON_LABELS,
            registry=self.registry)
        self.received_dividend = Gauge(
            "sb_received_dividend", "Sum of received dividend for the share",
            COMMON_LABELS, registry=self.registry)
        # Fed by the **replay**, never by the scrape (#672 D4): a position's
        # realized gain is born at the sale, which is the exact instant its
        # scrape job is removed. Riding on the price path, the figure would
        # never be published at all.
        self.realized_gain = Gauge(
            "sb_realized_gain",
            "Realized gain on the share (net proceeds minus the cost basis "
            "the sales consumed)",
            COMMON_LABELS, registry=self.registry)
        self.share_info = Gauge(
            "sb_share_info", "Share informations as label",
            SHARE_INFO_LABELS, registry=self.registry)
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
        # Price-freshness liveness sonde (issue #628). 1 when the stored price is
        # silently stale (frozen past the horizon while the live quote moves), 0
        # when fresh — a gauge so it auto-clears when the writer recovers.
        self.price_staleness = Gauge(
            "sb_price_staleness",
            "1 when the stored price is silently stale while the live quote moves",
            COMMON_LABELS, registry=self.registry)

        # ``sb_store_ephemeral`` (issue #741, ADR-0015). Created by the first
        # observation rather than here, which is the only way an *unlabelled*
        # gauge can be absent: ``prometheus_client`` publishes one at ``0`` from
        # the instant it is constructed, and ``0`` on this series states that
        # the store **is** kept — the exact false statement a macOS developer,
        # who has no mount table to read, would be handed. See
        # :meth:`update_store_persistence`.
        self.store_ephemeral = None

        # Everything a live quote feeds, and therefore everything that has to
        # **leave** when a symbol's scrape job does (#672 D6). Without the
        # removal, ``sb_share_price`` of a share sold four years ago sits at its
        # last observed price for as long as the process lives, never saying it
        # stopped moving: an absent gauge is readable, a frozen one is not. The
        # sonde rides along — it is a statement about a write path that no
        # longer exists. The position gauges are **not** here: the replay feeds
        # them, and it goes on doing so for a position at zero.
        self._quote_gauges = (
            (self.share_price, COMMON_LABELS),
            (self.share_price_native, COMMON_LABELS),
            (self.fx_rate, COMMON_LABELS),
            (self.share_info, SHARE_INFO_LABELS),
            (self.dividend_yield, COMMON_LABELS),
            (self.pe_ratio, COMMON_LABELS),
            (self.market_cap, COMMON_LABELS),
            (self.volume, COMMON_LABELS),
            (self.price_staleness, COMMON_LABELS),
        )

        # The replay's four, and the label sets it last published. A position
        # can leave the ledger outright — a forgotten import — and then no
        # `update_position` ever touches its series again: it would go on
        # publishing a cost basis for a holding nobody declares, and a
        # `sum(sb_cost_basis)` would go on counting it. The scrape's half has
        # `forget_quotes`; this is the same closure for the half that carries
        # money (see :meth:`retain_positions`).
        self._position_gauges = (
            self.owned_quantity, self.cost_basis, self.received_dividend,
            self.realized_gain,
        )
        self._published_positions = set()

        # Per-account cash & value gauges (opt-in accounts feature). Labelled by
        # account so each account is its own series.
        self.account_cash_balance = Gauge(
            "sb_account_cash_balance", "Cash balance of the account", ['account'],
            registry=self.registry)
        self.account_holdings_value = Gauge(
            "sb_account_holdings_value", "Market value of the account's holdings",
            ['account'], registry=self.registry)
        self.account_total_value = Gauge(
            "sb_account_total_value", "Total value (cash + holdings) of the account",
            ['account'], registry=self.registry)
        self.account_net_contributed = Gauge(
            "sb_account_net_contributed", "Net external cash contributed to the account",
            ['account'], registry=self.registry)
        # ``account_currency`` left this label set with ``Account.currency``
        # (issue #702, ADR-0002): an account has no currency of its own, and a
        # label that was always the same empty string across every account was
        # a third currency level publishing itself as a fact.
        self.account_info = Gauge(
            "sb_account_info", "Account informations as label",
            ['account', 'account_type'],
            registry=self.registry)
        # Money-weighted performance per account.
        self.account_xirr = Gauge(
            "sb_account_xirr", "Money-weighted return (XIRR, annualized) of the account",
            ['account'], registry=self.registry)
        self.account_gain_absolu = Gauge(
            "sb_account_gain_absolu", "Absolute gain of the account",
            ['account'], registry=self.registry)
        self.account_twr_index = Gauge(
            "sb_account_twr_index", "Time-weighted return index (base 100) of the account",
            ['account'], registry=self.registry)

        # Global portfolio perf gauges — NO account label (a single global series;
        # an account label would double every aggregation).
        self.portfolio_cash_balance = Gauge(
            "sb_portfolio_cash_balance", "Global cash balance", registry=self.registry)
        self.portfolio_holdings_value = Gauge(
            "sb_portfolio_holdings_value", "Global holdings value", registry=self.registry)
        self.portfolio_total_value = Gauge(
            "sb_portfolio_total_value", "Global total value", registry=self.registry)
        self.portfolio_net_contributed = Gauge(
            "sb_portfolio_net_contributed", "Global net contributed", registry=self.registry)
        self.portfolio_xirr = Gauge(
            "sb_portfolio_xirr", "Global money-weighted return (XIRR, annualized)",
            registry=self.registry)
        self.portfolio_gain_absolu = Gauge(
            "sb_portfolio_gain_absolu", "Global absolute gain", registry=self.registry)
        self.portfolio_twr_index = Gauge(
            "sb_portfolio_twr_index", "Global time-weighted return index (base 100)",
            registry=self.registry)

    @staticmethod
    def _share_labels(share: dict) -> tuple:
        """The three-label series identity of one position."""
        return (share['name'], share['symbol'],
                share.get('account', DEFAULT_ACCOUNT))

    def update_position(self, share: dict) -> None:
        """Publish one position's state — the gauges the **replay** feeds.

        Called after a replay, for every position the ledger holds, sold ones
        included: a position at zero quantity still has a realized gain and its
        dividends, and those are precisely the figures left to read once the
        holding is gone. It is deliberately not called from the scrape, which no
        longer knows anything about a position beyond its price.

        Every figure here is published as a **zero** rather than withheld when
        the position is sold out, and that is not the same decision as §11's
        *"a gauge whose field is absent is not published"*: a sold position's
        quantity and cost basis genuinely **are** zero, and a zero is a figure.
        Absence is kept for what could not be computed at all — which is exactly
        why the unit average is not a gauge here: it is undefined on a sold
        position, and a scraper that wants it divides two series that are not.

        Args:
            share: one position dict (name, symbol, account, quantity,
                cost_basis, realized_gain, received_dividend).
        """
        labels = self._share_labels(share)

        self.owned_quantity.labels(*labels).set(share.get('quantity') or 0.0)
        self.cost_basis.labels(*labels).set(share.get('cost_basis') or 0.0)
        self.received_dividend.labels(*labels).set(
            share.get('received_dividend') or 0.0)
        self.realized_gain.labels(*labels).set(share.get('realized_gain') or 0.0)
        self._published_positions.add(labels)

    def retain_positions(self, shares) -> None:
        """Publish these positions, and **remove every series not among them**.

        The replay's own gesture, and it is a *retain* rather than an update
        because the set is what changes: forgetting an import takes positions
        away, and a loop that only ever sets would leave their gauges standing —
        a cost basis for a holding nobody declares any more, quietly counted by
        every `sum()` over the metric until the process restarts.

        Zero quantity is **not** what takes a series away: a sold position is
        still declared and still has a realized gain to publish. What takes it
        away is the ledger no longer producing the row at all.
        """
        for share in shares:
            self.update_position(share)

        keep = {self._share_labels(share) for share in shares}
        for labels in sorted(self._published_positions - keep):
            for gauge in self._position_gauges:
                self._remove(gauge, labels)
            self._published_positions.discard(labels)

    def update_quote(self, share: dict, last_quote, info,
                     converted=None, fx_rate=None) -> None:
        """Publish one position's market gauges, from a successful fetch.

        Gated by the caller on **fetch success** rather than on the write gate,
        so a closed-market restart still leaves them populated (design #609).
        Does nothing at all without a quote — the position half is
        :meth:`update_position`'s, and it does not depend on the market being
        reachable.

        ``last_quote`` is the price **as quoted** and goes to
        ``sb_share_price_native``; ``converted`` and ``fx_rate`` are the caller's
        conversion into the reporting currency and go to ``sb_share_price`` and
        ``sb_fx_rate`` (issue #702). Passing neither — which is what a scrape
        does while the reporting currency is unanswered, or when the pair could
        not be resolved — leaves those two series **absent**, which is the only
        honest thing a Prometheus exporter can say about a value it has no unit
        for. A zero would be a figure and would be counted by every ``sum()``.

        Args:
            share: one position dict (name, symbol, account).
            last_quote: Latest native price, or None if the fetch failed.
            info: Enriched ticker info dict, or None if the fetch failed.
            converted: the same price in the reporting currency, or None.
            fx_rate: the rate that produced it, or None.
        """
        if last_quote is None or info is None:
            return

        account = share.get('account', DEFAULT_ACCOUNT)
        labels = self._share_labels(share)

        self.share_price_native.labels(*labels).set(last_quote)
        if converted is not None:
            self.share_price.labels(*labels).set(converted)
        if fx_rate is not None:
            self.fx_rate.labels(*labels).set(fx_rate)
        self.share_info.labels(
            share['name'], share['symbol'], account,
            info['currency'], info['exchange'], info['quoteType']).set(1)

        if info.get('dividendYield') is not None:
            # Match the stored quote: the yield is a percentage.
            self.dividend_yield.labels(*labels).set(info['dividendYield'] * 100)
        if info.get('peRatio') is not None:
            self.pe_ratio.labels(*labels).set(info['peRatio'])
        if info.get('marketCap') is not None:
            self.market_cap.labels(*labels).set(info['marketCap'])
        if info.get('volume') is not None:
            self.volume.labels(*labels).set(info['volume'])

    def forget_quotes(self, symbol: str) -> None:
        """Remove every market series of a symbol whose scrape job has departed.

        The counterpart of :meth:`update_quote`, and the reason it exists is
        stated on :attr:`_quote_gauges`: the last price of a symbol nobody polls
        any more is not a current price, and Prometheus has no way to say so
        other than by the series not being there.

        Works off ``collect()`` rather than the label sets of the current
        portfolio, because the position may have left the ledger entirely (a
        forgotten import) and there would then be nothing left to name it with.
        """
        for gauge, labelnames in self._quote_gauges:
            for metric in gauge.collect():
                for sample in metric.samples:
                    if sample.labels.get('share_symbol') != symbol:
                        continue
                    self._remove(
                        gauge, tuple(sample.labels[name] for name in labelnames))

    @staticmethod
    def _remove(gauge: Gauge, labels: tuple) -> None:
        """Drop one series, tolerating a label set that was never created."""
        try:
            gauge.remove(*labels)
        except KeyError:
            pass

    def update_price_staleness(self, share: dict, stale: bool) -> None:
        """Set the price-freshness sonde gauge for one share (issue #628).

        Diagnostic only: ``1`` flags a silently stale writer for
        (share_name, share_symbol, account), ``0`` clears it once the stored
        price tracks the live quote again.
        """
        self.price_staleness.labels(*self._share_labels(share)).set(
            1 if stale else 0)

    def update_store_persistence(self, ephemeral) -> None:
        """Publish ``sb_store_ephemeral`` — ``1`` **and** ``0``, never a gap.

        The gauge is **the only form of notice a headless installation gets**
        (issue #741): without it, ADR-0012's *"Prometheus stays"* serves the
        portfolio's figures and never the state of the installation itself. A
        gauge and not a counter, so it goes out on its own the day the container
        is restarted with a volume — a counter would only ever say that it was
        ephemeral once.

        Both values are published for the same reason: a series that disappears
        does not read as *off*, it reads as a scraper that lost its target. So
        ``0`` is written explicitly on a mounted store.

        ``None`` — :data:`mounts.UNKNOWN` — is the third answer and leaves the
        series **absent**, which is this module's own rule (a gauge whose field
        could not be computed is not published) rather than an exception to it.
        """
        if ephemeral is None:
            return
        if self.store_ephemeral is None:
            self.store_ephemeral = Gauge(
                "sb_store_ephemeral",
                "1 when the store lives in the container's writable layer and "
                "is lost with the container, 0 when it is on a mount that "
                "outlives it",
                registry=self.registry)
        self.store_ephemeral.set(1 if ephemeral else 0)

    def update_account(self, point) -> None:
        """Update the per-account gauges from a computed account_metrics point.

        Args:
            point: an :class:`~events.schemas.AccountMetricPoint` (the latest,
                today's, values for the account).
        """
        account = point.account
        self.account_cash_balance.labels(account).set(point.cash_balance)
        self.account_holdings_value.labels(account).set(point.holdings_value)
        self.account_total_value.labels(account).set(point.total_value)
        self.account_net_contributed.labels(account).set(point.net_contributed)
        self.account_info.labels(account, point.account_type or '').set(1)
        # Performance fields: only when computable (absent otherwise).
        if point.xirr is not None:
            self.account_xirr.labels(account).set(point.xirr)
        if point.gain_absolu is not None:
            self.account_gain_absolu.labels(account).set(point.gain_absolu)
        if point.twr_index is not None:
            self.account_twr_index.labels(account).set(point.twr_index)

    def update_portfolio(self, point) -> None:
        """Update the global (untagged) portfolio gauges from a
        :class:`~events.schemas.PortfolioTotalPoint`."""
        self.portfolio_cash_balance.set(point.cash_balance)
        self.portfolio_holdings_value.set(point.holdings_value)
        self.portfolio_total_value.set(point.total_value)
        self.portfolio_net_contributed.set(point.net_contributed)
        if point.xirr is not None:
            self.portfolio_xirr.set(point.xirr)
        if point.gain_absolu is not None:
            self.portfolio_gain_absolu.set(point.gain_absolu)
        if point.twr_index is not None:
            self.portfolio_twr_index.set(point.twr_index)
