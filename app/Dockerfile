FROM python:3.14-slim

# Bring in the uv binary from its official image (pinned for reproducibility)
COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /uvx /bin/

# Runtime deps only (UV_NO_DEV skips the dev group); compile bytecode; use the
# base image's Python and never download another one.
ENV UV_NO_DEV=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Install dependencies from the lockfile in a cached layer (before copying source)
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project

RUN useradd --create-home appuser
WORKDIR /home/appuser
COPY ./src /home/appuser
USER appuser

# 8080 serves the web UI and /health, 8081 keeps serving /metrics for existing
# Prometheus scrapers. Both are sockets of a single gunicorn master (issue #651).
EXPOSE 8080 8081

# gunicorn, not `python3 main.py`: the API runs inside the scraper process, and
# `preload_app` + `post_fork` in gunicorn.conf.py are what split the boot either
# side of the fork. There is no second boot path — the config file is the only
# place the sequence is written down.
ENTRYPOINT ["gunicorn", "--config", "gunicorn.conf.py", "web:create_app()"]
