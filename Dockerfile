FROM python:3.9

WORKDIR /usr/src/app
COPY ./app/ .

RUN python3 -m pip install influxdb
RUN python3 -m pip install yfinance

VOLUME [ "/data" ]

CMD ["python3", "main.py"]

