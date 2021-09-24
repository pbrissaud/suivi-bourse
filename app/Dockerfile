FROM python:3.9

WORKDIR /usr/src/app
COPY ./app/ .
COPY ./requirements.txt .

RUN python3 -m pip install -r requirements.txt

VOLUME [ "/data" ]

CMD ["python3", "main.py"]

