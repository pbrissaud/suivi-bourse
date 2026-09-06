"""The four workloads and the state they share (issue #850)."""
import threading
from datetime import date, datetime
from typing import Dict, List, Optional, Set, Tuple

from apscheduler.schedulers.background import BackgroundScheduler

from application import backfill
from application import fx
from application import ingestion
from application import market
from application import perf_job
from application import runtime_state
from application import scheduling
from application import scrape
from application import settings_registry


class Workloads:
    """The four workloads, and the state they share (issue #850)."""

    def __init__(self, config_manager,
                 recorder: Optional[runtime_state.RuntimeRecorder] = None):
        self.config_manager = config_manager

        self.base_currency: Optional[str] = None
        self.apply_dials(settings_registry.defaults())

        self._perf_lock = threading.RLock()

        self.rates = fx.Rates(market.pair_rate, market.pair_series)

        self.scheduler: Optional[BackgroundScheduler] = None

        info_cache: Dict[str, Dict] = {}

        self._scrape = scrape.ScrapeWorkload(self, info_cache)

        self._backfill = backfill.BackfillWorkload(self, info_cache)

        self._recompute = perf_job.PerfJob(self)

        self.recorder = recorder or runtime_state.RuntimeRecorder()

        self._ingestion = ingestion.IngestionWorkload(self)

    @property
    def _share_info_cache(self) -> Dict[str, Dict]:
        return self._scrape.info_cache

    @_share_info_cache.setter
    def _share_info_cache(self, cache: Dict[str, Dict]) -> None:
        self._scrape.info_cache = cache
        self._backfill.info_cache = cache

    @property
    def _failure_counts(self) -> Dict[str, int]:
        return self._scrape.failure_counts

    @_failure_counts.setter
    def _failure_counts(self, counts: Dict[str, int]) -> None:
        self._scrape.failure_counts = counts

    @property
    def _sonde_state(self) -> Dict[str, scheduling.SondeState]:
        return self._scrape.sonde_state

    @_sonde_state.setter
    def _sonde_state(self, state: Dict[str, scheduling.SondeState]) -> None:
        self._scrape.sonde_state = state

    @property
    def _backfill_complete(self) -> Dict[str, datetime]:
        return self._backfill.complete

    @_backfill_complete.setter
    def _backfill_complete(self, complete: Dict[str, datetime]) -> None:
        self._backfill.complete = complete

    @property
    def _lateral_retry_at(self) -> Dict[str, datetime]:
        return self._backfill.lateral_retry_at

    @_lateral_retry_at.setter
    def _lateral_retry_at(self, retry_at: Dict[str, datetime]) -> None:
        self._backfill.lateral_retry_at = retry_at

    @property
    def _quote_currency_unknown(self) -> Set[str]:
        return self._backfill.quote_currency_unknown

    @_quote_currency_unknown.setter
    def _quote_currency_unknown(self, symbols: Set[str]) -> None:
        self._backfill.quote_currency_unknown = symbols

    @property
    def shares(self) -> List[Dict]:
        """The held positions, read from the published configuration snapshot."""
        return self.config_manager.current().shares

    def _convert(self, price, currency: Optional[str],
                 at: Optional[date] = None) -> Tuple[Optional[float], Optional[float]]:
        """``(converted, rate)`` for one observed price, in one call."""
        return fx.convert(price, currency, self.base_currency, self.rates, at)

    def apply_dials(self, values: Dict[str, object]) -> None:
        """Set the live attributes a mapping of dials names (issue #701)."""
        for spec in settings_registry.SETTINGS:
            if spec.attribute is None:
                continue
            if values.get(spec.key) is not None:
                setattr(self, spec.attribute, values[spec.key])

    def _fetch_ticker_data(self, symbol: str, max_retries: int = 3):
        return self._scrape.fetch_ticker_data(symbol, max_retries)

    def _write_quote(self, symbol: str, last_quote, info, now: datetime,
                     converted=None, fx_rate=None) -> bool:
        return self._scrape.write_quote(symbol, last_quote, info, now,
                                        converted, fx_rate)

    def _held_symbols(self) -> set:
        return self._scrape.held_symbols()

    def _scheduled_symbols(self) -> set:
        return self._scrape.scheduled_symbols()

    def _arm_symbol(self, symbol: str, delay: float, now: datetime) -> None:
        return self._scrape.arm_symbol(symbol, delay, now)

    def _last_pass_closed(self, symbol: str) -> Optional[bool]:
        return self._scrape.last_pass_closed(symbol)

    def _reconcile_jobs(self) -> None:
        return self._scrape.reconcile_jobs()

    def _check_price_freshness(self, symbol: str,
                               live_price, now: datetime) -> bool:
        return self._scrape.check_price_freshness(symbol, live_price, now)

    def _scrape_symbol(self, symbol: str, now: Optional[datetime] = None) -> None:
        """Scrape one symbol and re-arm its job — what every job is armed on."""
        return self._scrape.scrape_symbol(symbol, now)

    def scrape_held(self):
        """Fetch and store every held symbol's quote, once — the e2e driver."""
        return self._scrape.scrape_held()

    def scrape(self):
        """The same pass, refusing to run on an empty portfolio."""
        return self._scrape.scrape()

    def read_exchange_of(self) -> Dict[str, Optional[str]]:
        """Each held symbol's venue, for the pool sizing (#851, #619)."""
        return self._scrape.read_exchange_of()

    def rearm_regular_scrapes(self) -> Tuple[int, int]:
        """``(reached, at_market_open)`` for a new ``regular_interval`` (#701)."""
        return self._scrape.rearm_regular_scrapes()

    def _fetch_historical_data(self, symbol: str, start: datetime, end: datetime,
                               max_retries: int = 3) -> Optional[List[Dict]]:
        return self._backfill.fetch_historical_data(symbol, start, end,
                                                    max_retries)

    def _backfill_symbol(self, symbol: str,
                         window: Tuple[date, Optional[date]],
                         held: bool, now: datetime) -> Tuple[int, int]:
        return self._backfill.backfill_symbol(symbol, window, held, now)

    def _fetch_and_store(self, symbol, start_date, end_date):
        return self._backfill.fetch_and_store(symbol, start_date, end_date)

    def _backward_anchor(self, symbol: str, ceiling: datetime) -> datetime:
        return self._backfill.backward_anchor(symbol, ceiling)

    def _convert_history(self, symbol: str, prices: List[Dict]) -> None:
        return self._backfill.convert_history(symbol, prices)

    def _backfill_backward(self, symbol: str, target: datetime,
                           ceiling: datetime,
                           now: Optional[datetime] = None) -> int:
        return self._backfill.backward(symbol, target, ceiling, now)

    def _collapse_to_ladder(self, now: datetime) -> int:
        return self._backfill.collapse_to_ladder(now)

    def _record_window_tried(self, symbol: str, oldest: date) -> None:
        return self._backfill.record_window_tried(symbol, oldest)

    def _backfill_forward(self, symbol: str,
                          now: Optional[datetime] = None) -> int:
        return self._backfill.forward(symbol, now)

    def _learn_quote_currency(self, symbol: str) -> Tuple[Optional[str], bool]:
        return self._backfill.learn_quote_currency(symbol)

    def _backfill_lateral(self, symbol: str) -> int:
        return self._backfill.lateral(symbol)

    def backfill(self, now: Optional[datetime] = None):
        """One cycle — the ladder, then three passes a symbol (issue #705)."""
        return self._backfill.run(now)

    def _rebuild_series(self) -> Dict[str, Optional[date]]:
        """The pass itself — the seam the suite watches for overlap."""
        return self._recompute.rebuild_series()

    def update_account_metrics(self) -> Dict[str, Optional[date]]:
        """Rebuild the perf cache — **one pass at a time** (issue #812)."""
        return self._recompute.update_account_metrics()

    def recompute_perf(self) -> None:
        """Rebuild the perf cache, in full, every cycle — **guarded** (ADR-0011)."""
        return self._recompute.recompute()

    def ingest(self, force: bool = False):
        """The boot's bootstrap, and the replay that follows a write (#697)."""
        return self._ingestion.ingest(force)

    def _adopt_declared_currency(self) -> None:
        return self._ingestion.adopt_declared_currency()

    def reconstruction_state(self) -> Tuple[int, int]:
        """``(complete, total)`` — never ``None``, which is *unobservable*."""
        return self._ingestion.reconstruction_state()

    def review_installation_facts(self) -> None:
        """Re-observe the installation facts, record the one that is an event."""
        return self._ingestion.review_installation_facts()

    def repair_conversions_now(self) -> bool:
        """Put the lateral pass in front of the queue (issue #704). Did it move?"""
        return self._ingestion.repair_conversions_now()
