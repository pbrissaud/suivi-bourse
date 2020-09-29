import yfinance as yf
import json
import time

while True:
    with open('data.json') as data_file:
        data = json.load(data_file)
        for action in data:
            ticker = yf.Ticker(action['sigle'])
            history = ticker.history()
            last_quote = (history.tail(1)['Close'].iloc[0])
            print(action, last_quote)
    time.sleep(10)
