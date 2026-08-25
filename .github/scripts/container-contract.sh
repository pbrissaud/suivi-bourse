#!/usr/bin/env bash
#
# The image's contract, asserted from outside (issue #744, spec #730 § 7).
#
# Nine assertions. The first one — `docker build ./app` succeeds — is the step
# that produced $IMAGE and cannot be made after the fact, so it lives in the
# workflow; the eight that follow live here. What they all have in common is
# that they attest **observable behaviour** and never the shape of a line of
# `Dockerfile`: a test that greps the file for `HEALTHCHECK` breaks at the first
# refactor *and passes on a broken probe*, while one that asks `docker inspect`
# and then waits for `healthy` attests the thing itself.
#
# Each assertion fails for its own reason and says which number it is, because
# the nine are nine decisions of ADR-0015 and #742 rather than nine details:
# a bare container that no longer starts and a healthcheck that never turns
# green are two different pieces of news.
#
# Run it by hand exactly as the CI does:
#
#     docker build -t suivi-bourse:pr ./app
#     IMAGE=suivi-bourse:pr .github/scripts/container-contract.sh
#
set -Eeuo pipefail

IMAGE="${IMAGE:-suivi-bourse:pr}"

# One label on every container and every volume this script creates, so the
# cleanup is a query rather than a list kept in step by hand — and so a run
# interrupted between two `docker run`s still leaves nothing behind.
LABEL='suivi-bourse-contract=744'

BARE=sb-contract-bare
KEPT=sb-contract-kept
PORTS=sb-contract-ports
LEGACY=sb-contract-legacy
STORE_VOLUME=sb-contract-store

# Host ports, all in one place and all **below** the ephemeral range the runner
# allocates from — Linux hands out 32768-60999 — so the kernel never gives one
# of these to an outbound socket while the script is running. The container-side
# ports differ per case on purpose: $PORTS is the one that proves `SB_WEB_PORT`
# is *read* rather than merely defaulted.
#
# One host port per container, because the image publishes one (ADR-0033): a
# second `-p` here would be the very dead mapping this script exists to keep out
# of the documentation.
BARE_WEB=18080
KEPT_WEB=18090
PORTS_WEB=19090
LEGACY_WEB=19081

# How long a container may take to answer, and how long its own probe may take
# to turn green. Generous rather than tight: a cold runner pays for the store's
# DDL, its seed and the first replay before either can happen, and a flaky
# timeout is a gate nobody trusts.
SERVING_TIMEOUT=120
HEALTHY_TIMEOUT=120

# --------------------------------------------------------------------------- #
# Plumbing
# --------------------------------------------------------------------------- #

cleanup() {
    local ids vols
    ids="$(docker ps -aq --filter "label=$LABEL" 2>/dev/null || true)"
    if [ -n "$ids" ]; then
        # shellcheck disable=SC2086
        docker rm -f $ids >/dev/null 2>&1 || true
    fi
    vols="$(docker volume ls -q --filter "label=$LABEL" 2>/dev/null || true)"
    if [ -n "$vols" ]; then
        # shellcheck disable=SC2086
        docker volume rm -f $vols >/dev/null 2>&1 || true
    fi
    return 0
}
# EXIT covers the three ways this script ends — the assertion that fails, the
# `set -e` that trips, and the run that succeeds — so nothing survives it.
trap cleanup EXIT

assertion() { printf '\n=== Assertion %s ===\n' "$*"; }
ok() { printf '  ok  %s\n' "$*"; }

fail() {
    printf '\n  FAIL  %s\n' "$*" >&2
    exit 1
}

dump() {
    printf '\n--- docker logs %s ---\n' "$1" >&2
    docker logs "$1" >&2 2>&1 || true
    printf -- '--- end of %s ---\n' "$1" >&2
}

start() {
    local name="$1"; shift
    docker run -d --name "$name" --label "$LABEL" "$@" "$IMAGE" >/dev/null
}

# `000` is curl's own write-out for a transfer that never got a status line, so
# the fallback covers only the case where curl printed nothing at all — appended
# to the failure it already reported, it would answer `000000` and put that in
# the message of assertions 5 and 9.
http_code() {
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true)"
    printf '%s' "${code:-000}"
}

# The ordinary wait, and deliberately **not** the image's own probe: the two
# would collapse assertion 2 into assertion 8, and a `HEALTHCHECK` deleted from
# the Dockerfile would then be reported as "the bare container does not start".
# Each of the nine has to fail for its own reason, so liveness is asked of the
# route and greenness is asked of the probe, separately.
wait_serving() {
    local name="$1" url="$2" waited=0
    while [ "$waited" -lt "$SERVING_TIMEOUT" ]; do
        if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)" != 'true' ]; then
            dump "$name"
            fail "$name exited before it served $url"
        fi
        if [ "$(http_code "$url")" = '200' ]; then
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
    done
    dump "$name"
    fail "$name never answered 200 on $url within ${SERVING_TIMEOUT}s"
}

# Assertion 8's own instrument, used on the bare container alone.
wait_healthy() {
    local name="$1" waited=0 status
    while [ "$waited" -lt "$HEALTHY_TIMEOUT" ]; do
        status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo gone)"
        case "$status" in
            healthy) return 0 ;;
            none) fail "assertion 8: $name reports no health state — the image declares no HEALTHCHECK" ;;
            gone) dump "$name"; fail "assertion 8: $name disappeared while its probe was running" ;;
        esac
        sleep 2
        waited=$((waited + 2))
    done
    dump "$name"
    fail "assertion 8: $name never reached 'healthy' in ${HEALTHY_TIMEOUT}s (last: $status)"
}

# `grep -c` exits 1 on no match, which `set -e` would turn into an abort where
# zero is the very thing several assertions measure.
count_in_logs() {
    docker logs "$1" 2>&1 | grep -c -- "$2" || true
}

condition_keys() {
    docker logs "$1" 2>&1 | grep -o 'condition="[a-z_]*"' | sort || true
}

# The store's persistence as the app itself publishes it (ADR-0033). Read from
# `/api/runtime` and not from `/api/store`: it is the one that makes no query,
# so it still answers on an install whose store will not open — which is exactly
# when *"where did my data go?"* is asked. `tr` then `sed` rather than a JSON
# parser, because the runner is not promised one and the member is a bare word.
persistence_of() {
    curl -s --max-time 10 "$1/api/runtime" \
        | tr ',{}' '\n\n\n' \
        | sed -n 's/^[[:space:]]*"persistence"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p'
}

# --------------------------------------------------------------------------- #
# The four containers, started together
# --------------------------------------------------------------------------- #
#
# Started before anything is asserted, because their boots are independent and
# serialising four of them would spend a minute of a pull request's check on
# waiting alone.

docker volume create --label "$LABEL" "$STORE_VOLUME" >/dev/null

# Bare: no volume, no variable. The trial run of ADR-0015.
start "$BARE" -p "$BARE_WEB:8080"

# The same image with a named volume on /data — the installation that keeps
# what it writes.
start "$KEPT" -v "$STORE_VOLUME:/data" -p "$KEPT_WEB:8080"

# The port moved, so the assertion is about the *variable* and not about a
# number that happens to be the default. It is also the container assertion 5
# goes looking for a second socket in, and moving the port is what makes that
# search mean something: neither the number the image used to expose nor the one
# next to the port actually in use is bound.
start "$PORTS" -e SB_WEB_PORT=9090 -p "$PORTS_WEB:9090"

# A v4 `.env` leftover: set, named at start-up, obeyed by nothing.
start "$LEGACY" -e SB_INGESTION_INTERVAL=42 -p "$LEGACY_WEB:8080"

# --------------------------------------------------------------------------- #

assertion '2 — the bare container starts and stays alive'
# ADR-0015 amends #677/D12: a missing store location is observed and stated, it
# is not a refusal to boot. So the bare run is the one that must not die.
wait_serving "$BARE" "http://127.0.0.1:$BARE_WEB/health"
sleep 5
[ "$(docker inspect -f '{{.State.Running}}' "$BARE")" = 'true' ] \
    || { dump "$BARE"; fail "assertion 2: the bare container stopped running"; }
[ "$(docker inspect -f '{{.State.Restarting}}' "$BARE")" = 'false' ] \
    || { dump "$BARE"; fail "assertion 2: the bare container is restarting"; }
ok 'a bare docker run boots and keeps running'

assertion '3 — it says it keeps nothing, once'
# The grep is on the logfmt `condition=` key rather than on the sentence: the
# key is the contract (#741), the wording is not. **Once** is the half that
# matters — the line is said in `build_runtime`, in the gunicorn master under
# `preload_app`, so a boot that started saying it twice would mean the master
# had forked before speaking, or that a respawn loop was under way.
said="$(count_in_logs "$BARE" 'condition="store_ephemeral"')"
[ "$said" -eq 1 ] || { dump "$BARE"; fail "assertion 3: the ephemeral-store line was said $said time(s), expected exactly 1"; }
ok 'the no-persistence condition is logged exactly once'

assertion '4 — with a volume it does not say it'
wait_serving "$KEPT" "http://127.0.0.1:$KEPT_WEB/health"
said="$(count_in_logs "$KEPT" 'condition="store_ephemeral"')"
[ "$said" -eq 0 ] || { dump "$KEPT"; fail "assertion 4: a mounted store still logged the ephemeral condition $said time(s)"; }
ok 'a mounted store says nothing about persistence'

assertion '5 — /health on SB_WEB_PORT, and nothing answers on a second port'
wait_serving "$PORTS" "http://127.0.0.1:$PORTS_WEB/health"
code="$(http_code "http://127.0.0.1:$PORTS_WEB/health")"
[ "$code" = '200' ] || fail "assertion 5: /health on SB_WEB_PORT=9090 answered $code"
# One socket, and this is where that is attested rather than read off the
# `EXPOSE` line (ADR-0033). Three assertions collapse into this one — that a
# second socket exists, that it answers, and that a variable silences it — and
# what replaces them says the thing itself: nothing is bound but the web port.
# `8081` is the number the image used to expose and the one a copied `docker run
# -p` still carries; `9091` is the neighbour of the port in use, so neither a
# hard-coded default nor an offset from `SB_WEB_PORT` can pass this.
#
# Asked from **inside** the container: a published host port whose upstream is
# not listening still completes a TCP handshake with the userland proxy, so
# probing from the runner would confuse *unbound* with *refused later*. Python
# does the asking because the runtime image ships no curl (which is also why the
# healthcheck is a `python -c`).
#
# The instrument is proved before it is trusted, because the probe below reads
# **any** failure of `docker exec` as "nothing is listening": no python, no
# container, an exec the daemon refused. That is the very shape this script
# refuses elsewhere — an assertion that passes on a broken sonde — so one
# separate `docker exec` establishes that python answers at all, and only then
# is its silence allowed to mean an unbound socket.
docker exec "$PORTS" python -c 'import socket' >/dev/null 2>&1 \
    || { dump "$PORTS"; fail 'assertion 5: python does not answer in the container, so nothing below could tell an unbound socket from a broken probe'; }
for dead_port in 8081 9091; do
    if docker exec "$PORTS" python -c "import socket; socket.create_connection(('127.0.0.1', $dead_port), timeout=5).close()" >/dev/null 2>&1; then
        dump "$PORTS"
        fail "assertion 5: something is listening on $dead_port — the app binds a second socket again"
    fi
done
ok 'the web port is the only socket the app binds'

assertion '6 — the store says it is ephemeral bare and persistent mounted'
# Read from the app's own resource and no longer from a gauge (ADR-0033): the
# fact outlived its instrument, and this is the assertion that proves the
# substitution rather than assuming it.
#
# Stated in both directions on purpose (#741): a member that *disappeared* would
# read as an install that has nothing to say, never as "it keeps what it
# writes". So the mounted case asserts the word `persistent` and not the absence
# of `ephemeral`.
bare_persistence="$(persistence_of "http://127.0.0.1:$BARE_WEB")"
[ "$bare_persistence" = 'ephemeral' ] \
    || fail "assertion 6: the bare container published '${bare_persistence:-nothing}', expected 'ephemeral'"
kept_persistence="$(persistence_of "http://127.0.0.1:$KEPT_WEB")"
[ "$kept_persistence" = 'persistent' ] \
    || fail "assertion 6: the mounted container published '${kept_persistence:-nothing}', expected 'persistent'"
ok 'the one fact that reports the installation rather than the portfolio'

assertion '7 — not root, and /data — the one mount — is writable'
whoami="$(docker exec "$BARE" id -un)"
uid="$(docker exec "$BARE" id -u)"
[ "$uid" != '0' ] || fail "assertion 7: the container runs as root (uid 0)"
[ "$whoami" = 'appuser' ] || fail "assertion 7: the effective user is '$whoami', expected 'appuser'"
# An actual write, not the permission bits: a fresh named volume inherits the
# image directory's ownership (ADR-0015), and that is the mechanism the whole
# uid apparatus was removed in favour of.
#
# **One mount, and this is where that is attested** (ADR-0032). The drop folder
# was the second, and the assertion that read it is gone rather than softened:
# every container this script starts runs with no `-v` on `/import` at all, so
# a `/import` reappearing in the image would be a directory nothing reads.
docker exec "$BARE" python -c "
import os
probe = '/data/.contract-probe'
with open(probe, 'w') as handle:
    handle.write('x')
os.unlink(probe)
if os.path.isdir('/import'):
    raise SystemExit('/import is back in the image')
" >/dev/null || { dump "$BARE"; fail 'assertion 7: /data is not writable, or /import is back in the image'; }
ok 'a non-root user owns what it writes, and there is one mount to own'

assertion '8 — a HEALTHCHECK is declared in the image, and the container reaches healthy'
# The first element of `Test` and not the mere presence of the object:
# `HEALTHCHECK NONE` leaves a `Healthcheck` behind whose test is `["NONE"]`, so
# a truthiness check would pass on an image that has explicitly disabled its
# probe — which is precisely the regression this assertion exists to catch.
declared="$(docker image inspect --format '{{if and .Config.Healthcheck .Config.Healthcheck.Test}}{{index .Config.Healthcheck.Test 0}}{{else}}absent{{end}}' "$IMAGE")"
case "$declared" in
    CMD | CMD-SHELL) ;;
    *) fail "assertion 8: the image declares no HEALTHCHECK ($declared) — it belongs in the image, not in a compose file the nominal path no longer reads" ;;
esac
# The declaration alone is what a `grep` of the Dockerfile would attest, and a
# broken probe would pass it — a probe pointed at a port nothing listens on, or
# at a route that answers before the store does. `healthy` is the thing itself.
wait_healthy "$BARE"
ok 'the probe is in the image and it turns green'

assertion '9 — a retired variable is named in the grouped notice and changes nothing'
wait_serving "$LEGACY" "http://127.0.0.1:$LEGACY_WEB/health"
# Anchored on the emitting function rather than on the sentence: `location=` is
# a code identifier, the prose is not, and the installation fact (#709) mentions
# the same variable name on another line. One line, from the one function whose
# whole job is the grouped notice.
named="$(docker logs "$LEGACY" 2>&1 | grep -c 'report_unread_environment.*SB_INGESTION_INTERVAL' || true)"
[ "$named" -eq 1 ] \
    || { dump "$LEGACY"; fail "assertion 9: the grouped notice named SB_INGESTION_INTERVAL $named time(s), expected exactly 1"; }
code="$(http_code "http://127.0.0.1:$LEGACY_WEB/health")"
[ "$code" = '200' ] || fail "assertion 9: with SB_INGESTION_INTERVAL set, /health answered $code"
# "Changes nothing" is asserted rather than assumed: the start-up conditions of
# this container are the bare one's, key for key. A variable that was still
# secretly obeyed would have to alter one of them or the boot itself.
if [ "$(condition_keys "$LEGACY")" != "$(condition_keys "$BARE")" ]; then
    dump "$LEGACY"
    fail 'assertion 9: SB_INGESTION_INTERVAL changed which start-up conditions stand'
fi
ok 'named, never obeyed'

printf '\nThe image honours its contract.\n'
