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
The single currency every figure in the app is reported in. It has no default — until
it is answered, prices are still fetched but nothing is converted and no return is
computed. Immutable once **set**: the answer can be given late, it just cannot be
taken back.
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
was down), and **lateral** (repairing a point whose currency conversion failed — and,
once per symbol, learning the unit a line the live scrape never polls is quoted in).

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

**Total gain**:
Latent gain plus realized gain plus dividends. The three are the *breakdown* of it and
never terms added to it — the sale's proceeds are already in the cash balance. Always
shown as a total dominating its three terms, because three figures aligned without
their total is what invites adding them to something else.
_Avoid_: gain absolu (as an on-screen label), plus-value (for the composite)

**TWR**:
Time-weighted return — how the securities performed, indexed to 100 at the start of
the series, blind to when money was added or removed.

**XIRR**:
Money-weighted return — what the owner actually earned, annualised, given when they
put money in and took it out. Needs only the external flows and today's value, so it
is exact from the first cycle even while history is still being fetched.

### The app talking about itself

**Setting**:
A dial the owner turns — a poll interval, a backfill chunk, the base currency. It
lives in the store and nowhere else: there is one place that says what a setting is
worth, and the environment is not it. Every setting has a default in the code; the
store carries a copy of it, and a value it does not carry is that default.
_Avoid_: configuration, option, parameter, environment variable

**Boot variable**:
Something the process has to know *before* it can open the store — where the store
is, where the drop folder is, which ports to bind, whether to serve metrics, how
loudly to log. The only thing the environment still says. Not a setting, and never
editable from the app. Its defaults describe a container; anything else overrides them.

**Drop folder**:
The directory a portfolio's files are read from — the events and the account
declaration. Read-only and optional: the app never writes to it and never creates it,
and an install that has none is ordinary rather than degraded. A provisioning input,
never the truth.
_Avoid_: config directory, events directory, data directory

**Headless**:
An install whose owner reads only the Prometheus gauges. Not a configuration — there is
no switch that turns the interface off; the page is always served, it is simply never
looked at. The API is served too, which is what keeps everything declarable and every
setting turnable by hand.
_Avoid_: headless mode, API-only mode

**Ephemeral install**:
An install whose store has nowhere to live, so it lasts exactly as long as the process.
Neither an error nor a mode one chooses: it is what an install *is* until it is given
somewhere to keep things — which makes it the honest way to try the app. The app says
so every time, because it stays true until it stops being true.
_Avoid_: demo mode, temporary mode, test mode

**Advisory**:
Something the app has to tell the owner: a predicate and a sentence. Most are
*derived* — the file that is present, the variable that is ignored, the key that is
missing — and are recomputed rather than recorded; only what cannot be recomputed is
written down, and only the acknowledgement is stored. An advisory is not a trace of
what happened: provenance is what records that.
_Avoid_: audit log, journal, notification, toast

**Provenance**:
Where a declared row came from — which file, imported when, with what fingerprint.
Displayable ("row 14 of `2024.csv`"), never an address to write back to.

**First run**:
Not a moment in the boot sequence but a state: the base currency is absent, which is to
say nobody has ever answered here. It is the app's only question, and the only setting
without a default. It ends when the question is answered — by a person, or by an import
that declares its currency — and a restored backup never re-enters it.
_Avoid_: onboarding (as a phase), setup, installation wizard, first boot

### On screen

**Convention note**:
The account a figure gives of the rule it rests on — an information icon beside the
figure, opening on click into a short text and a versioned link to the documentation.
It sits on the figure, never on the page: a page that states its conventions in prose is
a page explaining itself instead of showing figures. On a table it goes on the column
header, never on a cell.
_Avoid_: tooltip, hint, help text, disclaimer

**Banner**:
The one thing the app interrupts with: why what you are looking at is wrong or empty — a
missing base currency, a reconstruction still running, a scheduler that stopped. It shows
**one** at a time and never stacks; what it cannot fit is held by the installation panel
regardless. Its order is causal rather than a ranking, so two of them rarely contend.
_Avoid_: alert bar, notification bar, status strip

**Receipt**:
What a gesture produced, said back to whoever made it — and it lasts as long as the
operation does, not three seconds. It acknowledges an act; it is never the record of one.
An import started by the watcher has no gesture and therefore no receipt: its record is
its provenance.
_Avoid_: toast, notification, snackbar, flash message

**Absence**:
A figure that has no value, in one of four kinds that are never rendered alike. Under
one rule: **an em dash means there is nothing to compute; anything missing is named**.
_Nothing to compute_ — the latent gain of a position with no quantity. _Waiting_ — a
price exists but its conversion does not yet. _Never fetched_ — every attempt on a
symbol came back with nothing, which is repairable and says so. And _carried at cost_,
which is not an absence at all: the price is an em dash while the value is real.
A quote whose **unit** was never recorded is _carried at cost_ and never _waiting_ (#773):
a number with no unit is not a price, and no rate is coming for a pair nobody can name.
A zero is none of these. It is a figure, and never wears absence's grey.
_Avoid_: empty, missing, N/A, null (as an on-screen state)
