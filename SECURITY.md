# Security Policy

## Supported versions

One line is supported, and it is the current one. SuiviBourse ships as a single
container image, so a fix reaches an install by pulling that image again.

| Version | Supported |
| ------- | ------------------ |
| 5.x     | :white_check_mark: |
| 4.x     | :x:                |
| < 4.0   | :x:                |

v5 is a rewrite rather than a release: a portfolio became a dated event ledger
in one embedded store, the exporter and its second socket went, and the Grafana
dashboards left with them. Nothing is backported across that line — the way off
an older install is
[Coming from v4](https://pbrissaud.github.io/suivi-bourse/docs/v5/coming-from-v4),
not a patch release of v4.

## What the app assumes about where it runs

**SuiviBourse is not meant to be reachable from the open internet.** It is one
process bound to one socket, and the page, `/api` — writes included — `/mcp`
and `/health` all answer on it.

**An optional PIN closes that socket on your local network.** It is off by
default and turned on in the settings, under *Access*. While it is on, one gate
in front of the whole socket answers every request first: without a session
only the PIN screen, its stylesheet, the static assets and `/health` answer,
and any route added later is closed whatever its path. A session is an
`HttpOnly`, `SameSite=Strict` cookie; `/mcp` takes a bearer token instead,
shown once when the PIN is set. Attempts are throttled per address and
globally.

**What the PIN does not protect: the internet without TLS.** The code and the
cookie cross the network as they are. To reach the app from outside, put a
reverse proxy with TLS, a VPN or an identity layer in front of it, PIN or not.
Behind a proxy, name it in `SB_FORWARDED_ALLOW_IPS` so the throttle counts the
real client address and the cookie is marked `Secure` over https; no proxy is
trusted by default.

**A forgotten PIN** is cleared by starting the app once with
`SB_RESET_AUTH=1`: the PIN, the session secret and the MCP token go, the data
stays. Remove the variable afterwards — while it is set, the reset runs, and is
logged, at every start. There is no route that does this.

**With the PIN off**, whoever reaches the socket reaches the whole app, and
three residual risks remain: a hostile page can reach a local install through
DNS rebinding; a write sent without an `Origin` header is not refused; and
`/mcp` runs with the MCP SDK's DNS-rebinding protection off, so that a LAN
address, a container name or a proxy's domain can reach it.

A few more properties are worth knowing before you judge an issue:

- **Everything is local, except what you send to a model.** The store is a
  DuckDB file under the one mount, `/data`. The app sends the price requests
  it makes to Yahoo Finance, which name the symbols you hold; and, once you
  switch the in-app agent on, your questions and the figures its tools read go
  to the provider you configured. With Ollama on your own machine, nothing
  leaves it.
- **The store holds secrets.** The agent's provider key, and the PIN's hash,
  session secret and token hash. No route, MCP tool or export reads them, and
  no route serves the store file.
- **A file is read, never kept.** A `.csv`/`.xlsx` handed to
  `POST /api/events/import` is read once and dropped; the upload is bounded
  (`413` past the limit) and every refusal writes nothing at all.

## Reporting a vulnerability

**Report privately**, through GitHub:
[open a draft advisory](https://github.com/pbrissaud/suivi-bourse/security/advisories/new).
Private vulnerability reporting is enabled on this repository, so that gives us
a place to talk before anything is public. Please do not open a public issue or
a pull request for a vulnerability — a fix in the open is a disclosure. Without
a GitHub account, contact@pbrissaud.net reaches the same person.

What makes a report actionable:

- **the version**, which the app says itself: the settings page ends on a
  card called *The version*, and `GET /api/runtime` carries the same under
  `build`;
- **how it is deployed** — the image, or an install without Docker — and what
  sits in front of the socket;
- **the smallest sequence that reproduces it**, and what you expected instead.

This is a personal project maintained on personal time. You will get an
acknowledgement rather than a service-level agreement, and a fix ships as an
ordinary release once there is one.

## Keeping dependencies current

Renovate watches this repository's dependencies — the Python runtime, the
front's packages, the base image and the CI actions — and its minor and patch
updates merge on their own once the checks pass. Secret scanning and push
protection are on. An update that matters for security is cut as a release
rather than left waiting for the next feature.
