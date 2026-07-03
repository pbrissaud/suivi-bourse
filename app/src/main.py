"""
SuiviBourse
Paul Brissaud
"""
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Dict, Optional

import pandas as pd
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
from events.schemas import EventType
from influxdb_writer import InfluxDBWriter
from prometheus_exporter import PrometheusExporter

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

        # Store raw events for backfill date calculation
        self._cached_events: Optional[List] = None

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
            self._cached_events = []
            self._cache_key = current_key
            return []

        validator = EventValidator()
        validator.validate_or_raise(events)

        aggregator = EventAggregator()
        shares = aggregator.aggregate(events)

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

        # Cache for share info (to avoid repeated API calls during backfill)
        self._share_info_cache: Dict[str, Dict] = {}

        # Track symbols whose backfill has reached the first BUY date, keyed by
        # that date so an earlier newly-added event re-triggers backfill.
        self._backfill_complete: Dict[str, datetime] = {}

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
                    'volume': int(last_volume) if pd.notna(last_volume) else None
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
                    # idx is a pandas Timestamp
                    ts = idx.to_pydatetime()
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    prices.append({
                        'timestamp': ts,
                        'price': row['Close'],
                        'price_open': row['Open'],
                        'price_high': row['High'],
                        'price_low': row['Low'],
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

    def expose_metrics(self):
        """
        Expose the metrics for each stock share to InfluxDB.
        """
        for i, share in enumerate(self.shares):
            share_name = share['name']
            share_symbol = share['symbol']

            last_quote, info = self._fetch_ticker_data(share_symbol)

            # Update the legacy Prometheus gauges independently of the InfluxDB
            # write so the /metrics endpoint stays populated even if InfluxDB errors.
            if self.prometheus is not None:
                try:
                    self.prometheus.update_share(share, last_quote, info)
                except Exception as e:
                    app_logger.error(
                        f"Failed to update Prometheus metrics for {share_symbol}: {e}")

            # Skip writing when the fetch failed: writing portfolio fields with
            # missing currency/exchange/quote_type tags would land them in a
            # different InfluxDB series than the enriched (tagged) points.
            if last_quote is None or info is None:
                app_logger.warning(
                    f"No data fetched for {share_symbol}, skipping metrics write")
            else:
                # Guard the write so a transient InfluxDB error on one share does
                # not abort the whole scrape cycle and drop the remaining shares.
                try:
                    self.influxdb.write_metrics(
                        share_name=share_name,
                        share_symbol=share_symbol,
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
                except Exception as e:
                    app_logger.error(
                        f"Failed to write metrics for {share_symbol}: {e}")

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

        for share in self.shares:
            symbol = share['symbol']
            name = share['name']

            # Get the target date (first BUY)
            first_buy_date = self.config_manager.get_first_buy_date(symbol)
            if not first_buy_date:
                app_logger.debug(f"No BUY events found for {symbol}, skipping backfill")
                continue

            # Convert date to datetime if needed and make timezone-aware
            if isinstance(first_buy_date, datetime):
                if first_buy_date.tzinfo is None:
                    first_buy_date = first_buy_date.replace(tzinfo=timezone.utc)
            else:
                # It's a date object, convert to datetime
                first_buy_date = datetime.combine(first_buy_date, datetime.min.time(), tzinfo=timezone.utc)

            # Skip symbols already backfilled up to their first BUY date to avoid
            # refetching the same window every cycle (e.g. a first BUY on a
            # non-trading day never lets oldest reach it exactly).
            if self._backfill_complete.get(symbol) == first_buy_date:
                app_logger.debug(f"Backfill already complete for {symbol}")
                continue

            # Ensure share info (tags) is available so historical points share the
            # same series identity as live scrape points. Fetch it if the scrape
            # job has not populated the cache yet; defer backfill if unavailable.
            info = self._share_info_cache.get(symbol)
            if not info:
                self._fetch_ticker_data(symbol)
                info = self._share_info_cache.get(symbol)
            if not info:
                app_logger.warning(
                    f"No share info available for {symbol}, deferring backfill")
                continue

            # Get the oldest data point in InfluxDB
            oldest_timestamp = self.influxdb.get_oldest_timestamp(symbol)

            # Determine if we need to backfill (compare at day granularity)
            if oldest_timestamp is not None:
                # Already have some data, check if we need to go further back
                # Compare dates only to avoid tiny time windows
                if oldest_timestamp.date() <= first_buy_date.date():
                    app_logger.debug(
                        f"Backfill complete for {symbol}: "
                        f"oldest={oldest_timestamp.date()}, target={first_buy_date.date()}")
                    self._backfill_complete[symbol] = first_buy_date
                    continue

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
                continue

            app_logger.info(
                f"Backfilling {name} ({symbol}): {start_date.date()} to {end_date.date()}")

            # Fetch historical data
            prices = self._fetch_historical_data(symbol, start_date, end_date)

            if prices is None:
                app_logger.warning(f"Failed to fetch history for {symbol}, will retry next cycle")
                continue

            if not prices:
                # Empty window: the fetch succeeded but returned no rows. If we
                # have already reached the first BUY date there is no earlier
                # trading data (e.g. the first BUY fell on a weekend/holiday), so
                # mark the symbol complete to avoid refetching this window forever.
                if start_date <= first_buy_date:
                    app_logger.debug(
                        f"Backfill complete for {symbol}: reached first BUY date "
                        f"with no earlier trading data")
                    self._backfill_complete[symbol] = first_buy_date
                time.sleep(self.backfill_delay)
                continue

            # Enrich price data with portfolio state at each date
            events = self.config_manager.get_events()
            if events:
                aggregator = EventAggregator()
                for price_point in prices:
                    ts = price_point['timestamp']
                    # Convert datetime to date for aggregation
                    point_date = ts.date() if isinstance(ts, datetime) else ts
                    state = aggregator.aggregate_until_date(events, point_date, symbol)
                    if state:
                        price_point['purchased_quantity'] = state['purchase']['quantity']
                        price_point['purchased_price'] = state['purchase']['cost_price']
                        price_point['purchased_fee'] = state['purchase']['fee']
                        price_point['owned_quantity'] = state['estate']['quantity']
                        price_point['received_dividend'] = state['estate']['received_dividend']

            # Write to InfluxDB using the share info resolved earlier in the loop
            written = self.influxdb.write_historical_prices(
                share_name=name,
                share_symbol=symbol,
                prices=prices,
                share_currency=info.get('currency'),
                share_exchange=info.get('exchange'),
                quote_type=info.get('quoteType')
            )
            backfilled_count += written

            # Rate limit between symbols
            time.sleep(self.backfill_delay)

        if backfilled_count > 0:
            app_logger.info(f"Backfill cycle complete: {backfilled_count} data points written")
        else:
            app_logger.debug("Backfill cycle complete: no new data to write")

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

    # Get intervals from environment
    scraping_interval = int(os.getenv('SB_SCRAPING_INTERVAL', default='120'))
    ingestion_interval = int(os.getenv('SB_INGESTION_INTERVAL', default='300'))
    backfill_interval = int(os.getenv('SB_BACKFILL_INTERVAL', default='60'))

    sb_metrics = None
    try:
        # Init SuiviBourseMetrics (connects to InfluxDB)
        sb_metrics = SuiviBourseMetrics(config_manager, shares_validator)
        # Expose the legacy Prometheus /metrics endpoint if enabled (default on)
        if sb_metrics.prometheus is not None:
            metrics_port = int(os.getenv('SB_METRICS_PORT', default='8081'))
            sb_metrics.prometheus.start(metrics_port)
            app_logger.info(
                f"Prometheus metrics available on :{metrics_port}/metrics")
        # Start file watcher for hot-reload if in events mode
        config_manager.start_watcher(sb_metrics.ingest)
        # Run initial ingestion and scrape on startup
        sb_metrics.run()
        # Start scheduler with three separate jobs
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
        # Backfill job: progressively fills historical data
        scheduler.add_job(
            sb_metrics.backfill, 'interval',
            seconds=backfill_interval,
            id='backfill',
            name='Historical backfill')
        app_logger.info(
            f"Scheduler started: scraping every {scraping_interval}s, "
            f"ingestion every {ingestion_interval}s, "
            f"backfill every {backfill_interval}s")
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
        app_logger.fatal('An unexpected error occurred + ' + str(e), exc_info=True)
        sys.exit(1)
    finally:
        config_manager.stop_watcher()
        if sb_metrics:
            sb_metrics.close()
