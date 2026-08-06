# Settings live only in the store, and the environment stops speaking

The line between what the environment configures and what the app owns is drawn by a
mechanical test, not by a judgement about nature: **the environment holds what the
process must know before it can open the store** — where the store is, which ports to
bind, whether to serve metrics, how loudly to log. Everything else lives in the store,
and **keeps no environment form at all**: no precedence rule, no seed-on-first-boot, no
settings file. There is exactly one place that says what a setting is worth.

The objection that blocked this for a year — compose *always* renders the variable, so
the app's own defaults are dead code and the store's value is overwritten on every boot
— was a property of the v4 compose file, not of the design. Nothing carries it into v5:
the store location is mandatory and unset, so every install rewrites its compose anyway.

## Consequences

- **Headless means without an interface, not without HTTP.** The write API is always
  served, so a settings-by-`curl` install remains possible; what an operator can turn
  off is the page, never the API. This is what keeps ADR-0013's file-provisioning
  principle from being abandoned one decision later, and it does so without a second
  source of truth.
- **A dial that would need a restart is deleted rather than moved.** The executor-pool
  pair goes, and sizing is always automatic — so the settings page has one class of
  field rather than two.
- The table is `setting(key, value)`, seeded with the defaults and **completed at every
  boot**, so a later version that adds a dial needs no migration. It has no types, so
  validation lives in the write path against a **registry in code** — the single list of
  dials the API, the effective-configuration view and the form all read.
- The ingestion interval loses its subject with "the files are the truth": the replay
  follows the write that changed the ledger, and the drop folder is watched with no dial.
- Variables the app no longer reads are **named and not obeyed**, the gesture already
  used for `config.yaml` and `settings.yaml`.

[Full argument: #678](https://github.com/pbrissaud/suivi-bourse/issues/678) ·
[the inventory it rests on: #654](https://github.com/pbrissaud/suivi-bourse/issues/654)
