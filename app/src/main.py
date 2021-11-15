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

logger = getLogger("suivi_bourse")

sb_share_price = prometheus_client.Gauge(
    "sb_share_price",
    "Price of the share",
    ["share_name", "share_symbol"]
)

sb_purchased_quantity = prometheus_client.Gauge(
    "sb_purchased_quantity",
    "Quantity of purchased share",
    ["share_name", "share_symbol"]
)

sb_purchased_price = prometheus_client.Gauge(
    "sb_purchased_price",
    "Price of purchased share",
    ["share_name", "share_symbol"]
)

sb_purchased_fee = prometheus_client.Gauge(
    "sb_purchased_fee",
    "Fees",
    ["share_name", "share_symbol"]
)

sb_owned_quantity = prometheus_client.Gauge(
    "sb_owned_quantity",
    "Owned quantity of the share",
    ["share_name", "share_symbol"]
)

sb_received_dividend = prometheus_client.Gauge(
    "sb_received_dividend",
    "Sum of received dividend for the share",
    ["share_name", "share_symbol"]
)


def validate(validator: Validator, configuration: Configuration) -> bool:
    """Validate config file wirth a validator

    :param validator: Validator used to verify configuration
    :param configuration: Config object
    :return: Result of validation
    :rtype: bool
    """
    return validator.validate({"shares": configuration['shares'].get()})


def expose_metrics(configuration: Configuration):
    """Refresh exposed data

    :param configuration: Config object
    """
    for share in configuration['shares'].get():
        sb_purchased_quantity.labels(share_name=share['name'], share_symbol=share['symbol']).set(
            share['purchase']['quantity'])
        sb_purchased_price.labels(share_name=share['name'], share_symbol=share['symbol']).set(
            share['purchase']['cost_price'])
        sb_purchased_fee.labels(share_name=share['name'], share_symbol=share['symbol']).set(
            share['purchase']['fee'])
        sb_owned_quantity.labels(share_name=share['name'], share_symbol=share['symbol']).set(
            share['estate']['quantity'])
        sb_received_dividend.labels(share_name=share['name'], share_symbol=share['symbol']).set(
            share['estate']['received_dividend'])

        try:
            ticker = yf.Ticker(share['symbol'])
            history = ticker.history()
            last_quote = (history.tail(1)['Close'].iloc[0])
            sb_share_price.labels(
                share_name=share['name'], share_symbol=share['symbol']).set(last_quote)
        except u_exceptions.NewConnectionError as connection_exception:
            logger.error(
                "Error while retrieving data from Yfinance API : %s", connection_exception)
        except RuntimeError as runtime_exception:
            logger.error(
                "Error while retrieving data from Yfinance API : %s", runtime_exception)


def run(validator: Validator, configuration: Configuration):
    """Validate config file and refresh metrics

    :param validator: Validator used to verify configuration
    :param configuration: Config object
    """
    configuration.reload()

    if not validate(validator, configuration):
        logger.error('Shares field of the config file is invalid : %s', validator.errors)
        return

    expose_metrics(configuration)


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
        prometheus_client.start_http_server(int(os.getenv('SB_METRICS_PORT', default='8081')))
        # Schedule run the job on startup.
        run(shares_validator, config)
        # Start scheduler
        sched = BlockingScheduler()
        sched.add_job(run, 'interval', args=[shares_validator, config], seconds=int(
            os.getenv('SB_SCRAPING_INTERVAL', default='120')))
        sched.start()
    except c_exceptions.NotFoundError as confuse_exception_notfound:
        logger.critical(
            'Config file unreadable or non-existing field : %s', confuse_exception_notfound)
        sys.exit(1)
    except c_exceptions.ConfigTypeError as confuse_exception_configtype:
        logger.critical('Field in config file is invalid : %s', confuse_exception_configtype)
        sys.exit(1)
