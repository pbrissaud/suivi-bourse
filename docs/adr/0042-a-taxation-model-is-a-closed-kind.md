# A taxation model is a closed `kind`, and the app ships no tax table

[Issue #752](https://github.com/pbrissaud/suivi-bourse/issues/752) wants an account to carry
enough of its tax regime to say something useful about an unrealised gain.
[Issue #917](https://github.com/pbrissaud/suivi-bourse/issues/917) asked, first, what such a
regime *looks like* across Europe — eight countries, primary sources, every figure dated —
because the shape of the table is decided by the answer and not by the first country
encountered. The survey lives in that issue's comments. This record keeps what survives it.

Forty distinct parameter shapes were observed. They collapse into seven families, and the
frequency is lopsided: a flat rate on a realised gain describes five of the eight countries,
while a tax on an unrealised gain describes two and cannot be expressed by a realised-gain
model at all.

## The model is a closed `kind` plus typed parameters, and never a formula

A taxation model is **one constant from a closed enumeration**, and a small set of
parameters whose types that constant fixes. It is not a formula field, not an expression,
not a snippet the owner writes and the app evaluates.

There is no expression interpreter anywhere in this tree, and this record is where the first
one is declined. A formula field looks like flexibility and buys the opposite: every stored
string becomes a public contract the app can neither validate, migrate nor explain, and the
day one of them divides by an empty position the failure surfaces as a wrong number rather
than as an error. A closed enumeration is checked when it is written, is readable by the
agent surface ([ADR-0040](./0040-the-app-gets-a-second-reader-and-it-is-an-agent.md)) and
tells a reader what the app *cannot* compute — which is the more useful half.

## The kinds retained for v1

| `kind` | Assessed on | Parameters | The regimes it describes |
|---|---|---|---|
| `none` | — | — | An exempt holding, or an account the owner does not want projected |
| `flat_realised` | the realised gain | `rate`, `social_rate?` | FR compte-titres, BE, DE, IT, PT |
| `aged_flat_realised` | the realised gain | `rate_before`, `rate_after`, `threshold_years`, `age_basis`, `social_rate?` | FR PEA, FR assurance-vie, PT unit-linked |
| `bracketed_realised` | the realised gain | `brackets: list<(upper_bound, rate)>` | DK, ES, PT, BE substantial holdings |
| `withholding_income` | income received | `rate` | all eight countries |

Four of the five share one assiette, so the projection has **one code path and four ways of
choosing a rate**. `none` is not a placeholder: it is the correct answer for German shares
bought before 2009, and the default for an owner who has said nothing — an account whose tax
is unknown must publish no figure rather than a plausible one.

**`social_rate` is a second rate on the same base, not a decoration.** France forces it:
12,8 % of income tax plus 18,6 % of social charges, where the wrapper changes only the
second — assurance-vie stays at 17,2 % (LFSS 2026, art. 12). A single stored `31,4 %` would
be unmodellable the day a second wrapper appears. It matters most where the two diverge
completely: a PEA past five years owes **0 %** of income tax and **18,6 %** of social
charges, so a model holding one combined rate would report a mature PEA as untaxed, wrong by
the whole of the social charges.

**`age_basis` is a date the owner supplies, and it is not always the opening date.** A PEA's
five years run from *the first payment*. The two coincide often enough to hide the mistake
and not always enough to make it safe, which is why the parameter is named after what it
measures rather than after the column it usually reads.

## Three families are deferred, and they are named rather than forgotten

The survey found three regimes that this contract deliberately does not express in v1:

- **an annual tax on the unrealised gain** — Danish *lagerbeskatning* and the
  *aktiesparekonto*, Italian *risparmio gestito*;
- **an annual tax on a deemed return** — Dutch box 3, the German *Vorabpauschale*, both fed
  by a rate an authority publishes every January;
- **an annual tax on the value held** — Spanish *Patrimonio*, Italian *imposta di bollo* and
  IVAFE, the Belgian *taxe annuelle sur les comptes-titres*.

Each is real, in force, and describes somebody's actual account. Each also breaks the
sentence the projection exists to say — *the tax you would owe if you sold today* — because
the tax did not wait for a sale. Supporting them needs a year-end valuation and a memory of
tax already paid: a second shape of stored state, not a second rate. They are **additions,
not refactors**, which is the point of fixing the recipe below now.

## Adding a kind later

A regime is added in four steps and no others:

1. **a constant** in the closed enumeration — never a new nullable column on the existing
   parameters, which would make the absent case indistinguishable from the unset one;
2. **its typed parameters**, declared with the constant, so that a reader of the enumeration
   knows what a row of that kind must carry;
3. **its projection** — one pure function, `now` injected, no store and no yfinance, in the
   sense `CLAUDE.md` gives the word;
4. **its two catalogue sentences** — one saying what it is assessed on and when it is
   charged, one saying what it does not cover. They are what the front and the agent surface
   read; a kind without them is a figure nobody can qualify.

Nothing above is a migration. The DDL is applied with `IF NOT EXISTS` and there is no
migration machinery, so the account-level facts of #752 go in a **new table** rather than in
new columns — and a kind added in version *n+1* exists on a store created at version *n*
because rows simply do not use it.

## The model is a projection, and the tax return is not its business

Written down once, so it is not re-litigated per country. The model deliberately does not
express: allowances and exempt tranches; loss carry-forward (four years in Italy, five in
Portugal but only under *englobamento*, conditional on timely reporting in Denmark);
wash-sale deferral; the household's situation; grandfathering by acquisition date;
per-transaction taxes such as the Belgian TOB; and cost-basis resets.

Every one of those is real, and every one belongs to a tax return. The figure this module
publishes has one job: to stop the owner reading an unrealised gain as money they already
have. A figure that tried to be the return would be wrong more often and trusted more.

## Consequences

- **The app ships no tax table, and this is a decision rather than an omission.** Every rate,
  bracket, threshold and ceiling in the survey is *per tax year*, and several are defined by
  reference to figures a budget law moves annually — Portugal's day-count threshold points at
  the top bracket of another article, Belgium's allowances are base amounts indexed under
  CIR92 art. 178, Germany's *Basiszins* is published each January. The owner types their rate;
  the app stores what it was told and dates it. Maintaining eight countries' schedules is a
  contract nobody signed, and one stale bundled figure is worse than an absent one because it
  looks maintained.
- **A per-account model does not reach Denmark, and the limitation is stated rather than
  repaired.** Denmark attaches the method — *realisation* or *lager*, share-based or
  bond-based — to the **instrument**, not to the account. A Danish depot holding both cannot
  be described by one `kind` on one account. Per-instrument taxation stays addable; it is not
  in v1, and pretending otherwise would put a wrong number on a real portfolio.
- **Three ages appear in the survey and they are not interchangeable**: the *holding's* age
  (Portugal counts it in **days**), the *wrapper's* age (PEA, assurance-vie), and the
  *holder's* age (Portuguese PPR, German Rürup). #752 stores the second. The first would need
  a date per lot — the ledger has it, the account table does not — and the third is not the
  app's business.
- **Two premises changed while the survey was running, and documentation written on the old
  ones is now wrong.** Belgium has taxed private capital gains on financial assets at 10 %
  since 1 January 2026 (law of 6 April 2026, numac 2026002780); French social charges went
  from 17,2 % to 18,6 % on 1 January 2026 with assurance-vie carved out at 17,2 %. Both are
  sourced and dated in #917, and both are reasons the app stores a rate rather than knowing
  one.
- **The kinds are a closed enumeration on the store's side too.** A row carrying an unknown
  kind is a defect, not a case to tolerate: it means a store written by a newer version, and
  the read fails loudly rather than projecting zero.
- **The table this record describes has one writer**, as every table does
  ([ADR-0006](./0006-declaration-and-derived-state-never-share-a-row.md)), and the parameters
  are declaration: nothing derived is ever written beside them.
