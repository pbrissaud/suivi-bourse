# The English catalogue is not a translation of the French one

The interface ships in English and French. The source strings are English — code,
comments, routes and issues are English by decision, and Crowdin reads an English
source — but the two catalogues are addressed by **semantic keys**, so neither is the
original and neither is a translation of the other. Where a literal rendering would
lose a decision the map has already taken, the English catalogue **says something else**.

Two such places exist, and the side-by-side inventory is what found them. Both are cases
where English degrades a French decision rather than merely restating it; the risk the
ticket named up front — `PRU` versus `PMP` — is not one of them, because English has no
competing pair to arbitrate.

## Where the language lives

The language is a property of the **reader**, not of the installation. It lives in the
browser (`localStorage`), defaults to the browser locale, and has **no dial in the
store** — which keeps ADR-0014's registry purely about the engine, and keeps ADR-0021's
*one question at first run* at exactly one. The theme takes the same home and the same
three-state shape (`light` / `dark` / `auto`, absence meaning `auto`): two reader
preferences, one mechanism.

Both selectors sit in the **content header bar** that ADR-0022 introduced, beside the
status point. That is not a placement preference — the sidebar foot, where #691 had
mounted the language selector to prove the form, is exactly the surface #691's own F3
showed does not survive the drawer.

## Consequences

- **Number and date formatting follow the language**, not the currency. ADR-0002's
  *a currency is a unit, not a locale* is what licenses this rather than what it
  contradicts: precisely because the currency is a unit, it cannot dictate a decimal
  separator. `LOCALE` in `format.ts` stops being a constant; the eight `Intl` sites
  read the current language.
- **The server stays English, and the front stops displaying it.** `problem.py`
  already declares stable `type` identifiers and documents them as the thing the front
  branches on; the front branches on `status` instead and renders `detail` raw, which
  is why a French title sits over an English sentence today. The front branches on
  `type`; `detail` returns to being diagnostic. No contract changes, and no message
  table gets a second implementation — which is what `Accept-Language` would have cost.
- **Anything without a browser stays English, with no setting**: logs, the boot lines
  of ADR-0015, Prometheus `HELP` text, problem `type` URIs, event-file column headers.
  A `SB_LANG` variable would resurrect the environment-shaped setting ADR-0014 removed.
- **`Total gain` is not the English label.** `Total gain` and `Total return` — the TWR
  index, on the same head — begin with the same word and both carry an ADR-0016 icon,
  a collision French does not have. The English catalogue says `Total P&L`, which is
  also literally what the four terms are.
- **The six event types are named by effect, not by code.** In French `Attribution` is
  visibly not `GRANT`; in English a literal rendering makes all six labels equal to
  their own enum values, and ADR-0020's *labels that explain their effect rather than
  six codes* survives only as capitalisation. So: `Free shares`, `Cash in`, `Cash out`.
- **`Avg. cost` is not a decision.** ADR-0017 chose `PRU` over `PMP` because PMP names
  the rule and the ADR-0016 bubble now says the rule. English has one term with a long
  form, not two terms — the bubble takes the long form and the column takes `Avg. cost`,
  with nothing arbitrated.
- **Six French identifiers are renamed**, and this is not translation. Two of them —
  `sb_account_gain_absolu` and `sb_portfolio_gain_absolu` — are the contract of an
  install that never opens the UI (ADR-0012), and renaming a live gauge breaks alert
  rules silently. ADR-0008 makes v5 a fresh install, so the rename costs nothing
  exactly once; no later i18n work will look at them.
- **The documentation becomes bilingual through Crowdin, scoped to the v5 corpus.**
  `versioned_docs/version-3.x/` never enters `crowdin.yml`, and translation starts only
  after the v5 docs are written — translating the current 16 255 words translates what
  ADR-0015's three-step guide deletes. The cost that mechanism does not remove is a
  *stale* translation: Docusaurus falls back to source for an untranslated string, never
  for a translated one whose source moved, so a superseded French rule can ship.
- **The catalogues are ICU, keyed semantically, one JSON file per language**, English
  being the Crowdin source, in **one** project. Plurals are real here — a header counter, `Forget this import (214)`,
  `N consecutive readings` — and French carries gendered agreement (`latente`, `réalisée`,
  `soldée`) that English does not, so a shared string across contexts is not available.
  A third language is admitted by this shape without redoing it, which was the ticket's
  own test.

  **Amended (issue #739).** This decision first said *two* projects, front and docs,
  "different formats and different rhythms". Setting it up showed the reason does not
  hold: the documentation's own configuration already mixes Markdown and ICU JSON, and
  serving several formats in one project is what Crowdin is for — so the argument
  forbids the very project it was written to justify. The rhythms do differ, but that
  decides *when* one translates, not where the files live; a project organises by path.
  What settles it is the vocabulary this ADR exists to protect: a translation memory
  carries `defaultProjectIds`, so isolation is Crowdin's default and sharing is an
  explicit step. Two projects means *plus-value latente*, translated once in the
  interface, never suggests itself in the page that explains it — this ADR's own defect,
  two languages in one box, one storey up as two vocabularies for one product. One
  project, one `crowdin.yml` at the repository root, covering `website/` and
  `app/web/src/i18n/`.

[Full argument: #692](https://github.com/pbrissaud/suivi-bourse/issues/692) ·
[the labels it re-examined: #683](https://github.com/pbrissaud/suivi-bourse/issues/683),
[#684](https://github.com/pbrissaud/suivi-bourse/issues/684),
[#685](https://github.com/pbrissaud/suivi-bourse/issues/685),
[#686](https://github.com/pbrissaud/suivi-bourse/issues/686),
[#690](https://github.com/pbrissaud/suivi-bourse/issues/690)
