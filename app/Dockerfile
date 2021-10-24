FROM python:3 as builder

WORKDIR /usr/src/app

COPY requirements.txt .

RUN pip install --user --no-cache-dir -r requirements.txt

FROM gcr.io/distroless/python3

RUN adduser --disabled-password --gecos "" worker
USER worker

COPY --from=builder --chown=worker:worker /root/.local /home/worker/.local
COPY --chown=worker:worker src /home/worker

WORKDIR /home/worker

ENTRYPOINT ["python3", "main.py"]
