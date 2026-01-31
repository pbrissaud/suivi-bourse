"""
SuiviBourse
Paul Brissaud
"""
import os
import sys
import time
from pathlib import Path
from typing import List, Dict, Optional

import prometheus_client
import yaml
import yfinance as yf
from apscheduler.schedulers.blocking import BlockingScheduler
from cerberus import Validator
from confuse import Configuration, exceptions as ConfuseExceptions
from logfmt_logger import getLogger
from urllib3 import exceptions as u_exceptions
from yfinance.exceptions import YFRateLimitError

from events import EventLoader, EventValidator, EventAggregator, EventWatcher
from events.loader import EventLoaderError
from events.validator import EventValidationError
from events.aggregator import AggregationError

LOG_LEVEL = os.getenv('LOG_LEVEL', default='INFO')
app_logger = getLogger("suivi_bourse", level=LOG_LEVEL)
scheduler_logger = getLogger("apscheduler.scheduler", level=LOG_LEVEL)
yfinance_logger = getLogger("yfinance", level=LOG_LEVEL)


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
        self._confuse_config: Optional[Configuration] = None
        self._watcher: Optional[EventWatcher] = None
        self._reload_callback: Optional[callable] = None

        # Cache for events mode
        self._cached_shares: Optional[List[Dict]] = None
        self._cache_key: Optional[str] = None

    def _load_settings(self) -> None:
        """Load settings from settings.yaml or environment."""
        # Priority 1: Environment variable
        env_mode = os.getenv('SB_CONFIG_MODE')
        if env_mode:
            self._mode = env_mode.lower()
            app_logger.info(f"Using config mode from environment: {self._mode}")
        # Priority 2: settings.yaml
        elif self.settings_path.exists():
            with open(self.settings_path, 'r', encoding='utf-8') as f:
                settings = yaml.safe_load(f) or {}
            self._mode = settings.get('mode', self.MODE_MANUAL).lower()
            events_settings = settings.get('events', {})
            self._events_source = events_settings.get('source')
            self._watch_enabled = events_settings.get('watch', False)
            app_logger.info(f"Using config mode from settings.yaml: {self._mode}")
        # Priority 3: Default to manual
        else:
            self._mode = self.MODE_MANUAL
            app_logger.info(f"No settings found, using default mode: {self._mode}")

        # Default events source if not specified
        if self._mode == self.MODE_EVENTS and not self._events_source:
            self._events_source = str(self.config_dir / 'events')

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
            self._cache_key = current_key
            return []

        validator = EventValidator()
        validator.validate_or_raise(events)

        aggregator = EventAggregator()
        shares = aggregator.aggregate(events)

        # Update cache
        self._cached_shares = shares
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
        self._cache_key = None
        app_logger.debug("Cache invalidated")


class SuiviBourseMetrics:
    """
    Class for managing and exposing metrics related to stock shares.
    """

    def __init__(self, config_manager: ConfigurationManager, validator_: Validator,
                 configuration_: Optional[Configuration] = None):
        self.config_manager = config_manager
        self.configuration = configuration_  # For backward compatibility
        self.validator = validator_
        self.shares = config_manager.load_shares()
        self.init_metrics()

    def init_metrics(self):
        """
        Initialize the Prometheus metrics for tracking stock share information.
        """
        common_labels = ['share_name', 'share_symbol']

        self.sb_share_price = prometheus_client.Gauge(
            "sb_share_price",
            "Price of the share",
            common_labels
        )

        self.sb_purchased_quantity = prometheus_client.Gauge(
            "sb_purchased_quantity",
            "Quantity of purchased share",
            common_labels
        )

        self.sb_purchased_price = prometheus_client.Gauge(
            "sb_purchased_price",
            "Price of purchased share",
            common_labels
        )

        self.sb_purchased_fee = prometheus_client.Gauge(
            "sb_purchased_fee",
            "Fees",
            common_labels
        )

        self.sb_owned_quantity = prometheus_client.Gauge(
            "sb_owned_quantity",
            "Owned quantity of the share",
            common_labels
        )

        self.sb_received_dividend = prometheus_client.Gauge(
            "sb_received_dividend",
            "Sum of received dividend for the share",
            common_labels
        )

        self.sb_share_info = prometheus_client.Gauge(
            "sb_share_info",
            "Share informations as label",
            common_labels + ['share_currency', 'share_exchange', 'quote_type']
        )

        self.sb_dividend_yield = prometheus_client.Gauge(
            "sb_dividend_yield",
            "Dividend yield percentage of the share",
            common_labels
        )

        self.sb_pe_ratio = prometheus_client.Gauge(
            "sb_pe_ratio",
            "Price to earnings ratio of the share",
            common_labels
        )

        self.sb_market_cap = prometheus_client.Gauge(
            "sb_market_cap",
            "Market capitalization of the share",
            common_labels
        )

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
                last_quote = ticker_history.tail(1)['Close'].iloc[0]
                ticker_info = ticker.info
                info = {
                    'currency': ticker_info.get('currency', 'undefined'),
                    'exchange': ticker_info.get('exchange', 'undefined'),
                    'quoteType': ticker_info.get('quoteType', 'undefined'),
                    'dividendYield': ticker_info.get('dividendYield'),
                    'peRatio': ticker_info.get('trailingPE') or ticker_info.get('forwardPE'),
                    'marketCap': ticker_info.get('marketCap')
                }
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

    def expose_metrics(self):
        """
        Expose the metrics for each stock share.
        """
        for i, share in enumerate(self.shares):
            label_values = [share['name'], share['symbol']]

            self.sb_purchased_quantity.labels(
                *label_values).set(share['purchase']['quantity'])
            self.sb_purchased_price.labels(
                *label_values).set(share['purchase']['cost_price'])
            self.sb_purchased_fee.labels(
                *label_values).set(share['purchase']['fee'])
            self.sb_owned_quantity.labels(
                *label_values).set(share['estate']['quantity'])
            self.sb_received_dividend.labels(
                *label_values).set(share['estate']['received_dividend'])

            last_quote, info = self._fetch_ticker_data(share['symbol'])
            if last_quote is not None and info is not None:
                self.sb_share_price.labels(*label_values).set(last_quote)
                info_values = label_values + [
                    info['currency'], info['exchange'], info['quoteType']]
                self.sb_share_info.labels(*info_values).set(1)

                if info['dividendYield'] is not None:
                    self.sb_dividend_yield.labels(*label_values).set(info['dividendYield'] * 100)
                if info['peRatio'] is not None:
                    self.sb_pe_ratio.labels(*label_values).set(info['peRatio'])
                if info['marketCap'] is not None:
                    self.sb_market_cap.labels(*label_values).set(info['marketCap'])

            if i < len(self.shares) - 1:
                time.sleep(1)

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

    def scrape(self):
        """
        Scrape stock prices from Yahoo Finance and expose metrics.
        This is called on a separate schedule from ingestion.
        """
        if not self.shares:
            app_logger.warning("No shares configured, skipping scrape")
            return

        self.expose_metrics()

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


if __name__ == "__main__":
    app_logger.info('SuiviBourse is running !')

    # Initialize configuration manager
    config_manager = ConfigurationManager()

    # Load schema file
    with open(Path(__file__).parent / "schema.yaml", encoding='UTF-8') as f:
        dataSchema = yaml.safe_load(f)
    shares_validator = Validator(dataSchema)

    # Get intervals from environment
    scraping_interval = int(os.getenv('SB_SCRAPING_INTERVAL', default='120'))
    ingestion_interval = int(os.getenv('SB_INGESTION_INTERVAL', default='300'))

    try:
        # Start up the server to expose the metrics.
        prometheus_client.start_http_server(
            int(os.getenv('SB_METRICS_PORT', default='8081')))
        # Init SuiviBourseMetrics
        sb_metrics = SuiviBourseMetrics(config_manager, shares_validator)
        # Start file watcher for hot-reload if in events mode
        config_manager.start_watcher(sb_metrics.ingest)
        # Run initial ingestion and scrape on startup
        sb_metrics.run()
        # Start scheduler with two separate jobs
        scheduler = BlockingScheduler()
        # Scraping job: fetches prices from Yahoo Finance
        scheduler.add_job(
            sb_metrics.scrape, 'interval',
            seconds=scraping_interval,
            id='scrape',
            name='Price scraping')
        # Ingestion job: reloads events from files (with caching)
        scheduler.add_job(
            sb_metrics.ingest, 'interval',
            seconds=ingestion_interval,
            id='ingest',
            name='Event ingestion')
        app_logger.info(
            f"Scheduler started: scraping every {scraping_interval}s, "
            f"ingestion every {ingestion_interval}s")
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
    except Exception as e:
        app_logger.fatal('An unexpected error occurred + ' + str(e), exc_info=True)
        sys.exit(1)
    finally:
        config_manager.stop_watcher()
