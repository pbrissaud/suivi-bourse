"""The agent's interface — six read-only tools on the one socket (#749)."""
from datetime import date, datetime, timedelta, timezone
from functools import cache
from typing import Any, Dict, List, NotRequired, Optional, TypedDict

import duckdb
from pydantic import TypeAdapter, ValidationError

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from application import account_facts
from application import instants
from application import portfolio_facts
from application import rhythm
from application import store as store_module

DEFAULT_HISTORY_WINDOW = timedelta(days=365)

DEFAULT_EVENT_LIMIT = 100

_ABSENCE = (
    "A null is never zero and never an error: it means this app has no figure "
    "to give for that field. Say so plainly rather than substituting a number."
)

_CURRENCY = (
    "Every amount in this answer is in `base_currency`, which is stated once "
    "for the whole payload. `base_currency` is null when nobody has answered "
    "the app's one required question yet; when it is null, report amounts "
    "without naming a currency rather than guessing one."
)

# **A backtick means served** (#958). Every member a description cites as
# present is in backticks, and `tests/test_mcp_server.py` resolves each one
# against the tool's published schema: its own path (`price.currency`), an
# argument (`limit`), a tool, or another tool's member (`list_positions.realised`).
# A member that is *not* served is written without them — THERE IS NO
# market_value MEMBER — and a served member written without them fails too, so
# a negation cannot quietly become a lie. Every member the schema publishes has
# to be cited at least once, by a name that picks it out alone.

LIST_POSITIONS_DESCRIPTION = f"""\
What the owner currently holds, one row per (account, symbol).

`positions` holds the rows. Each carries `account`, `symbol` and `name`;
`quantity`, `cost_basis`, `realised` and `dividends`; `price` and `converted`;
`terminal`; `closed_at` (the day a quantity-0 row was sold); and
`fundamentals`.

READ `cost_basis` AS A TOTAL. It is what the whole holding cost, summed over
every purchase — NOT a unit price and not a purchase price. The weighted average
paid per unit is `cost_basis` / `quantity`, and you must do that division
yourself.

THERE IS NO market_value MEMBER AND NO UNREALISED-GAIN MEMBER. Both are yours to
compute: the holding is worth `quantity` x `converted.value`, and its unrealised
gain is that figure minus `cost_basis`. Say you computed them; do not attribute
them to this app.

{_CURRENCY}

THIS TOOL IS THE ONE THAT HAS EXCEPTIONS TO THAT PARAGRAPH, and there are two.
`price` and `converted` are the same price twice: `price.value` is in the
instrument's OWN currency, which `price.currency` names on the row, observed at
`price.at`; and `converted.value` is that same price in `base_currency`, which
`converted.currency` repeats on the row, at `converted.rate` as of
`converted.rate_at`. Use `converted` for anything you add up or compare; use
`price` only to quote the instrument on its own exchange, and name
`price.currency` when you do. And `fundamentals` — what the instrument is rather
than what the holding is worth — is quoted in `fundamentals.currency`, its own:
`fundamentals.market_cap` especially is NOT in `base_currency` and must never be
added to one. Beside it, `fundamentals` names the listing
(`fundamentals.exchange`, `fundamentals.quote_type`), two ratios
(`fundamentals.dividend_yield`, `fundamentals.pe_ratio`) and the classification
(`fundamentals.sector`, `fundamentals.industry`, `fundamentals.country`). A fund
publishes no sector: that is a null, never a bucket to sum.

Two things about a row will mislead you if you do not know them:
- `quantity` 0 is a SOLD position, not a mistake and not an empty row. It stays
  in the table on purpose, because what it realised still belongs to the
  totals.
- `terminal` tells you which kind of pricelessness a null price is. `terminal`
  false means the app has simply not fetched a price yet and one is expected;
  `terminal` true means no price will ever come for this symbol over the period
  it was held. Never report a position with a null price as being worth zero —
  in both cases the honest answer is that it is not priced, and `terminal` is
  what lets you say which of the two it is.

A SYMBOL ABSENT FROM THIS TABLE WAS NEVER IN IT. The ledger holds listed
instruments only, so a holding with no ticker — private equity, an SPV,
property — could not be entered and does not appear here. A sold position stays
as a row with `quantity` 0, which is the only shape a disposal takes: nothing
leaves this table. So a position you expected and cannot find was never
declared, and reading it as a sale is the mistake this paragraph exists to
prevent.

{_ABSENCE}
"""

GET_PORTFOLIO_TOTALS_DESCRIPTION = f"""\
The portfolio as a whole, on the most recent day the app has computed.

`totals` carries `day`, `total_value`, `holdings_value`, `cash_balance`,
`net_contributed`, the money-weighted return (`xirr`, annualised), the
time-weighted return (`twr_index`, based at 100, with its `twr_since`),
`gain_absolu`, `transfer_fees`, and `ytd`.

`ytd` IS A PAIR AND ITS `ytd.twr` IS NOT AN INDEX. `ytd.gain` is an amount;
`ytd.twr` is a RETURN FRACTION — 0.019 means 1.9% — and not a figure based at
100 like `twr_index` three paragraphs down. Do not read the two as the same
unit. `ytd` is null when the series does not reach back to the end of the
previous year.

THE GAIN ARRIVES WHOLE, NOT BROKEN DOWN. `gain_absolu` is the total, and the only
term served beside it is `transfer_fees`. The unrealised gain, the realised gain
and the dividends are NOT members here: they sum into `gain_absolu` and this
tool does not take them apart. If you need the breakdown,
`list_positions.realised` and `list_positions.dividends` carry them per holding
— say that you summed them yourself, and never present a difference between
your sum and `gain_absolu` as a discrepancy in the app.

`twr_index` is based at 100 on `twr_since`, the day this series starts. It is
NOT the same day as an account's own anchor, `list_accounts.twr_since`, and
THERE IS NO RULE ABOUT WHICH COMES FIRST — it depends on which accounts the app
last recomputed together, so do not derive one from the other. Read both. Where
they differ, the two figures measure different periods and cannot be ranked: a
global index below every account's is arithmetically ordinary, not a sign that
the accounts outperformed the portfolio holding them. Say which period each
figure covers. Where the two anchors are the same day, they are comparable and
you may say so.

{_CURRENCY}

`totals` is null when the app has computed nothing yet, which has two causes and
one shape: the ledger is empty, or the reporting currency has never been
answered — the app computes no performance at all until it is. Neither is an
error and neither means the portfolio is worth zero.

{_ABSENCE}
"""

GET_PORTFOLIO_HISTORY_DESCRIPTION = f"""\
The portfolio's value and return, one point per calendar day, over a window.

`points` holds them. Each carries `day` (an ISO calendar day), `cash_balance`,
`holdings_value`, `total_value`, `net_contributed` and `twr_index`. Defaults to
the last 365 days when no window is given; pass `from_day` and `to_day` as ISO
calendar days (YYYY-MM-DD) to narrow it. `from` and `to` state the window this
answer covers, as instants.

`twr_index` is an index, not a percentage: it is based at 100 at the start of
the series the app stored, so a difference between two of its points is a return
and a single point is not. If you want the return over the window the caller
asked about, rebase it yourself on the first point of what you received.

{_CURRENCY}

An empty `points` list means the app has computed nothing over that window — a
young install, or a window before the ledger starts. It does not mean the
portfolio was worth zero then.

{_ABSENCE}
"""

LIST_ACCOUNTS_DESCRIPTION = f"""\
The declared accounts, each with its newest figures — the allocation primitive.

Use this to answer how the portfolio is split, and to compare accounts.
`accounts` holds one row per account: `id` and `label` name it, `as_of` is the
day its figures are from, and it carries its own `total_value`,
`holdings_value`, `cash_balance`, `net_contributed`, returns (`xirr`,
`twr_index`), `gain_absolu` and `transfer_fees`. As on the portfolio totals,
`gain_absolu` is the WHOLE gain and is not broken down here: there is no
unrealised, realised or dividend member on these rows.

`declared` false means the owner has never declared an account, so what you are
looking at is the single account every install is given. It is a designed state
and not an empty one: the list always holds at least one row.

Comparing accounts by value tells you about size, not about performance. But
`twr_index` IS NOT COMPARABLE ACROSS ROWS AS IT STANDS: it is an index based at
100 on the first day of its own series, and these series do not start on the
same day. An account opened in 2019 has been indexing for six years; one opened
last month has been indexing for one, and the portfolio-wide index served by
`get_portfolio_totals` starts on a day of its own that follows neither rule — so
a global index sitting below every account's is arithmetically ordinary and not
a bug. Each row carries `twr_since`, the calendar day its index is based at, and
`get_portfolio_totals.twr_since` is the same member for the portfolio-wide
index. READ `twr_since` BEFORE YOU PUT TWO OF THESE FIGURES IN ONE SENTENCE.
Where two of them differ, the figures measure different periods and you cannot
rank them: say which period each one covers, and do not call the lower one the
worse performer. `twr_since` is absent on an account the app has computed no
series for.

A row carries three families of member, and they are absent independently of
one another. Do not read one family's absence as another's.

- `opened_on` and `first_payment` ride on their own facts and NOT on any
  taxation model: `opened_on` where the owner declared an opening day,
  `first_payment` where the ledger holds a payment into the account. An account
  with no model can carry both; an account with a model can carry neither.
- `taxation_model` is the owner's declaration of which model the account
  carries, served as written wherever there is one. It is an internal
  identifier, not a name: no tool here resolves it, so do not read it aloud —
  say *which account* needs its model looked at, in the app.
- `taxation_kind` and the four projected members — `projected_tax`,
  `projected_base`, `projected_rates` and `projected_rate_changes_on` — are the
  projection, and they are served only where that declared model still passes
  this version's own check on it. A model an older version accepted and this
  one refuses publishes NOTHING beyond its name. So `taxation_model` present
  with `taxation_kind` absent means the declaration needs repairing in the app
  — not that the tax is zero, and not that the read failed.

AND `taxation_kind` CAN RIDE WITHOUT A FIGURE. A model can be perfectly valid
and still project nothing — a kind that taxes no realised gain, an aged wrapper
with no date to age it from, an account one unvalued position makes
unmeasurable, and others: the list is not closed, and you are told only that
there is no figure. That is an honest absence, not a broken declaration and not
a zero.

`projected_tax` IS A PROJECTION AND NOT A TAX. It is what the account would owe
if it were emptied today under a model THE OWNER DECLARED THEMSELVES — they
entered the kind and the rates, and this app applied their arithmetic rather
than reading any tax code. It expresses no allowance, no loss carry-forward, no
household situation and no year of any actual return. Say it is a projection
under a model the owner declared, every time you quote it, and never use it to
advise what is owed, what is due, or when to sell.

`projected_base` is the LATENT gain — not `gain_absolu`, which also holds the
realised gain, the dividends and the fees. Applying `projected_rates` to
`gain_absolu` gives a number this app did not publish and does not agree with.

DO NOT RECOMPUTE `projected_tax` FROM THE OTHER TWO. The arithmetic behind it is
not rate times base, and multiplying them yourself gives a wrong answer in two
ordinary cases. A LOSING ACCOUNT carries a negative `projected_base` and a
`projected_tax` of 0: nothing is owed on a loss, and the rate was applied to
zero rather than to the negative figure you can see. A BRACKETED model carries
one fraction per rung and NOT the gain bounds that place a gain among them, so
its figure cannot be reconstructed from what is served at all. Quote
`projected_tax` as the app computed it; use `projected_rates` to say which rate
or rates are in force, never to derive the figure.

`projected_rate_changes_on` is the day the rate would next change for this
wrapper, absent when nothing is coming. It is a UTC calendar day, and so is the
day the whole projection was decided against: the change lands at UTC midnight,
not at midnight where the reader is. Say the day with that boundary attached
rather than as *today* or *tomorrow*, which are the reader's words and are off
by their offset on the one day this member matters.

{_CURRENCY}

{_ABSENCE}
"""

LIST_EVENTS_DESCRIPTION = f"""\
The event ledger — everything the owner declared they did, newest first.

The ledger is the only thing this app stores as a fact; positions, prices and
performance are all derived from it. Use this to answer what the owner actually
did, and when.

`events` holds the rows. Each carries its `id`, its `date`, its `event_type`
(BUY, SELL, GRANT, DIVIDEND, DEPOSIT or WITHDRAWAL), the `symbol` and `name` it
concerns, `quantity`, `unit_price`, `fee` and `amount`, the owner's `notes`, and
the `account` it belongs to. A member an event does not have is null.

THIS ANSWER IS A SLICE. It returns at most `limit` events (default
{DEFAULT_EVENT_LIMIT}) out of `total`, which counts every event matching the
filters. Read `total` before you characterise the owner's history: if
`returned` is less than `total`, you are looking at the most recent part of it
and you must say so rather than describing it as the whole. Narrow with
`from_day` / `to_day` (ISO calendar days), with `symbol`, or raise `limit`
deliberately.

Filtering by `symbol` excludes cash events (DEPOSIT and WITHDRAWAL), which carry
no symbol. An `account` of "default" is the account every install is given.

{_CURRENCY}

{_ABSENCE}
"""

GET_INVESTMENT_RHYTHM_DESCRIPTION = f"""\
How much the owner buys in a month, and how often — over the last 12 months.

Use this to describe the owner's investing habit, and as the input to any
projection of what they will put in next. It is measured on the BUY events over
the twelve calendar months ending today, for the portfolio as a whole and broken
down by account. There is no per-symbol figure. `months` is the observed months
themselves, oldest first, each a `months.month` (YYYY-MM) with its
`months.amount` — null on a month with no purchase — and the figures below are
reductions of that series.

`accounts` is the same measure per account: each row names its
`accounts.account` and carries `accounts.monthly_amount`,
`accounts.months_covered`, `accounts.months_observed`, `accounts.dispersion`
and `accounts.months`, each `accounts.months.month` with its
`accounts.months.amount`. Read them exactly as the portfolio's below.

NEVER QUOTE `monthly_amount` WITHOUT `months_covered` AND `months_observed`. The
amount is the median of the months that carried at least one purchase — months
with no purchase are not averaged in as zeros. So 500 with `months_covered` 6
and `months_observed` 12 means "500 in each of six months out of twelve", which
is about 3000 over the year and NOT 6000. Multiplying the amount by twelve is
the wrong answer this app publishes the coverage to prevent. Give both figures
in the same sentence, every time.

`months_observed` is 12 unless the ledger is younger than that, in which case it
is the ledger's age in months, counted from its first event of any kind — so a
portfolio opened four months ago reports 4. Months with no purchase are counted
as observed and uncovered, which is how a stop in investing is visible: 12
observed and 3 covered means nine months without a purchase, not nine months
nobody looked at.

SELLS ARE NOT SUBTRACTED, and that inflates the figure. Selling one holding to
buy another counts as rhythm here, because nothing on a purchase says where its
money came from — so a month of rebalancing reports more than the owner actually
put in, and this measure is not proof that money entered the portfolio. Say so
when the figure is doing work in your answer; never call it a contribution, a
deposit, or dollar-cost averaging.

`dispersion` is the coefficient of variation of those same monthly amounts: 0
means every covered month was the same size, and around 1 or above means one
month dominates the rest. It is not a percentage of anything.

A null `monthly_amount` with `months_covered` 0 means NO PURCHASE IN THE WINDOW
— the owner may still have deposited, been granted shares or received
dividends, none of which is a purchase. A null with `months_observed` 0 as well
means the ledger is empty, or has nothing dated in the past. Neither is a rhythm
of zero and neither is an error.

There is deliberately no label here — no "regular", no "monthly", no
"irregular". The app publishes the numbers and does not judge them; the
judgement is yours to state and to attribute to yourself.

{_CURRENCY}

{_ABSENCE}
"""


# --------------------------------------------------------------------- #
# What each tool serves — the schema a client is given (#958)
# --------------------------------------------------------------------- #
#
# **The annotation is the published `outputSchema`**, and the SDK holds every
# answer to it: a key declared nowhere here is dropped from the structured
# content without a word, and a value of the wrong kind is refused. So a member
# that can be missing is `Optional` (a NaN is served as `null` rather than
# breaking the client), and a member the builder *omits* rather than nulls is
# `NotRequired` — the absence rule of #845, stated in the schema. The builders
# live in `portfolio_view`, `account_facts` and `rhythm`; the types live here,
# with the one reader they have, and the suite holds the two together.

class Price(TypedDict):
    value: Optional[float]
    currency: Optional[str]
    at: Optional[str]


class Converted(TypedDict):
    value: Optional[float]
    currency: Optional[str]
    rate: Optional[float]
    rate_at: Optional[str]


class Fundamentals(TypedDict):
    currency: Optional[str]
    exchange: Optional[str]
    quote_type: Optional[str]
    dividend_yield: Optional[float]
    pe_ratio: Optional[float]
    market_cap: Optional[float]
    sector: Optional[str]
    industry: Optional[str]
    country: Optional[str]


class Position(TypedDict):
    account: Optional[str]
    symbol: Optional[str]
    name: Optional[str]
    quantity: Optional[float]
    cost_basis: Optional[float]
    realised: Optional[float]
    dividends: Optional[float]
    price: Optional[Price]
    converted: Optional[Converted]
    closed_at: Optional[str]
    terminal: bool
    fundamentals: Optional[Fundamentals]


class Positions(TypedDict):
    base_currency: Optional[str]
    positions: List[Position]


class Ytd(TypedDict):
    gain: Optional[float]
    twr: Optional[float]


class Totals(TypedDict):
    day: Optional[str]
    total_value: Optional[float]
    holdings_value: Optional[float]
    cash_balance: Optional[float]
    net_contributed: Optional[float]
    xirr: Optional[float]
    twr_index: Optional[float]
    twr_since: Optional[str]
    gain_absolu: Optional[float]
    transfer_fees: Optional[float]
    ytd: Optional[Ytd]


class PortfolioTotals(TypedDict):
    base_currency: Optional[str]
    totals: Optional[Totals]


class Point(TypedDict):
    day: Optional[str]
    cash_balance: Optional[float]
    holdings_value: Optional[float]
    total_value: Optional[float]
    net_contributed: Optional[float]
    twr_index: Optional[float]


# The functional form, because `from` is a keyword.
History = TypedDict('History', {
    'base_currency': Optional[str],
    'from': str,
    'to': str,
    'points': List[Point],
})


class Account(TypedDict):
    id: str
    label: Optional[str]
    as_of: Optional[str]
    cash_balance: Optional[float]
    holdings_value: Optional[float]
    total_value: Optional[float]
    net_contributed: Optional[float]
    gain_absolu: Optional[float]
    xirr: Optional[float]
    twr_index: Optional[float]
    transfer_fees: Optional[float]
    # `account_facts.declared_only` drops each of these where there is none.
    taxation_model: NotRequired[str]
    opened_on: NotRequired[str]
    first_payment: NotRequired[str]
    twr_since: NotRequired[str]
    taxation_kind: NotRequired[str]
    projected_tax: NotRequired[Optional[float]]
    projected_base: NotRequired[Optional[float]]
    projected_rates: NotRequired[List[float]]
    projected_rate_changes_on: NotRequired[str]


class Accounts(TypedDict):
    base_currency: Optional[str]
    declared: bool
    accounts: List[Account]


class LedgerEvent(TypedDict):
    id: Optional[str]
    date: Optional[str]
    event_type: Optional[str]
    symbol: Optional[str]
    name: Optional[str]
    quantity: Optional[float]
    unit_price: Optional[float]
    fee: Optional[float]
    amount: Optional[float]
    notes: Optional[str]
    account: Optional[str]


class Ledger(TypedDict):
    base_currency: Optional[str]
    total: int
    returned: int
    events: List[LedgerEvent]


class Month(TypedDict):
    month: str
    amount: Optional[float]


class Figures(TypedDict):
    """``rhythm.Figures.to_dict()`` — the portfolio's, and each account's."""
    monthly_amount: Optional[float]
    months_covered: int
    months_observed: int
    dispersion: Optional[float]
    months: List[Month]


class AccountRhythm(Figures):
    account: str


class Rhythm(Figures):
    base_currency: Optional[str]
    accounts: List[AccountRhythm]


#: One validator per shape, built on first use and kept.
_adapter = cache(TypeAdapter)


def build_server(runtime, name: str = "suivibourse") -> MCPServer:
    """The MCP server for a runtime — the tools closed over it, and nothing else."""
    mcp = MCPServer(
        name=name,
        instructions=(
            "SuiviBourse tracks one person's stock portfolio. A portfolio here "
            "is a dated ledger of what its owner did; everything else — the "
            "positions, the prices, the returns — is derived from it. These "
            "tools read that data and cannot change it.\n\n"
            "THIS IS NOT THE OWNER'S WHOLE WEALTH. The ledger holds listed "
            "instruments, valued from market data: anything held outside that "
            "— private equity, an SPV, property, a holding with no ticker — "
            "cannot be entered here and is therefore not in any answer these "
            "tools give. A holding you expected and cannot find was very "
            "probably never in scope, and its absence is not a sale. Say what "
            "this app covers before you characterise what the owner owns, and "
            "never present these figures as their net worth.\n\n"
            "Advise on strategy and allocation. Do not recommend individual "
            "securities to buy or sell.\n\n"
            "Read each tool's description before using its figures: this app "
            "distinguishes several kinds of absence that a null would otherwise "
            "flatten, and reporting one of them as a zero is the mistake that "
            "matters here."
        ),
    )

    def _store():
        """The runtime's read view on the store, raising when there is none.

        This server writes nothing — every tool below is a read — so it reads
        through the same connection of its own the ``/api`` blueprint uses
        (#967), rather than waiting behind a background pass.
        """
        if runtime.store is None:
            raise ToolError(
                "the portfolio store is not available in this process; this is "
                "a failure to read, not an empty portfolio")
        return runtime.store.reader()

    def reading(work, shape):
        """Run a tool body, and let a storage fault arrive **in words**.

        **The answer is held to its published shape here, before the SDK does
        it** (#958). The SDK validates after the body has returned, out of this
        function's reach, and reports a refusal as a bare *"Error executing
        tool <name>"* — the one fault that would reach the agent with no words.
        Checked here, the refusal names the member; the answer itself goes out
        untouched. The branch sits above the ``ValueError`` one on purpose:
        pydantic's error is a ``ValueError``, and would otherwise read as a
        store that could not answer.
        """
        try:
            answer = work()
            _adapter(shape).validate_python(answer)
            return answer
        except ToolError:
            raise
        except ValidationError as exc:
            raise ToolError(
                f"this answer does not match the schema the tool publishes, so "
                f"it is withheld rather than served wrong: {exc}") from exc
        except (store_module.StoreUnavailable, duckdb.Error,
                ValueError) as exc:
            raise ToolError(
                f"the portfolio store could not answer this read, so there is "
                f"no figure to give: {exc}") from exc

    def _snapshot():
        """The published configuration snapshot — the lock-free read (#658)."""
        return runtime.config_manager.current()

    def _reader():
        """A reader over the open store — built per call, holding no state."""
        from application.store_reads import PortfolioReader
        return PortfolioReader(_store())

    def _base_currency() -> Optional[str]:
        """The reporting currency, or ``None`` while the question is unanswered."""
        return _store().setting('base_currency')

    @mcp.tool(description=LIST_POSITIONS_DESCRIPTION)
    def list_positions() -> Positions:
        """``/api/positions``' payload, field for field."""
        def _body():
            """The read itself, so :func:`reading` can wrap a fault around it."""
            return portfolio_facts.positions_payload(
                _store(), _snapshot(), datetime.now(timezone.utc))
        return reading(_body, Positions)

    @mcp.tool(description=GET_PORTFOLIO_TOTALS_DESCRIPTION)
    def get_portfolio_totals() -> PortfolioTotals:
        """The newest day of the global perf series, plus its three derivations."""
        def _body():
            """The read itself, so :func:`reading` can wrap a fault around it."""
            return portfolio_facts.totals_payload(_store())
        return reading(_body, PortfolioTotals)

    @mcp.tool(description=GET_PORTFOLIO_HISTORY_DESCRIPTION)
    def get_portfolio_history(from_day: Optional[str] = None,
                              to_day: Optional[str] = None) -> History:
        """The global perf series over a window — five members, as #721 defines them."""
        start, stop = _window(from_day, to_day, DEFAULT_HISTORY_WINDOW)

        def _body():
            """The read itself; the window was parsed before it, so a bad day is refused as a bad day and not as a storage fault."""
            return {
                'base_currency': _base_currency(),
                'from': start.isoformat(),
                'to': stop.isoformat(),
                'points': [
                    {
                        'day': instants.iso(row.get('day')),
                        'cash_balance': row.get('cash_balance'),
                        'holdings_value': row.get('holdings_value'),
                        'total_value': row.get('total_value'),
                        'net_contributed': row.get('net_contributed'),
                        'twr_index': row.get('twr_index'),
                    }
                    for row in _reader().totals_series(start, stop)
                ],
            }
        return reading(_body, History)

    @mcp.tool(description=LIST_ACCOUNTS_DESCRIPTION)
    def list_accounts() -> Accounts:
        """The declared accounts with their newest figures — ``/api/accounts``."""
        def _body():
            """The read itself, so :func:`reading` can wrap a fault around it."""
            return {
                'base_currency': _base_currency(),
                **account_facts.accounts_payload(
                    _store(), _snapshot(), datetime.now(timezone.utc)),
            }
        return reading(_body, Accounts)

    @mcp.tool(description=LIST_EVENTS_DESCRIPTION)
    def list_events(symbol: Optional[str] = None,
                    from_day: Optional[str] = None,
                    to_day: Optional[str] = None,
                    limit: int = DEFAULT_EVENT_LIMIT) -> Ledger:
        """The ledger, **bounded**, from the published snapshot."""
        events = _snapshot().events

        if symbol:
            events = [event for event in events if event.symbol == symbol]
        start = _day(from_day, 'from_day')
        if start is not None:
            events = [event for event in events
                      if event.date is not None and event.date >= start]
        stop = _day(to_day, 'to_day')
        if stop is not None:
            events = [event for event in events
                      if event.date is not None and event.date <= stop]

        total = len(events)
        if limit < 0:
            raise ToolError("limit must not be negative")
        newest = sorted(events,
                        key=lambda event: event.date or date.min,
                        reverse=True)[:limit]

        return reading(lambda: {
            'base_currency': _base_currency(),
            'total': total,
            'returned': len(newest),
            'events': [_event_to_dict(event) for event in newest],
        }, Ledger)

    @mcp.tool(description=GET_INVESTMENT_RHYTHM_DESCRIPTION)
    def get_investment_rhythm() -> Rhythm:
        """``/api/investment-rhythm``' payload, field for field (#751)."""
        return reading(lambda: {
            'base_currency': _base_currency(),
            **rhythm.measure(_snapshot().events,
                             datetime.now(timezone.utc)).to_dict(),
        }, Rhythm)

    return mcp


def _event_to_dict(event) -> Dict[str, Any]:
    """One event, as ``/api/events`` puts it on the wire."""
    return {key: store_module.finite(value) for key, value in {
        'id': str(event.id) if event.id is not None else None,
        'date': event.date.isoformat() if event.date else None,
        'event_type': event.event_type.value,
        'symbol': event.symbol,
        'name': event.name,
        'quantity': event.quantity,
        'unit_price': event.unit_price,
        'fee': event.fee,
        'amount': event.amount,
        'notes': event.notes,
        'account': event.account,
    }.items()}


def _day(value: Optional[str], field: str) -> Optional[date]:
    """One ISO calendar day on the way in, and only that spelling (#764)."""
    if value is None:
        return None
    text = value.strip()
    try:
        parsed = date.fromisoformat(text)
    except ValueError:
        raise ToolError(
            f"{field} must be an ISO calendar day (YYYY-MM-DD), got {value!r}")
    if parsed.isoformat() != text:
        raise ToolError(
            f"{field} must be an ISO calendar day (YYYY-MM-DD), got {value!r}")
    return parsed


def _window(from_day: Optional[str], to_day: Optional[str],
            default: timedelta) -> tuple:
    """Resolve two optional calendar days into a UTC instant window."""
    stop_day = _day(to_day, 'to_day')
    stop = (datetime.combine(stop_day, datetime.min.time(), timezone.utc)
            if stop_day is not None else datetime.now(timezone.utc))
    start_day = _day(from_day, 'from_day')
    start = (datetime.combine(start_day, datetime.min.time(), timezone.utc)
             if start_day is not None else stop - default)
    if start > stop:
        raise ToolError("from_day must not be later than to_day")
    return start, stop


__all__ = ['build_server', 'DEFAULT_EVENT_LIMIT', 'DEFAULT_HISTORY_WINDOW']
