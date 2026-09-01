# The app gets a second reader, and it is an agent

[ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) removed the last
non-browser consumer and drew the conclusion out loud: `/api` is **the front's interface**,
it sheds a promise of stability it never actually made, and a product with one owner, one
browser and one container *"pays for a second interface twice — once to build it, once in
the shape it forces on the model"*. **This record reopens exactly one half of that**, and it
does it the way ADR-0033 asked to be answered: *"the API's status is decided here rather
than left to erode."* The app gets a second reader. It is an agent, it only reads, and the
decision is taken rather than drifted into.

**The reason this is not `/metrics` coming back** is the one thing that endpoint never had:
an internal consumer. The gauges were justified by *"whoever wants something very simple"* —
a person with no existence — and that is why removing them cost nothing. The tool surface
below has a consumer, and it is the headline feature of the same milestone: the built-in
chat (#750) is defined on **the same tool functions**, called in process, with no HTTP hop
in a loopback. A surface the app's own feature runs on cannot quietly rot, and that is the
whole of what makes a second non-browser reader defensible here where the gauges were not.
What the external client buys, on top, is the case the owner named: somebody who already has
their own agent and wants their portfolio in it, without going through ours.

**One socket, one process, and no fork.** The MCP server is not a second service. Its
Streamable HTTP application is ASGI, mounted beside the WSGI-wrapped Flask app inside
`boot.Serving`, on the same bind, under `/mcp`. The SDK requires the *host* application's
lifespan to enter `session_manager.run()` — a mounted sub-application's own lifespan never
runs — and `Serving` already intercepts the lifespan protocol, for another reason entirely:
it is where the teardown lives, the heir of gunicorn's `worker_exit`. The hook the SDK asks
for is therefore already there. `SB_WEB_PORT` stays the only port, the three boot variables
stay three, and [ADR-0039](./0039-the-app-stops-forking.md) is untouched.

**Three machine readers now, and three different statuses — stated, so none of them erodes.**
`/health` is the orchestrator's contract, settled in
[ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md). `/api` stays
the front's interface and stays disposable: a route and its caller may still be reshaped in
one commit. The **tool surface is a contract** — names, arguments, payload shapes — and that
is a narrow promise granted on purpose, because a person points their own client at it and a
tool that renames itself breaks their setup in silence, with no page to show a diagnostic on.
It is the reason the surface is documented on the site: ADR-0033 counted *"nothing on the
site describes an API"* as an economy, and this is the first thing there that describes a
machine interface. A contract nobody can read is not one.

**It reads, and it does not write.** `entries.py` remains the ledger's one writer
([ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md)), reached by a person's gesture.
This is not caution for its own sake — it is what makes the access model honest. The
`before_request` guard refuses a *foreign origin*, which is a statement about browsers; a
client with no `Origin` at all is not refused, and never will be, because that is the rule's
deliberate shape. So an MCP write would be an exposure that no existing guard covers, and
the answer is not to invent a guard for it. **The socket is the authorization**, exactly as
it already is for `/api` — *"whoever reaches the socket reaches the whole app"* — and
read-only is what turns that from an oversight into a decision. Whoever publishes the socket
puts it behind their own proxy, which is what publishing this app has always meant.

**A tool's description is payload, not documentation.** This app has three structurally
distinct states of absence ([ADR-0026](./0026-a-read-in-flight-is-not-an-absence.md)), a
carrying convention with two terms — `terminal` separates *not priced yet* from *never
priced* ([ADR-0004](./0004-carrying-price.md)) — one reporting currency carried in the head
of a payload and never on a row ([ADR-0002](./0002-one-base-currency.md)), and a sold
position that stays in the table at quantity zero
([ADR-0017](./0017-a-closed-position-leaves-the-table-never-the-total.md)). A model that
does not hold those will say *"you own 0 € of AAPL"* in perfect confidence when the truth is
that nothing has ever priced it. The description string is the only channel that reaches the
model **without anybody choosing to attach it** — which is why the conventions travel there,
and not in a resource or a prompt that an optional client gesture may never load.

**And there is exactly one place this surface departs from `/api`, which is the ledger.**
[ADR-0031](./0031-the-ledger-loads-in-pages.md) answers `GET /api/events` *entire* and says
so as a decision: the forty rows are a rendering budget, not a fetch, and *"paging the
resource was never considered."* That is right for a browser, whose constraint is the pixel.
A model's constraint is the context window, and the ledger is the only resource where the two
differ enough to change the shape — every other tool is bounded by what the portfolio *is*.
So the ledger tool is bounded, and it carries the total, because a bounded answer without one
is worse than an unbounded answer: it produces an agent that states *"you have made a hundred
operations"* and is wrong.

## Consequences

- **The MCP SDK becomes a direct dependency**, and its tail is not nothing: `pydantic`,
  `starlette`, `sse-starlette`, `httpx2`, `jsonschema`, `pyjwt[crypto]` and — the line worth
  writing down — `opentelemetry-api`. That is a transitive dependency of a protocol library
  and **not the exporter returning**; the next reader of `pyproject.toml` is told so there,
  in the comment, because every other line in that file explains itself and this one invites
  the wrong conclusion.
- **The code is a module of `application`, not a third package.** `src/mcp/` would shadow the
  SDK's own import name under `PYTHONPATH=src` — a failure that appears in the image and not
  in a checkout. It is not in `api` either: that package is Flask and WSGI, and this is ASGI.
- **`Serving` grows a path branch, and it is the only new code on every request's path.** An
  error there breaks the whole app, not the MCP surface, so it is tested as routing in its own
  right: `/mcp` reaches the MCP application, everything else reaches the WSGI one, and the
  lifespan enters and exits the session manager.
- **`create_app()` stops being the whole application's test seam**, and that is the real price
  of the mount. The tools are tested as functions over a real store in `tmp_path`, like
  everything else; the surface is tested through the SDK's in-memory client, which is what
  proves the descriptions exist at all. No test binds a socket to speak Streamable HTTP.
- **The one faked external edge is still yfinance.** The store is real, the tools read the
  store, and nothing here is doubled.
- **A store that cannot answer is a tool error, never an empty payload.** `/api` already
  separates a failed request from an empty portfolio, and the stakes are higher here: an agent
  handed `[]` will report that the owner holds nothing.
- **The interface answers under any host name, and that is passed explicitly.**
  Handing the SDK no transport-security settings is the one thing that does not
  mean *no policy*: it reads its `host` argument, defaults it to `127.0.0.1`,
  and substitutes an allowlist of localhost names — which answers `421 Invalid
  Host header` to a LAN address, a container name and a reverse proxy's domain
  alike, every way this app is actually reached except the one a developer tests
  from. The alternative, a real allowlist, is not available: the app cannot know
  the name it is reached under, and learning one would be a fourth boot
  variable. What the check defends is defended structurally instead — the SDK
  enforces `Content-Type: application/json` on every POST whatever that setting
  says, and a browser cannot send it cross-origin without a preflight this app
  answers no CORS header to.
- **The site gets its first machine-facing page**, in English only — `i18n/` holds `en/` alone
  and French arrives through Crowdin, never by hand.

[The half it reopens: ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) ·
[the process it does not fork: ADR-0039](./0039-the-app-stops-forking.md) ·
[the ledger shape it declines: ADR-0031](./0031-the-ledger-loads-in-pages.md) ·
[the writer it does not become: ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md) ·
[the conventions its descriptions carry: ADR-0004](./0004-carrying-price.md),
[ADR-0026](./0026-a-read-in-flight-is-not-an-absence.md) ·
[the ticket: #749](https://github.com/pbrissaud/suivi-bourse/issues/749) ·
[its first consumer: #750](https://github.com/pbrissaud/suivi-bourse/issues/750)
