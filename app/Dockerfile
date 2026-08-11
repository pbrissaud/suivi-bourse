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

# The content-addressable store pnpm resolves under $PNPM_HOME, named here so
# the cache mount below can target it (issue #742). It is a **build** cache and
# it has one audience: the contributor who rebuilds. The cache that serves a
# PaaS starting from nothing is a registry cache and belongs to the release
# workflow — confusing the two is how neither ends up optimised.
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

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
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    cd web && pnpm install --frozen-lockfile

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
# Same cache mount, same audience (issue #742): a wheel already downloaded is
# not downloaded again on the next local rebuild. `/root/.cache/uv` is uv's own
# default location and this layer runs as root — naming it here rather than
# moving it with UV_CACHE_DIR keeps one convention instead of two.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-project

# The whole uid apparatus left here with #742: no `chmod 0755` on the home, no
# sticky-writable cache, no `ENV HOME`. All three existed because the container
# ran under the *host* user's uid — the price of a config directory the app and
# a human both wrote in. The store now has a named volume of its own (ADR-0015),
# so the container runs as `appuser`, who owns their own `$HOME`: Debian's
# HOME_MODE 0700 is correct again, gunicorn's `chdir` lands in a directory its
# own user owns, and yfinance's timezone cache under `$HOME/.cache` belongs to
# whoever writes it. The inherited PaaS hazard — a platform that never records
# an invoking uid landing on `1000:1000` by accident — closes with the cause
# rather than by being handled.
RUN useradd --create-home appuser \
    # ---- TRANSITIONAL, AND #743 DELETES BOTH LINES WITH ITS OWN SUBJECT ----
    # The paragraph above is true of the target state and premature by exactly
    # one ticket. `docker-compose/` still points `SB_STORE_DIR` **inside** the
    # host-mounted config directory, which the human owns, so the stack still
    # runs `user: "${SB_UID:-1000}:${SB_GID:-1000}"` — 501 on a Mac. And
    # `/home/appuser` is that uid's `$HOME` *and* gunicorn's `chdir` (the
    # WORKDIR below): `useradd --create-home` leaves it 0700, so without the
    # traverse bit the container dies on `Permission denied: '/home/appuser'`
    # before a line of application code runs. Measured, not feared — and it
    # kills the macOS development loop `CLAUDE.md` prescribes, on the one
    # platform where the app cannot run natively at all (#657).
    #
    # The cache goes with it for the same foreign uid: yfinance keeps its
    # timezone cache under `$HOME/.cache`, silently degrading to a no-op dummy
    # when it cannot write there — one network round-trip per ticker, forever.
    #
    # Neither line costs anything in the target state (a traverse bit on the
    # home of a container's only user), and #743 removes their subject when it
    # removes the stack. It must remove them too.
    && chmod 0755 /home/appuser \
    && mkdir -p /home/appuser/.cache \
    && chmod 1777 /home/appuser/.cache \
    # ---- END TRANSITIONAL ----
    # The two directories the environment names by default (issue #740,
    # ADR-0015): `/data` is where the store is written, `/import` is the drop
    # folder and is read-only in use. They exist in the image because a bare
    # `docker run` must **start** — `appuser` cannot create a directory at the
    # filesystem root, and a store that cannot be created is a named exit, not
    # a degraded mode. They are **owned by appuser**, and that is what replaces
    # everything above: Docker initialises a fresh named volume with the
    # content *and the permissions* of the image directory it covers, so a
    # non-root container writes into a brand-new volume with not one uid
    # gesture anywhere. An unmounted `/import` is an ordinary state — an
    # install with nothing to import is a complete install.
    #
    # And no `VOLUME` instruction: it would have Docker create an anonymous
    # volume on every bare `docker run`, making the trial run persist behind
    # the user's back into a volume they cannot name — the opposite of what a
    # trial run is, and the notice #743 prints would be a lie.
    && mkdir -p /data /import \
    && chown appuser:appuser /data /import
WORKDIR /home/appuser
COPY ./src /home/appuser

# The built SPA, landing where Flask already looks for it: `_static_dir()`
# resolves `<parent of the web package>/static`, which is this path in the image
# and `app/src/static` in a checkout. One convention, no env var to keep in sync
# — and .dockerignore excludes a locally built src/static so the host's copy can
# never shadow this one.
COPY --from=web /build/src/static /home/appuser/static

USER appuser

# 8080 serves the web UI and /health, 8081 keeps serving /metrics for existing
# Prometheus scrapers. Both are sockets of a single gunicorn master (issue #651).
EXPOSE 8080 8081

# The probe lives in the image (issue #742, ADR-0015). In v4 it lived in
# compose, so whoever followed the `docker run` page had none — and did not
# know it. Here it applies to a bare run and to a PaaS alike.
#
# It **touches the store**, because `/health` does (#696): the v4 rule — *never
# depend on the database, an outage of someone else's is not ours to restart
# for* — lost its subject the day the database became a file this process
# opens. It **does not touch the scheduler**: a wedged backfill must not
# restart the container, that is something the runtime state *displays* (#668),
# not something a healthcheck decides.
#
# `SB_WEB_PORT` is read here rather than hard-coded, and read the way the app
# reads it — blank counts as unset (`boot_env.text`), since compose renders an
# undefined substitution as the empty string. Python does the request because
# the runtime image ships no curl and no wget, and adding one for a probe would
# be a package installed for a single line.
#
# The `start-period` covers the **opening of the store** — the master's DDL,
# seed and first ledger replay, then the fork — and deliberately not the
# historical reconstruction, which runs for ~25 minutes on thirty symbols over
# five years. A start period stretched over the rebuild would report *starting*
# for that whole span on a container whose store never answers at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % (os.environ.get('SB_WEB_PORT') or '8080'), timeout=4).read()"]

# gunicorn, not `python3 main.py`: the API runs inside the scraper process, and
# `preload_app` + `post_fork` in gunicorn.conf.py are what split the boot either
# side of the fork. There is no second boot path — the config file is the only
# place the sequence is written down.
ENTRYPOINT ["gunicorn", "--config", "gunicorn.conf.py", "web:create_app()"]
