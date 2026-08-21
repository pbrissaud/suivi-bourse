# Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern
static website generator. Dependencies are managed with
[pnpm](https://pnpm.io/).

The documentation is **versioned, and every version has an address** — the
current one included (ADR-0025). The `docs/` folder holds **v5**, served at
`/docs/v5`; `versioned_docs/version-4.x/` and `versioned_docs/version-3.x/` hold
the frozen **v4** and **v3** docs, at `/docs/v4` and `/docs/v3`. Use the version
selector in the navbar to switch between them. To snapshot a new version, run
`pnpm docusaurus docs:version <name>`.

`/docs` itself is a **client-side redirect** to `/docs/v5`
(`@docusaurus/plugin-client-redirects`). It only exists in the built output —
under `pnpm start`, `/docs` 404s — so check it with `pnpm build` and read
`build/docs/index.html`, never in the dev server.

The in-app links the product emits carry the version and the language:

```
https://pbrissaud.github.io/suivi-bourse/{locale}/docs/v5/<page>#<anchor>
```

with the locale segment absent for the default locale (English) and `fr/` for
French. The segment is frozen at the **major**: a 5.1 install still reads
`/docs/v5`.

## Translation

The site ships in English and French. **English is the source**, not one of two
translations (ADR-0024): the corpus is written in English, [Crowdin][crowdin]
reads it, French comes back. There is **one** project for the whole product, the
site and the interface's catalogue alike (ADR-0024, amended by #739) — a
translation memory is per-project, so two projects would let the app and the page
that explains it name the same figure two ways. Its configuration is therefore
`crowdin.yml` at the **repository root**, not here: it is the only place that can
name both halves.

What enters the pipeline is the **current** corpus (`docs/`) and the theme
catalogues. `versioned_docs/` never does: `version-3.x/` is a product two
majors old, and `version-4.x/` is the corpus the v5 rewrite killed. Both are
already banded *unmaintained* on the site.

The English catalogues under `i18n/en/` are **generated**, never hand-written:

```
$ pnpm write-translations --override    # refresh i18n/en/** before uploading
```

`--override` is not optional. Plain `write-translations` only *adds* keys it
cannot find; it never refreshes one that already exists. Without the flag, a
string changed in `docusaurus.config.js` leaves the catalogue untouched — and
the catalogue is what the build reads.

Which is the second thing to know about these files: **they are the authority
for the English strings, not `docusaurus.config.js`.** At build time the
catalogue wins over the config, for the default locale as much as for French.
Two consequences, and both are gated in CI (`.github/workflows/pr-checks.yml`):

- a theme string edited in the config and not regenerated here is **ignored**,
  with every other check green — so the workflow re-runs
  `write-translations --override` and fails on any diff under `i18n/en/`;
- a **computed** value in such a string is frozen the day the catalogue is
  generated. There is none left: the footer copyright carries no year, because
  `new Date().getFullYear()` would have gone on reading 2026 into 2027 with
  nobody editing anything.

Nothing under `i18n/fr/` is written by hand either — it is Crowdin's output,
landing in the repository through an import. The repository holds no French
file today, and that is the expected state until the first import: `pnpm build`
serves the English source under `/fr/` in the meantime.

Syncing is the [Crowdin CLI][cli] run against `crowdin.yml`, which lives at the
**repository root** and covers the whole product in one project — the site and
the interface's catalogue alike (ADR-0024, amended by #739). The project and its
token come from the environment, `CROWDIN_PROJECT_ID` and
`CROWDIN_PERSONAL_TOKEN`, so the file carries no secret and the GitHub
integration can read the same one:

```
$ pnpm write-translations --override    # from website/, refresh the English sources
$ cd .. && crowdin upload sources       # English → Crowdin
$ crowdin download                      # French → website/i18n/fr/ and app/web/src/i18n/fr.json
```

### `crowdin.yml` is checked by Crowdin, never by a YAML parser

```
$ CROWDIN_PROJECT_ID=0 CROWDIN_PERSONAL_TOKEN=config-lint-only \
    npx @crowdin/cli@4.15.0 config lint
```

The placeholder credentials are honest: `config lint` reads the file alone and
touches no network, which is what lets the CI run it on a fork's pull request.

The CLI compiles every `source:` pattern into a **regex**, so a glob that is
valid YAML and valid shell can still be refused: `'/website/docs/**/*.{md,mdx}'` becomes
`.+\.{md,mdx}` and dies on `Illegal repetition`, because `{` opens a repetition
quantifier. Crowdin has no brace expansion — **one extension per entry**. The
failure is invisible to `pnpm build`, which never opens this file, and its
symptom at upload time is an empty project rather than an error anyone reads.

The lint reads the file alone and calls nothing, so the script supplies
placeholder credentials when the real ones are absent; it validates the
configuration, never the token.

### The limit: a stale translation is served with no fallback

Docusaurus falls back to the English source for a string that has **no**
translation. It does not fall back for a string that **has** one whose source
has since moved — the French page keeps serving the older text, silently. A
superseded French rule can therefore ship, and no configuration removes this:
it is a property of the fallback, which has no way to know that an English
sentence changed after its French counterpart was approved.

What it costs is a **rhythm**, and the rhythm is the mitigation: translate a
page once its English text has settled, never while it is being written. That
is why translation starts at v5 rather than before it — translating the v4
corpus would have translated the 16 255 words the rewrite deletes.

[crowdin]: https://crowdin.com/project/suivi-bourse
[cli]: https://crowdin.github.io/crowdin-cli/

### Installation

```
$ pnpm install
```

### Local Development

```
$ pnpm start
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

### Build

```
$ pnpm build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

It builds **every declared locale**: English at the root, French under `fr/`.
That is what makes `…/fr/docs/v5/<page>` — a link the product itself emits —
resolve. To build one locale alone, e.g. to check that French still builds
without any translation file:

```
$ pnpm build --locale fr
```

### Deployment

Using SSH:

```
$ USE_SSH=true pnpm deploy
```

Not using SSH:

```
$ GIT_USER=<Your GitHub username> pnpm deploy
```

If you are using GitHub pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.
