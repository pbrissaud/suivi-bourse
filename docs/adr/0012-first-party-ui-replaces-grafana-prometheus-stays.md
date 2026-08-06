# The first-party UI replaces Grafana, and Prometheus stays

Grafana leaves v5: the first-party UI, built and played for real as a prototype,
replaces it in full — a clean departure that owes nothing, no dashboard and no alert
rule having to be carried. The front is rewritten on the same stack the prototype
verified (Vite, React, TypeScript, Tailwind/shadcn, TanStack Query/Table/Router,
Recharts), and the four pages are **redesigned from what playing it taught**, not
ported.

The Prometheus endpoint, by contrast, **stays**. It is not the legacy half to be swept
away with Grafana: it is what makes the app usable **headless** — the gauges alone,
for whoever wants something very simple — as well as headful with the UI on top. That
duality is a product principle, and it constrains the store, the packaging and the
docs.

## Consequences

- Files stop being the truth; the store is. File provisioning survives, but
  **read-only and all-or-nothing**.
- Because a headless install has no UI in which to declare accounts, accounts must be
  provisionable **from files, with provenance**, and revocable file-by-file. This is
  the principle biting rather than decorating.
- Infrastructure settings stay in the environment; the user-facing dials and the user's
  data move into the store.

[Full argument: #667](https://github.com/pbrissaud/suivi-bourse/issues/667) ·
[prototype lessons: #675](https://github.com/pbrissaud/suivi-bourse/issues/675)
