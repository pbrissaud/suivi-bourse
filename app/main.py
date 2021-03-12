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
                argv, "hH:P:D:U:P:i:p:", ["help", "host=", "port=", "database=", "username=", "password=", "interval=", "path="]
            )
        except getopt.GetoptError as err:
            print(err)
            usage()
            sys.exit(1)
        
        influxHost = os.getenv('INFLUXDB_HOST', default='localhost')
        influxPort = os.getenv('INFLUXDB_PORT', default=8086)
        influxDatabase = os.getenv('INFLUXDB_DATABASE', default='bourse')
        influxUsername = ""
        influxPassword = ""

        self.appScrapingInterval = os.getenv('APP_SCRAPING_INTERVAL', default=60)
        self.appDataFilePath = os.getenv('APP_FILE_PATH', default='/data/data.json')

        for opt, arg in opts:
            if opt in ("-h", "--help"):
                usage()
                sys.exit(0)
            elif opt in ("-H", "--host"):
                influxHost = arg
            elif opt in ("-P", "--port"):
                influxPort = arg
            elif opt in ("-D", "--database"):
                influxDatabase = arg
            elif opt in ("-U", "--username"):
                influxUsername = arg
            elif opt in ("-P", "--password"):
                influxPassword = arg
            elif opt in ("-i", "--interval"):
                self.appScrapingInterval = arg
            elif opt in ("-p", "--path"):
                self.appDataFilePath = arg

        self.influxdbClient = InfluxDBClient(host=influxHost,port=influxPort,database=influxDatabase,username=influxUsername,password=influxPassword)
        

    def run(self):
        try:
            with open(self.appDataFilePath) as data_file:
                data = json.load(data_file)
                for action in data:
                    ticker = yf.Ticker(action['sigle'])
                    history = ticker.history()
                    last_quote = (history.tail(1)['Close'].iloc[0])
                    json_body = [{
                        "measurement": "cours",
                        "tags": {
                            "nom": action['nom']
                        },
                        "fields": {
                            "price": last_quote
                        }
                    }, {
                        "measurement": "patrimoine",
                        "tags": {
                            "nom": action['nom'],
                        },
                        "fields": {
                            "quantite": action['patrimoine']['quantite'],
                            "prix_revient":
                            action['patrimoine']['prix_revient']
                        }
                    }]
                    self.influxdbClient.write_points(json_body)
                    self.influxdbClient.close()
        except Exception as e:
            print(e)
            sys.exit(1)

def usage():
    print("usage")
        


if __name__ == "__main__":
    suivi = SuiviBourse(sys.argv[1:])
    # If you want to run the app not in Docker, replace next lines with 'suivi.run()' 
    while True:
        suivi.run()
        time.sleep(suivi.appScrapingInterval)

