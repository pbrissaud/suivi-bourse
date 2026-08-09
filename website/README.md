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
