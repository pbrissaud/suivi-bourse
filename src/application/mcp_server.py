"""The agent's interface — six read-only tools on the one socket (ADR-0040, #749)."""
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

DEFAULT_HISTORY_WINDOW = timedelta(days=365)

DEFAULT_EVENT_LIMIT = 100

_ABSENCE = (
    "A null is never zero and never an error: it means this app has no figure "
    "to give for that field. Say so plainly rather than substituting a number."
)

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
down by account. There is no per-symbol figure. months is the observed months
themselves, oldest first, each with its amount — null on a month with no
purchase — and the figures below are reductions of that series.

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
    """The MCP server for a runtime — the tools closed over it, and nothing else."""
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
        """The runtime's open store, raising when there is none."""
        if runtime.store is None:
            raise ToolError(
                "the portfolio store is not available in this process; this is "
                "a failure to read, not an empty portfolio")
        return runtime.store

    def reading(work):
        """Run a tool body, and let a storage fault arrive **in words**."""
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
        """The symbols a position may be carried at cost on (ADR-0004, #845)."""
        return quotes.terminal_symbols(
            _store(), _snapshot().backfill_windows(),
            datetime.now(timezone.utc))

    @mcp.tool(description=LIST_POSITIONS_DESCRIPTION)
    def list_positions() -> Dict[str, Any]:
        """``/api/positions``' payload, field for field."""
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
        """The newest day of the global perf series, plus its three derivations."""
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
        return reading(_body)

    @mcp.tool(description=LIST_ACCOUNTS_DESCRIPTION)
    def list_accounts() -> Dict[str, Any]:
        """The declared accounts with their newest figures — ``/api/accounts``."""
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
        """The ledger, **bounded**, from the published snapshot (ADR-0031, ADR-0040)."""
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

        return {
            'base_currency': reading(_base_currency),
            'total': total,
            'returned': len(newest),
            'events': [_event_to_dict(event) for event in newest],
        }

    @mcp.tool(description=GET_INVESTMENT_RHYTHM_DESCRIPTION)
    def get_investment_rhythm() -> Dict[str, Any]:
        """``/api/investment-rhythm``' payload, field for field (#751, ADR-0041)."""
        return {
            'base_currency': reading(_base_currency),
            **rhythm.measure(_snapshot().events,
                             datetime.now(timezone.utc)).to_dict(),
        }

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
