"""What the jobs share, and the one edge they reach the market through (#1253).

``MarketClient`` is the seam a test fakes: the jobs ask it for a quote, a
history or a symbol's attributes, and keep for themselves what they do with the
answer (the info cache, the splits written beside a history). ``YahooMarket``
looks :mod:`market` up on each call, so a test that patches the module still
reaches the jobs.

``JobContext`` holds the state more than one job reads: the configuration, the
recorder, the FX rates, the info cache, the perf lock, the scheduler and the
live dials.
"""
import threading
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Mapping, Optional, Protocol, Tuple

from application import fx
from application import market
from application import runtime_state
from application import settings_registry


class MarketClient(Protocol):
    """The market data the jobs ask for, and nothing they do with it."""

    def latest_quote(self, symbol: str, max_retries: int = 3
                     ) -> Tuple[Optional[float], Optional[Dict]]:
        """``(last_quote, info)``, or ``(None, None)`` when there is none."""

    def price_history(self, symbol: str, start: datetime, end: datetime,
                      delay: float = 0.0, max_retries: int = 3
                      ) -> Tuple[Optional[List[Dict]], Optional[Dict]]:
        """``(prices, splits)`` over ``[start, end]``; ``prices`` ``None`` on failure."""

    def symbol_attributes(self, symbol: str) -> Optional[Dict]:
        """What the market says a symbol is, or ``None``."""


class YahooMarket:
    """The production client: :mod:`market`, read at call time."""

    def latest_quote(self, symbol, max_retries=3):
        return market.latest_quote(symbol, max_retries)

    def price_history(self, symbol, start, end, delay=0.0, max_retries=3):
        return market.price_history(symbol, start, end, delay, max_retries)

    def symbol_attributes(self, symbol):
        return market.symbol_attributes(symbol)


#: The dials that live on the context, read off ``settings_registry``.
DIAL_ATTRIBUTES: Tuple[str, ...] = tuple(
    spec.attribute for spec in settings_registry.SETTINGS
    if spec.attribute is not None)


@dataclass(eq=False)
class JobContext:
    """The state the jobs share. One per running process."""

    config_manager: Any
    recorder: runtime_state.RuntimeRecorder = field(
        default_factory=runtime_state.RuntimeRecorder)
    market: MarketClient = field(default_factory=YahooMarket)
    rates: fx.Rates = field(
        default_factory=lambda: fx.Rates(market.pair_rate, market.pair_series))
    info_cache: Dict[str, Dict] = field(default_factory=dict)
    perf_lock: Any = field(default_factory=threading.RLock)
    #: Duck-typed: ``main.start_runtime`` sets it, tests hand a mock.
    scheduler: Any = None

    def __post_init__(self):
        self.base_currency: Optional[str] = None
        self.apply_dials(settings_registry.defaults())

    @property
    def shares(self) -> List[Dict]:
        """The held positions, read from the published configuration snapshot."""
        return self.config_manager.current().shares

    def convert(self, price, currency: Optional[str],
                at: Optional[date] = None) -> Tuple[Optional[float], Optional[float]]:
        """``(converted, rate)`` for one observed price, in one call."""
        return fx.convert(price, currency, self.base_currency, self.rates, at)

    def apply_dials(self, values: Mapping[str, object]) -> None:
        """Set the live attributes a mapping of dials names (issue #701)."""
        for spec in settings_registry.SETTINGS:
            if spec.attribute is None:
                continue
            if values.get(spec.key) is not None:
                setattr(self, spec.attribute, values[spec.key])


__all__ = ['MarketClient', 'YahooMarket', 'DIAL_ATTRIBUTES', 'JobContext']
