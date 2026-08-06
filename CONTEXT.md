# SuiviBourse

A personal stock-portfolio tracker: you record what you bought, sold, received and
paid in; it fetches prices, values your positions and computes your returns.

This glossary is the **v5 language**, settled across the decision record in
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669) and its tickets.
Where a v4 term was retired, the retirement is noted under `_Avoid_` and the ADR in
`docs/adr/` says why.

## Language

### The ledger

**Event**:
A single dated fact about the portfolio, as the owner recorded it. One of six kinds:
`BUY`, `SELL`, `GRANT`, `DIVIDEND`, `DEPOSIT`, `WITHDRAWAL`. Events are the only
user-authored truth about a portfolio; everything else is derived from them.
_Avoid_: transaction, operation, movement

**Ledger**:
The whole set of events, across every account. Ordered by date, never by the file or
row they arrived in.

**Cash event**:
A `DEPOSIT` or `WITHDRAWAL` — an event that names an account and an amount, and no
security.

**Account**:
A named bucket of positions and cash, corresponding to a real-world envelope (a PEA,
a CTO, a broker). Every event belongs to exactly one. There is always at least one;
when the owner has declared none it is called `default`.

**Position**:
What an account holds of one security: a quantity and a cost basis. A position with
a quantity of zero is not a special kind of position — it is a position that has
fallen out of the model.
_Avoid_: holding, line, closed position

**Cost basis**:
What an account paid, in total, for the quantity it still holds — an amount, not a
unit price. Acquisition fees are absorbed into it; the unit price (the *PMP*) is
derived by division, never stored.
_Avoid_: cost price, purchase price, PMP (as a stored figure), average price

**Cash balance**:
An account's running cash, moved by every event that has a monetary side. It may be
negative.

**Net contribution**:
Deposits minus withdrawals, fees excluded — the money the owner put in from outside,
as opposed to money the portfolio moved around inside itself.
_Avoid_: invested amount, capital

**External flow**:
A movement across the portfolio's boundary: a deposit, a withdrawal, or a grant.
External flows are the *contribution*; they are what a return is measured against.

**Internal flow**:
A movement inside the portfolio: a purchase, a sale, a dividend, a fee. Internal
flows are the *performance*; they never change the contribution.

### Money

**Base currency**:
The single currency every figure in the app is reported in. Chosen once, on first
run, and immutable for as long as any event exists.
_Avoid_: reporting currency, account currency, home currency

**Quote currency**:
The currency a security is priced in by the market. Converted to the base currency
at write time, never at read time.

### Prices

**Symbol**:
A security's Yahoo Finance ticker — the identity under which prices are fetched and
stored. Prices belong to a symbol alone, never to an account: a market price belongs
to no one.

**Price point**:
One observation of a symbol's price at one instant, carrying the native price, the
converted price and the rate used.
_Avoid_: quote (for a stored point), tick, sample

**Scrape**:
Fetching a symbol's current price. Market-aware: a symbol whose market is open is
polled on a short cadence, a symbol whose market is closed sleeps until it reopens.

**Backfill**:
Fetching a symbol's *past* prices. Three independent passes: **backward** (toward the
start of the holding window), **forward** (recovering a session missed while the app
was down), and **lateral** (repairing a point whose currency conversion failed).

**Terminal**:
Said of a backfill that will never fetch anything more for a symbol — either it
reached the start of the holding window, or the symbol can never be converted. A
terminal backfill is what makes a missing price *permanent* rather than *not yet
arrived*, and the two are never confused.

**Carrying price**:
What a position is valued at on a day where no price exists and none ever will: its
own unit cost basis. Deliberately invoked, never a silent fallback — it is a
convention, and the screen says so.
_Avoid_: fallback price, last known price, forward-filled price

**Resolution ladder**:
The rule that a stored point's resolution is a function of its age — fine while
recent, hourly past a year, daily past two. A ceiling on how fine a point may be
kept, never a floor: it collapses history in place and fabricates nothing.

### Performance

**Performance series**:
The daily valuation and return of an account (and of the portfolio as a whole). A
derived series, recomputed in full from the ledger and the prices, holding no fact
of its own.
_Avoid_: account metrics, portfolio metrics (as domain terms)

**Horizon**:
The earliest day an account's performance can honestly be stated — the day from
which every security it held has a price. It recedes as the backfill advances, so
the series fills in leftward; nothing is written before it.
_Avoid_: cutoff, start date, window

**Latent gain**:
What the holdings are worth minus what they cost. Distinct from *realized gain* and
from *dividends*: three named figures, never one composite.

**Realized gain**:
What a sale returned above the cost basis it consumed. A property of a position, not
of a price.

**TWR**:
Time-weighted return — how the securities performed, indexed to 100 at the start of
the series, blind to when money was added or removed.

**XIRR**:
Money-weighted return — what the owner actually earned, annualised, given when they
put money in and took it out. Needs only the external flows and today's value, so it
is exact from the first cycle even while history is still being fetched.
