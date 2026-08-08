# Every version has an address, and the newest is not an exception

The documentation site versions everything except the version people actually read:
`3.x` is served at `/docs/v3`, `4.x` at `/docs/v4`, and the current one at bare
`/docs`, because `/docs` means *latest*. That is fine for a site and fatal for
ADR-0016, which sends the in-app bubble to a page on this site and requires the
link to **carry the version**. Under the existing configuration it cannot: a v5
install's bubble points at `/docs/…`, and the day v6 ships the same URL serves v6.

The bubble explains a **convention** — `PRU`, TWR, XIRR, the four terms of the gain.
Conventions are precisely the class of thing a major version changes. So the failure
is not a stale page, it is a *correct* page about a different product, reached from
an app that promised to explain its own numbers. No line of front-end code would be
at fault; the publication scheme alone would do it.

**The current version therefore gets a path segment too** (`/docs/v5`), with `/docs`
redirecting to it. The scheme becomes uniform instead of *everything is versioned
except the newest*, which is the rule that produced the conflict. The link is fixed
at the **major** — v5.1 still reads `/docs/v5` — because doc versions are majors.

The cost is breaking deep URLs into `/docs`, and this is the one release where that
costs nothing: the corpus is rewritten from zero, so none of those pages survive
anyway.

## The corpus is rewritten from zero, into one flat list

Not a pass of edits over the existing tree. ADR-0015's own F4 established that the
`deployment/` category never described three audiences but three ways of gluing a
stack back together; starting from that tree inherits a taxonomy of an assembly.

Measured against the 17 pages and 16 255 words of v4: **4 pages and 3 860 words die
with no successor** (InfluxDB internals, the Cerberus schema, the v4.1 account seam,
manual mode, the Compose stack), one is replaced by ADR-0016's anchored page, two
splinter, and nine survive only as subjects. The v5 corpus is **structurally
shorter** — the first number that says the documentation had been describing an
assembly rather than a product.

It carries **no categories**, only an order: a flat list whose head is the path of
someone arriving (home → start → import your events → read your numbers → settings)
and whose tail explains the machine to someone already running it. A category by
*usage* — headed versus headless — was refused for re-creating in the documentation
the split ADR-0014 and ADR-0015 had just removed from the product: headless is a
usage, not a variant install, and giving it a branch makes it optional again.

## Consequences

- **`deployment/` goes from three pages to one, not two.** ADR-0015/D9 kept two;
  ADR-0015/D6, seven decisions earlier in the same session, emptied one of them —
  the `HEALTHCHECK` moved into the image, `--restart unless-stopped` became "a
  sentence of the guide", log rotation left the product, the steps became the guide
  and the variables became the settings page. Nothing was left but *supported
  architectures*, one line. What remains is **Installing without Docker**, which
  ADR-0015 had already turned from the most advanced form into the simplest.
- **"Coming from v4" is a page, not a title of the guide** — an amendment to
  ADR-0015/D13, which made it the third of three. ADR-0008 loads it with four
  decisions including a table of *which figures must coincide and which are
  deliberately corrected*; a guide title that carries a reconciliation table is not
  a guide title, and its reader is the only one who has nothing to install. It is
  also the only page whose expiry does not follow the release cycle: frozen forever
  at 5.0, where release notes accrue 5.1 and 5.2 above it.
- **The hand-written changelog freezes with v4 and a new one starts at 5.0.** Keeping
  one page that lists v4.2 and v5.0 together makes someone reading v5's docs read the
  announcement of a release they can no longer run.
- **The major is declared, not deduced: `Release-As: 5.0.0`.** A `!` on a commit makes
  the version number depend on a character in a commit message; this major is a
  decision. `preview/v5` reaches `master` as a **merge**, not a squash — and `docs`
  becomes `hidden: true` in `release-please-config.json`, because the generated
  changelog would otherwise present this map's own journal (12 ADR commits) as the
  product's release notes. That is what makes the hand-written page the only surface
  able to say *this release changes where your data lives*.
- **The image renames on both registries** (`suivi-bourse-app` → `suivi-bourse`,
  Docker Hub and GHCR), keeping the four tags. ADR-0015/D11 made the rename free
  because nothing migrates; the dividend is that **`suivi-bourse-app:5` never
  exists**, so a v4 install that bumps its tag fails at the pull instead of starting
  on a store that dies with the container.
- **v4 stays reachable indefinitely, and is warned twice.** The theme banner on every
  page — its real product is its *link*, the only thing that catches a deep landing
  from a search engine, and under a rewritten corpus almost no v4 page has a v5
  counterpart — plus an admonition on the frozen home saying the thing the theme text
  cannot: *v5 exists and is not an upgrade*, not *this version is unmaintained*.
  A `4.2.3` whose only content is that announcement was refused: it charges a restart
  to someone who asked for nothing, and engraves into a frozen version a sentence
  nobody can later correct.
- **The `README` stops duplicating the guide but keeps guiding.** It has said
  *"It uses Prometheus as TSDB"* since before v4 and ends on Grafana's `admin/admin`:
  the staleness is structural, not neglect — a copied getting-started has two writers
  and one is never re-read. It survives as **one command and one URL** (`docker run`
  with the volume, then `:8080`), which is possible only because ADR-0015 reduced the
  guide to that; a command everyone types is a command whose staleness is visible.
  It shows **no file**, which a `config.yaml` on the repo's front page would have
  contradicted. The screenshot is still Grafana's dashboard and the site tagline still
  names InfluxDB and Grafana: both move with the rewrite, the image as a placeholder
  the implementation fills.
- **Freezing v4 is a command plus 79 link rewrites.** `docs:version` copies verbatim,
  and the 79 absolute `/docs/…` links in the corpus keep pointing at *current*.
  With `onBrokenLinks: 'throw'` the build breaks the moment `docs/` diverges — during
  the rewrite, attributed to whoever edits rather than to the freeze. The v3 snapshot
  had been hand-rewritten to `/docs/v3/…`; this one is rewritten to `/docs/v4/…` at
  the same time it is taken, which is why the snapshot is this map's last gesture
  rather than the release's first.
- **Translation starts here.** ADR-0024 scoped Crowdin to the v5 corpus and made it
  wait on this record; the list above is what it waits for.

[Full argument: #680](https://github.com/pbrissaud/suivi-bourse/issues/680) ·
[the guide and the container: #679](https://github.com/pbrissaud/suivi-bourse/issues/679) ·
[no upgrade: #677](https://github.com/pbrissaud/suivi-bourse/issues/677) ·
[the page it must serve: #690](https://github.com/pbrissaud/suivi-bourse/issues/690) ·
[bilingual: #692](https://github.com/pbrissaud/suivi-bourse/issues/692)
