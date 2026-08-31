# website/ — the documentation site

Docusaurus, dependencies managed with pnpm, bilingual through Crowdin — **by
construction, French pending the first import**.

```bash
pnpm install
pnpm start                          # dev — beware: /docs 404s here (see below)
pnpm build                          # every locale, fails on a broken link
pnpm build --locale fr              # French alone
pnpm write-translations --override  # refresh the English sources Crowdin uploads
pnpm docusaurus docs:version <name> # snapshot a version
```

## Every version has an address, the current one included (ADR-0025)

`docs/` holds **v5** at `/docs/v5`; `versioned_docs/version-4.x/` and
`version-3.x/` hold v4 and v3 at `/docs/v4` and `/docs/v3`. `lastVersion` is still
`current`: v5 is the default version, it simply no longer sits at the bare root.

The scheme is uniform rather than *everything is versioned except the newest*,
because that latter rule is what made ADR-0016's in-app convention bubble
impossible: with `/docs` meaning *latest*, a link a v5 install emits serves v6's
page the day v6 ships — a correct page about another product. **The link contract
the product consumes** is therefore:

```
https://pbrissaud.github.io/suivi-bourse/{locale}/docs/v5/<page>#<anchor>
```

Locale segment absent for the default locale (English), `fr/` for French, and the
version frozen at the **major** (a 5.1 install still reads `/docs/v5`).

> **Trap**: `/docs` is kept alive by `@docusaurus/plugin-client-redirects`, which
> points it at `/docs/v5/`. That redirect is **client-side and only exists in the
> built output** — under `pnpm start` `/docs` 404s, so a manual check in
> development concludes the opposite of the truth. Verify it on
> `build/docs/index.html`.

The anchors in `docs/read-your-figures.mdx` are **a contract with the front**: eleven
anchors hand-written on every heading, because a *derived* anchor moves with a
reworded title — the front sees nothing, the site still builds, and every bubble
lands at the top of the page. The authoritative list is `DOCS_ANCHORS` in
`src/web/src/lib/docs.ts`; the count is descriptive and grows with the figures that
earn a bubble — `net-contributed` is the one that arrived that way.

## Bilingual through Crowdin (ADR-0024)

`i18n.locales` is `['en', 'fr']` with English the **source**, so `pnpm build`
builds both and `/fr/` is published. **`i18n/` holds `en/` alone today**, and that is
the expected state until the first Crowdin import: Docusaurus falls back to the source
for an untranslated string, so `/fr/` serves English in the meantime and the build is
green. Nothing under `i18n/fr/` is written by hand — it is Crowdin's output, landing
here through an import.

`crowdin.yml` sits at the **repository root** and covers the whole product in
**one project**: the site *and* `src/web/src/i18n/en.json`. A translation memory
is per-project — *plus-value latente* translated in the interface would never
suggest itself in the page that explains it. Its sources are `website/docs/`, the
theme catalogues under `website/i18n/en/` (generated, committed) and the front's
catalogue. The frozen versions never enter it.

`editUrl` splits by locale — GitHub for English, Crowdin otherwise: a pull request
on a French file is lost at the next import.

## Two gates, and neither is `pnpm build`

`pnpm build` opens neither of these files.

- **The CI lints `crowdin.yml` with the tool that consumes it**, from the root:
  ```bash
  CROWDIN_PROJECT_ID=0 CROWDIN_PERSONAL_TOKEN=config-lint-only \
    npx @crowdin/cli@4.15.0 config lint
  ```
  The CLI compiles each `source:` into a regex, so `'/docs/**/*.{md,mdx}'` — valid
  YAML, valid shell — is refused (`{` opens a quantifier). Crowdin has no brace
  expansion: **one extension per entry**. Checked with a YAML parser the file
  passes, and the symptom is an upload that carries nothing.
- **`pnpm write-translations --override` must leave `i18n/en/` unchanged.** The
  committed English catalogues **win over `docusaurus.config.js` at build time,
  for English too**: a theme string edited in the config and not regenerated is
  ignored with every check green. `--override` is what makes the check real —
  plain `write-translations` only adds missing keys. It is also why the footer
  copyright carries no year: a `getFullYear()` frozen into a catalogue goes on
  reading 2026 into 2027.

## The cost no configuration removes

Docusaurus falls back to the source for an **untranslated** string, never for a
translated one whose source moved — so a superseded French rule can be served. It
is written in `website/README.md` because it decides a rhythm: translate **after**
the English text settles, never during.

## Frozen corpora

`versioned_docs/` is not rewritten, and it links to GitHub by absolute URL —
Docusaurus checks nothing there, so the build stays green whatever those links point
at. **The Grafana dashboards are already safe**: v3's `deployment/standalone.mdx` names
its four on `blob/v3.8.5` and v4's names its two on `blob/v4.2.2`, tags rather than a
branch, so v5 reaching `master` moves nothing under them.

What is still pinned to `blob/master` in the frozen corpora is `CONTRIBUTING.md`, the
licence and the changelog — files that exist on every branch and are *meant* to be read
at their newest. Nothing there needs repairing either; the rule to keep is the one the
dashboards illustrate: **an absolute link to a file the rewrite deletes is written
against a tag, never against `master`.**
