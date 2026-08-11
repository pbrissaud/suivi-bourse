# --- Front-end build stage (issue #659) -------------------------------------
# The cost #655 decision 2 measured before choosing a packaged SPA over vendored
# bundles: one node stage, and `COPY --from` of its output. Node never reaches
# the final image — the runtime layer below stays Python-only, and `dist/` is
# static files. The whole stage disappears the day the front is thrown away.
FROM node:26-slim AS web

WORKDIR /build
# Node 25 unbundled corepack, so node:26-slim no longer ships it. Reinstalling
# it beats `npm i -g pnpm@x` because corepack reads the version from
# `web/package.json`'s `packageManager` field — one source of truth for the
# package manager, instead of a second one to keep in sync here.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@latest && corepack enable

# Manifest and lockfile first, so a source-only change reuses the install layer.
# `--frozen-lockfile` makes a lockfile that disagrees with package.json a build
# failure rather than a silent resolution — the same contract `uv sync --locked`
# gives the Python half.
#
# `pnpm-workspace.yaml` belongs to this layer and not to the source copy below:
# it is where pnpm 11 reads the `allowBuilds` verdicts, and `pnpm install` is
# what asks for them. Without it here the install stops on
# `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: msw`, and nothing on a pull
# request sees it — the image is only built by the release workflow.
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/
RUN cd web && pnpm install --frozen-lockfile

COPY web ./web
# Vite writes to ../src/static (see web/vite.config.ts), i.e. /build/src/static.
RUN cd web && pnpm build

# --- Runtime stage ----------------------------------------------------------
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

RUN useradd --create-home appuser \
    # Debian's HOME_MODE is 0700, which since #658 no longer works: the service
    # runs as the *host* user's uid so the config it writes stays theirs, and
    # /home/appuser is both that uid's $HOME and gunicorn's `chdir` (the WORKDIR
    # below). Without the traverse bit the boot dies on `os.chdir` before a line
    # of application code runs.
    && chmod 0755 /home/appuser \
    # yfinance keeps a timezone cache under $HOME/.cache. That same foreign uid
    # does not own it, so the cache would silently degrade to yfinance's no-op
    # dummy — an extra network round-trip per ticker, forever. Sticky-writable,
    # like /tmp, so any uid gets its own.
    && mkdir -p /home/appuser/.cache \
    && chmod 1777 /home/appuser/.cache \
    # The two directories the environment names by default (issue #740,
    # ADR-0015): `/data` is where the store is written, `/import` is the drop
    # folder and is read-only in use. They exist in the image because a bare
    # `docker run` must **start** — `appuser` cannot create a directory at the
    # filesystem root, and a store that cannot be created is a named exit, not
    # a degraded mode. Sticky-writable on the store for the same foreign-uid
    # reason as the cache above. The named volume, the mounts and the
    # observation that says which of the two you are running are #743's.
    && mkdir -p /data /import \
    && chmod 1777 /data \
    && chmod 0755 /import
WORKDIR /home/appuser
COPY ./src /home/appuser

# The built SPA, landing where Flask already looks for it: `_static_dir()`
# resolves `<parent of the web package>/static`, which is this path in the image
# and `app/src/static` in a checkout. One convention, no env var to keep in sync
# — and .dockerignore excludes a locally built src/static so the host's copy can
# never shadow this one.
COPY --from=web /build/src/static /home/appuser/static

# Not redundant with the appuser home. Since #658 the config mount is writable
# and compose runs the service under the *host* user's uid so the files the UI
# writes stay theirs — a uid with no /etc/passwd entry (501 on macOS), for which
# Docker sets HOME=/, which would send main.py's
# Path('~/.config/SuiviBourse').expanduser() to /.config/SuiviBourse and away
# from the mount entirely.
ENV HOME=/home/appuser

USER appuser

# 8080 serves the web UI and /health, 8081 keeps serving /metrics for existing
# Prometheus scrapers. Both are sockets of a single gunicorn master (issue #651).
EXPOSE 8080 8081

# gunicorn, not `python3 main.py`: the API runs inside the scraper process, and
# `preload_app` + `post_fork` in gunicorn.conf.py are what split the boot either
# side of the fork. There is no second boot path — the config file is the only
# place the sequence is written down.
ENTRYPOINT ["gunicorn", "--config", "gunicorn.conf.py", "web:create_app()"]
