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
reads it, French comes back. The documentation project is **not** the front's —
Markdown against ICU JSON, a release's rhythm against a component's — and its
configuration is `crowdin.yml`, here, beside the site it describes.

What enters the pipeline is the **current** corpus (`docs/`) and the theme
catalogues. `versioned_docs/` never does: `version-3.x/` is a product two
majors old, and `version-4.x/` is the corpus the v5 rewrite killed. Both are
already banded *unmaintained* on the site.

The English catalogues under `i18n/en/` are **generated**, never hand-written:

```
$ pnpm write-translations     # refresh i18n/en/** before uploading sources
```

Nothing under `i18n/fr/` is written by hand either — it is Crowdin's output,
landing in the repository through an import. The repository holds no French
file today, and that is the expected state until the first import: `pnpm build`
serves the English source under `/fr/` in the meantime.

Syncing is the [Crowdin CLI][cli] run against `crowdin.yml`, with the project
and its token supplied by the environment — `CROWDIN_DOCS_PROJECT_ID` and
`CROWDIN_DOCS_PERSONAL_TOKEN`, distinct from the front project's:

```
$ pnpm write-translations && crowdin upload sources     # English → Crowdin
$ crowdin download                                      # French → i18n/fr/
```

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

[crowdin]: https://crowdin.com/project/suivi-bourse-docs
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
