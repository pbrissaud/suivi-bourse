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
**How it arrived is not part of it**: an event typed in the app and an event read from
an uploaded file are one row of one kind, and nothing distinguishes them afterwards.
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
_Avoid_: reporting currency (as an on-screen label), account currency, home currency —
*reporting currency* is the source's own name for the same thing, in twenty modules under
`src/application/`, and nothing here asks for that to be renamed.

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
once per symbol, learning the unit a line the live scrape has never *written* is quoted
in: a line it never polls at all, or one it met with its market shut). The two are
triggers of their own: a symbol quoted in the reporting currency has nothing to convert
and its unit is learnt all the same.

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
Latent gain plus realized gain plus dividends plus the fees taken from your transfers
(ADR-0018). The four are the *breakdown* of it and never terms added to it — the sale's
proceeds are already in the cash balance. Always shown as a total dominating its terms,
because figures aligned without their total is what invites adding them to something
else. The fourth term renders only when it is non-zero, so an install whose broker
charges nothing for a transfer reads three and never learns the fourth exists.
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
Something the process has to know *before* it can open the store — where the store is,
which port to bind, how loudly to log. The only thing the environment still says. Not a
setting, and never editable from the app. Its defaults describe a container; anything
else overrides them.

**Import**:
A gesture, never a source. A file the owner hands to the app, read once, whose rows
become ordinary events the moment they land — indistinguishable from typed ones, and
individually editable and removable like them. The store keeps no memory of the file:
there is nothing to revoke, because there is nothing that stands.
_Avoid_: source, drop folder, provisioning, sync

**Ephemeral install**:
An install whose store has nowhere to live, so it lasts exactly as long as the process.
Neither an error nor a mode one chooses: it is what an install *is* until it is given
somewhere to keep things — which makes it the honest way to try the app. The app says
so every time, because it stays true until it stops being true.
_Avoid_: demo mode, temporary mode, test mode

**Health**:
Whether the app is doing its work: it serves, its store answers, its jobs ran when they
were due. It is said in **two registers that never mix** — an HTTP status code, whose
only reader is the orchestrator and whose only question is *should this container be
restarted*; and a body, whose reader is a person and which carries each job's last pass.
A silent scrape is health the colour of a warning and never a failing code: restarting
repairs nothing that yfinance broke.
_Avoid_: liveness (as the whole of it), uptime, monitoring

**Installation fact**:
Something true of *this install* that the owner should know and cannot compute — a
retired variable still set, a currency adopted from a file, a reconstruction under way.
A predicate and a sentence, recomputed rather than recorded; only the acknowledgement is
stored, because it is the one part that cannot be derived, and it is **permanent**. It
says nothing about the portfolio and nothing about whether the app is working.
_Avoid_: advisory (for this), audit log, journal, toast

**Advisory**:
What the owner's **data** says about itself — an audit on the portfolio, not on the app
and not on the install: a quarter of an account sitting in cash, a position that has
outgrown the rest. Derived on every read and stored nowhere; it is a **condition the
owner can end**, and it ends when the figure that raised it stops. It can be
acknowledged, but only **for a window** — never for good, because an acknowledgement
that outlived its condition would silence the app the second time the condition arose.
It is read twice: as a chip beside the figure it comments on, which is the reading, and
as a card in the notifications panel, which is the inventory and the only place it is
acknowledged. The two are two questions about the same instant, so they answer
differently once the window is open: the card goes — that is what the gesture was for —
and the chip stays, because the condition it reads is still standing.
_Avoid_: alert, warning, recommendation

**First run**:
Not a moment in the boot sequence but a state: a required setting is unanswered, which
is to say nobody has ever answered here. Today there is one, the base currency — the
only setting without a default — and the state is written to hold more. It carries three
passages in order: **the required settings**, **the accounts**, and **the first events**,
the last opened by either of two doors of equal weight — a file handed over, or an event
typed. It ends when they have been traversed, and the memory of that is the browser's
alone, so the state stays derived on the server and a wiped store asks again.
_Avoid_: onboarding (as a phase), setup, installation wizard, first boot

### On screen

**Convention note**:
The account a figure gives of the rule it rests on — an information icon beside the
figure, opening on click into a short text and a versioned link to the documentation.
It sits on the figure, never on the page: a page that states its conventions in prose is
a page explaining itself instead of showing figures. On a table it goes on the column
header, never on a cell.
_Avoid_: tooltip, hint, help text, disclaimer

**Reduction**:
A table shown for one subject only — the ledger reduced to the securities a notice
names, the shares page reduced to one account. It is not a *filter* in the sense the
product refuses: it **states itself, with what it names, and offers the way out**, and
whatever sums the table above it goes on summing the lines it sits above. A table
silently shorter than expected is the defect; worse where a total sits over it, since a
correct sum of the wrong perimeter reads exactly like the figure it is not.
_Avoid_: filter (as a hidden state), view, scope selector

**Facet**:
One option of one axis of a reduction, carrying **the count it would leave**. The count
is what makes it a facet rather than a chip, and it is taken with **its own axis
excluded**: the number beside *Dividend* is *what is left if I press Dividend*, so every
other axis in force applies and this one is replaced. Counted off the rows on screen
instead, every option but the pressed one reads zero and the panel answers a question
nobody asks. An option retaining nothing stays on screen and stays pressable: *no sale
ever* is a fact about the owner's ledger, and a vocabulary that moves under the hand at
every gesture is not one.
_Avoid_: filter chip (for a counted option), tag, category

**Notifications**:
The one place the app says what it has to say: a panel behind the header's bell, holding
health, installation facts and advisories together. The three keep their registers — what
each card offers differs — but the register is never a word on screen; the reader sees
**subjects** (Health, Installation, Portfolio, Accounts) and reads the rest off what the
card lets them do. The bell is the app's **only** global indicator: its icon carries the
health colour, its badge counts every open entry, and there is no second one anywhere.
_Avoid_: notification centre, inbox, alerts, activity feed

**Receipt**:
What a gesture produced, said back to whoever made it — and it lasts as long as the
operation does, not three seconds. It acknowledges an act; it is never the record of one.
An import is read back **before** it is written as well as after: what the file holds,
what of it the ledger already has, and what will be added — the same sentence twice, once
as a forecast the owner may refuse, once as a fact.
_Avoid_: toast, notification, snackbar, flash message

**Absence**:
A figure that has no value, in one of four kinds that are never rendered alike. Under
one rule: **an em dash means there is nothing to compute; anything missing is named**.
_Nothing to compute_ — the latent gain of a position with no quantity. _Waiting_ — a
price exists but its conversion does not yet. _Never fetched_ — every attempt on a
symbol came back with nothing, which is repairable and says so. And _carried at cost_,
which is not an absence at all: the price is an em dash while the value is real.
A quote whose **unit** was never recorded is _carried at cost_ and never _waiting_ (#773,
and on the page since #774): a number with no unit is not a price, and no rate is coming
for a pair nobody can name.
What separates _never fetched_ from _carried at cost_ is **terminality**, never a counter:
a symbol whose backfill is still running has no price *yet*, and carrying it renders *not
yet* as *never*. The counter says how many readings came back empty — a fact for the
sentence, never the verdict.
A sum that a non-terminal line empties is **refused and named**, never silently shortened:
a total that quietly drops a position is a wrong number, where a refused one is an honest
absence. A *series* omits instead, having to draw the day either way.
A zero is none of these. It is a figure, and never wears absence's grey.
_Avoid_: empty, missing, N/A, null (as an on-screen state)

**Landed read**:
A read whose answer has arrived. Until it has, the app says nothing about its subject:
a read in flight is **none of the four absences** — those describe a figure with no
value, this one a figure nothing is yet known about — and a block waiting on one renders
nothing at all, title included. *Empty* is a claim about the reader's own data and is
never made on a request still in flight. The distinction is by **read**, not by block: a
block's *needed* reads are waited for together, while an *optional* one absent removes a
line rather than falsifying one — and where a block's rows come from two reads, the rule
holds a **row** at a time (#777), so what one read knows is on screen whatever became of
the other. *Empty* covers a **sentence** as much as a primitive: *« Rien n'a encore été
importé »* said on a silence is the same claim as an empty state, which is why the net
reads the phrases and not only the markers.
_Avoid_: loading, pending, spinner, skeleton, empty (for a read in flight)
