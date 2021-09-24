FROM python:3 as builder

COPY requirements.txt .

RUN pip install --user -r requirements.txt

FROM python:3-slim

RUN adduser --disabled-password worker
USER worker

COPY --from=builder --chown=worker:worker /root/.local /home/worker/.local
COPY --chown=worker:worker app /home/worker

WORKDIR /home/worker

CMD ["python3", "main.py"]
