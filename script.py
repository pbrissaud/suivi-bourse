import yfinance as yf
import json
import time
from influxdb import InfluxDBClient
import datetime

while True:
    client = InfluxDBClient(host="localhost", port=8086, database="bourse")
    with open('data.json') as data_file:
        data = json.load(data_file)
        for action in data:
            ticker = yf.Ticker(action['sigle'])
            history = ticker.history()
            last_quote = (history.tail(1)['Close'].iloc[0])
            json_body = [
                {
                    "measurement": "quotations",
                    "tags": {
                        "nom": action['nom'],
                        "sector": ticker.info['sector']
                    },
                    "fields": {
                        "price": last_quote
                    }
                }
            ]
            client.write_points(json_body)
            time.sleep(10)
