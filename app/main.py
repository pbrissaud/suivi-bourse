import json,
import os
import time
import yfinance as yf
from influxdb import InfluxDBClient


class SuiviBourse:
    def __init__(self):
        try:
            self.influxdbClient = InfluxDBClient(
                host=os.environ['INFLUXDB_HOST'],
                port=os.environ['INFLUXDB_PORT'],
                database=os.environ['INFLUXDB_DATABASE'])
        except ConnectionError:
            print('Problème de connexion à INfluxBD')
            exit(1)

    def run(self):
        while True:
            with open('/data/data.json') as data_file:
                data = json.load(data_file)
                for action in data:
                    ticker = yf.Ticker(action['sigle'])
                    history = ticker.history()
                    last_quote = (history.tail(1)['Close'].iloc[0])
                    json_body = [{
                        "measurement": "cours",
                        "tags": {
                            "nom": action['nom'],
                            "sector": ticker.info['sector']
                        },
                        "fields": {
                            "price": last_quote
                        }
                    }, {
                        "measurement": "patrimoine",
                        "tags": {
                            "nom": action['nom'],
                            "sector": ticker.info['sector']
                        },
                        "fields": {
                            "quantite": action['patrimoine']['quantite'],
                            "prix_revient":
                            action['patrimoine']['prix_revient']
                        }
                    }]
                    self.influxdbClient.write_points(json_body)
                    time.sleep(10)


if __name__ == "__main__":
    suivi = SuiviBourse()
    suivi.run()
