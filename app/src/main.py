"""
SuiviBourse
Paul Brissaud
"""
import os
import sys
from pathlib import Path

import prometheus_client
import yaml
import yfinance as yf
from apscheduler.schedulers.blocking import BlockingScheduler
from cerberus import Validator
from confuse import Configuration, exceptions as c_exceptions
from logfmt_logger import getLogger
from urllib3 import exceptions as u_exceptions

logger = getLogger("suivi_bourse", level=os.getenv(
    'LOG_LEVEL', default='DEBUG'))

class InvalidConfigFile(Exception):
  def __init__(self, errors_):
      self.errors = errors_
      self.message = 'Shares field of the config file is invalid :' + str(self.errors)
      super().__init__(self.message)

class SuiviBourseMetrics:
    def __init__(self, configuration_: Configuration, validator_: Validator):
        self.configuration = configuration_
        self.validator = validator_
        self.init_metrics()

    def init_metrics(self):
        if self.validate():
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
        else:
            raise InvalidConfigFile(self.validator.errors)

    def validate(self):
        return self.validator.validate({"shares": self.configuration['shares'].get()})

    def expose_metrics(self):
        for share in self.configuration['shares'].get():
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

            try:
                ticker = yf.Ticker(share['symbol'])
                last_quote = ticker.info['currentPrice']
                self.sb_share_price.labels(*label_values).set(last_quote)
            except u_exceptions.NewConnectionError as connection_exception:
                logger.error(
                    "Error while retrieving data from Yfinance API : %s", connection_exception)
            except RuntimeError as runtime_exception:
                logger.error(
                    "Error while retrieving data from Yfinance API : %s", runtime_exception)

    def run(self):
        self.configuration.reload()

        if not self.validate():
          raise InvalidConfigFile(self.validator.errors)

        self.expose_metrics()


if __name__ == "__main__":
    logger.info('SuiviBourse is running !')

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
    except c_exceptions.NotFoundError as confuse_exception_notfound:
        logger.critical(
            'Config file unreadable or non-existing field : %s', confuse_exception_notfound)
        sys.exit(1)
    except c_exceptions.ConfigTypeError as confuse_exception_configtype:
        logger.critical('Field in config file is invalid : %s',
                        confuse_exception_configtype)
        sys.exit(1)
    except InvalidConfigFile as invalid_config_exception:
        logger.error(invalid_config_exception.message)
