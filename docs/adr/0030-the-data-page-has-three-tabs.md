# The data page has three tabs

> **The notices' exception is withdrawn by
> [ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md)**: the dot
> says health and leads to the installation tab, so the notices lose the question they were
> mounted to answer and become an ordinary block that does not exist when it is empty. And
> the file list with its revocation goes with
> [ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md) — the band above the ledger keeps
> the upload and the export, and loses the sources. What stands below is the **three-tab
> cut** and the reason provenance belonged beside the rows it described.

[ADR-0020](./0020-the-line-is-no-longer-the-unit.md) cut the data page in two — what the
user *declared* against what the installation *is* — and put the notices inside the
second half, as a block that does not exist when it is empty.

Two things break that arrangement. The **accounts leave the page**: a declaration is made
where its subject is looked at, so declaring, renaming and removing an account move to
the accounts page (ADR-0028), and the first half stops being *what the owner declared* —
it becomes the ledger and its provenance. And a **notice is prose**: *a `config.yaml` of
the v4 sits in the configuration directory and is not read*, with a date, an
acknowledgement and a link to the events concerned. Rendered as a card in a column
beside the store, it has nowhere to say that.

The page therefore has three tabs — **the ledger** (what you declared, and where it came
from), **the notices** (what the app has to tell you), **the installation** (what it is).
A tab is not a page, so the four-page cut of ADR-0020 still holds.

## Consequences

- **The notices tab was always mounted, and that was this decision's one exception —
  [withdrawn by ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md),
  so nothing below is claimed of the product today.** The reason was the status dot:
  [ADR-0022](./0022-the-navigation-is-a-sidebar.md) made the dot *lead* somewhere rather
  than indicate without pointing, and a destination that exists only when the dot is
  amber gives one control two addresses; a tab that answers *nothing to report* answers
  exactly the question the dot asks. The dot does not ask it — it leads to the
  installation tab, where one repairs — so the block became ordinary again, and *a block
  with nothing in it does not exist*, unchanged everywhere else all along, has no
  exception anywhere. The second argument went the same way: acknowledging the last
  notice makes the surface vanish under the reader, which was the objection and is the
  behaviour.
- **The imports return to the ledger tab, which is where ADR-0020 had put them.** The
  redesign had moved the imported files beside the store; provenance is a property of a
  *declared row* — which file, imported when, with what fingerprint — and ADR-0020 had
  already made the provenance cell a link to the import block. Split across two tabs,
  that link crosses the page. The drop zone, the export menu and the file list with its
  revocation are one band above the table.
- **The export keeps its four entries, accounts included, and does not follow the
  declaration.** Declaring an account is a gesture on a domain object; exporting is a
  gesture on data, and the data page is where it belongs whatever the subject. The
  symmetry with the declaration is apparent, not real.
- **The status dot stays in the content header.** ADR-0022 measured that as the only
  place surviving all three sidebar states — shadcn hides `SidebarMenuBadge` in icon mode
  and the drawer takes the navigation with it. The sidebar's status card is the dot's
  development where there is room for one, never its address.
- **The installation tab is what is left, and it is coherent on its own**: the settings,
  the store with its orphans, and nothing that belongs to a row.

[The two tabs it splits and the imports it restores: ADR-0020](./0020-the-line-is-no-longer-the-unit.md) ·
[the dot whose single destination it serves: ADR-0022](./0022-the-navigation-is-a-sidebar.md) ·
[the page the declaration moves to: ADR-0028](./0028-the-accounts-page-shows-one-account.md) ·
[the spec that carries it: #787](https://github.com/pbrissaud/suivi-bourse/issues/787) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
