# Real `/proc/self/mountinfo`, captured in a container

These four files are the **proof** ADR-0015's amendment rests on (issue #741),
not an illustration of it: *a mounted path — named volume or bind — is
distinguished from the container's writable layer with certainty*. That fact was
**asserted false in session before it was verified**, which is why the samples
are captured rather than written, and versioned rather than regenerated.

Each was produced by the command written beside it, on Docker 29.4 with the
`overlay2` storage driver, and copied out unedited.

| File | Case | Command |
|---|---|---|
| `bare.mountinfo` | **no mount** — `/data` does not figure at all, and `/` is the writable layer | `docker run --rm alpine:3 cat /proc/self/mountinfo` |
| `named-volume.mountinfo` | **exact mount** — a named volume on `/data`, plus the read-only `/import` bind of ADR-0015's two-mount shape | `docker run --rm -v sb741-store:/data -v /private/tmp/sb741-events:/import:ro alpine:3 cat /proc/self/mountinfo` |
| `ancestor-bind.mountinfo` | **mount of an ancestor** — a bind on `/srv`, with the store at `/srv/suivi-bourse` | `docker run --rm -v /private/tmp/sb741-host:/srv alpine:3 cat /proc/self/mountinfo` |
| `nested-mounts.mountinfo` | **two mounts, one prefixing the other** — the longest must win | `docker run --rm -v /private/tmp/sb741-host:/srv -v sb741-store:/srv/data alpine:3 cat /proc/self/mountinfo` |

Three things these samples say that a hand-written one would have got wrong, and
all three are decisions in `src/mounts.py`:

* **`/` is always there.** An unmounted `/data` is absent, but the root mount is
  not — so *"the path is not in the table"* is never the observation actually
  made. What is read is the **longest mount point that prefixes** the path, and
  in the bare case that is `/`.
* **The root of a container is `overlay`.** That is the field that separates the
  writable layer from an ordinary filesystem, and it is why the rule is on the
  filesystem type rather than on the mount point being `/`: a Docker-less
  install has `/` on ext4/btrfs/xfs and keeps its store perfectly well.
* **A bind and a named volume are two different filesystems** here (`virtiofs`
  for the host bind, `btrfs` for the volume) and neither is volatile, which is
  what makes one rule cover both.

The host directories and the volume are throwaway; recreate them with
`mkdir -p /private/tmp/sb741-host /private/tmp/sb741-events` and
`docker volume create sb741-store` if a capture ever has to be repeated.
