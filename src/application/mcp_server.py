"""The agent's interface — six read-only tools on the one socket (ADR-0040, #749).

This module is the second reader ADR-0040 grants, and it is deliberately the
same shape as :mod:`api.api`: a thin adapter over the durable Python boundary,
:class:`store_reads.PortfolioReader` and :mod:`portfolio_view`. **It computes
nothing.** Every figure a tool returns is the figure a route already returns,
reached through the same primitive, so the two interfaces cannot drift into
disagreeing about what the portfolio is worth.

**A tool has two audiences and therefore two texts.** The ``description=`` on the
decorator is what a *model* reads before choosing to call, and ADR-0040 makes it
payload rather than documentation: it states which of the three absences a
``null`` is, that ``terminal`` separates *not priced yet* from *never priced*,
that a quantity of zero is a sold position. A docstring is what the *next
maintainer* reads, and it carries the decisions and their issue numbers, which
mean nothing to a model. Neither text is the other's summary.

**It imports no Flask and no** :mod:`api`. The blueprint reaches its runtime
through a module global written by ``create_app``; this one is handed the runtime
by :func:`build_server`, because :mod:`api` already imports :mod:`application`
and the reverse would close a cycle.

**It writes nothing.** ``entries.py`` remains the ledger's one writer (ADR-0032),
reached by a person's gesture, and read-only is what makes ADR-0040's access
model — *the socket is the authorization* — a decision rather than an oversight.

**A refusal is raised as** :class:`ToolError` **and never as a bare exception**,
and that is not decoration: the SDK reports anything else to the caller as
*"Error executing tool <name>"* with the message dropped on the floor. An agent
told that much cannot tell an unreadable store from a malformed date, and it is
precisely the distinction ADR-0040 insists on — a failure to read must not reach
a model as an empty portfolio, which means the message has to survive.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Optional

import duckdb

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from application import accounts as accounts_module
from application import instants
from application import portfolio_view
from application import quotes
from application import rhythm
from application import store as store_module

#: The window a history tool defaults to when the caller names none. The global
#: series is written **one point per calendar day** (#660), so a year of it is
#: 365 points — the same default ``/api/portfolio-totals/history`` takes, and
#: for the same reason: the short presets that suit a per-share chart are
#: degenerate on this series.
DEFAULT_HISTORY_WINDOW = timedelta(days=365)

#: How many ledger rows a tool returns when the caller names no bound.
#:
#: **This is the one place the tool surface departs from** ``/api`` (ADR-0040).
#: ADR-0031 answers ``GET /api/events`` with the ledger entire and argues it: the
#: forty rows the page reveals are a rendering budget, not a fetch. A browser's
#: constraint is the pixel; a model's is the context window, and the ledger is
#: the only resource here whose size is unbounded by what the portfolio *is* —
#: every other tool is bounded by the holdings, the accounts, or a day.
DEFAULT_EVENT_LIMIT = 100

#: The absence rule, stated in every description that can return one.
#:
#: It is repeated rather than referenced because a model reads one description at
#: a time and cannot follow a pointer to another (ADR-0026, ADR-0040).
_ABSENCE = (
    "A null is never zero and never an error: it means this app has no figure "
    "to give for that field. Say so plainly rather than substituting a number."
)

#: The currency rule (ADR-0002).
_CURRENCY = (
    "Every amount in this answer is in base_currency, which is stated once for "
    "the whole payload and never on a row. base_currency is null when nobody "
    "has answered the app's one required question yet; when it is null, report "
    "amounts without naming a currency rather than guessing one."
)

LIST_POSITIONS_DESCRIPTION = f"""\
What the owner currently holds, one row per (account, symbol).

Each row carries quantity, unit_cost (a weighted average over everything bought,
never a purchase price), market_value, and the unrealised gain.

{_CURRENCY}

Two things about a row will mislead you if you do not know them:

- quantity 0 is a SOLD position, not a mistake and not an empty row. It stays in
  the table on purpose, because what it realised still belongs to the totals.
- terminal tells you which kind of pricelessness a null price is. terminal=false
  means the app has simply not fetched a price yet and one is expected;
  terminal=true means no price will ever come for this symbol over the period it
  was held. Never report a position with a null price as being worth zero — in
  both cases the honest answer is that it is not priced, and terminal is what
  lets you say which of the two it is.

{_ABSENCE}
"""

GET_PORTFOLIO_TOTALS_DESCRIPTION = f"""\
The portfolio as a whole, on the most recent day the app has computed.

Carries the market value, the net amount contributed, the money-weighted return
(xirr, annualised), the time-weighted return (twr, an index based at 100), the
year-to-date figures, and the gain broken into its four terms — the unrealised
gain, the realised gain, the dividends received, and the transfer fees paid.
Those four terms sum to the total gain by definition: do not recombine them some
other way, and do not treat their sum as an independent check.

{_CURRENCY}

totals is null when the app has computed nothing yet, which has two causes and
one shape: the ledger is empty, or the reporting currency has never been
answered — the app computes no performance at all until it is. Neither is an
error and neither means the portfolio is worth zero.

{_ABSENCE}
"""

GET_PORTFOLIO_HISTORY_DESCRIPTION = f"""\
The portfolio's value and return, one point per calendar day, over a window.

Each point carries cash_balance, holdings_value, total_value, net_contributed
and twr_index. Defaults to the last 365 days when no window is given; pass
from_day and to_day as ISO calendar days (YYYY-MM-DD) to narrow it.

twr_index is an index, not a percentage: it is based at 100 at the start of the
series the app stored, so a difference between two of its points is a return and
a single point is not. If you want the return over the window the caller asked
about, rebase it yourself on the first point of what you received.

{_CURRENCY}

An empty points list means the app has computed nothing over that window — a
young install, or a window before the ledger starts. It does not mean the
portfolio was worth zero then.

{_ABSENCE}
"""

LIST_ACCOUNTS_DESCRIPTION = f"""\
The declared accounts, each with its newest figures — the allocation primitive.

Use this to answer how the portfolio is split, and to compare accounts. Each
account carries its own value, net contribution, returns and the four terms of
its gain.

declared=false means the owner has never declared an account, so what you are
looking at is the single account every install is given. It is a designed state
and not an empty one: the list always holds at least one row.

Comparing accounts by value tells you about size, not about performance. twr is
the figure that compares two accounts of different sizes, because an index
carries neither size nor currency.

{_CURRENCY}

{_ABSENCE}
"""

LIST_EVENTS_DESCRIPTION = f"""\
The event ledger — everything the owner declared they did, newest first.

The ledger is the only thing this app stores as a fact; positions, prices and
performance are all derived from it. Use this to answer what the owner actually
did, and when.

THIS ANSWER IS A SLICE. It returns at most `limit` events (default
{DEFAULT_EVENT_LIMIT}) out of `total`, which counts every event matching the
filters. Read `total` before you characterise the owner's history: if returned
is less than total, you are looking at the most recent part of it and you must
say so rather than describing it as the whole. Narrow with from_day / to_day
(ISO calendar days), with symbol, or raise limit deliberately.

Filtering by symbol excludes cash events (DEPOSIT and WITHDRAWAL), which carry no
symbol. An account of "default" is the account every install is given.

{_CURRENCY}

{_ABSENCE}
"""

GET_INVESTMENT_RHYTHM_DESCRIPTION = f"""\
How much the owner buys in a month, and how often — over the last 12 months.

Use this to describe the owner's investing habit, and as the input to any
projection of what they will put in next. It is measured on the BUY events over
the twelve calendar months ending today, for the portfolio as a whole and broken
down by account. There is no per-symbol figure and no month-by-month series.

NEVER QUOTE monthly_amount WITHOUT months_covered AND months_observed. The
amount is the median of the months that carried at least one purchase — months
with no purchase are not averaged in as zeros. So 500 with months_covered 6 and
months_observed 12 means "500 in each of six months out of twelve", which is
about 3000 over the year and NOT 6000. Multiplying the amount by twelve is the
wrong answer this app publishes the coverage to prevent. Give both figures in
the same sentence, every time.

months_observed is 12 unless the ledger is younger than that, in which case it
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

dispersion is the coefficient of variation of those same monthly amounts: 0
means every covered month was the same size, and around 1 or above means one
month dominates the rest. It is not a percentage of anything.

A null monthly_amount with months_covered 0 means NO PURCHASE IN THE WINDOW —
the owner may still have deposited, been granted shares or received dividends,
none of which is a purchase. A null with months_observed 0 as well means the
ledger is empty, or has nothing dated in the past. Neither is a rhythm of zero
and neither is an error.

There is deliberately no label here — no "regular", no "monthly", no
"irregular". The app publishes the numbers and does not judge them; the
judgement is yours to state and to attribute to yourself.

{_CURRENCY}

{_ABSENCE}
"""


def build_server(runtime, name: str = "suivibourse") -> MCPServer:
    """The MCP server for a runtime — the tools closed over it, and nothing else.

    Takes the runtime rather than reaching for one, which is the seam
    ``api.create_app(runtime)`` already established (ADR-0039) and the reason
    this module does not import :mod:`api`.

    The tool functions are defined here rather than at module level so that they
    close over ``runtime``: that is what makes them **callable in process** by
    the built-in chat (#750) with no HTTP hop in a loopback, which is ADR-0040's
    one-surface-consumed-twice.
    """
    mcp = MCPServer(
        name=name,
        instructions=(
            "SuiviBourse tracks one person's stock portfolio. A portfolio here "
            "is a dated ledger of what its owner did; everything else — the "
            "positions, the prices, the returns — is derived from it. These "
            "tools read that data and cannot change it.\n\n"
            "Advise on strategy and allocation. Do not recommend individual "
            "securities to buy or sell.\n\n"
            "Read each tool's description before using its figures: this app "
            "distinguishes several kinds of absence that a null would otherwise "
            "flatten, and reporting one of them as a zero is the mistake that "
            "matters here."
        ),
    )

    def _store():
        """The runtime's open store, raising when there is none.

        The raise is the contract, exactly as it is on the blueprint: an absent
        store is a **failed call**, and it must never reach a model as an empty
        portfolio. An agent handed ``[]`` reports that the owner holds nothing.
        """
        if runtime.store is None:
            raise ToolError(
                "the portfolio store is not available in this process; this is "
                "a failure to read, not an empty portfolio")
        return runtime.store

    def reading(work):
        """Run a tool body, and let a storage fault arrive **in words**.

        ``_store`` raises :class:`ToolError` for the store that is not there;
        this is the other half, and without it the half above is decorative. A
        query that fails raises ``duckdb.Error``, which is not a
        :class:`ToolError` — so the SDK reports it as *"Error executing tool
        <name>"* with the cause discarded, and a model cannot tell an unreadable
        store from a malformed date. ADR-0040 asks for exactly that distinction
        to survive, and it is this wrapper that makes it.

        The message is the exception's own text and nothing constructed: a
        DuckDB error names the table it could not read, which is the one thing
        that turns *something failed* into a bug report.

        A ``ToolError`` travels untouched — it is already the answer.
        """
        try:
            return work()
        except ToolError:
            raise
        except (store_module.StoreUnavailable, duckdb.Error) as exc:
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

    def _carried():
        """The symbols a position may be carried at cost on (ADR-0004, #845).

        Two batched queries for the whole portfolio, never one per row — the
        same call ``/api/positions`` makes, and the reason ``terminal`` can ride
        on every row of :func:`list_positions` without a read per holding.
        """
        return quotes.terminal_symbols(
            _store(), _snapshot().backfill_windows(),
            datetime.now(timezone.utc))

    @mcp.tool(description=LIST_POSITIONS_DESCRIPTION)
    def list_positions() -> Dict[str, Any]:
        """``/api/positions``' payload, field for field.

        Reached through the same primitive and the same builder, so the page and
        the agent cannot disagree about a holding. ``terminal`` rides on the row
        for the reason #845 put it there: without it a reader cannot tell *no
        price yet* from *no price ever*, and the substitute it reached for was a
        diagnostic counter.
        """
        def _body():
            """The read itself, so :func:`reading` can wrap a fault around it."""
            currency = _base_currency()
            return {
                'base_currency': currency,
                'positions': portfolio_view.build_positions(
                    _reader().positions(), currency, _carried()),
            }
        return reading(_body)

    @mcp.tool(description=GET_PORTFOLIO_TOTALS_DESCRIPTION)
    def get_portfolio_totals() -> Dict[str, Any]:
        """The newest day of the global perf series, plus its three derivations.

        The three extra reads are asked only once there is a row to hang them
        on: on an install whose perf cache is empty they would each answer
        nothing, and asking is how a resource acquires queries it does not need.
        """
        def _body():
            """The read itself, so :func:`reading` can wrap a fault around it."""
            reader = _reader()
            latest = reader.latest_totals()

            totals = None
            if latest is not None:
                day = latest['day']
                totals = portfolio_view.build_portfolio_totals(
                    latest,
                    reader.totals_on_or_before(portfolio_view.ytd_base_day(day)),
                    reader.twr_origin(),
                    reader.transfer_fees(day))

            return {'base_currency': _base_currency(), 'totals': totals}
        return reading(_body)

    @mcp.tool(description=GET_PORTFOLIO_HISTORY_DESCRIPTION)
    def get_portfolio_history(from_day: Optional[str] = None,
                              to_day: Optional[str] = None) -> Dict[str, Any]:
        """The global perf series over a window — five members, as #721 defines them.

        The five are the account resource's field for field, so one shape reads
        both and a rebasing is written once (ADR-0019).
        """
        start, stop = _window(from_day, to_day, DEFAULT_HISTORY_WINDOW)

        def _body():
            """The read itself; the window was parsed before it, so a bad day is
            refused as a bad day and not as a storage fault."""
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
        return reading(_body)

    @mcp.tool(description=LIST_ACCOUNTS_DESCRIPTION)
    def list_accounts() -> Dict[str, Any]:
        """The declared accounts with their newest figures — ``/api/accounts``.

        ``transfer_fees`` is bounded per account by the day its own row
        describes (#765): the days differ the moment one account's series is
        capped in the past, and ADR-0018's identity only holds between terms
        measured at the same instant.
        """
        def _body():
            """The read itself, so :func:`reading` can wrap a fault around it."""
            accounts = _snapshot().accounts
            declaration = (
                accounts.accounts if accounts is not None
                else [row for row in accounts_module.read_accounts(_store())
                      if row.id == accounts_module.DEFAULT_ACCOUNT])
            declaration = [accounts_module.as_declared(row)
                           for row in declaration]

            reader = _reader()
            rows = reader.latest_account_metrics()
            through = {
                row['account']: row['day'] for row in rows
                if row.get('account') is not None and row.get('day') is not None
            }
            return {
                'base_currency': _base_currency(),
                'declared': accounts is not None,
                'accounts': [
                    summary.to_dict()
                    for summary in portfolio_view.build_accounts(
                        declaration, rows,
                        reader.transfer_fees_by_account(through))
                ],
            }
        return reading(_body)

    @mcp.tool(description=LIST_EVENTS_DESCRIPTION)
    def list_events(symbol: Optional[str] = None,
                    from_day: Optional[str] = None,
                    to_day: Optional[str] = None,
                    limit: int = DEFAULT_EVENT_LIMIT) -> Dict[str, Any]:
        """The ledger, **bounded**, from the published snapshot (ADR-0031, ADR-0040).

        **The rows come from the snapshot and not from the store**, which is
        ``/api/events``' contract and is inherited whole: they are the ones the
        aggregator actually ran on, so the ledger an agent sees is the ledger
        every other figure was computed from.

        **The head is not**, and the docstring used to claim otherwise. The
        reporting currency is a setting, the snapshot does not carry one, and
        every amount below — a unit price, a fee, an amount — is meaningless
        without it: this tool therefore reads the store for exactly one value
        and fails like any other when it cannot. What `/api/events` gains from
        opening nothing is the shares page's chart markers surviving a storage
        fault; there is no equivalent stake here, where a broken store has
        already taken the other four tools with it. The resilience was copied
        along with the rule, and it never transferred.

        **The bound is this surface's one departure from** ``/api`` and the
        reason is written on :data:`DEFAULT_EVENT_LIMIT`. ``total`` travels with
        the slice because a bounded answer without one is worse than an
        unbounded answer: it produces a reader that states *"you have made a
        hundred operations"* in perfect confidence.

        Newest first, which the resource is not: a page reads a ledger forwards,
        and a bound that keeps the *oldest* hundred events of a ten-year history
        answers a question nobody asked.
        """
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
        # ``date.min`` for an undated row rather than a tuple key: two of them
        # would put ``None < None`` on the comparison path and raise, which is a
        # crash a ledger produces and no test would think to write.
        newest = sorted(events,
                        key=lambda event: event.date or date.min,
                        reverse=True)[:limit]

        return {
            'base_currency': reading(_base_currency),
            'total': total,
            'returned': len(newest),
            'events': [_event_to_dict(event) for event in newest],
        }

    @mcp.tool(description=GET_INVESTMENT_RHYTHM_DESCRIPTION)
    def get_investment_rhythm() -> Dict[str, Any]:
        """``/api/investment-rhythm``' payload, field for field (#751, ADR-0041).

        The **route exists** and this reaches the same primitive over the same
        rows, which is what keeps this module's opening promise literal: a tool
        computing a figure no route publishes would have been the second
        departure from ``/api`` after ADR-0031's paging, and would have needed
        arguing as one.

        The rows come from the snapshot, as ``list_events`` takes them and for
        the same reason — they are the ones the aggregator ran on. The store is
        read for the reporting currency alone, and it fails like any other tool
        when it cannot: an amount labelled with nothing is the figure this tool
        exists to keep from being misread.
        """
        return {
            'base_currency': reading(_base_currency),
            **rhythm.measure(_snapshot().events,
                             datetime.now(timezone.utc)).to_dict(),
        }

    return mcp


def _event_to_dict(event) -> Dict[str, Any]:
    """One event, as ``/api/events`` puts it on the wire.

    ``id`` is a string for the reason #764 records — a JSON number above 2^53 is
    not the integer that was sent — and the four numbers go out through
    :func:`store.finite`, because JSON has neither NaN nor infinity and a single
    such value would make the whole answer unparseable.

    There is no provenance here and none in the store (ADR-0032): a file is a
    payload, so the row it wrote is a row.
    """
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
    """One ISO calendar day on the way in, and only that spelling (#764).

    ``date.fromisoformat`` accepts several others since 3.11 — a bare
    ``20260210``, a whole instant — and the store's rule is that a day is a day
    and never a midnight: a bound that arrived as an instant is what silently
    drops the first day of every window.
    """
    # ``is None`` and not falsiness: the contract takes an absent argument or a
    # calendar day, and ``''`` is neither. Read as an omission it silently
    # widens the window a caller meant to narrow — the one wrong answer that
    # looks like a right one.
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
    # ``>`` and not ``>=``: two equal days are a **one-day window**, not an empty
    # one. The store bounds a series inclusively at both ends
    # (:func:`store_reads._window`), so ``from_day == to_day`` asks for exactly
    # that day's point — and a tool that promises one point per calendar day
    # cannot refuse to be asked for one of them (issue #877 review).
    if start > stop:
        raise ToolError("from_day must not be later than to_day")
    return start, stop


__all__ = ['build_server', 'DEFAULT_EVENT_LIMIT', 'DEFAULT_HISTORY_WINDOW']
