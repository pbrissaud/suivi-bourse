FROM python:3.9-slim as builder

ADD requirements.txt .

RUN pip install --upgrade pip

RUN pip install --no-cache-dir -r ./requirements.txt

FROM gcr.io/distroless/python3

COPY --from=builder /usr/local/lib/python3.9/site-packages /usr/local/lib/python3.9/site-packages

ENV LC_ALL C.UTF-8
ENV PYTHONPATH=/usr/local/lib/python3.9/site-packages/

WORKDIR /app

ADD ./src /app

EXPOSE 8081

ENTRYPOINT ["python3", "main.py"]
