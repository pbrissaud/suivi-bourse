# The account type stops being a question

[Issue #916](https://github.com/pbrissaud/suivi-bourse/issues/916) set out to close
`account.type` into a catalogue, because
[#752](https://github.com/pbrissaud/suivi-bourse/issues/752) was about to attach a taxation
model to it and *a default cannot be attached to a value the owner invented in a text box*.
The catalogue was built, and building it is what showed the column had nothing to close
around. This record keeps why it was removed instead, and where the knowledge it was
supposed to carry actually went.

## The column was read by nothing, and its one future job was one-shot

`account.type` was free text: typed by hand in the account form and in the first-run
passage, accepted by the API as any string. `portfolio_view` copied it onto the wire, the
API served it, three components displayed it. Its only non-decorative reader was
`accounts.default_is_declared`, which read it as a marker — *has the owner touched this
row* — never for its value.

Its one future job was #752's, and #752 states the shape of it: *"When an account is
declared, the app proposes the default model of its type; what the owner validates is
written into their account fact row and stops moving."* With, as an acceptance criterion,
*"Changing an account's type afterwards leaves its taxation model unchanged."*

So the type would be read **once**, at declaration, to pre-fill a form, and never again.
Which is what condemned the apparatus #916 had built around it: a closed catalogue, an
advisory family naming every account outside it, and a repair path bringing them back in —
all of it maintaining a value whose correction, by #752's own decision, changes no figure
anywhere. The advisory nagged about a subtitle.

## Only one of the five kinds has anything to pre-fill

The deeper reason is arithmetic on [ADR-0042](./0042-a-taxation-model-is-a-closed-kind.md)'s
own table. That record ships no rates — *"the owner types their rate"* — so what the app may
ship is only what is **not money**: structure.

| `kind` | Parameters | Shippable |
|---|---|---|
| `none` | — | nothing to fill |
| `flat_realised` | `rate`, `social_rate?` | **nothing** — all money |
| `bracketed_realised` | `brackets: (upper_bound, rate)` | **nothing** — bounds and rates are both money |
| `withholding_income` | `rate` | **nothing** |
| `aged_flat_realised` | `rate_before`, `rate_after`, **`threshold_years`**, **`age_basis`**, `social_rate?` | **two fields** |

One kind out of five. And the three products it describes are, per ADR-0042, *FR PEA, FR
assurance-vie, PT unit-linked*.

That is what makes a wrapper catalogue mostly furniture: a French `CTO`, a German *Depot*
and a Belgian *compte-titres* are the **same** object — `flat_realised`, nothing pre-filled
— differing only by a rate the app does not ship. A catalogue spanning them would be a list
of synonyms under different flags.

And it could never be complete anyway. ADR-0042 defers three families of seven, among them
the *principal* regime of several countries — Dutch box 3, Danish *lagerbeskatning*, the
*aktiesparekonto*, the Italian *bollo*. A complete European wrapper list is impossible in
v1 by construction, not for want of effort.

## The knowledge moves into the taxation model, nested under the one kind that uses it

What survives is not a column but a **shortcut**, and it lives inside `aged_flat_realised`:
having chosen that shape, the owner is offered the three known wrappers, and picking one
fills `threshold_years` and `age_basis`. It is not stored, it does not survive the
submission, and nothing ever reads it back — the taxation model is what is written.

Three properties of it are deliberate:

- **It is nested, so it is never met by someone it is not for.** No Danish regime has an age
  threshold — Denmark sits under `bracketed_realised` — so a Danish owner chooses a shape,
  types brackets, and the word *PEA* appears on no screen they cross. Which is also the
  answer to the objection this decision was tested against: the shortcut is French, the
  product is not.
- **The abbreviation is expanded before it is used**, and the country is in the label:
  *Plan d'épargne en actions (PEA) — France · 5 ans depuis le premier versement*. Written
  `PEA (France)`, the label leans on a sigle a reader outside France cannot expand; WCAG
  3.1.4 is about exactly that, and it argues for expanding, not for tagging.
- **The escape hatch is named**, *none of these — I will enter it myself*, rather than left
  as an empty control (GOV.UK's own rule for a closed list).

## The prior art says the same thing three times

Surveyed against primary sources while deciding:

- **Ghostfolio had an account type and deleted it.** Its issue #1900 — *changing an account
  type crashes the app* — was closed with *"the concept of account type has been
  deprecated"*; it left the interface in 2.1.0 and the schema in 2.20.0.
- **GnuCash decouples on purpose**: tax attaches through a separate Income Tax Information
  dialog rather than the account type, and the manual warns that changing the type
  *"will make all previously assigned categories invalid"*.
- **Portfolio Performance never had one** — its `Account` carries no type at all, and taxes
  are transactions.

Three products, three ways of saying that deriving tax treatment from an account type is
paid for on the day somebody changes the type — the day #752 had already decided would
change nothing.

On the other half of the question, no taxonomy solves jurisdiction with a field:
**Plaid** puts `401k`, `isa`, `tfsa`, `rrsp` and `sipp` in one flat list with no country
member; **FDX** carries the jurisdiction in the English prose of its documentation only;
and **OFX** names the gap in its own specification — the element is literally
`<USPRODUCTTYPE>` — and promises an extension for other countries that has never shipped.
The one comparable product that does scope by jurisdiction, **Sharesight**, pays for it:
a portfolio's tax residency *"cannot be changed once it has been set up"*, and the
documented remedy is to recreate the portfolio and re-import. That is the shape of a
country dial, and it is why there is none here.

## The column outlives the decision, and goes in two steps

The DDL runs with `IF NOT EXISTS` and `type` is `NOT NULL`, so the column cannot simply be
dropped: it survives this record. The removal is therefore split.

**#916 removes the question** — the field in both forms, the subtitle, the member on `/api`
and on the front's `Account`, and `default_is_declared` rewritten to read the label alone.
Every install stops being asked, and nothing visible remains. New rows are written `OTHER`,
the value the seed already carries.

**A later ticket removes the column**, and it introduces the migration machinery this
project has never had — which is a reversal of a rule stated in `CLAUDE.md`, leaned on by
five records and asserted by name in nine tests, and it gets **its own ADR**. Splitting it
this way is what keeps that decision from being made under a milestone's pressure, for the
sake of a column nobody reads. The column is also the ideal first case for the machinery:
a removal with no reader, and therefore no risk, to prove the mechanism before anything
that matters is handed to it.

## Consequences

- **The account id returns to the accounts page, in the slot the type held, reversing
  [#838](https://github.com/pbrissaud/suivi-bourse/issues/838).** That ticket removed it
  saying the page heads an account with *what the owner called it and what kind it is*; only
  one of the two is left, and the id is the half that does concrete work — it is what the
  owner writes in the `account` column of an import file. **Beside the name, never beneath
  it**: the drawing puts this value on the heading's own line — inline after a `·` on the
  detail, at the far end of a `justify-between` row on the rail — so what changes is which
  value sits there and nothing about where.
- **`wrapper` enters `CONTEXT.md`, and it is the only word this adds.** ADR-0042 already
  uses it three times as though it were defined. The shortcut gets no term of its own: it is
  not stored, does not survive the form, and naming it would promise a concept where there
  is a list.
- **`POST /api/accounts` stops reading `type` rather than refusing it.** `/api` is the
  front's interface and not a contract held for anybody else (ADR-0033), the front stops
  sending it, and a refusal written for a client that does not exist is code for nobody.
- **#921's open question is answered here**: it asked whether the contribution ceiling is
  declared per account or attached to the account type. There is no account type to attach
  it to.
- **The finished implementation of the opposite decision is kept, unmerged**, on
  `feat/916-account-type-catalogue`. It is the shortest available evidence of what the
  closed catalogue actually cost — a catalogue, an advisory family, a repair path and two
  message catalogues — and therefore the shortest argument against re-proposing it.
- **The disconfirming evidence is recorded rather than buried.** ADR-0042 ships no rates
  because they are per tax year; **OpenFisca** answers that same problem with one package
  per country and every rate a **dated parameter**, so a change in the law is a new dated
  entry rather than a migration. Sharesight ships the Australian CGT formula with an
  editable default, and Parqet computes the German *Vorabpauschale* automatically. None of
  this makes ADR-0042 wrong — OpenFisca is a funded public project maintaining precisely the
  contract that record says *"nobody signed"* — but the alternative exists, is proven, and
  should be met as an argument rather than as a surprise.
