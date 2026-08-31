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

**SuiviBourse has no authentication and is not meant to be reachable from the
open internet.** It is one process bound to one socket, and the page, `/api`
— writes included — and `/health` all answer on it: whoever reaches the socket
reaches the whole app, and there is no setting that changes that. Publish it on
a private network, or put your own reverse proxy, VPN or identity layer in
front of it.

Two more properties are worth knowing before you judge an issue:

- **Everything is local.** The store is a DuckDB file under the one mount,
  `/data`. Nothing is sent anywhere except the price requests the app makes to
  Yahoo Finance, which name the symbols you hold.
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
