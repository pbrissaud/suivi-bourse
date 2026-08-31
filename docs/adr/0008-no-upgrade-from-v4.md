# There is no upgrade from v4

A v5 install is a **new install whose import folder happens to be full**. Nothing is
carried over — not from v4, not from the v5 preview branch — so there is no version
detection, no migration command, and no special startup path. The documentation gets a
paragraph titled *"coming from v4"*, not a migration guide.

The one continuity that survives concerns no state at all: an empty account column
means `default` until an account is declared, which lets a single-account v4's event
files import **without a single edit**.

## Consequences

- Reassurance cannot come from comparing v4 and v5 figures — ADR-0002, ADR-0003 and
  ADR-0004 changed the conventions, so only quantity, cash balance and net contribution
  are expected to coincide. The reassurance is that the original files are never
  touched.
- ~~Accounts are declared in a **dedicated file in the event format**~~; the v4
  `settings.yaml` is *named, never read* — reading it would make every multi-account
  v4's files fail validation outright.
  **Amended by [ADR-0034](./0034-accounts-are-born-in-the-app.md)**: an account is
  born in the app and nowhere else, so there is no declaration file in either
  direction. The half that stands is the second one, and it is what the migration
  page says: the ids are redeclared by hand, and `settings.yaml` is refused **by
  name** at the import.
- ~~v5 **refuses to start** without an explicit store location; the error message is the
  guide.~~ **Amended by [ADR-0015](./0015-one-container-two-mounts-persistence-is-observed.md)**:
  a bare run starts and simply does not persist. The refusal guarded against a loss that
  turns out to be detectable, so the condition is observed and stated instead.
- **Exporting events exists**, without which the honest answer to "can I go back to
  v4?" is no.
- ~~The several notices this produces (an unread `config.yaml`, an unread
  `settings.yaml`, the assumed base currency, the reconstruction) share **one dated,
  acknowledgeable journal** rather than four ad-hoc placements.~~ **Amended twice.**
  [ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md) removed the first two
  with the mount they `stat`ed: a v4 file is refused *at the gesture that hands it
  over*, by name, which beats a notice discovered later on another screen.
  [ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md) and
  [ADR-0037](./0037-notifications-have-a-space-and-the-banner-has-none.md) then
  split the one journal into three registers — health, installation facts,
  advisories — sharing **one destination**, the panel behind the header's bell. What
  is left of this bullet is its principle: one place, not four.

[Full argument: #677](https://github.com/pbrissaud/suivi-bourse/issues/677)
