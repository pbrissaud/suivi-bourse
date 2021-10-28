"""
SuiviBourse
Paul Brissaud
"""
import sys
import os
from pathlib import Path
import yaml
import yfinance as yf
from confuse import Configuration, exceptions as CExceptions
from prometheus_client import start_http_server, Gauge
from cerberus import Validator
from logfmt_logger import getLogger
from apscheduler.schedulers.blocking import BlockingScheduler
from urllib3 import exceptions as UExceptions

logger = getLogger("suivi_bourse")

sb_share_price = Gauge(
    "sb_share_price",
    "Price of the share",
    ["share_name", "share_symbol"]
)

sb_purchased_quantity = Gauge(
    "sb_purchased_quantity",
    "Quantity of purchased share",
    ["share_name", "share_symbol"]
)

sb_purchased_price = Gauge(
    "sb_purchased_price",
    "Price of purchased share",
    ["share_name", "share_symbol"]
)

sb_purchased_fee = Gauge(
    "sb_purchased_fee",
    "Fees",
    ["share_name", "share_symbol"]
)

sb_owned_quantity = Gauge(
    "sb_owned_quantity",
    "sb_owned_quantity",
    ["share_name", "share_symbol"]
)

sb_received_dividend = Gauge(
    "sb_received_dividend",
    "sb_received_dividend",
    ["share_name", "share_symbol"]
)


def expose_metrics(configuration: Configuration):
    """
    Expose stock share in OpenMetrics format
    """
    configuration.reload()

    if not validator.validate({"shares": configuration['shares'].get()}):
        logger.error(
            'Shares field of the config file is invalid : %s', validator.errors)

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
        except UExceptions.NewConnectionError as connection_exception:
            logger.error(
                "Error while retrieving data from Yfinance API : %s", connection_exception)
        except RuntimeError as runtime_exception:
            logger.error(
                "Error while retrieving data from Yfinance API : %s", runtime_exception)


if __name__ == "__main__":
    logger.info('SuiviBourse is running !')

    # Load config
    config = Configuration('SuiviBourse', __name__)

    # Load schema file
    with open(Path(__file__).parent / "schema.yaml", encoding='UTF-8') as f:
        dataSchema = yaml.safe_load(f)
    validator = Validator(dataSchema)

    try:
        # Start up the server to expose the metrics.
        start_http_server(int(os.getenv('SB_METRICS_PORT', default='8081')))
        # Schedule run the job on startup.
        expose_metrics(config)
        # Start scheduler
        sched = BlockingScheduler()
        sched.add_job(expose_metrics, 'interval', args=[config], seconds=int(
            os.getenv('SB_SCRAPING_INTERVAL', default='120')))
        sched.start()
    except CExceptions.NotFoundError as confuse_exception_notfound:
        logger.critical(
            'Config file unreadable or non-existing field : %s', confuse_exception_notfound)
        sys.exit(1)
    except CExceptions.ConfigTypeError as confuse_exception_configtype:
        logger.critical('Field in config file is invalid : %s',
                        confuse_exception_configtype)
        sys.exit(1)
