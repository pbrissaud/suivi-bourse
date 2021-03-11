FROM python:3.9

WORKDIR /usr/src/app
COPY ./app/ .

RUN python3 -m pip install influxdb
RUN python3 -m pip install yfinance

ENV INFLUXDB_HOST=suivi-bourse-influxdb
ENV INFLUXDB_PORT=8086
ENV INFLUXDB_DATABASE=bourse

VOLUME [ "/data" ]

CMD ["python3", "main.py"]

