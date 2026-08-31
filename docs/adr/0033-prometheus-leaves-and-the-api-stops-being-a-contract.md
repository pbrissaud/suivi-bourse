# Prometheus leaves, and the API stops being a contract

ADR-0012 kept the Prometheus endpoint when Grafana left, and called the duality a product
principle: *"it is what makes the app usable **headless** — the gauges alone, for whoever
wants something very simple — as well as headful with the UI on top."* **This record
retires the second half.** `/metrics` goes, `prometheus_exporter.py` (573 lines) goes,
`SB_PROMETHEUS_ENABLED` and `SB_METRICS_PORT` go with the second socket, and the word
*headless* leaves the vocabulary rather than becoming a usage nobody can practise.

The reason is not that the gauges cost much. It is that **the guarantee behind them cost a
great deal**, in a place nobody would look for it: ADR-0012's own third consequence made
file-provisioned accounts *with provenance* a requirement, because a headless install has
no UI to declare them in. The whole import apparatus
([ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md)) is the descendant of that
sentence. A product with one owner, one browser and one container pays for a second
interface twice — once to build it, once in the shape it forces on the model — and this
one is choosing not to.

**The API's status is decided here rather than left to erode**, because removing the gauges
removes the last non-browser consumer. And the honest finding is that it was never a
contract: there is no OpenAPI document, no API page among the site's eleven, no CORS, no
versioning of `/api`. `problem.py`'s RFC 9457 discipline reads like a contract with third
parties and its own docstring says otherwise — the three states exist because *"rendering
the first two as errors is what a generic dashboard does, and that is half the argument for
building a first-party UI at all"*. It was paid for the front. So `/api` is **the front's
interface**: it keeps every property that serves the front, and sheds the promise of
stability it never actually made.

## Consequences

- **Nothing is deleted for the API's demotion.** `problem.py` stays, whole, with its
  argument intact; `PUT /api/settings` goes on validating the entire body and writing
  nothing when it refuses, because that is a property of the store and not a courtesy to a
  client. What ends is the obligation to keep a route's shape across v5.x — a route and its
  caller may now be reshaped in one commit.
- **One contract remains, and its reader is a machine**: `/health`, probed by the image's
  `HEALTHCHECK`. Its two registers are settled in
  [ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md).
- **The upload stays `multipart`, and that is a fact rather than a promise.** `curl -F` will
  work; nothing undertakes that it keeps working.
- **One socket, one bind.** `gunicorn.conf.py` stops appending a second port, and *"two
  sockets, one application"* stops being a thing to explain. Boot variables reach **three**:
  `SB_STORE_DIR`, `SB_WEB_PORT`, `LOG_LEVEL`.
- **The freshness sonde survives its gauge.** `main.py`'s `staleness_horizon` probe emits a
  `WARNING` *and* feeds the scrape record that `runtime_view.py` renders; only
  `sb_price_staleness` disappears. The dial stays, and the six settings stay six.
- **`headless-gauges.mdx` is deleted rather than rewritten**, and `settings.mdx` and
  `install-without-docker.mdx` lose the three variables. Nothing on the site describes an
  API, so nothing has to be withdrawn.
- **What replaces the observability is the app's own**, not a smaller Prometheus: the health
  body and the runtime tab. That substitution is the load-bearing part of this decision — an
  owner who could once alert on `sb_price_staleness` now has a coloured dot, and if that
  proves too little, the answer is a better health surface and not the endpoint's return.

[The principle it halves: ADR-0012](./0012-first-party-ui-replaces-grafana-prometheus-stays.md) ·
[the apparatus its guarantee produced: ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md) ·
[the health surface that inherits: ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md) ·
[the environment it shortens: ADR-0014](./0014-settings-live-only-in-the-store.md) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
