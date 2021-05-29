import json
import os
import time
import sys
import getopt
import logging
import yaml
import yfinance as yf
from cerberus import Validator
from pathlib import Path
from influxdb_client import InfluxDBClient, Point, WritePrecision
from influxdb_client.client.write_api import SYNCHRONOUS

logging.basicConfig(format='%(asctime)s %(levelname)s - %(message)s', datefmt='%d/%m/%Y %H:%M:%S')

class SuiviBourse:
    def __init__(self, argv):
        try:
            opts, _ = getopt.getopt(
                argv, "hH:p:D:U:P:i:c:", [
                    "help", "host=", "port=", "database=", "username=",
                    "password=", "interval=", "config="]
            )
        except getopt.GetoptError as err:
            logging.error(err)
            usage()
            sys.exit(2)

        influxHost = os.getenv('INFLUXDB_HOST', default='localhost')
        influxPort = os.getenv('INFLUXDB_PORT', default=8086)
        influxToken = os.getenv('INFLUXDB_TOKEN', default='')
        influxProtocol = os.getenv('INFLUXDB_PROTOCOL', default='http')

        if influxProtocol not in ['http', 'https']:
            logging.error("Le protocol ")

        self.influxBucket = os.getenv('INFLUXDB_BUCKET', default='bourse')
        self.influxOrg =  os.getenv('INFLUXDB_ORG', default='')
        self.appScrapingInterval = int(os.getenv('APP_SCRAPING_INTERVAL', default=60))
        self.appDataFilePath = os.getenv('APP_FILE_PATH', default='/data/data.json')

        for opt, arg in opts:
            if opt in ("-h", "--help"):
                usage()
                sys.exit(0)
            elif opt in ("-H", "--host"):
                influxHost = arg
            elif opt in ("-p", "--port"):
                influxPort = arg
            elif opt in ("-D", "--database"):
                influxDatabase = arg
            elif opt in ("-U", "--username"):
                influxUsername = arg
            elif opt in ("-P", "--password"):
                influxPassword = arg
            elif opt in ("-i", "--interval"):
                self.appScrapingInterval = int(arg)
            elif opt in ("-c", "--config"):
                self.appDataFilePath = arg

        self.influxdbClient: InfluxDBClient = InfluxDBClient(url=influxProtocol+"://"+influxHost+":"+influxPort,token=influxToken)

        with open(Path(__file__).parent / "schema.yaml") as f:
            self.dataSchema = yaml.load(f, Loader=yaml.FullLoader)

    def check(self):
        self.influxdbClient.ready()
        if(not os.path.exists(self.appDataFilePath)):
            raise Exception(
                "Data file {} doesn't exist !".format(self.appDataFilePath))

    def validate(self, data):
        v = Validator(self.dataSchema)
        return v.validate(data), v.errors

    def run(self):
        with open(self.appDataFilePath) as data_file:
            data = json.load(data_file)
            is_valid, validation_error = self.validate(data)
            if is_valid:
                for share in data['shares']:
                    ticker = yf.Ticker(share['symbol'])
                    history = ticker.history()
                    last_quote = (history.tail(1)['Close'].iloc[0])
                    json_body = [
                        {
                            "measurement": "price",
                            "tags": {
                                "name": share['name']
                            },
                            "fields": {
                                "amount": float(last_quote)
                            }
                        },
                        {
                            "measurement": "estate",
                            "tags": {
                                "name": share['name'],
                            },
                            "fields": {
                                "quantity": float(share['estate']['quantity']),
                                "received_dividend":
                                    float(share['estate']['received_dividend']),
                            }
                        },
                        {
                            "measurement": "purchase",
                            "tags": {
                                "name": share['name'],
                            },
                            "fields": {
                                "quantity": float(share['purchase']['quantity']),
                                "cost_price":
                                    float(share['purchase']['cost_price']),
                                "fee": float(share['purchase']['fee'])
                            }
                        }
                    ]
                    write_api = self.influxdbClient.write_api(write_options=SYNCHRONOUS)
                    write_api.write(self.influxBucket, self.influxOrg, json_body)
            else:
                raise Exception("Data file isn't valid : {}".format(validation_error))

def usage():
    print("\nUsage: python3 main.py [OPTIONS]")
    print("\nOPTION\t\t\tDESCRIPTION")
    print("-h, --help\t\tShow manual")
    print("-H, --host\t\tInfluxDB Host")
    print("-p, --port\t\tInfluxDB Port")
    print("-D, --database\t\tInfluxDB Database")
    print("-U, --username\t\tInfluxDB Username")
    print("-P, --password\t\tInfluxDB Password")
    print("-i, --interval\t\tApplication Scraping Interval (seconds)")
    print("-c, --config\t\tData file path")


if __name__ == "__main__":
    error_counter = 0
    suivi = SuiviBourse(sys.argv[1:])
    while True:
        try:
            suivi.check()
            suivi.run()
        except Exception as err:
            logging.error(str(err))
            error_counter += 1
            if error_counter >= 5:
                logging.critical("5 consecutive errors : Exiting the app")
                sys.exit(1)
        else:
            error_counter = 0
        time.sleep(suivi.appScrapingInterval)
