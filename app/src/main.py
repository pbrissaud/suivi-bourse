"""
SuiviBourse
Paul Brissaud
"""
import os
import sys
import time
from pathlib import Path

import prometheus_client
import yaml
import yfinance as yf
from apscheduler.schedulers.blocking import BlockingScheduler
from cerberus import Validator
from confuse import Configuration, exceptions as ConfuseExceptions
from logfmt_logger import getLogger
from urllib3 import exceptions as u_exceptions
from yfinance.exceptions import YFRateLimitError

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


class SuiviBourseMetrics:
    """
    Class for managing and exposing metrics related to stock shares.
    """

    def __init__(self, configuration_: Configuration, validator_: Validator):
        self.configuration = configuration_
        self.validator = validator_
        self.shares = configuration_['shares'].get()
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
                info = {
                    'currency': ticker.info.get('currency', 'undefined'),
                    'exchange': ticker.info.get('exchange', 'undefined'),
                    'quoteType': ticker.info.get('quoteType', 'undefined')
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

            if i < len(self.shares) - 1:
                time.sleep(1)

    def reload(self):
        """
        Reload the configuration and update the stock shares.
        """
        try:
            self.configuration.reload()
            self.shares = self.configuration['shares'].get()

        except Exception as e:
            raise e

    def run(self):
        """
        Run the metrics collection process.
        """
        self.reload()

        if not self.validate():
            raise InvalidConfigFile(self.validator.errors)

        self.expose_metrics()


if __name__ == "__main__":
    app_logger.info('SuiviBourse is running !')

    # Load config
    config = Configuration('SuiviBourse', __name__)

    # Load schema file
    with open(Path(__file__).parent / "schema.yaml", encoding='UTF-8') as f:
        dataSchema = yaml.safe_load(f)
    shares_validator = Validator(dataSchema)

    try:
        # Start up the server to expose the metrics.
        prometheus_client.start_http_server(
            int(os.getenv('SB_METRICS_PORT', default='8081')))
        # Init SuiviBourseMetrics
        sb_metrics = SuiviBourseMetrics(config, shares_validator)
        # Schedule run the job on startup.
        sb_metrics.run()
        # Start scheduler
        scheduler = BlockingScheduler()
        scheduler.add_job(sb_metrics.run, 'interval', seconds=int(
            os.getenv('SB_SCRAPING_INTERVAL', default='120')))
        scheduler.start()
    except ConfuseExceptions.NotFoundError as e:
        app_logger.fatal(
            'An error occurred while loading the configuration file : ' + str(e))
        sys.exit(1)
    except InvalidConfigFile as e:
        app_logger.fatal(e.message)
        sys.exit(1)
    except Exception as e:
        app_logger.fatal('An unexpected error occurred + ' + str(e), exc_info=True)
        sys.exit(1)
