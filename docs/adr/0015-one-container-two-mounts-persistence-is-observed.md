# One container, two mounts, and persistence that is observed rather than demanded

v5 ships as **one container with two mounts**: the store in a named volume, the drop
folder as an **optional read-only bind**. That split is what finally separates what the
app *writes* from what a human *edits* — and with it the whole apparatus that existed
only because the two shared a directory (`SB_UID`/`SB_GID`, `user:`, `chmod 0755` on
`$HOME`, `chmod 1777` on the cache) disappears, along with the inherited PaaS hazard of a
platform that never records an invoking uid.

A bare `docker run` **starts**, and simply does not persist. This **amends ADR-0008**,
which required a refusal to boot without an explicit store location: the refusal was
guarding against a silent loss that is not silent — `/proc/self/mountinfo` distinguishes a
mounted path from the container's writable layer with certainty, so the condition is
*observed and stated* rather than refused. What that buys was not the point of the change:
an ephemeral container is a **trial run**, which is exactly what ADR-0005 needs now that
typing a position is the onboarding.

## Consequences

- **`docker-compose/` goes entirely**, the `Makefile` with it. Its four jobs die of four
  independent causes — none of them "compose is leaving" — so nothing was left to port.
- **Headless is a usage, not a setting.** There is no dial for the page; an operator
  publishes only the metrics port and never visits the other. The base currency is
  therefore set by `curl` on the write API, which is the only non-interactive path.
- **`/health` reaches the store** — the "survive a database outage" argument has no
  subject once the store is in-process — and the `HEALTHCHECK` moves into the image, where
  it applies to plain `docker run` and to PaaS alike.
- The two paths are **directories, each with its own boot variable**, which takes
  ADR-0014's inventory to **six** — `SB_STORE_DIR`, `SB_IMPORT_DIR`, `SB_WEB_PORT`,
  `SB_METRICS_PORT`, `SB_PROMETHEUS_ENABLED`, `LOG_LEVEL`, as `boot_env.py` enumerates
  them. Its principle was the boot test, never a count.
  The defaults are chosen for the container; the Docker-less deployment overrides them —
  the reverse of v4, where compose always set every variable.
- The image is renamed `ghcr.io/pbrissaud/suivi-bourse`, with no compatibility alias:
  renaming is free precisely because ADR-0008 says nothing migrates.
- The getting-started drops from six steps to three and **shows no file at all** — the
  first thing the documentation shows becomes a command and a screen. No single decision
  produced this; it is where ADR-0005, ADR-0014 and this record intersect.

[Full argument: #679](https://github.com/pbrissaud/suivi-bourse/issues/679)
