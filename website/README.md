# Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern
static website generator. Dependencies are managed with
[pnpm](https://pnpm.io/).

The documentation is **versioned**: the `docs/` folder holds the current **v4**
docs, and `versioned_docs/version-3.x/` holds the frozen **v3** docs. Use the
version selector in the navbar to switch between them. To snapshot a new version,
run `pnpm docusaurus docs:version <name>`.

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
