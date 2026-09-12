# A new fact lands in a new table, never in a new column

Two tickets reached the same wall from opposite ends and were about to improvise the
same answer twice. [#886](https://github.com/pbrissaud/suivi-bourse/issues/886) wants
per-symbol classification — sector, country, currency exposure, PEA eligibility, TER —
and finds no column on `symbol_quote` available to it.
[#752](https://github.com/pbrissaud/suivi-bourse/issues/752) wants account-level facts —
an opening date, the taxation model a wrapper carries — and finds none on `account`
either. Whichever shipped first would have settled the rule for the other, which would
then have inherited a structural decision it took no part in. So the decision is taken
once, here, by [#915](https://github.com/pbrissaud/suivi-bourse/issues/915), and it
blocks both.

## The rule

- A **derived** fact is computed at read time. It gets no column and no table. This is
  already the settled answer for `twr_since`, `transfer_fees`, `ytd`, `closed_at` and
  the rhythm figures, and nothing here disturbs it.
- A **declared** fact — one the owner states, which no computation can produce — that no
  existing table can carry goes into a **new table**, keyed by whatever the domain
  already names: an account id, a symbol. Never a new column on a table that exists.
- The new table has **exactly one writer**, named in `.github/scripts/conventions.sh`
  beside the others ([ADR-0006](./0006-declaration-and-derived-state-never-share-a-row.md)).
- An **absent row is an absence** and reaches the reader as one
  ([#845](https://github.com/pbrissaud/suivi-bourse/issues/845)): no sentinel, no zero,
  no *not set*.

## Why it is not "because a column is impossible"

The obvious argument is that the DDL runs with `IF NOT EXISTS`, that there is not one
`ALTER TABLE` in the tree, and that a column added to an existing table would therefore
exist on no store created before it. It is true today, and it is **the wrong argument**
— because [#926](https://github.com/pbrissaud/suivi-bourse/issues/926) is queued to make
it false. That ticket introduces schema-migration machinery, reversing a rule stated in
`CLAUDE.md`, leaned on by five records and asserted by name in nine tests; the reversal
was decided in [ADR-0043](./0043-the-account-type-stops-being-a-question.md)'s own
grilling. A record written on a premise already scheduled for removal is a documentation
defect on the day it lands, which is what `docs/adr/README.md` says in as many words.

So the argument is written on what survives the machinery. **A declared fact is its own
thing, and three properties say so:**

- **It has its own writer.** A column on `account` is written by whoever owns `account`,
  and ADR-0006's organizing rule is one writer per table. Adding a fifth fact to a table
  means either a second writer — which that record answers with *two tables, never a
  lock* — or one module that writes things it has no business knowing about.
- **It has its own absence, and a column cannot express it.** A nullable column says
  *unset*; a missing row says *never declared*. On an account fact those are two
  different sentences — *this owner has not told us their tax model* is not *this
  owner's tax model is nothing* — and #845 is the ticket about exactly the class of
  defect that follows from confusing them.
- **It has its own lifetime.** A taxation model is attached and detached; a
  classification is refetched; an account is neither. Rows come and go under a key
  without touching the row that key belongs to.

None of the three mentions migrations. All three hold on the day #926 lands, which is
the test this record is written to pass.

**What remains true of the DDL is a convenience, not the reason**: a new table is
created by the same `IF NOT EXISTS` statement, so it appears empty on a store that
predates it and needs nothing done to that store. That is why this costs nothing today.
It is not why it is right.

## What this does not license

**Not a table per field.** The unit is the *subject* — an account, a symbol — not the
attribute. #752's account facts are one table holding an opening date and a taxation
model reference together, because both are facts about an account declared by its owner;
they are not two tables. A second table appears when a genuinely different thing is
being described, with its own key, its own writer and its own lifetime — which is the
argument above, applied again rather than waived.

**Not a reason to store what can be derived.** The first clause of the rule is the one
that gets used most, and #926 does not soften it: a figure that can be recomputed from
the ledger is recomputed.

## Consequences

- **#886 and #752 are unblocked**, and both are held to the same shape: a keyed table, a
  single writer named in `conventions.sh`, and an absent row that reaches the reader as
  an absence.
- **The table count stops being a constant nobody may change and becomes a number two
  suite assertions state deliberately.** Both tickets grow it, and each says by how much
  in its own acceptance criteria rather than discovering it.
- **This record is what #926 must amend rather than contradict.** When migrations exist,
  the convenience paragraph above stops being true and the three properties do not. The
  amendment is a sentence, and it is already written here for whoever makes it.
