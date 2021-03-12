import json
import os
import time
import sys
import getopt
import yfinance as yf
from influxdb import InfluxDBClient


class SuiviBourse:
    def __init__(self, argv):
        try:
            opts, _ = getopt.getopt(
                argv, "hH:p:D:U:P:i:c:", [
                    "help", "host=", "port=", "database=", "username=", "password=", "interval=", "config="]
            )
        except getopt.GetoptError as err:
            print(err)
            usage()
            sys.exit(2)

        influxHost = os.getenv('INFLUXDB_HOST', default='localhost')
        influxPort = os.getenv('INFLUXDB_PORT', default=8086)
        influxDatabase = os.getenv('INFLUXDB_DATABASE', default='bourse')
        influxUsername = ""
        influxPassword = ""

        self.appScrapingInterval = int(
            os.getenv('APP_SCRAPING_INTERVAL', default=60))
        self.appDataFilePath = os.getenv(
            'APP_FILE_PATH', default='/data/data.json')

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

        self.influxdbClient = InfluxDBClient(
            host=influxHost, port=influxPort, database=influxDatabase, username=influxUsername, password=influxPassword)

    def check(self):
        self.influxdbClient.ping()
        if(not os.path.exists(self.appDataFilePath)):
            raise Exception(
                "File {} doesn't exist !".format(self.appDataFilePath))

    def run(self):
        with open(self.appDataFilePath) as data_file:
            data = json.load(data_file)
            for share in data:
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
                        "amount": last_quote
                    }
                },
                {
                    "measurement": "estate",
                    "tags": {
                        "name": share['name'],
                    },
                    "fields": {
                        "quantity": share['estate']['quantity'],
                        "received_dividend": share['estate']['received_dividend'],
                    }
                },
                {
                    "measurement": "purchase",
                    "tags": {
                        "name": share['name'],
                    },
                    "fields": {
                        "quantity": share['purchase']['quantity'],
                        "cost_price": share['purchase']['cost_price'],
                        "fee": share['purchase']['fee']
                    }
                }
                ]
                self.influxdbClient.write_points(json_body)
                self.influxdbClient.close()

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
            error_counter = 0
        except Exception as err:
            print("An error has occured: " + str(err))
            error_counter += 1
            if error_counter >= 5:
                print("5 consecutive errors : Exiting the app")
                sys.exit(1)
        finally:
            time.sleep(suivi.appScrapingInterval)
