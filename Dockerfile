# --- Front-end build stage (issue #659) -------------------------------------
# The cost #655 decision 2 measured before choosing a packaged SPA over vendored
# bundles: one node stage, and `COPY --from` of its output. Node never reaches
# the final image — the runtime layer below stays Python-only, and `dist/` is
# static files. The whole stage disappears the day the front is thrown away.
FROM node:26-slim AS web

WORKDIR /build
# Node 25 unbundled corepack, so node:26-slim no longer ships it. Reinstalling
# it beats `npm i -g pnpm@x` because corepack reads the version from
# `src/web/package.json`'s `packageManager` field — one source of truth for the
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
COPY src/web/package.json src/web/pnpm-lock.yaml src/web/pnpm-workspace.yaml ./web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    cd web && pnpm install --frozen-lockfile

COPY src/web ./web
# Vite writes to ../static (see src/web/vite.config.ts), i.e. /build/static.
RUN cd web && pnpm build

# --- Runtime stage ----------------------------------------------------------
FROM python:3.14-slim

# Bring in the uv binary from its official image (pinned for reproducibility)
COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /uvx /bin/

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

# And the server's console script goes straight back out (ADR-0039). uvicorn is
# called from `boot.py` as a library — `uvicorn.run(...)`, in process — and the
# script is the one thing in this image that would accept `--workers 4`, which
# is the capability the design does not want: N workers are N schedulers. The
# entrypoint below closes that door by carrying no flags; this closes the one an
# `--entrypoint uvicorn` override would open.
RUN rm -f /opt/venv/bin/uvicorn

# The whole uid apparatus is gone (issues #742 and #743): no `chmod 0755` on the
# home, no sticky-writable cache, no `ENV HOME`. All three existed because the
# container ran under the *host* user's uid — the price of a config directory
# the app and a human both wrote in — and the last thing that still ran one was
# the compose stack, which #743 deleted. The store has a named volume of its own
# (ADR-0015), so the container runs as `appuser`, who owns their own `$HOME`:
# Debian's HOME_MODE 0700 is correct again, the working directory
# is one its own user owns, and yfinance's timezone cache belongs to whoever
# writes it. The inherited PaaS hazard — a platform that never records an
# invoking uid landing on `1000:1000` by accident — closes with the cause rather
# than by being handled: there is no uid to guess left.
RUN useradd --create-home appuser \
    # The **one** directory the environment names by default (issue #740,
    # ADR-0015, ADR-0032): `/data` is where the store is written, and it is the
    # only mount there is — the drop folder left with the watcher that read it,
    # a file being handed to the app instead. It exists in the image because a
    # bare `docker run` must **start** — `appuser` cannot create a directory at
    # the filesystem root, and a store that cannot be created is a named exit,
    # not a degraded mode. It is **owned by appuser**, and that is what replaces
    # everything above: Docker initialises a fresh named volume with the
    # content *and the permissions* of the image directory it covers, so a
    # non-root container writes into a brand-new volume with not one uid
    # gesture anywhere.
    #
    # And no `VOLUME` instruction: it would have Docker create an anonymous
    # volume on every bare `docker run`, making the trial run persist behind
    # the user's back into a volume they cannot name — the opposite of what a
    # trial run is, and the notice #741 prints would be a lie.
    && mkdir -p /data \
    && chown appuser:appuser /data
WORKDIR /home/appuser

# The two Python packages, and only those: `src/web` is the front's *sources*,
# built in the stage above and copied below as static files — it has no business
# in a Python runtime image. Naming the two rather than copying `./src` is what
# keeps that true without relying on .dockerignore to subtract a directory.
COPY ./src/application /home/appuser/src/application
COPY ./src/api /home/appuser/src/api

# `src/` is the import root, in the image exactly as `pythonpath = ["src"]` makes
# it in a checkout: `application` and `api` are packages, and neither is reachable
# by accident from the working directory.
ENV PYTHONPATH=/home/appuser/src

# The built SPA, landing where Flask already looks for it: `_static_dir()`
# resolves `<parent of the api package>/static`, which is this path in the image
# and `src/static` in a checkout. One convention, no env var to keep in sync
# — and .dockerignore excludes a locally built src/static so the host's copy can
# never shadow this one.
COPY --from=web /build/static /home/appuser/src/static

# yfinance's timezone cache, out of `$HOME` and into the directory the base
# image already publishes world-writable. Not transitional and not a
# workaround: it is **strictly better than what this image used to do**, which
# was to ship a `$HOME/.cache` of its own at `1777` so that a foreign uid could
# write there. A world-writable directory is exactly what `/tmp` is for, its
# sticky bit is the mitigation, and reusing it means this image ships none.
#
# It also stops depending on `HOME` being right. Measured: with `HOME=/nowhere`
# and this variable set, `yfinance.cache.get_tz_cache()` reports `dummy: False`,
# writes `py-yfinance/tkr-tz.db` and reads the value back — so the cache is
# whole for **every** uid, including `appuser`, and that is why it survived #743
# where `ENV HOME` did not.
ENV XDG_CACHE_HOME=/tmp/.cache

# No `ENV HOME` (issue #743). It compensated for a uid absent from `/etc/passwd`
# — Docker hands such a uid `HOME=/` — and the only thing that ever ran one was
# the compose stack, which pointed the store inside a directory the human owned
# and therefore had to run `user:`. `appuser` *is* in `/etc/passwd`, so the base
# image's own `HOME` is right, `expanduser` lands where it should, and there is
# nothing left to compensate for.
USER appuser

# One port, because there is one socket (ADR-0033): 8080 serves the web UI, the
# API and /health. The second one existed for /metrics alone, and a `docker run
# -p` copied from the documentation would now publish a port nothing listens on.
EXPOSE 8080

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
# The `start-period` covers the **opening of the store** — the DDL, the seed and
# the first ledger replay — and deliberately not the historical reconstruction,
# which runs for ~25 minutes on thirty symbols over five years. A start period stretched over the rebuild would report *starting*
# for that whole span on a container whose store never answers at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % ((os.environ.get('SB_WEB_PORT') or '').strip() or '8080'), timeout=4).read()"]

# Which SuiviBourse this is, stamped by whoever builds the image, and **the
# last thing in the file** — that placement is the whole of the cost control.
# `SOURCE_COMMIT` changes on every commit and an `ARG` invalidates every layer
# that *follows* it; here it follows nothing, so the front-end build, the
# dependency layers and the source copies are all cached above it and only this
# trivial layer is rebuilt. Coolify's own documentation names that trade-off and
# defaults its compose build pack to leaving the commit out for it; put last,
# there is nothing left to trade.
#
# `SOURCE_COMMIT` is **Coolify's name**, not one this project chose: it is the
# predefined build argument the Dockerfile build pack injects on its own, so a
# deployment from git identifies itself with nothing configured anywhere.
# `RELEASE_VERSION` is passed by `releasing.yml`, which knows the tag the two
# registries publish under.
#
# Both default to the empty string so that a plain `docker build` still works,
# and the app reads them through `boot_env.text`, where **blank counts as
# unset** — the whole reason the empty default is not a stamp saying "".
# `build_info` reads them under those exact names; neither carries the `SB_`
# prefix, because that prefix is what `boot_env.unread` filters on, and a
# variable the app has just read must never be reported as one it no longer
# obeys.
ARG SOURCE_COMMIT=""
ARG RELEASE_VERSION=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT} \
    RELEASE_VERSION=${RELEASE_VERSION}

# `python -m application.boot`, and **no server command line** (ADR-0039). The
# module form rather than a path because `boot.py` sits inside a package now: `-m`
# puts `PYTHONPATH` in charge of resolution instead of the working directory,
# which is the rule the tests and a checkout already run under. The API runs
# inside the scraper process, and `boot.py` is the whole sequence — the
# environment, the store, the application, the jobs, the socket — in one file,
# because there is no fork to split it across any more. There is no second boot
# path.
#
# The absence of a CLI is itself a decision. gunicorn had two guards against a
# second worker (`on_starting` and a closed control socket), because N workers
# are N schedulers; uvicorn has a multiprocess mode of its own, so swapping one
# command line for another would have reopened the door those guards shut. This
# entrypoint calls `uvicorn.run(...)` in process — there is no flag to pass
# because there is no server command line here — and the console script that
# would have taken one was removed above.
ENTRYPOINT ["python", "-m", "application.boot"]
