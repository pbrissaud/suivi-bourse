"""
SuiviBourse
Paul Brissaud
"""
import concurrent.futures
import os
import random
import sys
import threading
import time
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from typing import List, Dict, Optional, Tuple

import pandas as pd
import yaml
import yfinance as yf
from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.schedulers.blocking import BlockingScheduler
from cerberus import Validator
from confuse import Configuration, exceptions as ConfuseExceptions
from logfmt_logger import getLogger
from urllib3 import exceptions as u_exceptions
from yfinance.exceptions import YFRateLimitError

import performance
import scheduling
from events import (
    EventLoader, EventValidator, EventAggregator, EventWatcher,
    AccountMetricPoint, PortfolioTotalPoint,
)
from events.loader import EventLoaderError
from events.validator import EventValidationError
from events.aggregator import AggregationError
from events.schemas import EventType, Account, Portfolio, DEFAULT_ACCOUNT
from influxdb_writer import InfluxDBWriter
from prometheus_exporter import PrometheusExporter

LOG_LEVEL = os.getenv('LOG_LEVEL', default='INFO')
app_logger = getLogger("suivi_bourse", level=LOG_LEVEL)
scheduler_logger = getLogger("apscheduler.scheduler", level=LOG_LEVEL)
yfinance_logger = getLogger("yfinance", level=LOG_LEVEL)

# Cerberus schema for the opt-in `accounts:` block of settings.yaml. Declaring
# this block turns on first-class accounts; its absence leaves behaviour
# strictly unchanged.
ACCOUNTS_SCHEMA = {
    'accounts': {
        'type': 'list',
        'required': True,
        'empty': False,
        'schema': {
            'type': 'dict',
            'schema': {
                'id': {'type': 'string', 'required': True, 'empty': False},
                'type': {'type': 'string', 'required': True, 'empty': False},
                'currency': {'type': 'string', 'required': True, 'empty': False},
                'label': {'type': 'string', 'required': False},
            },
        },
    },
}


# Per-symbol scrape jobs are keyed ``scrape:<symbol>`` in the APScheduler
# jobstore (issue #616). One job per symbol — scraping is account-independent.
SCRAPE_JOB_PREFIX = 'scrape:'


def _scrape_job_id(symbol: str) -> str:
    return f'{SCRAPE_JOB_PREFIX}{symbol}'


# Pre-scheduler exchange capture for auto pool sizing (issue #619). At boot the
# whole app blocks on this before ``BlockingScheduler`` is even built, so the
# fetch is fanned out over a small bounded pool and hard-capped by an overall
# deadline — a slow / rate-limited yfinance session must not delay startup
# indefinitely. Symbols unresolved within the deadline fall back to solo markets.
_EXCHANGE_CAPTURE_WORKERS = 8
_EXCHANGE_CAPTURE_TIMEOUT_SECONDS = 30


def resolve_regular_interval() -> int:
    """Resolve the REGULAR-state poll interval (``base_interval``) from the env.

    Precedence (design #607): ``SB_REGULAR_INTERVAL`` > ``SB_SCRAPING_INTERVAL``
    (deprecated fallback) > ``120``. ``SB_SCRAPING_INTERVAL`` is the direct heir
    of the removed global scrape interval, so it is still honored as a fallback
    but a warning is logged whenever it is present — whether used or ignored.
    """
    new_val = os.getenv('SB_REGULAR_INTERVAL')
    old_val = os.getenv('SB_SCRAPING_INTERVAL')
    if old_val is not None:
        if new_val is not None:
            app_logger.warning(
                "SB_SCRAPING_INTERVAL is deprecated and ignored because "
                "SB_REGULAR_INTERVAL is set; remove SB_SCRAPING_INTERVAL.")
        else:
            app_logger.warning(
                "SB_SCRAPING_INTERVAL is deprecated; prefer SB_REGULAR_INTERVAL. "
                "Honoring it as a fallback for now.")
    if new_val is not None:
        return int(new_val)
    if old_val is not None:
        return int(old_val)
    return 120


def resolve_executor_pool_size(mode: str, shares: List[dict],
                               capture_exchange_of) -> int:
    """Resolve the APScheduler executor-pool size from the two dials (issue #619).

    ``SB_DYNAMIC_EXECUTOR_POOL`` (default ``false``) picks fixed vs auto:

      * ``false`` → a fixed pool of ``SB_EXECUTOR_POOL`` (default ``10``) —
        identical to today's behaviour on upgrade (APScheduler's default pool is
        also 10).
      * ``true``  → ``scheduling.compute_pool_size`` over same-exchange cohorts.
        ``capture_exchange_of`` (a zero-arg callable → ``{symbol: exchange}``,
        e.g. the ``SuiviBourseMetrics`` method of the same name) is invoked
        **only** on this path, so the fixed default never triggers the
        pre-scheduler exchange fetch. If ``SB_EXECUTOR_POOL`` is also set it is
        ignored, with a warning (convention of #607).

    Always ``>= 1``. ``POOL_CAP`` bounds only the auto formula, never the fixed
    dial (operator freedom, design #611).
    """
    auto = os.getenv('SB_DYNAMIC_EXECUTOR_POOL', 'false').lower() == 'true'
    fixed_raw = os.getenv('SB_EXECUTOR_POOL')
    if not auto:
        fixed = int(fixed_raw) if fixed_raw is not None else 10
        return max(1, fixed)
    if fixed_raw is not None:
        app_logger.warning(
            "SB_EXECUTOR_POOL is ignored because SB_DYNAMIC_EXECUTOR_POOL is "
            "enabled; the executor pool is sized automatically.")
    return scheduling.compute_pool_size(mode, shares, capture_exchange_of())


def register_interval_jobs(scheduler, sb_metrics, ingestion_interval: int,
                           backfill_interval: int, perf_interval: int) -> None:
    """Register the three fixed-cadence interval jobs on ``scheduler``.

    Kept separate from the per-symbol scrape jobs (issue #616), which are ``date``
    triggers armed by ``ingest``/``_reconcile_jobs`` under the ``scrape:`` id
    prefix. The perf recompute is its own job at ``SB_PERF_INTERVAL`` (issue
    #618), never piggybacked on the scrape. Extracted from ``__main__`` so the
    wiring is unit-testable against a spy scheduler.
    """
    scheduler.add_job(
        sb_metrics.ingest, 'interval',
        seconds=ingestion_interval,
        id='ingest',
        name='Event ingestion')
    scheduler.add_job(
        sb_metrics.backfill, 'interval',
        seconds=backfill_interval,
        id='backfill',
        name='Historical backfill')
    scheduler.add_job(
        sb_metrics.recompute_perf, 'interval',
        seconds=perf_interval,
        id='perf',
        name='Performance recompute')


class InvalidConfigFile(Exception):
    def __init__(self, errors_):
        self.errors = errors_
        self.message = 'Shares field of the config file is invalid :' + \
            str(self.errors)
        super().__init__(self.message)


class ConfigurationManager:
    """
    Manages configuration loading from either manual config or events files.
    Includes caching to avoid reloading unchanged files.
    """

    MODE_MANUAL = 'manual'
    MODE_EVENTS = 'events'

    def __init__(self, config_dir: Optional[str] = None):
        """
        Initialize the configuration manager.

        Args:
            config_dir: Override configuration directory (for testing).
        """
        if config_dir:
            self.config_dir = Path(config_dir).expanduser()
        else:
            self.config_dir = Path('~/.config/SuiviBourse').expanduser()

        self.settings_path = self.config_dir / 'settings.yaml'
        self._mode: Optional[str] = None
        self._events_source: Optional[str] = None
        self._watch_enabled: bool = False
        # Declared accounts (opt-in). None means no accounts block was declared.
        self._accounts: Optional[Portfolio] = None
        self._confuse_config: Optional[Configuration] = None
        self._watcher: Optional[EventWatcher] = None
        self._reload_callback: Optional[callable] = None

        # Cache for events mode
        self._cached_shares: Optional[List[Dict]] = None
        self._cache_key: Optional[str] = None

        # Store raw events for backfill date calculation
        self._cached_events: Optional[List] = None

    def _load_settings(self) -> None:
        """Load settings from settings.yaml or environment."""
        # Read settings.yaml once (if present) so the accounts block is available
        # regardless of how the mode is ultimately selected.
        settings = {}
        if self.settings_path.exists():
            with open(self.settings_path, 'r', encoding='utf-8') as f:
                settings = yaml.safe_load(f) or {}

        # Priority 1: Environment variable
        env_mode = os.getenv('SB_CONFIG_MODE')
        if env_mode:
            self._mode = env_mode.lower()
            app_logger.info(f"Using config mode from environment: {self._mode}")
        # Priority 2: settings.yaml
        elif self.settings_path.exists():
            self._mode = settings.get('mode', self.MODE_MANUAL).lower()
            events_settings = settings.get('events', {})
            self._events_source = events_settings.get('source')
            self._watch_enabled = events_settings.get('watch', False)
            app_logger.info(f"Using config mode from settings.yaml: {self._mode}")
        # Priority 3: Default to manual
        else:
            self._mode = self.MODE_MANUAL
            app_logger.info(f"No settings found, using default mode: {self._mode}")

        # Accounts are an opt-in feature declared in settings.yaml, independent of
        # how the mode was selected. Absence leaves behaviour strictly unchanged.
        self._accounts = self._parse_accounts(settings.get('accounts'))
        if self._accounts is not None:
            app_logger.info(
                f"Loaded {len(self._accounts.accounts)} declared account(s): "
                f"{', '.join(sorted(self._accounts.ids()))}")

        # Default events source if not specified
        if self._mode == self.MODE_EVENTS and not self._events_source:
            self._events_source = str(self.config_dir / 'events')

    def _parse_accounts(self, raw) -> Optional[Portfolio]:
        """Validate and build the declared accounts from the raw settings block.

        Returns None when no accounts are declared (opt-out). Raises ValueError
        on a malformed block or duplicate account ids.
        """
        if not raw:
            return None

        validator = Validator(ACCOUNTS_SCHEMA)
        if not validator.validate({'accounts': raw}):
            raise ValueError(
                f"Invalid 'accounts' block in settings.yaml: {validator.errors}")

        accounts = [
            Account(
                id=a['id'],
                type=a['type'],
                currency=a['currency'],
                label=a.get('label', a['id']),
            )
            for a in raw
        ]

        ids = [a.id for a in accounts]
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        if duplicates:
            raise ValueError(
                f"Duplicate account id(s) in settings.yaml: {duplicates}")

        return Portfolio(accounts=accounts)

    def load_accounts(self) -> Optional[Portfolio]:
        """Return the declared accounts, or None when none are declared.

        The None return is the single signal that later gates per-account series
        publication (see the accounts roadmap).
        """
        if self._mode is None:
            self._load_settings()
        return self._accounts

    def get_mode(self) -> str:
        """Get the current configuration mode."""
        if self._mode is None:
            self._load_settings()
        return self._mode

    def _compute_cache_key(self) -> Optional[str]:
        """Compute a cache key based on event files' modification times."""
        if self._mode != self.MODE_EVENTS:
            return None

        source = Path(self._events_source).expanduser()
        if not source.exists():
            return None

        # Build cache key from file paths and their mtimes
        mtimes = []
        if source.is_file():
            mtimes.append(f"{source}:{source.stat().st_mtime}")
        elif source.is_dir():
            for f in sorted(source.iterdir()):
                if f.suffix.lower() in ('.csv', '.xlsx'):
                    mtimes.append(f"{f}:{f.stat().st_mtime}")

        return "|".join(mtimes) if mtimes else None

    def load_shares(self, force: bool = False) -> List[Dict]:
        """
        Load shares configuration based on the current mode.

        Args:
            force: Force reload even if cache is valid.

        Returns:
            List of share configurations.

        Raises:
            EventLoaderError, EventValidationError, AggregationError: If events mode fails.
            ConfuseExceptions.NotFoundError: If manual mode fails.
        """
        if self._mode is None:
            self._load_settings()

        if self._mode == self.MODE_EVENTS:
            return self._load_from_events(force=force)
        else:
            return self._load_from_manual()

    def _load_from_events(self, force: bool = False) -> List[Dict]:
        """Load shares from event files with caching."""
        # Check cache validity
        current_key = self._compute_cache_key()

        if not force and self._cached_shares is not None and current_key == self._cache_key:
            app_logger.debug("Using cached shares (no file changes detected)")
            return self._cached_shares

        source = Path(self._events_source).expanduser()
        app_logger.info(f"Loading events from: {source}")

        loader = EventLoader(str(source))
        events = loader.load()

        if not events:
            app_logger.warning("No events found in events directory")
            self._cached_shares = []
            self._cached_events = []
            self._cache_key = current_key
            return []

        # When accounts are declared, every event must carry a valid account and
        # positions are keyed per account; otherwise everything falls under
        # 'default' (a single code path either way).
        account_ids = self._accounts.ids() if self._accounts else None

        validator = EventValidator(account_ids=account_ids)
        validator.validate_or_raise(events)

        aggregator = EventAggregator()
        shares = aggregator.aggregate(events, accounts_declared=account_ids is not None)

        # Update cache
        self._cached_shares = shares
        self._cached_events = events
        self._cache_key = current_key

        app_logger.info(f"Loaded {len(events)} events for {len(shares)} shares")
        return shares

    def _load_from_manual(self) -> List[Dict]:
        """Load shares from manual config.yaml."""
        if self._confuse_config is None:
            self._confuse_config = Configuration('SuiviBourse', __name__)
        else:
            self._confuse_config.reload()

        return self._confuse_config['shares'].get()

    def get_first_buy_date(self, symbol: str) -> Optional[datetime]:
        """
        Get the date of the first BUY event for a symbol.

        Args:
            symbol: Yahoo Finance ticker symbol

        Returns:
            Date of first BUY event, or None if not found
        """
        if self._cached_events is None:
            return None

        buy_dates = [
            e.date for e in self._cached_events
            if e.symbol == symbol and e.event_type == EventType.BUY
        ]

        if not buy_dates:
            return None

        return min(buy_dates)

    def get_events(self) -> Optional[List]:
        """
        Get the cached events list.

        Returns:
            List of events, or None if not in events mode or no events loaded.
        """
        return self._cached_events

    def start_watcher(self, reload_callback: callable) -> None:
        """
        Start watching for event file changes.

        Args:
            reload_callback: Function to call when files change.
        """
        if self._mode != self.MODE_EVENTS or not self._watch_enabled:
            return

        if self._watcher is not None:
            return

        source = Path(self._events_source).expanduser()
        if not source.exists():
            app_logger.warning(f"Events directory does not exist, skipping watcher: {source}")
            return

        self._reload_callback = reload_callback

        def on_change():
            app_logger.info("Event files changed, triggering reload...")
            try:
                reload_callback()
            except Exception as e:
                app_logger.error(f"Error during hot-reload: {e}")

        self._watcher = EventWatcher(str(source), on_change)
        self._watcher.start()
        app_logger.info(f"Started watching for event file changes: {source}")

    def stop_watcher(self) -> None:
        """Stop the file watcher."""
        if self._watcher is not None:
            self._watcher.stop()
            self._watcher = None
            app_logger.info("Stopped event file watcher")

    def invalidate_cache(self) -> None:
        """Invalidate the shares cache, forcing a reload on next load_shares call."""
        self._cached_shares = None
        self._cached_events = None
        self._cache_key = None
        app_logger.debug("Cache invalidated")


class SuiviBourseMetrics:
    """
    Class for managing and exposing metrics related to stock shares.
    """

    def __init__(self, config_manager: ConfigurationManager, validator_: Validator,
                 configuration_: Optional[Configuration] = None,
                 influxdb_writer: Optional[InfluxDBWriter] = None,
                 prometheus_exporter: Optional[PrometheusExporter] = None):
        self.config_manager = config_manager
        self.configuration = configuration_  # For backward compatibility
        self.validator = validator_
        self.shares = config_manager.load_shares()

        # InfluxDB writer
        self.influxdb = influxdb_writer or InfluxDBWriter()
        self.influxdb.connect()

        # Prometheus exporter (legacy /metrics endpoint, on by default for
        # backward compatibility). The HTTP server is started separately.
        self.prometheus = prometheus_exporter
        if self.prometheus is None and \
                os.getenv('SB_PROMETHEUS_ENABLED', 'true').lower() == 'true':
            self.prometheus = PrometheusExporter()

        # Backfill configuration
        self.backfill_delay = int(os.getenv('SB_BACKFILL_DELAY', '10'))
        self.backfill_chunk_days = int(os.getenv('SB_BACKFILL_CHUNK_DAYS', '365'))

        # Market-aware per-symbol scheduling (issue #616). Each held symbol runs
        # as its own self-rescheduling APScheduler job; the scheduler is injected
        # from __main__ (None until then, so unit tests that never wire it skip
        # reconciliation). `regular_interval` is the REGULAR-state poll cadence
        # (base_interval), overridden from the environment in __main__.
        # `_failure_counts` holds the per-symbol consecutive-failure count fed to
        # scheduling.decide for the dead-ticker backoff (issue #617); it is
        # dropped in _reconcile_jobs when a symbol departs so state is per-job.
        # Written by the scrape thread and popped by the ingest/reconcile thread
        # (APScheduler's default ThreadPoolExecutor runs jobs concurrently), so
        # guarded by `_failure_counts_lock`: without it, an in-flight scrape of a
        # just-departed symbol could resurrect its counter after cleanup.
        self.scheduler: Optional[BlockingScheduler] = None
        self.regular_interval = 120
        self._failure_counts: Dict[str, int] = {}
        self._failure_counts_lock = threading.Lock()

        # Cache for share info (to avoid repeated API calls during backfill)
        self._share_info_cache: Dict[str, Dict] = {}

        # Track (symbol, account) pairs whose backfill has reached the first BUY
        # date, mapped to that date so an earlier newly-added event re-triggers
        # backfill for that account.
        self._backfill_complete: Dict[Tuple[str, str], datetime] = {}

        # Incremental perf-series write watermark (issue #597). Rewriting the
        # whole daily account_metrics/portfolio_totals series every scrape cycle
        # lands new, never-compacted Parquet files on InfluxDB 3 Core, so file
        # count grows without bound. Instead we rewrite only the stale tail:
        #   _perf_dirty_from — earliest day backfill has newly filled since the
        #     last write (None = nothing earlier than today is stale). Written by
        #     the backfill thread, read/reset by the scrape thread, so guarded by
        #     _perf_lock.
        #   _perf_last_events — the events list object fed to the last write; a
        #     new object means the events cache was reloaded (files changed) and
        #     the whole series must be rewritten. Touched only on the perf-job
        #     thread (recompute_perf/update_account_metrics), so it needs no lock.
        #   _perf_dirty_live — a single global bool set on the REGULAR write path
        #     in _scrape_symbol (issue #618): the live-write trigger for the
        #     gated perf job, alongside the two above. Written by the scrape
        #     threads and checked-and-cleared by the perf-job thread, so guarded
        #     by _perf_lock. Seeded True at boot so today's point is always fresh
        #     after a weekend/overnight restart.
        self._perf_lock = threading.Lock()
        self._perf_dirty_from: Optional[date] = None
        self._perf_last_events: Optional[List] = None
        self._perf_dirty_live: bool = True

    def validate(self) -> bool:
        """
        Validate the configuration for the stock shares.
        Returns:
            bool: True if the configuration is valid, False otherwise.
        """
        return self.validator.validate({"shares": self.shares})

    def _fetch_ticker_data(self, symbol: str, max_retries: int = 3):
        """
        Fetch ticker data from yfinance with retry logic for rate limiting.

        Args:
            symbol: The stock symbol to fetch
            max_retries: Maximum number of retry attempts

        Returns:
            Tuple of (last_quote, info_dict) or (None, None) if fetch fails
        """
        for attempt in range(max_retries):
            try:
                ticker = yf.Ticker(symbol)
                ticker_history = ticker.history()
                if ticker_history.empty:
                    app_logger.warning(f"No price history returned for {symbol}")
                    return None, None
                last_row = ticker_history.tail(1)
                last_quote = last_row['Close'].iloc[0]
                # Guard against a NaN close (holiday / partial bar): treat it as
                # no data so we never write a NaN price to InfluxDB.
                if pd.isna(last_quote):
                    app_logger.warning(f"Latest close price is NaN for {symbol}, skipping")
                    return None, None
                # Get hourly volume instead of daily volume
                ticker_history_hourly = ticker.history(period='1d', interval='1h')
                if not ticker_history_hourly.empty and 'Volume' in ticker_history_hourly.columns:
                    last_volume = ticker_history_hourly.tail(1)['Volume'].iloc[0]
                else:
                    last_volume = None
                ticker_info = ticker.info
                info = {
                    'currency': ticker_info.get('currency', 'undefined'),
                    'exchange': ticker_info.get('exchange', 'undefined'),
                    'quoteType': ticker_info.get('quoteType', 'undefined'),
                    'dividendYield': ticker_info.get('dividendYield'),
                    'peRatio': ticker_info.get('trailingPE') or ticker_info.get('forwardPE'),
                    'marketCap': ticker_info.get('marketCap'),
                    'volume': int(last_volume) if pd.notna(last_volume) else None,
                    # Market-context fields feed the per-symbol scheduler
                    # (scheduling.extract_market_context). They ride on `info`
                    # so _fetch_ticker_data keeps its (last_quote, info) shape;
                    # _history_meta carries currentTradingPeriod for the exact
                    # next-open. Extra keys are ignored by the write path.
                    'marketState': ticker_info.get('marketState'),
                    'exchangeTimezoneName': ticker_info.get('exchangeTimezoneName'),
                    '_history_meta': getattr(ticker, 'history_metadata', None),
                }
                # Cache the info for backfill use
                self._share_info_cache[symbol] = info
                return last_quote, info
            except YFRateLimitError:
                if attempt < max_retries - 1:
                    wait_time = 2 ** (attempt + 1)
                    app_logger.warning(
                        f"Rate limited for {symbol}, retrying in {wait_time}s "
                        f"(attempt {attempt + 1}/{max_retries})")
                    time.sleep(wait_time)
                else:
                    app_logger.error(
                        f"Rate limited for {symbol}, max retries exceeded")
                    return None, None
            except (u_exceptions.NewConnectionError, RuntimeError):
                app_logger.error(
                    "Error while retrieving data from Yfinance API",
                    exc_info=True)
                return None, None
        return None, None

    def _fetch_historical_data(self, symbol: str, start: datetime, end: datetime,
                               max_retries: int = 3) -> Optional[List[Dict]]:
        """
        Fetch historical price data from yfinance.

        Args:
            symbol: Stock symbol
            start: Start date
            end: End date
            max_retries: Maximum retry attempts

        Returns:
            List of dicts with 'timestamp' and 'price' keys, or None on failure
        """
        for attempt in range(max_retries):
            try:
                ticker = yf.Ticker(symbol)
                # Use hourly interval for data within 730 days, daily for older
                days_ago = (datetime.now(timezone.utc) - start).days
                interval = '1h' if days_ago <= 729 else '1d'
                history = ticker.history(start=start, end=end, interval=interval)

                if history.empty:
                    app_logger.debug(f"No historical data for {symbol} from {start} to {end}")
                    return []

                prices = []
                for idx, row in history.iterrows():
                    # Skip rows without a valid close price (holidays / partial
                    # bars come back as NaN) so no NaN point reaches InfluxDB.
                    close = row['Close']
                    if pd.isna(close):
                        continue
                    # idx is a pandas Timestamp
                    ts = idx.to_pydatetime()
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    prices.append({
                        'timestamp': ts,
                        'price': float(close),
                        'price_open': float(row['Open']) if pd.notna(row['Open']) else None,
                        'price_high': float(row['High']) if pd.notna(row['High']) else None,
                        'price_low': float(row['Low']) if pd.notna(row['Low']) else None,
                        'volume': int(row['Volume']) if 'Volume' in row and pd.notna(row['Volume']) else None
                    })

                return prices

            except YFRateLimitError:
                if attempt < max_retries - 1:
                    wait_time = self.backfill_delay * (2 ** attempt)
                    app_logger.warning(
                        f"Rate limited fetching history for {symbol}, "
                        f"retrying in {wait_time}s (attempt {attempt + 1}/{max_retries})")
                    time.sleep(wait_time)
                else:
                    app_logger.error(
                        f"Rate limited fetching history for {symbol}, max retries exceeded")
                    return None
            except Exception as e:
                app_logger.error(f"Error fetching history for {symbol}: {e}")
                return None

        return None

    def _update_share_prometheus(self, share, last_quote, info) -> None:
        """Update the legacy Prometheus ``sb_share_*`` gauges for one share.

        Kept independent of the InfluxDB write so ``/metrics`` stays populated
        even if InfluxDB errors, and gated by the caller on **fetch success**
        (price present) rather than the write/REGULAR gate — a closed-market
        restart must still leave the share gauges populated (design #609).
        """
        if self.prometheus is None:
            return
        try:
            self.prometheus.update_share(share, last_quote, info)
        except Exception as e:
            app_logger.error(
                f"Failed to update Prometheus metrics for {share['symbol']}: {e}")

    def _write_share_metrics(self, share, last_quote, info) -> bool:
        """Write one share's live metrics point to InfluxDB.

        Guarded so a transient InfluxDB error on one share does not abort the
        surrounding cycle. Callers only invoke this once the fetch succeeded, so
        currency/exchange/quote_type tags are always present and the point lands
        in the same enriched series as its history. Returns whether the point
        was actually persisted, so callers can tell a real write from a
        swallowed failure (issue #618 — an all-failed wave must not raise the
        perf dirty flag).
        """
        try:
            self.influxdb.write_metrics(
                share_name=share['name'],
                share_symbol=share['symbol'],
                account=share.get('account', DEFAULT_ACCOUNT),
                share_price=last_quote,
                purchased_quantity=share['purchase']['quantity'],
                purchased_price=share['purchase']['cost_price'],
                purchased_fee=share['purchase']['fee'],
                owned_quantity=share['estate']['quantity'],
                received_dividend=share['estate']['received_dividend'],
                share_currency=info['currency'],
                share_exchange=info['exchange'],
                quote_type=info['quoteType'],
                dividend_yield=info['dividendYield'] * 100 if info['dividendYield'] is not None else None,
                pe_ratio=info['peRatio'],
                market_cap=info['marketCap'],
                volume=info['volume']
            )
            return True
        except Exception as e:
            app_logger.error(
                f"Failed to write metrics for {share['symbol']}: {e}")
            return False

    def expose_metrics(self):
        """
        Expose the metrics for each stock share to InfluxDB.

        Synchronous whole-portfolio scrape kept for the manual/backward-compat
        path; the scheduled runtime drives per-symbol jobs via ``_scrape_symbol``.
        """
        for share in self.shares:
            share_symbol = share['symbol']

            last_quote, info = self._fetch_ticker_data(share_symbol)
            self._update_share_prometheus(share, last_quote, info)

            # Skip writing when the fetch failed: writing portfolio fields with
            # missing currency/exchange/quote_type tags would land them in a
            # different InfluxDB series than the enriched (tagged) points.
            if last_quote is None or info is None:
                app_logger.warning(
                    f"No data fetched for {share_symbol}, skipping metrics write")
            else:
                self._write_share_metrics(share, last_quote, info)

    # ------------------------------------------------------------------ #
    # Market-aware per-symbol scheduling (issue #616)
    # ------------------------------------------------------------------ #

    def _held_symbols(self) -> set:
        """The set of symbols currently held across all accounts."""
        return {s['symbol'] for s in self.shares if s.get('symbol')}

    @staticmethod
    def _exchange_from_info(info: Optional[dict]) -> Optional[str]:
        """The exchange from a ticker ``info`` dict, or ``None``.

        ``None`` for a failed fetch or the ``'undefined'`` sentinel (yfinance's
        default for a missing exchange), so ``compute_pool_size`` treats the
        symbol as a solo market rather than grouping every unknown into one giant
        cohort.
        """
        exchange = (info or {}).get('exchange')
        return exchange if exchange and exchange != 'undefined' else None

    def capture_exchange_of(self) -> Dict[str, Optional[str]]:
        """Map each held symbol to its exchange for auto pool sizing (#619, #611).

        Same-exchange cohorts drive ``scheduling.compute_pool_size``, but the
        exchange lives only in the yfinance ``info`` — not the config — so we fetch
        it once up front, before the scheduler's executor is fixed at construction
        (the design's "pre-scheduler scrape"). Reuses the shared
        ``_share_info_cache`` so a symbol already fetched isn't fetched twice.

        The whole app blocks here at boot, so the uncached symbols are fetched
        concurrently over a bounded pool (``_EXCHANGE_CAPTURE_WORKERS``) and the
        collection is hard-capped by ``_EXCHANGE_CAPTURE_TIMEOUT_SECONDS``: a slow
        or rate-limited yfinance session can't delay scheduler startup
        indefinitely. Any symbol that fails or doesn't resolve in time maps to
        ``None`` — a solo market (see ``_exchange_from_info``).

        Only called on the auto path (``SB_DYNAMIC_EXECUTOR_POOL=true``), so the
        fixed-pool default never pays this fetch cost.
        """
        exchange_of: Dict[str, Optional[str]] = {}
        to_fetch = []
        for symbol in sorted(self._held_symbols()):
            info = self._share_info_cache.get(symbol)
            if info is None:
                to_fetch.append(symbol)
                exchange_of[symbol] = None  # solo unless the fetch resolves below
            else:
                exchange_of[symbol] = self._exchange_from_info(info)

        if not to_fetch:
            return exchange_of

        pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=min(_EXCHANGE_CAPTURE_WORKERS, len(to_fetch)))
        futures = {pool.submit(self._fetch_ticker_data, s): s for s in to_fetch}
        try:
            for future in concurrent.futures.as_completed(
                    futures, timeout=_EXCHANGE_CAPTURE_TIMEOUT_SECONDS):
                symbol = futures[future]
                try:
                    _, info = future.result()
                except Exception as e:
                    app_logger.warning(
                        f"Exchange capture failed for {symbol}, treating as a "
                        f"solo market: {e}")
                    continue
                exchange_of[symbol] = self._exchange_from_info(info)
        except concurrent.futures.TimeoutError:
            unresolved = sorted(s for f, s in futures.items() if not f.done())
            app_logger.warning(
                f"Exchange capture timed out after "
                f"{_EXCHANGE_CAPTURE_TIMEOUT_SECONDS}s; treating "
                f"{len(unresolved)} symbol(s) as solo markets: "
                f"{', '.join(unresolved)}")
        finally:
            # Don't block startup joining slow/hung in-flight fetches; cancel what
            # hasn't started yet (cancel_futures: py3.9+).
            pool.shutdown(wait=False, cancel_futures=True)
        return exchange_of

    def _scheduled_symbols(self) -> set:
        """Symbols that currently have a live per-symbol scrape job."""
        out = set()
        for job in (self.scheduler.get_jobs() or []):
            jid = getattr(job, 'id', '') or ''
            if jid.startswith(SCRAPE_JOB_PREFIX):
                out.add(jid[len(SCRAPE_JOB_PREFIX):])
        return out

    def _arm_symbol(self, symbol: str, delay: float, now: datetime) -> None:
        """(Re)schedule a symbol's scrape job to fire ``delay`` seconds from now.

        A single ``date`` trigger — the job re-arms itself each cycle, so this is
        both the immediate bootstrap (``delay=0``) and the self-reschedule.

        Anti-herd jitter (issue #619): offset every arming by a fresh
        ``uniform(0, JITTER_SECONDS)`` — the heir of the removed inter-share
        ``time.sleep(1)``. A same-exchange cohort sharing one next-open thus
        spreads over ``[open, open + JITTER_SECONDS]``, and the ``REGULAR``-poll
        lockstep is re-randomized each cycle. A ``date`` trigger can't carry
        APScheduler's own ``jitter`` (only interval/cron can), so we apply it to
        ``run_date`` directly, mirroring APScheduler's ``uniform(0, jitter)``.

        ``misfire_grace_time=None`` (run however late): under per-symbol jobs each
        job *is* its own scheduler (it re-arms inside ``_scrape_symbol``), so a
        misfired-and-skipped run would permanently kill the symbol and ingest()'s
        set-diff wouldn't revive it. Running late is safe — the on-wake
        ``marketState`` re-read (#608/#616) self-corrects. ``max_instances=1``
        (no overlap; ``coalesce`` is moot with one pending run per job).
        """
        jitter = random.uniform(0, scheduling.JITTER_SECONDS)
        run_date = now + timedelta(seconds=delay + jitter)
        self.scheduler.add_job(
            self._scrape_symbol, 'date', run_date=run_date,
            args=[symbol], id=_scrape_job_id(symbol),
            name=f'Scrape {symbol}', replace_existing=True,
            misfire_grace_time=None, max_instances=1)

    def _reconcile_jobs(self) -> None:
        """Diff the held-symbol set against the scheduled jobs (design #604).

        New **and** revived (missing) symbols are armed to fire immediately (the
        first fire is the bootstrap); departed symbols are ``remove_job``'d;
        unchanged symbols keep their existing timers untouched. Guarded so a
        scheduler hiccup never aborts ingestion.
        """
        if self.scheduler is None:
            return
        try:
            now = datetime.now(timezone.utc)
            held = self._held_symbols()
            scheduled = self._scheduled_symbols()
        except Exception as e:
            app_logger.error(f"Failed to reconcile per-symbol jobs: {e}")
            return
        # Add new + revive missing in one pass: any held symbol without a live
        # job fires immediately. Remove departed symbols' idle jobs (belt-and-
        # braces with the in-flight membership re-check in _scrape_symbol).
        # Each op is guarded on its own so one failure — e.g. a JobLookupError
        # from a self-re-arming date job that just fired and vanished — never
        # aborts the rest of the reconcile pass.
        for symbol in held - scheduled:
            try:
                self._arm_symbol(symbol, 0, now)
            except Exception as e:
                app_logger.error(f"Failed to arm scrape job for {symbol}: {e}")
        for symbol in scheduled - held:
            try:
                self.scheduler.remove_job(_scrape_job_id(symbol))
            except Exception as e:
                app_logger.debug(f"Job for {symbol} already gone, skipping: {e}")
            finally:
                # Failure-backoff state is per-job (issue #617): drop it when the
                # symbol departs so a later revival starts fresh at base_interval
                # rather than inheriting a stale dead-ticker backoff. Under the
                # shared lock so a concurrent in-flight scrape (which re-checks
                # membership under the same lock) can't write the entry back.
                with self._failure_counts_lock:
                    self._failure_counts.pop(symbol, None)

    def _scrape_symbol(self, symbol: str, now: Optional[datetime] = None) -> None:
        """Scrape one symbol, gate the write, and re-arm the job (design #602).

        Fetch once, then apply ``scheduling.decide`` to split the two gates:
        the write gate (not-closed AND price present) and the reschedule gate
        (closed → sleep to next open, else ``base_interval``). Writes one point
        per account holding this symbol. Re-arms only while the symbol is still
        held (the in-flight half of the self-reschedule↔removal race guard).
        """
        injected_now = now is not None
        now = now or datetime.now(timezone.utc)
        last_quote, info = self._fetch_ticker_data(symbol)
        price_present = last_quote is not None and info is not None

        holdings = [s for s in self.shares if s.get('symbol') == symbol]

        # Prometheus sb_share_* gauges stay on the fetch-success gate (#609),
        # never the write/REGULAR gate.
        if price_present:
            for share in holdings:
                self._update_share_prometheus(share, last_quote, info)

        if info is not None:
            state, next_open = scheduling.extract_market_context(
                info, info.get('_history_meta'), now)
        else:
            # Fetch failed outright: no state to read, fail-open as REGULAR so a
            # transient failure keeps the job polling rather than sleeping it.
            state, next_open = None, None

        with self._failure_counts_lock:
            should_write, next_delay, new_failure_count, mark_dirty = scheduling.decide(
                state, price_present, next_open, now,
                self._failure_counts.get(symbol, 0), self.regular_interval)
            # Persist the backoff counter only while the symbol is still held. A
            # concurrent ingest() reconcile may have removed it (and popped its
            # entry) between this cycle's fetch and here; the held-recheck under
            # the shared lock stops this write from resurrecting a departed
            # symbol's counter after cleanup (issue #617 race). Both branches run
            # under the lock so the reconcile pop can't interleave mid-decision.
            if symbol in self._held_symbols():
                self._failure_counts[symbol] = new_failure_count
            else:
                self._failure_counts.pop(symbol, None)

        if should_write:
            wrote_live_data = False
            for share in holdings:
                wrote = self._write_share_metrics(share, last_quote, info)
                wrote_live_data = wrote_live_data or wrote
            # A REGULAR write makes today's perf series stale: raise the global
            # live-write dirty bool so the gated perf job (issue #618) runs its
            # next cycle. One flag for the whole market-open wave — it coalesces
            # N symbols' writes into a single recompute by construction. Only
            # when a point actually persisted — an all-failed Influx outage
            # must not trigger a perf recompute with nothing new to read.
            if mark_dirty and wrote_live_data:
                with self._perf_lock:
                    self._perf_dirty_live = True
        else:
            app_logger.debug(
                f"Skipping write for {symbol} (state={state}, "
                f"price_present={price_present})")

        # Re-arm only if still held — the in-flight guard against a job that was
        # removed mid-cycle re-adding itself after reconcile's remove_job.
        if self.scheduler is not None and symbol in self._held_symbols():
            # Schedule from a fresh wall-clock, not the decision `now` captured
            # before the fetch: _fetch_ticker_data can sleep on rate-limit
            # retries, which for a small next_delay would otherwise put run_date
            # in the past and let APScheduler drop the job, breaking the
            # self-reschedule chain. Tests inject `now` to keep run_date
            # deterministic; production recomputes it here.
            arm_now = now if injected_now else datetime.now(timezone.utc)
            self._arm_symbol(symbol, next_delay, arm_now)

    def recompute_perf(self) -> None:
        """Recompute the perf series as its own gated interval job (#605, #618).

        Now that per-symbol jobs replaced the global scrape loop, the
        account_metrics/portfolio_totals recompute runs as its own scheduled
        job at ``SB_PERF_INTERVAL`` — never inside the scrape, which would fire N
        recomputes per market-open wave.

        Read the three dirty signals up front and gate on
        ``scheduling.perf_should_run`` so a fully-closed market wave writes
        nothing (no closed-day Parquet drip, #597/#606):
          * the live-write bool ``_perf_dirty_live`` — set on the REGULAR write
            path in ``_scrape_symbol``; **checked-and-cleared here** under
            ``_perf_lock`` (seeded True at boot so today's point is fresh after
            an overnight restart).
          * the backfill watermark ``_perf_dirty_from`` — merely *checked* here;
            its consume/clear stays in ``update_account_metrics``.
          * ``events_changed`` — a reloaded events cache (a new list object).

        Guarded so an error never kills the scheduler thread.
        """
        with self._perf_lock:
            live_write = self._perf_dirty_live
            self._perf_dirty_live = False
            backfill_pending = self._perf_dirty_from is not None
        events = self.config_manager.get_events()
        events_changed = events is not self._perf_last_events
        if not scheduling.perf_should_run(events_changed, backfill_pending, live_write):
            app_logger.debug(
                "Perf recompute skipped: nothing changed since last run")
            return
        try:
            self.update_account_metrics()
        except Exception as e:
            # The live-write signal was consumed up front (for concurrency), so a
            # failed write would otherwise drop today's fresh point until the next
            # REGULAR scrape re-sets the flag. Re-arm it on error so the next
            # cycle retries, mirroring the _perf_dirty_from re-arm inside
            # update_account_metrics.
            if live_write:
                with self._perf_lock:
                    self._perf_dirty_live = True
            app_logger.error(f"Failed to update account metrics: {e}")

    def ingest(self):
        """
        Ingest events and update shares configuration.
        This is called on a separate schedule from scraping.
        Uses caching to avoid reloading unchanged files.

        Errors are logged but not raised to avoid blocking the scraping job.
        The previous valid configuration is kept until the error is fixed.
        """
        try:
            new_shares = self.config_manager.load_shares()
            if new_shares != self.shares:
                if not self.validator.validate({"shares": new_shares}):
                    app_logger.error(
                        f"Invalid shares configuration, keeping previous: "
                        f"{self.validator.errors}")
                    return
                self.shares = new_shares
                app_logger.info("Shares configuration updated from events")
            else:
                app_logger.debug("No changes in shares configuration")
        except Exception as e:
            app_logger.error(f"Error during ingestion (keeping previous config): {e}")

        # Reconcile the per-symbol scrape jobs against the (possibly unchanged)
        # held-symbol set. Idempotent and always run — on the first ingest it
        # arms every symbol, later it only touches the diff. No-op until the
        # scheduler is wired in __main__.
        self._reconcile_jobs()

    def backfill(self):
        """
        Backfill historical price data for all shares.
        This runs as a third scheduled job, progressively filling gaps.

        For each share:
        1. Find the first BUY date from events
        2. Check the oldest data point in InfluxDB
        3. If there's a gap, fetch one chunk (default: 1 year) of history
        4. Rate limit between requests
        """
        if not self.shares:
            app_logger.debug("No shares configured, skipping backfill")
            return

        # Only backfill in events mode where we have event history
        if self.config_manager.get_mode() != ConfigurationManager.MODE_EVENTS:
            app_logger.debug("Backfill only available in events mode")
            return

        app_logger.info("Starting backfill cycle")
        backfilled_count = 0

        # Accounts are resolved per (symbol, account) so a symbol held in two
        # accounts backfills each series independently.
        accounts_declared = self.config_manager.load_accounts() is not None

        # A single replay per cycle serves every symbol and every date; each
        # per-date lookup below is a forward-fill on this timeline, never a
        # re-replay (backfill drops from O(days × events) to O(events + days)).
        events = self.config_manager.get_events()
        timeline = EventAggregator().replay(events, accounts_declared) if events else None

        for share in self.shares:
            backfilled_count += self._backfill_share(share, timeline)

        if backfilled_count > 0:
            app_logger.info(f"Backfill cycle complete: {backfilled_count} data points written")
        else:
            app_logger.debug("Backfill cycle complete: no new data to write")

    def _backfill_share(self, share, timeline) -> int:
        """Backfill one share in both directions (issue #626).

        The **backward** pass extends the series toward the first BUY date and
        stops once ``_backfill_complete`` is set; the **forward** pass recovers a
        recent session missed while the app was down. The two directions are
        **independent** — a completed backward watermark never suppresses the
        forward pass (issue #627). Returns points written this cycle.
        """
        symbol = share['symbol']
        account = share.get('account', DEFAULT_ACCOUNT)

        # Get the target date (first BUY)
        first_buy_date = self.config_manager.get_first_buy_date(symbol)
        if not first_buy_date:
            app_logger.debug(f"No BUY events found for {symbol}, skipping backfill")
            return 0

        # Convert date to datetime if needed and make timezone-aware
        if isinstance(first_buy_date, datetime):
            if first_buy_date.tzinfo is None:
                first_buy_date = first_buy_date.replace(tzinfo=timezone.utc)
        else:
            # It's a date object, convert to datetime
            first_buy_date = datetime.combine(
                first_buy_date, datetime.min.time(), tzinfo=timezone.utc)

        written = 0
        # Backward pass — skip once complete to avoid refetching the same window
        # every cycle (e.g. a first BUY on a non-trading day never lets oldest
        # reach it exactly). This skip must NOT gate the forward pass below.
        if self._backfill_complete.get((symbol, account)) == first_buy_date:
            app_logger.debug(f"Backfill already complete for {symbol} ({account})")
        else:
            written += self._backfill_backward(share, first_buy_date, timeline)

        # Forward pass — independent of the backward-completion watermark.
        written += self._backfill_forward(share, timeline)
        return written

    def _ensure_share_info(self, symbol: str) -> Optional[Dict]:
        """Resolve the share info (tags) so historical points share the same
        series identity as live scrape points.

        Fetches it if the scrape job has not populated the cache yet; returns
        ``None`` (the caller defers this cycle) if still unavailable.
        """
        info = self._share_info_cache.get(symbol)
        if not info:
            self._fetch_ticker_data(symbol)
            info = self._share_info_cache.get(symbol)
        if not info:
            app_logger.warning(
                f"No share info available for {symbol}, deferring backfill")
        return info

    def _enrich_and_write(self, share, info, prices, perf_from_date,
                          timeline) -> int:
        """Enrich a fetched price chunk with portfolio state and write it.

        Shared by the backward and forward passes so recovered points carry the
        **same** enriched series identity/tags as live and backward-filled ones,
        letting the perf ``holdings_value`` pick them up on the next recompute.
        Guarded like ``expose_metrics`` so a transient InfluxDB error on one
        share does not abort backfilling the remaining shares. Returns the number
        of points written.
        """
        symbol = share['symbol']
        name = share['name']
        account = share.get('account', DEFAULT_ACCOUNT)

        # Enrich price data with portfolio state at each date, read from the
        # single per-cycle timeline. Many price points (esp. hourly) share the
        # same calendar day and thus the same state; look up once per date.
        if timeline is not None:
            state_by_date: Dict = {}
            for price_point in prices:
                ts = price_point['timestamp']
                # Convert datetime to date for the timeline lookup
                point_date = ts.date() if isinstance(ts, datetime) else ts
                if point_date not in state_by_date:
                    state_by_date[point_date] = timeline.position_at(
                        account, symbol, point_date)
                state = state_by_date[point_date]
                if state:
                    price_point['purchased_quantity'] = state['purchase']['quantity']
                    price_point['purchased_price'] = state['purchase']['cost_price']
                    price_point['purchased_fee'] = state['purchase']['fee']
                    price_point['owned_quantity'] = state['estate']['quantity']
                    price_point['received_dividend'] = state['estate']['received_dividend']

        try:
            written = self.influxdb.write_historical_prices(
                share_name=name,
                share_symbol=symbol,
                prices=prices,
                share_currency=info.get('currency'),
                share_exchange=info.get('exchange'),
                quote_type=info.get('quoteType'),
                account=account
            )
            # Newly filled prices change holdings_value for that window; re-arm
            # the perf series so the next recompute rewrites the tail from here
            # (issue #597).
            if written > 0:
                self._mark_perf_dirty(perf_from_date)
            return written
        except Exception as e:
            app_logger.error(
                f"Failed to write historical prices for {symbol}: {e}")
            return 0

    def _fetch_and_store(self, share, info, start_date, end_date, timeline):
        """Fetch one ``[start, end]`` chunk and, if non-empty, enrich + write it.

        The shared tail of both backfill passes (they differ only in window
        sizing and how they treat an empty window). Returns ``(prices, written)``:

          * ``prices is None`` — the fetch failed; the caller logs and retries.
          * ``prices == []`` — an empty window (yfinance returned no rows); the
            caller decides what an empty window means for its direction.
          * otherwise ``prices`` is the fetched rows and ``written`` the count
            persisted.

        Rate-limits (``SB_BACKFILL_DELAY``) after any completed fetch — empty or
        written — but not after a fetch failure.
        """
        prices = self._fetch_historical_data(
            share['symbol'], start_date, end_date)
        if prices is None:
            return None, 0
        if not prices:
            time.sleep(self.backfill_delay)
            return prices, 0
        written = self._enrich_and_write(
            share, info, prices, start_date.date(), timeline)
        # Rate limit between symbols
        time.sleep(self.backfill_delay)
        return prices, written

    def _backfill_backward(self, share, first_buy_date, timeline) -> int:
        """Backward pass: extend the series toward the first BUY date, one chunk
        (``SB_BACKFILL_CHUNK_DAYS``) per cycle. Returns points written this cycle.
        """
        symbol = share['symbol']
        name = share['name']
        account = share.get('account', DEFAULT_ACCOUNT)

        info = self._ensure_share_info(symbol)
        if info is None:
            return 0

        # Get the oldest data point in InfluxDB for this (symbol, account)
        oldest_timestamp = self.influxdb.get_oldest_timestamp(symbol, account=account)

        # Determine if we need to backfill (compare at day granularity)
        if oldest_timestamp is not None:
            # Already have some data, check if we need to go further back
            # Compare dates only to avoid tiny time windows
            if oldest_timestamp.date() <= first_buy_date.date():
                app_logger.debug(
                    f"Backfill complete for {symbol} ({account}): "
                    f"oldest={oldest_timestamp.date()}, target={first_buy_date.date()}")
                self._backfill_complete[(symbol, account)] = first_buy_date
                return 0

            # Need to fetch data before oldest_timestamp
            # Use the actual timestamp to minimize gaps with hourly data
            end_date = oldest_timestamp
            if end_date.tzinfo is None:
                end_date = end_date.replace(tzinfo=timezone.utc)
        else:
            # No data at all, start from now
            end_date = datetime.now(timezone.utc)

        # Calculate the chunk to fetch (going backwards in time)
        start_date = end_date - timedelta(days=self.backfill_chunk_days)

        # Don't go before the first BUY date
        if start_date < first_buy_date:
            start_date = first_buy_date

        # Skip if window is less than 1 day (avoids useless requests outside market hours)
        if (end_date - start_date).days < 1:
            app_logger.debug(
                f"Backfill window too small for {symbol}, skipping until next cycle")
            return 0

        app_logger.info(
            f"Backfilling {name} ({symbol}): {start_date.date()} to {end_date.date()}")

        prices, written = self._fetch_and_store(
            share, info, start_date, end_date, timeline)

        if prices is None:
            app_logger.warning(f"Failed to fetch history for {symbol}, will retry next cycle")
            return 0

        if not prices:
            # Empty window: the fetch succeeded but returned no rows. If we
            # have already reached the first BUY date there is no earlier
            # trading data (e.g. the first BUY fell on a weekend/holiday), so
            # mark the symbol complete to avoid refetching this window forever.
            if start_date <= first_buy_date:
                app_logger.debug(
                    f"Backfill complete for {symbol} ({account}): reached first BUY "
                    f"date with no earlier trading data")
                self._backfill_complete[(symbol, account)] = first_buy_date

        return written

    def _backfill_forward(self, share, timeline) -> int:
        """Forward pass: recover a session missed while the app was down by
        fetching ``[newest, now]`` (issue #627).

        Window sizing is delegated to the pure
        ``scheduling.forward_backfill_window`` and gap classification to yfinance
        — an empty window (weekend/holiday, or already covered) writes nothing.
        The pure ``< 1 day`` guard makes this **no-op during live trading**
        (newest ≈ now → sub-day window → skip), so the live ``REGULAR`` writer
        stays the sole writer of the present with no duplicate at the seam.
        Returns points written this cycle.
        """
        symbol = share['symbol']
        name = share['name']
        account = share.get('account', DEFAULT_ACCOUNT)

        newest = self.influxdb.get_newest_timestamp(symbol, account=account)
        window = scheduling.forward_backfill_window(
            newest, datetime.now(timezone.utc), self.backfill_chunk_days)
        if window is None:
            return 0
        start_date, end_date = window

        info = self._ensure_share_info(symbol)
        if info is None:
            return 0

        app_logger.info(
            f"Forward-filling {name} ({symbol}): {start_date.date()} to {end_date.date()}")

        # Same granularity/chunking as the backward pass: 1h within 730d, 1d beyond.
        prices, written = self._fetch_and_store(
            share, info, start_date, end_date, timeline)

        if prices is None:
            app_logger.warning(
                f"Failed to fetch forward history for {symbol}, will retry next cycle")
            return 0

        if not prices:
            # Empty window: yfinance returned no rows — a weekend/holiday gap or
            # an already-covered range. Self-classifying no-op, nothing written.
            app_logger.debug(
                f"Forward-fill window for {symbol} returned no rows, skipping")

        return written

    def scrape(self):
        """
        Scrape stock prices from Yahoo Finance and expose metrics.

        Synchronous whole-portfolio path kept for the manual/backward-compat and
        e2e harness; the scheduled runtime drives per-symbol jobs + the perf job.
        The perf recompute is **detached** from scrape (issue #618): it is its
        own gated interval job, never piggybacked here.
        """
        if not self.shares:
            app_logger.warning("No shares configured, skipping scrape")
            return

        self.expose_metrics()

    @staticmethod
    def _midnight(day) -> datetime:
        """Midnight UTC of ``day`` — never stamped in the future."""
        return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)

    @staticmethod
    def _value_kwargs(dp, last: bool, perf) -> dict:
        """Shared value + perf fields for a metric point built from a DailyPerf.

        twr_index is per-day; xirr / gain_absolu land only on the latest point.
        """
        return dict(
            cash_balance=dp.cash_balance,
            holdings_value=dp.holdings_value,
            total_value=dp.total_value,
            net_contributed=dp.net_contributed,
            twr_index=dp.twr_index,
            xirr=perf.xirr if last else None,
            gain_absolu=perf.gain_absolu if last else None,
        )

    def _mark_perf_dirty(self, from_date: date) -> None:
        """Lower the perf-series write watermark to ``from_date`` (thread-safe).

        Called by the backfill thread once it has written prices for an earlier
        day: that day's ``holdings_value`` changed and TWR compounds forward, so
        the whole tail from ``from_date`` to today must be rewritten next cycle.
        ``min`` keeps the earliest pending bound across several backfills.
        """
        with self._perf_lock:
            cur = self._perf_dirty_from
            self._perf_dirty_from = from_date if cur is None else min(cur, from_date)

    def _consume_perf_dirty_from(self) -> Optional[date]:
        """Atomically read and clear the backfill watermark (thread-safe).

        Reset happens up-front so a backfill landing mid-cycle re-arms the
        watermark for the *next* cycle instead of being swallowed by this one.
        """
        with self._perf_lock:
            pending = self._perf_dirty_from
            self._perf_dirty_from = None
            return pending

    def update_account_metrics(self):
        """Recompute and write the daily ``account_metrics`` + ``portfolio_totals``
        series via the performance module.

        Opt-in only: gated on ``load_accounts()`` returning a Portfolio. The full
        series (earliest event date → today, one point per calendar day at
        midnight) is recomputed every cycle, but only the **stale tail** is
        written — a steady cycle rewrites just today's point. This is the fix for
        issue #597: on InfluxDB 3 Core a full-series rewrite every scrape lands
        new, never-compacted Parquet files, so file count grew without bound. The
        write window widens back to an earlier day when backfill fills earlier
        prices (``_mark_perf_dirty``) or when the events cache is reloaded (a new
        events list object => full rewrite). Money-weighted performance (xirr /
        gain_absolu / twr_index) comes from
        ``performance.py``; xirr / gain_absolu land only on the latest point.
        """
        portfolio = self.config_manager.load_accounts()
        if portfolio is None:
            return  # single gate: no declared accounts -> no account series

        events = self.config_manager.get_events()
        if not events:
            return

        timeline = EventAggregator().replay(events, accounts_declared=True)

        # Injected price source: per-symbol daily closes, forward-filled. The
        # performance module never touches InfluxDB — it only calls price_at.
        symbols = {s['symbol'] for s in self.shares if s.get('symbol')}
        price_pairs = {
            sym: sorted(self.influxdb.get_price_series(sym).items())
            for sym in symbols
        }

        def price_at(symbol, day):
            pairs = price_pairs.get(symbol)
            return timeline.state_at(pairs, day) if pairs else None

        start = min(e.date for e in events)
        today = datetime.now(timezone.utc).date()

        # Incremental write window (issue #597). Consume the backfill watermark
        # first so a backfill landing mid-cycle re-arms it for the next cycle. A
        # reloaded events cache (new list object) forces a full rewrite; else we
        # write from the earliest day backfill touched, defaulting to today only.
        pending = self._consume_perf_dirty_from()
        events_changed = events is not self._perf_last_events
        self._perf_last_events = events
        if events_changed:
            write_from = start
        elif pending is not None:
            write_from = max(start, min(pending, today))
        else:
            write_from = today

        per_account = {
            account.id: performance.compute_account(
                timeline, account, symbols, price_at, start, today)
            for account in portfolio.accounts
        }
        total = performance.compute_portfolio_total(
            timeline, portfolio.accounts, symbols, price_at, start, today, per_account)

        # --- account_metrics ------------------------------------------------
        # ``last`` (and thus xirr / gain_absolu) is decided over the FULL series
        # so it always lands on today's point; only points on/after write_from
        # are actually written. today >= write_from always, so the latest point
        # (Prometheus + negative-cash warning) is present every cycle.
        acc_points = []
        latest_by_account: Dict[str, AccountMetricPoint] = {}
        for account in portfolio.accounts:
            perf = per_account[account.id]
            for i, dp in enumerate(perf.daily):
                last = i == len(perf.daily) - 1
                if dp.date < write_from:
                    continue
                pt = AccountMetricPoint(
                    account=account.id,
                    account_type=account.type,
                    account_currency=account.currency,
                    timestamp=self._midnight(dp.date),
                    **self._value_kwargs(dp, last, perf),
                )
                acc_points.append(pt)
                if last:
                    latest_by_account[account.id] = pt
        # --- portfolio_totals (global, untagged; only if single currency) ---
        total_points = []
        if total is not None:
            total_points = [
                PortfolioTotalPoint(
                    timestamp=self._midnight(dp.date),
                    **self._value_kwargs(dp, i == len(total.daily) - 1, total),
                )
                for i, dp in enumerate(total.daily)
                if dp.date >= write_from
            ]

        # The watermark was consumed up front (for concurrency), so a failed
        # write would otherwise drop the stale tail silently. Re-arm it on any
        # write error so the next cycle retries the same slice; today's point is
        # rewritten every cycle anyway, so only a sub-today tail needs re-arming.
        try:
            if acc_points:
                self.influxdb.write_account_metrics(acc_points)
            if total_points:
                self.influxdb.write_portfolio_totals(total_points)
        except Exception:
            if write_from < today:
                self._mark_perf_dirty(write_from)
            raise

        # Permissive cash policy: a negative balance is allowed (it keeps a user
        # who adds accounts without rewriting their DEPOSIT history running), but
        # it is worth a non-blocking warning.
        for acc, p in latest_by_account.items():
            if p.cash_balance < 0:
                app_logger.warning(
                    f"Account '{acc}' has a negative cash balance "
                    f"({p.cash_balance:.2f}) — insufficient recorded cash")

        # Prometheus: expose the latest (today) value per account + global.
        if self.prometheus is not None:
            for acc, p in latest_by_account.items():
                try:
                    self.prometheus.update_account(p)
                except Exception as e:
                    app_logger.error(
                        f"Failed to update Prometheus account metrics for {acc}: {e}")
            if total is not None and total.daily:
                try:
                    self.prometheus.update_portfolio(total_points[-1])
                except Exception as e:
                    app_logger.error(f"Failed to update Prometheus portfolio totals: {e}")

    def reload(self):
        """
        Reload the configuration and update the stock shares.
        Legacy method for backward compatibility.
        """
        try:
            self.shares = self.config_manager.load_shares(force=True)
        except Exception as e:
            raise e

    def run(self):
        """
        Run the full metrics collection process (ingest + scrape).
        Used for initial startup and backward compatibility.
        """
        self.ingest()
        self.scrape()

    def close(self):
        """Close connections."""
        if self.influxdb:
            self.influxdb.close()


if __name__ == "__main__":
    app_logger.info('SuiviBourse is running !')

    # Initialize configuration manager
    config_manager = ConfigurationManager()

    # Load schema file
    with open(Path(__file__).parent / "schema.yaml", encoding='UTF-8') as f:
        dataSchema = yaml.safe_load(f)
    shares_validator = Validator(dataSchema)

    # Get intervals from environment. SB_REGULAR_INTERVAL is the heir of the
    # removed global SB_SCRAPING_INTERVAL (design #607); resolve_regular_interval
    # applies the precedence + deprecation warning.
    regular_interval = resolve_regular_interval()
    ingestion_interval = int(os.getenv('SB_INGESTION_INTERVAL', default='300'))
    backfill_interval = int(os.getenv('SB_BACKFILL_INTERVAL', default='60'))
    perf_interval = int(os.getenv('SB_PERF_INTERVAL', default='120'))

    sb_metrics = None
    try:
        # Init SuiviBourseMetrics (connects to InfluxDB)
        sb_metrics = SuiviBourseMetrics(config_manager, shares_validator)
        sb_metrics.regular_interval = regular_interval
        # Expose the legacy Prometheus /metrics endpoint if enabled (default on)
        if sb_metrics.prometheus is not None:
            metrics_port = int(os.getenv('SB_METRICS_PORT', default='8081'))
            sb_metrics.prometheus.start(metrics_port)
            app_logger.info(
                f"Prometheus metrics available on :{metrics_port}/metrics")
        # Start file watcher for hot-reload if in events mode
        config_manager.start_watcher(sb_metrics.ingest)
        # Size the executor pool from the two dials (issue #619). Default
        # (SB_DYNAMIC_EXECUTOR_POOL=false) is a fixed pool of SB_EXECUTOR_POOL
        # (10) — identical to today. Auto sizing groups the held symbols into
        # same-exchange cohorts, so capture_exchange_of() is invoked only on that
        # path (a pre-scheduler fetch; the executor is fixed once at
        # construction, no hot resize).
        pool_size = resolve_executor_pool_size(
            config_manager.get_mode(), sb_metrics.shares,
            sb_metrics.capture_exchange_of)
        # Wire the scheduler before bootstrapping so ingest() can arm the
        # per-symbol scrape jobs (issue #616). Their immediate first fire IS the
        # bootstrap — no separate initial scrape.
        scheduler = BlockingScheduler(
            executors={'default': ThreadPoolExecutor(pool_size)})
        sb_metrics.scheduler = scheduler
        # Bootstrap: load shares + arm one self-rescheduling scrape job per
        # symbol (each fires immediately, then re-arms on its market cadence).
        sb_metrics.ingest()
        # Register the three fixed-cadence interval jobs (ingestion, backfill,
        # perf recompute). Per-symbol scrape jobs are armed by ingest() above and
        # kept separate; the perf recompute is its own gated job (issue #618).
        register_interval_jobs(
            scheduler, sb_metrics, ingestion_interval, backfill_interval,
            perf_interval)
        app_logger.info(
            f"Scheduler started: per-symbol scraping (REGULAR every "
            f"{regular_interval}s), ingestion every {ingestion_interval}s, "
            f"backfill every {backfill_interval}s, perf every {perf_interval}s, "
            f"executor pool: {pool_size} workers")
        scheduler.start()
    except ConfuseExceptions.NotFoundError as e:
        app_logger.fatal(
            'An error occurred while loading the configuration file : ' + str(e))
        sys.exit(1)
    except (EventLoaderError, EventValidationError, AggregationError) as e:
        app_logger.fatal(f'An error occurred while loading events : {e}')
        sys.exit(1)
    except InvalidConfigFile as e:
        app_logger.fatal(e.message)
        sys.exit(1)
    except ValueError as e:
        app_logger.fatal(f'Configuration error: {e}')
        sys.exit(1)
    except Exception as e:
        app_logger.fatal(f'An unexpected error occurred: {e}', exc_info=True)
        sys.exit(1)
    finally:
        config_manager.stop_watcher()
        if sb_metrics:
            sb_metrics.close()
