import sys
import yaml
import yfinance as yf
from prometheus_client import start_http_server, Gauge
from confuse import Configuration, exceptions as confuseExceptions
from cerberus import Validator
from pathlib import Path
from logfmt_logger import getLogger
from apscheduler.schedulers.blocking import BlockingScheduler

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
        
def expose_metrics():

    if not validator.validate({"shares": config['shares'].get()}):
        logger.error('Shares field of the config file is invalid : {}'.format(validator.errors))
            
    for share in config['shares'].get():
        sb_purchased_quantity.labels(share_name=share['name'], share_symbol=share['symbol']).set(share['purchase']['quantity'])
        sb_purchased_price.labels(share_name=share['name'], share_symbol=share['symbol']).set(share['purchase']['cost_price'])
        sb_purchased_fee.labels(share_name=share['name'], share_symbol=share['symbol']).set(share['purchase']['fee'])
        sb_owned_quantity.labels(share_name=share['name'], share_symbol=share['symbol']).set(share['estate']['quantity'])
        sb_received_dividend.labels(share_name=share['name'], share_symbol=share['symbol']).set(share['estate']['received_dividend'])

        try:
            ticker = yf.Ticker(share['symbol'])
            history = ticker.history()
            last_quote = (history.tail(1)['Close'].iloc[0])
            sb_share_price.labels(share_name=share['name'], share_symbol=share['symbol']).set(last_quote)
        except Exception as e:
            logger.error("Error while retrieving data from Yfinance API : {}".format(e))
            pass

if __name__ == "__main__":
    logger.info('SuiviBourse is running !')

    # Load config
    config = Configuration('SuiviBourse', __name__)

    # Load schema file
    with open(Path(__file__).parent / "schema.yaml") as f:
        dataSchema = yaml.load(f, Loader=yaml.FullLoader)
    validator = Validator(dataSchema)

    try:
        # Start up the server to expose the metrics.
        start_http_server(config['params']['http_port'].as_number())
        # Schedule run the job on startup.
        expose_metrics()
        # Start scheduler
        sched = BlockingScheduler()
        sched.add_job(expose_metrics, 'interval', seconds=config['params']['scraping_interval'].as_number())
        sched.start()
    except confuseExceptions.NotFoundError as e:
        logger.critical('Config file unreadable or non-existing field : {}'.format(e))
        sys.exit(1)
    except confuseExceptions.ConfigTypeError as e:
        logger.critical('Field in config file is invalid : {}'.format(e))
        sys.exit(1)