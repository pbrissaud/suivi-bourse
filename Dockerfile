FROM node:26-slim AS web

WORKDIR /build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@latest && corepack enable

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

COPY src/web/package.json src/web/pnpm-lock.yaml src/web/pnpm-workspace.yaml ./web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    cd web && pnpm install --frozen-lockfile

COPY src/web ./web
RUN cd web && pnpm build

FROM python:3.15-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.8 /uv /uvx /bin/

ENV UV_NO_DEV=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# The dependency layer needs each member's manifest to resolve the workspace,
# and none of its sources: a source change does not reinstall the dependencies.
COPY pyproject.toml uv.lock ./
COPY packages/core/pyproject.toml packages/core/
COPY packages/store/pyproject.toml packages/store/
COPY packages/market/pyproject.toml packages/market/
COPY packages/app/pyproject.toml packages/app/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-workspace \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends binutils \
 && find /opt/venv -type d -name tests -prune -print0 | xargs -0 rm -rf \
 && find /opt/venv -type d -name test -prune -print0 | xargs -0 rm -rf \
 && find /opt/venv -name "*.so*" -exec strip --strip-unneeded {} + \
 && apt-get purge -y -qq binutils \
 && apt-get autoremove -y -qq \
 && rm -rf /var/lib/apt/lists/*

RUN rm -f /opt/venv/bin/uvicorn

RUN useradd --create-home appuser \
    && mkdir -p /data \
    && chown appuser:appuser /data
WORKDIR /home/appuser

# The members, built into the venv as wheels (#1199). The front goes inside
# `api` first, so the `app` wheel carries it where `api._static_dir()` looks.
COPY packages /app/packages
COPY --from=web /packages/app/src/api/static /app/packages/app/src/api/static
RUN --mount=type=cache,target=/root/.cache/uv \
    cd /app && uv sync --locked --package app --no-editable \
 && rm -rf /app/packages

ENV XDG_CACHE_HOME=/tmp/.cache

USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % ((os.environ.get('SB_WEB_PORT') or '').strip() or '8080'), timeout=4).read()"]

ARG SOURCE_COMMIT=""
ARG RELEASE_VERSION=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT} \
    RELEASE_VERSION=${RELEASE_VERSION}

ENTRYPOINT ["python", "-m", "application.boot"]
