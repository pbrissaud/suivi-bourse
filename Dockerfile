FROM python:3.8

WORKDIR /usr/src/app
COPY ./app/ .

RUN pip install pipenv
RUN pipenv lock --requirements > requirements.txt
RUN pip install -r requirements.txt

COPY ./patchs_libs/base.py /tmp/base.py
RUN cp /tmp/base.py /usr/local/lib/python3.8/site-packages/yfinance/base.py
RUN rm /tmp/base.py

ENV INFLUXDB_HOST=influxdb
ENV INFLUXDB_PORT=8086
ENV INFLUXDB_DATABASE=bourse

VOLUME [ "/data" ]

CMD ["python3", "main.py"]

