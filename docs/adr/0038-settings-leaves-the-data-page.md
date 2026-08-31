# Settings leaves the data page, and the tabs leave with it

[ADR-0030](./0030-the-data-page-has-three-tabs.md) cut the data page into three tabs —
the ledger, the notices, the installation — and defended the four-page cut of
[ADR-0020](./0020-the-line-is-no-longer-the-unit.md) with one sentence: *a tab is not a
page*. Two records have taken tabs off that page since.
[ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md) withdrew
the notices tab's exception, and
[ADR-0037](./0037-notifications-have-a-space-and-the-banner-has-none.md) moved the
notices off the page altogether, into a panel behind the header's bell.

What is left is the ledger and the installation. **A two-tab bar is a bar that should not
exist**: it costs a control and a level of nesting to hold a choice between two things
that have nothing to do with each other — what the owner declared, and what the
installation is. So the installation becomes a page, the tab bar goes, and the four-page
cut becomes five.

## Consequences

- **The data page is renamed for the one thing it now holds.** It is the **ledger** —
  `Grand livre` in French, the word `CONTEXT.md` and every French record already use. It
  is not called *Registre*: the concept has a word, and a page label that invents a
  second one puts two names on one thing, which is the failure the glossary exists to
  stop. Labels are decided in English first ([ADR-0024](./0024-the-english-catalogue-is-not-a-translation.md)),
  so the source is `Ledger` and the French arrives through Crowdin.
- **The status dot's destination changes name, not nature.** ADR-0036 sent it to *the
  installation tab, where one repairs*; it now leads to **Settings**, which is that tab
  with a shorter address. The property that mattered — the dot *leads* somewhere rather
  than indicating without pointing, which is what ADR-0022 asked of it — is untouched.
- **Both new entries stay at the bottom of the navigation.** The sidebar's top holds the
  portfolio — dashboard, securities, accounts — and its foot holds what is not the
  portfolio. The ledger has a claim to the top since
  [ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md) made it the surface where
  events are declared, corrected and deleted; it is declined, because the top three are
  what the owner *looks at* and these two are what they *act on*, and a five-item list
  that groups by neither is worse than a three-and-two that groups by one.
- **ADR-0020's cut is amended in its count and kept in its principle.** The principle was
  never *four*; it was that each page answers one question and a bookmark survives. Five
  pages do that as well as four. What is spent is ADR-0030's defence — *a tab is not a
  page* — which was only ever needed because the page was carrying three answers.
- **The settings page is coherent on its own, and it is what ADR-0030 already described**:
  the settings themselves, the store with its size and its last ledger write, and the
  orphaned securities. Nothing on it belongs to a row.

[The tab cut it ends: ADR-0030](./0030-the-data-page-has-three-tabs.md) ·
[the page cut it amends: ADR-0020](./0020-the-line-is-no-longer-the-unit.md) ·
[the panel that emptied the page: ADR-0037](./0037-notifications-have-a-space-and-the-banner-has-none.md) ·
[the dot whose destination it renames: ADR-0022](./0022-the-navigation-is-a-sidebar.md) ·
[the catalogue that names it: ADR-0024](./0024-the-english-catalogue-is-not-a-translation.md) ·
[the spec that carries it: #787](https://github.com/pbrissaud/suivi-bourse/issues/787) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
