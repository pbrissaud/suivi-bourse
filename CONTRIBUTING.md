# Contributing Guidelines

Contributions are welcome via GitHub pull requests. This document outlines the process to help get your contribution accepted.

## Sign off Your Work

The Developer Certificate of Origin (DCO) is a lightweight way for contributors to certify that they wrote or otherwise have the right to submit the code they are contributing to the project.
Here is the full text of the [DCO](http://developercertificate.org/).
Contributors must sign-off that they adhere to these requirements by adding a `Signed-off-by` line to commit messages.

```text
This is my commit message

Signed-off-by: Random J Developer <random@developer.example.org>
```

See `git help commit`:

```text
-s, --signoff
    Add Signed-off-by line by the committer at the end of the commit log
    message. The meaning of a signoff depends on the project, but it typically
    certifies that committer has the rights to submit this work under the same
    license and agrees to a Developer Certificate of Origin (see
    http://developercertificate.org/ for more information).
```

## How to Contribute

1. Fork this repository, develop, and test your changes
2. Remember to sign off your commits as described above
3. Submit a pull request

## Working on it

The repository holds three trees and each has its own loop. `src/` is the import
root: it holds two Python packages — `application` (the app) and `api` (Flask) —
beside `src/web`, which is the front and is not Python. Nothing is installable
(`package = false`), so the path is named rather than installed.

### The application

```bash
uv sync                                             # runtime + dev tooling into .venv
uv run flake8 src/application src/api --ignore=E501 # the two packages, never `src/`
uv run pytest tests/                                # unit + end-to-end, all network-mocked
PYTHONPATH=src uv run python -m application.boot    # run it, on http://localhost:8080
```

The lint names the two packages rather than `src/`, which would walk the front's
`node_modules`. `src/application/boot.py` is the only boot path: the web API and
the scheduler share one process and that file holds the whole sequence.

**It runs on macOS**, and that is new (ADR-0039): the app no longer forks, so
there is no longer a container to build in order to see it work.

### The front

```bash
cd src/web && pnpm install
pnpm lint    # tsc -b --noEmit
pnpm test    # vitest — no network, no configuration
pnpm build   # → src/static/, which Flask serves; git-ignored
pnpm dev     # Vite on :5173, proxying /api and /health to localhost:8080
```

`pnpm dev` needs the API running. If it is not on 8080, name the other port:
`SB_API_URL=http://localhost:9000 pnpm dev`.

### The documentation site

```bash
cd website && pnpm install
pnpm start   # dev server — beware, the /docs redirect only exists in the build
pnpm build   # every locale, and it fails on a broken link
```

The site is bilingual through Crowdin, English being the source. **Nothing under
`website/i18n/fr/` is written by hand** — a pull request on a French file is lost
at the next import. Translate after the English text has settled.

### The container

There is no compose stack; `docker run` is the canonical form.

```bash
docker build -t suivi-bourse:dev .
docker run -d --name suivi-bourse --restart unless-stopped -p 8080:8080 \
  -v suivi-bourse:/data suivi-bourse:dev

IMAGE=suivi-bourse:dev .github/scripts/container-contract.sh   # what CI asserts
```

## Commit messages

Commits are [conventional](https://www.conventionalcommits.org/): `feat`, `fix`,
`docs`, `deps`, `chore` and `refactor`, with the touched tree as the scope —
`feat(app):`, `fix(web):`, `docs(website):`. This is not a style rule: Release
Please reads those subjects to decide the next version and to write the
changelog, and a subject it cannot parse is discarded whole.

### Technical Requirements

* Must pass the [DCO check](#sign-off-your-work) — every commit signed off
* `flake8` over `src/application` and `src/api`
* `uv run pytest tests/`
* The front's `pnpm lint`, `pnpm test` and `pnpm build`, when `src/web` changed
* The image builds and honours its contract, when what it is built from changed
* The site builds, `crowdin.yml` lints and `i18n/en/` is what
  `pnpm write-translations --override` generates, when `website/` changed

Each of the last three runs only when its own tree changed, so a documentation
pull request does not wait on a container build.

**You don't need to bump any version number, this will be done automatically once PR merged**

## Releasing

Release Please cuts the releases from the conventional commits landed on
`master`. Four files carry the version and **none of them is edited by hand**:
`version.txt` and `.release-please-manifest.json`, which `release-type: simple`
bumps, and `pyproject.toml` and `uv.lock`, which the two `extra-files` entries
of `release-please-config.json` bump with the TOML updater.

`uv.lock` is in that list because of `Dockerfile`'s `uv sync --locked`: uv
records the root project's own version in the lockfile, so a `pyproject.toml`
bumped alone makes the lockfile stale and the release's image build fails. Its
JSONPath reads `@.name.value` rather than `@.name` — release-please parses the
TOML with a parser that tags every scalar with its byte offsets, so a package's
`name` is an object and not a string. That is the community's workaround for a
lockfile release-please does not know about yet
([release-please#2561](https://github.com/googleapis/release-please/issues/2561));
should it stop matching, the updater changes nothing and the release's image
build is what says so.

Two gestures happen at merge time rather than in a file, which is why they are
written down here. They are **separate**: the merge carries no trailer, and the
trailer rides its own commit.

* **A major is declared, not deduced.** A `!` on a commit makes the version
  number depend on one character in a commit message. When the next version is
  a decision rather than a consequence — v5 is — an empty **conventional**
  commit on `master` carries the trailer in its body:

  ```bash
  git commit -s --allow-empty \
    -m "chore: release 5.0.0" \
    -m "Release-As: 5.0.0"
  ```

  **The trailer must not ride the merge commit**, and the reason is mechanical:
  release-please reads `Release-As` from `commit.notes` only, and notes exist
  only on a commit its conventional parser **accepts**. GitHub's default merge
  subject — `Merge pull request #N from owner/branch` — raises
  `ParseError: unexpected token ' ' at 1:6, valid tokens [(, !, :]` and the
  commit is discarded **whole**, so the trailer is never read. The version then
  falls back to whatever the landed commits deduce, which for a branch of
  `feat:` without a `!` is a *minor* — the silent 4.3.0 in place of the 5.0.0
  that was decided. `chore:` is hidden from the changelog
  (`release-please-config.json`), so the declaring commit costs no release note.

* **An integration branch reaches `master` as a merge, not a squash.**
  `preview/v5` holds the history of the rewrite, and that history has value;
  squashing trades twenty-three commits for one line. This gesture is only
  about history: it declares nothing, and its message is left alone.

`docs:` commits are hidden from the generated `CHANGELOG.md`
(`release-please-config.json`). On a branch where twelve of them are the map's
own ADRs, the generated notes would serve the journal of the work as the
release notes of the product. The hand-written release-notes page of the
documentation is the surface that tells a reader what the release changes.

