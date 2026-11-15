# Security Policy

## Supported versions

Only the latest 5.x release receives fixes. To get a fix, pull the image again.

| Version | Supported          |
| ------- | ------------------ |
| 5.x     | :white_check_mark: |
| < 5.0   | :x:                |

## Where SuiviBourse is meant to run

SuiviBourse is meant for your own machine or home network, not the open
internet. One port serves the pages, `/api` (writes included), `/mcp` and
`/health`.

### The access code

The access code is optional and off by default. Turn it on in
**Settings → Security**. While it is on:

- A request without a session or token gets the lock screen (pages) or `401`
  (`/api`, `/mcp`, writes). WebSocket connections are closed.
- Without a session, only these answer: the lock screen, the static assets and
  icons, the theme stylesheet, `/health` (and `/healthz`, `/readyz`), and
  `/auth/*`. Any route added later is closed by default.
- `/auth/*` reports whether a code is set and takes a code to sign in. Changing
  or removing the code needs a session and the current code.
- The code is six digits, stored as a scrypt hash.
- The session is an `HttpOnly`, `SameSite=Strict` cookie. It ends after a period
  without activity: 15 minutes to 30 days, 30 days by default. Background polls
  from an idle tab do not extend it.
- Wrong codes are throttled per address: five free tries, then a wait that
  starts at 30 seconds and doubles up to 15 minutes. Past 60 failures in an hour
  from all addresses, the app accepts one attempt per minute.

### Access tokens

Access tokens let scripts and MCP clients in without the code. Create them in
**Settings → Security** once the code is on.

- Each token has a label, one or both scopes and an expiry: 90 days, 1 year or
  never. **/api, for a script** opens every method on `/api`. **/mcp, for Claude
  Desktop** opens `/mcp`.
- The app shows the secret once and stores only its SHA-256 hash.
- A token never opens `/auth/*` or the token routes: it cannot create a token,
  change the code or change the session length.
- Turning the code off deletes every token.

### Without TLS, everything travels in clear

The code, the session cookie and the tokens cross the network as they are. To
reach the app from outside, put a reverse proxy with HTTPS, a VPN or an identity
layer in front of it.

Behind a proxy, set `SB_FORWARDED_ALLOW_IPS` to the proxy's address. The
throttle then counts the real client address, and the cookie is marked `Secure`
over HTTPS. No proxy is trusted by default.

### Forgotten code

Start the app once with `SB_RESET_AUTH=1`. It removes the code, the session
secret and every access token, and keeps your data. Remove the variable
afterwards: while it is set, the reset runs at every start and logs a warning.
No route does this.

### With the code off

Anyone who reaches the port reaches the whole app. Three risks remain:

- A hostile web page can reach a local installation through DNS rebinding.
- A write to `/api` sent without an `Origin` header is accepted. A write with
  another site's `Origin` is refused.
- `/mcp` runs with the MCP SDK's DNS-rebinding protection off, so a LAN address,
  a container name or a proxy's domain can reach it.

### Data and secrets

- **What leaves the machine.** Price requests to Yahoo Finance, which name the
  securities you follow. A check for new releases on GitHub every six hours
  (turn off **Report new versions** on the **System** page). A download from the
  documentation site when you import a tax-model preset. Once you set them up:
  your questions and the figures the agent reads, sent to your AI provider, and
  notices sent to your notification channels. With Ollama on your own machine,
  the agent sends nothing out.
- **The store holds secrets.** The store is a DuckDB file under `/data`. It
  holds the AI provider keys and notification-channel secrets in clear, and the
  hashes of the code and the tokens. No route serves the store file, and a key
  or channel secret leaves the server as its last four characters only.
- **Uploaded files are not kept.** A `.csv` or `.xlsx` sent to
  `POST /api/events/import` is read once and dropped. Uploads over 8 MiB are
  refused with `413`.

## Reporting a vulnerability

**Report privately**, through GitHub:
[open a draft advisory](https://github.com/pbrissaud/suivi-bourse/security/advisories/new).
Do not open a public issue or pull request for a vulnerability. Without a GitHub
account, write to contact@pbrissaud.net.

Include:

- **the version**: shown on the **System** page under **Installation**, at the
  foot of the sidebar, and under `build` in `GET /api/runtime`;
- **how it is deployed**: the image or an install without Docker, and what sits
  in front of it;
- **the smallest sequence that reproduces it**, and what you expected instead.

This is a personal project maintained on personal time. You will get an
acknowledgement, not a service-level agreement. A fix ships as an ordinary
release.

## Keeping dependencies current

Renovate watches the Python packages, the front's packages, the base image and
the CI actions. Minor and patch updates merge on their own once the checks pass.
A Python version upgrade is merged by hand. Secret scanning and push protection
are on. A security fix ships as its own release.
