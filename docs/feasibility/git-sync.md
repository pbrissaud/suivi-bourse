# Feasibility: hydrating the config directory from Git with `git-sync`

Study of integrating [kubernetes/git-sync](https://github.com/kubernetes/git-sync)
into the compose stack so that the config directory (`SB_CONFIG_DIR`, the single
read-only mount introduced in 4.2) is fed from a Git repository instead of a
hand-managed host folder.

**Verdict: feasible, small, and it fits the existing overlay architecture** —
one new `docker-compose.gitsync.yaml`, chained through `COMPOSE_FILE` exactly
like `docker-compose.expose.yaml`, plus four `.env` variables. No change to the
app image, to `docker-compose.yaml`, or to any Python code.

Two app-level behaviours do **not** survive the integration and must be
documented (or fixed first): `events.watch: true` stops working, and
`settings.yaml` is never re-read at runtime. Details in
[Behaviours that break](#behaviours-that-break).

Everything below was checked against git-sync `master` (post-`v4.7.1`) source
and validated with `docker compose config`. It has **not** been run against a
live daemon — no Docker daemon was available in the environment where this was
written. See [What is left to verify](#what-is-left-to-verify).

---

## 1. Why bother

Today the config directory is a host folder the user edits in place. That is
fine on a machine you have a shell on: `git pull` in a cron job does the whole
job for free, and it keeps the file watcher intact.

The gap is the deployment target the project already documents — Coolify,
Dokploy and friends, where the stack is regenerated from `docker-compose.yaml`
and nobody has a shell on the host to drop a `.csv` into. There, "my portfolio
lives in a private Git repo" is the only ergonomic way to get event files onto
the box, and updating the portfolio becomes `git push`.

So the feature is not "replace `SB_CONFIG_DIR`" — it is "offer a second way to
fill it, for deployments that cannot fill it by hand".

## 2. The contract git-sync offers, and why it does not match ours

git-sync's published interface is deliberately **not** a plain directory:

> Inside the root directory, git-sync stores the synced git state and other
> things. […] One of the things in that directory is a symlink (see the
> `--link` flag) to the most recently synced data. This is how the data is
> expected to be consumed, and is considered to be the "contract".

The symlink exists because a `git checkout` is not atomic: git-sync fetches,
builds a **new worktree** under `<root>/.worktrees/<sha>`, then `rename(2)`s the
symlink onto it. Consumers therefore always see a complete tree.

Our stack mounts the config directory *itself*:

```yaml
- ${SB_CONFIG_DIR:-./data}:/home/appuser/.config/SuiviBourse:ro
```

Those two do not compose directly: git-sync cannot publish its content *as* the
directory it is told to work in, and a Docker bind/volume mount resolves
symlinks **once, at container start**. Mounting the symlink (or a volume
`subpath` pointing at it) would pin the container to the worktree that existed
at boot and never see another sync. That rules out the obvious approach.

The way out is in git-sync's own code (`main.go`, `publishSymlink`):

```go
// linkDir is absolute, so we need to change it to a relative path.  This is
// so it can be volume-mounted at another path and the symlink still works.
targetRelative, err := filepath.Rel(linkDir.String(), targetPath.String())
```

The published symlink is **relative**. So if we put `--link` and `--root`
side by side in one volume and mount that volume *one level above* the config
directory, the symlink resolves inside the app container too — and it is
re-resolved on every `open()`, which is exactly the atomic-swap semantics we
want.

## 3. Recommended design — Option A: shared volume, mounted one level up

git-sync writes into a named volume:

```
/git                              ← the volume
├── SuiviBourse -> repo/.worktrees/<sha>   (the published symlink)
└── repo/                                  (--root: git state + worktrees)
    ├── .git/
    └── .worktrees/<sha>/                  ← settings.yaml, config.yaml, events/
```

The app mounts the same volume read-only at `/home/appuser/.config`, so
`~/.config/SuiviBourse` *is* the symlink and the hardcoded config path in
`ConfigurationManager` (`Path('~/.config/SuiviBourse')`) keeps working
untouched.

### `docker-compose.gitsync.yaml`

```yaml
# SuiviBourse — config directory hydrated from a Git repository.
services:
  gitsync:
    container_name: ${COMPOSE_PROJECT_NAME:-suivi-bourse}-gitsync
    image: registry.k8s.io/git-sync/git-sync:v4.7.1
    restart: unless-stopped
    environment:
      GITSYNC_REPO: ${SB_CONFIG_REPO:?set SB_CONFIG_REPO in .env}
      GITSYNC_REF: ${SB_CONFIG_REF:-HEAD}
      GITSYNC_PERIOD: ${SB_CONFIG_SYNC_PERIOD:-60s}
      GITSYNC_ROOT: /git/repo
      GITSYNC_LINK: /git/SuiviBourse
      GITSYNC_DEPTH: "1"
      GITSYNC_STALE_WORKTREE_TIMEOUT: 5m
      GITSYNC_HTTP_BIND: ":8082"
      GITSYNC_USERNAME: ${SB_CONFIG_REPO_USERNAME:-}
      GITSYNC_PASSWORD: ${SB_CONFIG_REPO_TOKEN:-}
    volumes:
    - sb_config_repo:/git
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8082/"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  app:
    depends_on:
      gitsync:
        condition: service_healthy
    volumes: !override
    - sb_config_repo:/home/appuser/.config:ro

volumes:
  sb_config_repo:
    driver: local
```

Enabled the same way ports are:

```dotenv
COMPOSE_FILE=docker-compose.yaml:docker-compose.expose.yaml:docker-compose.gitsync.yaml
SB_CONFIG_REPO=https://github.com/me/my-portfolio.git
SB_CONFIG_REF=HEAD
SB_CONFIG_SYNC_PERIOD=60s
SB_CONFIG_REPO_USERNAME=
SB_CONFIG_REPO_TOKEN=
```

The repository's **root** must be what `data/` is today: `settings.yaml`,
optionally `config.yaml`, optionally `events/`. `SB_CONFIG_DIR` is unused while
the overlay is on.

### Why each piece is there

| Piece | Reason |
|---|---|
| `volumes: !override` on `app` | Compose merges service `volumes` **by target path**. Without `!override`, the base `${SB_CONFIG_DIR}:…/SuiviBourse:ro` bind is kept *and* nested inside the new mount, shadowing the symlink. `!override` replaces the list wholesale. Requires Compose ≥ 2.24. |
| `--root=/git/repo`, not `/git` | git-sync's own README warns that pointing `--root` at a volume root can trip over filesystem metadata (`lost+found`). A subdirectory also keeps the volume root free for the symlink. |
| `--link=/git/SuiviBourse` | Puts the link at the volume root, so the app's mount target `/home/appuser/.config` yields `~/.config/SuiviBourse`. The relative target `repo/.worktrees/<sha>` resolves identically in both containers. |
| `--http-bind` + healthcheck | `/` returns 503 until the first successful sync, 200 after. With `depends_on: service_healthy`, the app never boots against a missing config directory. `curl` is present in the git-sync image. |
| `--stale-worktree-timeout=5m` | Default is `0` — the previous worktree is deleted immediately after the flip. If ingestion is mid-`iterdir()` on the old tree it gets a `FileNotFoundError`; the app already keeps the previous config on ingestion errors, but a 5-minute grace makes the race disappear rather than be tolerated. |
| `--depth=1` | A config repo has no use for history, and shallow keeps the volume small. |
| Explicit `:-` defaults on every `GITSYNC_*` | **git-sync does not follow our blank-is-unset convention.** `envString`/`envInt`/`envDuration` use `os.LookupEnv`, so a variable rendered as the empty string by compose is a *value*: `GITSYNC_REF=""` overrides the `HEAD` default, and an empty duration/int is a fatal parse error. Empty is only safe for `GITSYNC_USERNAME`/`GITSYNC_PASSWORD`, where it correctly means "no auth". |

### Volume ownership

The git-sync image runs as UID/GID `65533:65533` and its Dockerfile ships
`/git` as `65533:65533`, mode `02775`. Docker initialises a **fresh** named
volume from the ownership and mode of the image directory it is first mounted
on — and `depends_on` guarantees `gitsync` starts before `app`, so the volume is
initialised from git-sync's `/git`. Files land as `0644`/`0755` world-readable,
so `appuser` (UID 1000, no relation to 65533) reads them through the "other"
bits. No `chown`, no init container, no root.

This is the one piece of the design that leans on an implicit Docker behaviour.
It breaks if the volume already exists as root-owned — which is precisely what
some PaaS platforms do when they pre-create volumes or map them onto host
paths. Mitigations, in order of preference: `user: "0:0"` on the `gitsync`
service (files stay world-readable, so the app is unaffected), or `--group-write`
with a matching supplemental group. Worth exposing as an `SB_GITSYNC_USER`
escape hatch and calling out in the Coolify/Dokploy docs.

## 4. Behaviours that break

### `events.watch: true` stops working — hard incompatibility

`EventWatcher` schedules a non-recursive `watchdog` observer on
`<config dir>/events`. `inotify_add_watch` follows the symlink and pins the
**inode** of the current worktree's `events/`. After a sync, the live data is a
different directory; the watched one is gone. There is no re-arm path in
`watcher.py`.

Subtle detail: because the old worktree is deleted *after* the symlink flip, the
first sync usually does fire a reload — watchdog reports the deletions,
`on_deleted` matches `.csv`, and the debounced callback re-reads through the
(already updated) symlink, landing on the new content. That is an accident, not
a design, and it happens exactly once.

**Recommendation:** document `watch: false` under git-sync and rely on
`SB_INGESTION_INTERVAL` (default 300s — comparable to the sync period anyway).
A proper fix, if it is ever wanted, is to make the watcher re-arm when its root
disappears, or watch the parent directory — a `watcher.py` change, out of scope
for the compose work.

The polling path is unaffected: `_compute_cache_key()` is built from file paths
+ `st_mtime`, the paths go through the stable symlink, and a checkout stamps
fresh mtimes — so every sync that changes content invalidates the cache and
triggers a reload.

### `settings.yaml` is never re-read

`_load_settings()` is guarded by `if self._mode is None`, so it runs once per
process. Mode, `events.source`, `events.watch` and the whole `accounts:` block
are frozen at boot. Pushing an `accounts:` change to Git will sync to disk and
be silently ignored until the app restarts.

**Recommendation:** document it, and consider a follow-up that re-reads
`settings.yaml` in the ingestion job. Not a blocker for the compose work but it
is the surprise most likely to generate an issue.

### Manual mode is fine

`_load_from_manual()` calls `Configuration.reload()` on every ingestion cycle
and reads through the symlink, so `config.yaml` changes are picked up.

### Torn read (theoretical)

`_compute_cache_key()` stats the files, then `EventLoader` opens them. A symlink
flip in that window would key on old mtimes while reading new content, leaving a
stale cache key for one cycle. Milliseconds wide, self-corrects on the next
cycle, and the ingestion error handler covers the crash case. Not worth
engineering around.

## 5. Options considered and rejected

### Option B — `--exechook-command` copying into a plain directory

git-sync syncs into a private root and a post-sync hook copies the worktree over
the real `data/` directory, which stays a plain bind mount.

Upsides: `docker-compose.yaml`'s mount line is untouched (no `!override`, no
Compose 2.24 floor), and `watch: true` keeps working because the directory inode
never changes.

Downsides, and they are what sink it: the hook takes **no arguments** ("this
command does not take any arguments"), so it has to be a script file mounted
into the container; the copy is not atomic, re-introducing exactly the torn-read
problem the symlink exists to prevent; propagating deletions means an `rm -rf`
aimed at the user's config directory; and git-sync writing to a host bind mount
as UID 65533 needs a `user:` override keyed to the host UID.

Worth revisiting only if `watch: true` turns out to matter more than atomicity.

### Option C — no sidecar

Document `git pull` in cron / a systemd timer against `SB_CONFIG_DIR`. Zero
code, zero images, watcher intact. This is genuinely the right answer for
anyone with a shell on the host, and it should stay in the docs even if Option A
ships — Option A's audience is the PaaS deployment, not the homelab.

### Option D — a hand-rolled `alpine/git` loop sidecar

`while true; do git pull; sleep N; done`. Simpler to read, but it re-implements
auth handling, retry/backoff, shallow-fetch and atomic publication, and gets
each of them slightly wrong. git-sync exists for this.

## 6. Secrets and threat model

A portfolio repo is personal financial data and should be private, which means
credentials in the stack:

- **HTTPS + PAT** (recommended default): `SB_CONFIG_REPO_USERNAME` +
  `SB_CONFIG_REPO_TOKEN` in `.env`, mapped to `GITSYNC_USERNAME` /
  `GITSYNC_PASSWORD`. Consistent with how `INFLUXDB_TOKEN` is already handled.
  git-sync also supports `--password-file` if we ever want the value off the
  environment.
- **SSH deploy key**: `--ssh` with the key mounted at `/etc/git-secret/ssh` plus
  `--ssh-known-hosts`. More moving parts (file mount, known_hosts, `--add-user`
  when running under a non-default UID); document as the advanced path.
- **GitHub App**: supported upstream, overkill here.

Docs should say plainly: use a **private** repo and a **read-only** token
(GitHub fine-grained PAT with `Contents: read`, or a read-only deploy key).

## 7. Cost of the change

| Item | Size |
|---|---|
| `docker-compose/docker-compose.gitsync.yaml` | ~40 lines, new file |
| `.env.example` — a commented git-sync block | ~15 lines |
| `Makefile` — mention the overlay in `init`'s `COMPOSE_FILE` hint | ~3 lines |
| `website/docs/deployment/docker-compose.mdx` or a new advanced page | one section |
| App code | none |

No change to `docker-compose.yaml`, `docker-compose.dev.yaml`, the app image, or
the Grafana/InfluxDB services.

## 8. What is left to verify

The design is validated on paper and by static merge checks; a live run is
still needed:

1. `docker compose config` with the overlay chained — **done**, the merge is
   correct: `app` ends up with a single mount, the volume at
   `/home/appuser/.config` read-only, and `depends_on` gains `gitsync` alongside
   `influxdb`.
2. Fresh-volume ownership really lands as `65533:65533` and `appuser` can read
   through the symlink. **Not run** (no daemon available) — this is the main
   assumption to confirm.
3. A second commit pushed to the repo is picked up within one
   `SB_INGESTION_INTERVAL` in events mode, and immediately in manual mode.
4. That `watch: true` degrades as described rather than crashing the app
   (watchdog's behaviour when its watched root is deleted varies by version).
5. Behaviour on a PaaS with pre-created volumes (Coolify) — the ownership
   escape hatch is the thing to exercise.
6. `arm64` image availability for Raspberry Pi users — upstream builds
   `linux/amd64`, `linux/arm`, `linux/arm64`, `linux/ppc64le`, `linux/s390x`, so
   this should be a formality.

## 9. Open questions for the maintainer

- Is the config repo expected to be **repo root = config dir**? git-sync's
  `--link` always points at the worktree root, so a config living in a
  subdirectory is not supported. `--sparse-checkout-file` prunes what is
  fetched but does not re-root the link. Documenting "root of the repo" is the
  cheap answer.
- Should `watch:` be force-disabled (a log warning when git-sync mode is
  detected) or just documented? The app cannot currently detect it.
- Is the `settings.yaml`-never-reloaded fix in scope, or a separate issue?
