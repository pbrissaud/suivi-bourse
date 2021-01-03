import json
import os
import time
import yfinance as yf
from influxdb import InfluxDBClient


class SuiviBourse:
    def __init__(self):
        self.influxHost = os.environ['INFLUXDB_HOST']
        self.influxPort = os.environ['INFLUXDB_PORT']
        self.influxDatabase = os.environ['INFLUXDB_DATABASE']

    def run(self):
        try:
            with open('/data/data.json') as data_file:
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
                    influxdbClient = InfluxDBClient(
                        host=self.influxHost,
                        port=self.influxPort,
                        database=self.influxDatabase)
                    influxdbClient.write_points(json_body)
                    influxdbClient.close()
        except Exception as e:
            print(e)


if __name__ == "__main__":
    suivi = SuiviBourse()
    while True:
        print('suivi.run()')
        suivi.run()
        time.sleep(60)
