# The rhythm is measured on the buys, and it describes without judging

[Issue #751](https://github.com/pbrissaud/suivi-bourse/issues/751) asks the app to detect
how regularly its owner invests, so that a forecast
([#757](https://github.com/pbrissaud/suivi-bourse/issues/757)) has something to project.
The word it used was *DCA* and the figure it named was *the monthly amount invested*. Both
hide a choice, and this record makes it.

## The signal is the buys, and the deposits were declined

The ledger offers two candidates. **Deposits** are the *net contribution* — money crossing
the portfolio's boundary, which is what dollar-cost averaging means everywhere the term is
written down. **Buys** are an internal flow: money already inside, changing form.

The owner's own account of their habit settles it. Cash arrives on the CTO on a schedule
and is spent when something is worth buying — some months an ETF, some months bitcoin,
rarely both at once. The deposits describe the **funding**, and they are regular by
construction: they would report a discipline the owner never has to exercise. The buys
describe the **investing**, which is the behaviour a forecast has to extend.

**The cost of that choice is named rather than repaired.** Selling one holding to buy
another counts as rhythm, because nothing on a `BUY` says where its money came from; a
month of rebalancing reports more rhythm than the owner lived. Subtracting the month's
sells was considered and rejected — it turns a heavy rebalancing into a *negative* rhythm,
which is not a slower rhythm but a meaningless one, and it buys accuracy in the rare month
at the price of nonsense in the rarer one. The limitation travels in the MCP tool's
description, where a model reads it before quoting the figure.

## An amount that cannot be quoted alone

Six months of 500 € inside a twelve-month window is not *250 € a month*, and it is not
*0 € a month* — the two figures a mean over the window, and a median over it, would
produce. It is **500 €, six months out of twelve**, and that pair is the smallest honest
statement available.

So the amount is a **median over the months that carry a purchase**, and it is published
**with its coverage or not at all**. A median rather than a mean, because one exceptional
month — a bonus, a release of savings — would otherwise set the figure a twenty-year
projection is built on. The coverage beside it, because a reader handed `500 €` alone will
say `6 000 € a year` with complete confidence when half of that never went in; and that
class of confident-and-wrong sentence is precisely what
[ADR-0040](./0040-the-app-gets-a-second-reader-and-it-is-an-agent.md) puts the tool
description in place to stop.

## It describes, and the reader judges

There is no label — no *monthly*, no *regular*, no *irregular* — and there is no advisory.
The machinery for one exists and was declined. The only advisory family today is about a
**fact of the portfolio**, cash sitting idle; an advisory here would be about the owner's
life, and someone who stopped buying in March because they bought a house would be told
about it every thirty days.

*Regular* is also a threshold, and
[ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md) already
answered thresholds nobody asked for: *"a setting nobody has ever turned is a setting that
should not have been written."* The numbers are published; the chat and the MCP agent draw
the conclusion, which is what #751 wanted from them to begin with.

## Consequences

- **The window is twelve rolling months and it is hard-coded**, bounded only by the age of
  the ledger — counted from the first event of any kind, never from the first buy. Nine
  months without a purchase is a fact *about* the rhythm, not a gap in the observation, and
  starting the count at the first buy would erase exactly the thing a reader wants to see.
- **The grain is the portfolio, broken down by account, and never by symbol.** An ETF
  bought in January and bitcoin in February are one monthly habit expressed twice; per
  symbol they are two irregular ones. A rotation out of A into B would likewise break a
  per-symbol rhythm without the owner's effort having moved. Per symbol stays *addable*:
  ADR-0040 makes the tool surface a contract in which a new field is safe and a removed one
  is not.
- **Nothing is stored.** The figures are derived on every read, like the advisories, for
  the reason that module already gives — there is nothing a row could know that the figures
  do not. The DDL runs with `IF NOT EXISTS` and there is no migration machinery, so a table
  added now would exist on no store created before it; and twelve months of buys is a cheap
  replay.
- **The calculation is a pure module** in the sense `CLAUDE.md` gives the word: no store,
  no yfinance, `now` injected. The purity guard that already runs over the source holds it.
- **`/api` gains a route, the tool surface gains a sixth tool, and the order matters.**
  `mcp_server` opens by promising that *"it computes nothing — every figure a tool returns
  is the figure a route already returns."* A tool without a route would have made this the
  second departure from `/api` after [ADR-0031](./0031-the-ledger-loads-in-pages.md)'s
  paging, and would have needed arguing as one. The route keeps the promise literal, and
  both surfaces reach the same primitive so they cannot disagree.
- **Absence is a `null` and never a zero.** A portfolio with no purchase in the window has
  no monthly amount and no dispersion; it has a coverage of zero out of the months
  observed. The precedent is the performance writer, which writes `NULL` rather than `0` so
  that *"no ledger"* and *"a ledger at zero"* are not the same row.
- **The dashboard gains a block; the sidebar gains nothing.** Its five entries are argued
  as three and two ([ADR-0022](./0022-the-navigation-is-a-sidebar.md),
  [ADR-0038](./0038-settings-leaves-the-data-page.md)), and a sixth would open a page
  holding a single block. The eventual home is a `Projections` page, created when #757 or
  [#758](https://github.com/pbrissaud/suivi-bourse/issues/758) gives it a second occupant —
  a block moves there painlessly, a menu entry cannot be withdrawn painlessly.
- **The name is *investment rhythm*, and *cadence* was refused.** The settings page already
  says *Cadence de relevé* and *Cadence de reconstruction* for the scheduler's intervals,
  and one word for two things is as bad as two words for one. *DCA* joins the `_Avoid_`
  list in `CONTEXT.md`: it is jargon foreign to this domain, and it promises money that
  crossed the boundary — which is the one thing this measure does not guarantee.

[The agent that reads it: ADR-0040](./0040-the-app-gets-a-second-reader-and-it-is-an-agent.md) ·
[the threshold it refuses to invent: ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md) ·
[the block that renders nothing while it loads: ADR-0026](./0026-a-read-in-flight-is-not-an-absence.md) ·
[the five entries it does not become a sixth of: ADR-0038](./0038-settings-leaves-the-data-page.md) ·
[issue #751](https://github.com/pbrissaud/suivi-bourse/issues/751)
