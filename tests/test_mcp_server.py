"""The agent's five tools (issue #749).

**The store is real**, under ``tmp_path``, as it is everywhere else in this
suite; the one faked external edge is still yfinance and nothing here needs it.
The surface is exercised through the SDK's **in-memory client**, which is what
proves a description exists at all — a tool called as a Python function would
pass with an empty one, and the description is payload.

No test binds a socket. Speaking Streamable HTTP over a real port would re-test
the SDK's transport and nothing of ours; what is ours is the routing, and that is
held in ``test_mcp_wiring.py``.
"""
import asyncio
import json
import math
import re
from datetime import date, datetime, timedelta, timezone

import pytest
from mcp import Client

from api import create_app
from application import accounts as accounts_module
from application import entries
from application import main
from application import mcp_server
from application import perf_series
from application import quotes
from application import store as store_module
from conftest import write_legacy_taxation_model
from application.events.schemas import (
    AccountMetricPoint, Event, EventType, PortfolioTotalPoint,
)


def build_runtime(tmp_path, events=None, currency='EUR', break_store=False):
    """A runtime over a real store — ``build_runtime``'s shape, in miniature.

    The events go in through :func:`entries.create_many`, which is the ledger's
    one writer and the function the upload route calls: a fixture that
    wrote rows itself would be writing through a road the product does not have.

    ``manager.reload()`` is the first publication, as the boot performs it. It
    matters here beyond ceremony: ``list_events`` answers from the **snapshot**
    and not from the store, which is ``/api/events``' contract inherited whole.
    """
    opened = store_module.open_store(tmp_path / 'store.duckdb')
    if currency is not None:
        opened.execute(
            'INSERT INTO setting (key, value) VALUES (?, ?) '
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            ['base_currency', currency])
    if events:
        entries.create_many(opened, events)
    manager = main.ConfigurationManager(config_dir=str(tmp_path),
                                        opened_store=opened)
    runtime = main.Runtime(manager, None)
    runtime.store = opened
    manager.reload()
    if break_store:
        # A genuine storage fault rather than a simulated one, exactly as the
        # web suite produces it: the query raises and nothing in between has to
        # recognise an error message.
        opened.execute('DROP TABLE position')
        opened.execute('DROP TABLE account_metrics')
        opened.execute('DROP TABLE portfolio_totals')
        opened.execute('DROP TABLE price_point')
    return runtime, opened


def call(runtime, tool, arguments=None):
    """Call one tool through the in-memory client and hand back the result."""
    async def _run():
        """One session per call: the surface holds no state between them."""
        async with Client(mcp_server.build_server(runtime)) as client:
            return await client.call_tool(tool, arguments or {})
    return asyncio.run(_run())


def listed(runtime):
    """The tools a client sees, which is the only copy that reaches a model.

    Through the client and not through the server object: a description read off
    a Python attribute would pass whatever the wire carries, and the wire is what
    a tool description is *for*.
    """
    async def _run():
        """One session, opened and closed around the listing."""
        async with Client(mcp_server.build_server(runtime)) as client:
            return await client.list_tools()
    return asyncio.run(_run()).tools


def payload(result):
    """The structured payload of a successful call — the copy a client holds
    to the tool's published schema (#958)."""
    assert result.is_error is False, _text(result)
    return result.structured_content


def _text(result):
    """The words a caller actually receives — where a refusal has to be legible."""
    return result.content[0].text if result.content else ''


LEDGER = [
    Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
          quantity=10, unit_price=150.00, fee=2.50),
    Event(date(2024, 2, 1), EventType.BUY, "MSFT", "Microsoft",
          quantity=5, unit_price=380.00, fee=2.50),
    Event(date(2024, 3, 1), EventType.DIVIDEND, "AAPL", "Apple Inc",
          amount=2.40),
    Event(date(2024, 6, 15), EventType.BUY, "AAPL", "Apple Inc",
          quantity=5, unit_price=175.00, fee=2.00),
    Event(date(2024, 9, 15), EventType.SELL, "AAPL", "Apple Inc",
          quantity=3, unit_price=190.00, fee=2.00),
]


# --------------------------------------------------------------------- #
# The surface itself
# --------------------------------------------------------------------- #

def test_the_surface_is_six_tools_and_nothing_else(tmp_path):
    """Six, named, and no seventh arriving by accident.

    Either should fail a test rather than a user's setup.

    The sixth is the investment rhythm (#751), and it arrived with a route of
    its own: this module's opening promise — *it computes nothing* — is kept at
    the word rather than gaining a second exception.
    """
    runtime, _ = build_runtime(tmp_path)

    names = sorted(tool.name for tool in listed(runtime))
    assert names == ['get_investment_rhythm', 'get_portfolio_history',
                     'get_portfolio_totals', 'list_accounts', 'list_events',
                     'list_positions']


def test_every_description_states_the_absence_rule(tmp_path):
    """A description is payload, not documentation.

    This is the test that stops a description from being trimmed to a stub the
    day somebody finds them long. What it holds is the **one** convention every
    tool here can return and that a model gets wrong by default: a ``null`` is
    not a zero. It is asserted on the text a client actually receives, which is
    the only copy that reaches a model.
    """
    runtime, _ = build_runtime(tmp_path)

    for tool in listed(runtime):
        description = tool.description or ''
        assert len(description) > 200, tool.name
        assert 'null' in description, tool.name
        assert 'never zero' in description or 'not priced' in description, tool.name


def test_the_positions_description_carries_both_terms_of_the_carrying_convention(tmp_path):
    """``terminal`` is useless to a model that is not told what it separates.
    """
    runtime, _ = build_runtime(tmp_path)

    described = {tool.name: tool.description or ''
                 for tool in listed(runtime)}['list_positions']
    assert 'terminal' in described
    assert 'not fetched a price yet' in described
    assert 'no price will ever come' in described
    assert 'worth zero' in described


def test_the_positions_description_names_the_members_the_row_actually_has(
        tmp_path):
    """**A description is what an agent reads closely**, so a member it names
    and the payload does not carry is worse than silence.

    This one promised `unit_cost`, `market_value` and an unrealised gain. None
    of the three is on the row: what is there is `cost_basis`, which is a TOTAL
    over the holding. An agent told `unit_cost` is a weighted average reads that
    total as a price per unit and is wrong by a factor of the quantity held —
    the same shape as the two figures called a gain that #951 had to separate on
    screen.

    Which members the row has is no longer asserted here: every citation is
    resolved against the published schema, and every published member must be
    cited (#958, below). What stays is the reading each one needs.
    """
    runtime, _ = build_runtime(tmp_path)

    described = ' '.join({tool.name: tool.description or ''
                          for tool in listed(runtime)
                          }['list_positions'].split())

    assert 'READ `cost_basis` AS A TOTAL' in described
    assert 'THERE IS NO market_value MEMBER' in described
    # And the currency exception, which contradicts the shared paragraph unless
    # it says so: price.value is the only amount here not in base_currency.
    assert 'EXCEPTIONS TO THAT PARAGRAPH' in described
    assert ('`fundamentals.market_cap` especially is NOT in `base_currency`'
            in described)


def test_a_row_says_what_the_instrument_is_and_where_it_is_from(tmp_path):
    """The complaint that motivated the classification, asserted on the wire.

    The first outside agent driven against this server had to know by itself
    that Air Liquide, BNP and Engie are French to answer what the portfolio
    holds in France — the payload said nothing, and a model less well read on
    the CAC cannot answer at all.

    The assertion is on **what crossed the client**, not on the store, and that
    distinction is not ceremony: a symbol attribute is kept by hand in six
    separate lists between Yahoo and this payload, and the one that publishes it
    — ``store_reads.QUOTE_COLUMNS`` — was left out once on this very branch. The
    columns were written, stored, and read back correctly; ``fundamentals``
    carried none of them and nothing raised. Only a test on the payload sees it.

    The ETF beside the equity is the other half: Yahoo publishes no ``sector``
    for a fund, and that absence reaches the agent as an absent member rather
    than as an invented bucket (#845).
    """
    runtime, opened = build_runtime(tmp_path, events=LEDGER)
    quotes.record_quote(opened, 'AAPL', datetime(2024, 9, 16, tzinfo=timezone.utc),
                        190.0, {'currency': 'USD', 'quote_type': 'EQUITY',
                                'sector': 'Technology',
                                'industry': 'Consumer Electronics',
                                'country': 'United States'}, 190.0, 1.0)
    quotes.record_quote(opened, 'MSFT', datetime(2024, 9, 16, tzinfo=timezone.utc),
                        410.0, {'currency': 'USD', 'quote_type': 'ETF'},
                        410.0, 1.0)

    served = {row['symbol']: row
              for row in payload(call(runtime, 'list_positions'))['positions']}

    fundamentals = served['AAPL']['fundamentals']
    assert fundamentals['sector'] == 'Technology'
    assert fundamentals['industry'] == 'Consumer Electronics'
    assert fundamentals['country'] == 'United States'

    # The fund: the block still stands on what was observed, and the three
    # unobserved members are null — never 'Unknown', which would be a bucket
    # an allocation could sum.
    fund = served['MSFT']['fundamentals']
    assert fund['quote_type'] == 'ETF'
    assert (fund['sector'], fund['industry'], fund['country']) == \
        (None, None, None)


def test_the_server_states_the_set_its_answers_are_drawn_from(tmp_path):
    """**What is not here**, said once for the six tools (#889).

    Every field says which absence it is, and the payload as a whole said
    nothing about the set it is drawn from. An unlisted holding — private
    equity, an SPV, anything without a ticker — cannot be in the ledger, and the
    first outside agent to use this server nearly reported a position as sold
    when it had simply never been in scope.

    The perimeter is stated in the instructions, which every tool inherits, and
    again on ``list_positions``, which is the table an agent reads when it goes
    looking for a line that is not there.
    """
    runtime, _ = build_runtime(tmp_path)

    async def _handshake():
        """Through the client, as :func:`listed` is: what a model reads is the
        copy that crossed the wire."""
        async with Client(mcp_server.build_server(runtime)) as client:
            return client.instructions or ''

    said = asyncio.run(_handshake())
    assert 'listed instruments' in said
    assert 'not a sale' in said
    assert 'net worth' in said

    # Unwrapped before it is read: these are sentences, and a paragraph
    # reflowed to 79 columns puts a line break wherever it lands. An assertion
    # that a rewrap breaks is an assertion about the margin, not about the words.
    described = ' '.join({tool.name: tool.description or ''
                          for tool in listed(runtime)}['list_positions'].split())
    assert 'A SYMBOL ABSENT FROM THIS TABLE WAS NEVER IN IT' in described
    assert 'was never declared, and reading it as a sale' in described


def test_the_accounts_description_frames_the_tax_and_the_index(tmp_path):
    """Two figures a model will misread unless the words stop it.

    ``projected_tax`` is a number called *tax*, and a model reading one will
    present it as one (#920): the description has to say it is a projection
    under a model the owner declared, and name what it does not express.
    ``twr_index`` is an index whose base day differs per row (#887), so the
    description has to send the reader to ``twr_since`` rather than invite the
    comparison — which is what it used to do.
    """
    runtime, _ = build_runtime(tmp_path)

    described = ' '.join({tool.name: tool.description or ''
                          for tool in listed(runtime)}['list_accounts'].split())

    assert 'projection' in described
    assert 'OWNER DECLARED THEMSELVES' in described
    assert 'no allowance' in described and 'loss carry-forward' in described
    assert 'when to sell' in described
    assert 'projected_base' in described
    # The three families are absent independently, and the description has to
    # say so: opened_on and first_payment do not consult the model at all, and
    # a valid model can still project nothing.
    assert 'absent independently' in described
    assert 'NOT on any taxation model' in described
    assert '`taxation_kind` CAN RIDE WITHOUT A FIGURE' in described
    # And the figure is not rate times base: a loss floors the tax at 0 while
    # the base stays negative, and a ladder does not serve its bounds.
    assert 'DO NOT RECOMPUTE `projected_tax`' in described
    assert 'negative `projected_base` and a' in described

    assert 'twr_since' in described
    # The sentence that sold the comparison the payload cannot support.
    assert 'the figure that compares two accounts of different sizes' not in described


def test_the_totals_description_names_the_day_its_own_index_counts_from(tmp_path):
    """The other half of #887, and the half nothing held.

    ``list_accounts`` now warns a model off ranking two indexes — but the
    comparison a model actually reaches for is the portfolio against one of its
    accounts, and that figure comes from **this** tool. The aggregate is based
    at the *latest* horizon among the accounts it sums, so it sits below every
    one of them as a matter of arithmetic. A description that does not say so
    leaves a model free to report the portfolio as the worst performer in it.
    """
    runtime, _ = build_runtime(tmp_path)

    # Unwrapped before it is read, as above: a rewrap to 79 columns is a
    # property of the margin and not of the sentence.
    described = ' '.join({tool.name: tool.description or ''
                          for tool in listed(runtime)
                          }['get_portfolio_totals'].split())

    assert '`twr_index` is based at 100 on `twr_since`' in described
    assert 'not a sign that the accounts outperformed' in described
    # **And no claim about which anchor comes first.** The aggregate is clipped
    # to `max([start] + bounds)`, but `bounds` covers only the accounts that
    # pass rewrote, and `_fill_twr` anchors on the first day of value rather
    # than the first day of the list — so the order is a property of the last
    # recompute, not an invariant. A description asserting one teaches the agent
    # a rule the data breaks.
    assert 'THERE IS NO RULE ABOUT WHICH COMES' in described
    assert 'latest horizon' not in described


# --------------------------------------------------------------------- #
# The figures
# --------------------------------------------------------------------- #

def test_positions_name_the_reporting_currency_in_the_head(tmp_path):
    """One reporting currency, on the payload and never on a row."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER, currency='EUR')

    body = payload(call(runtime, 'list_positions'))

    assert body['base_currency'] == 'EUR'
    assert body['positions']
    for row in body['positions']:
        assert 'currency' not in row


def test_a_null_currency_is_how_the_unanswered_question_is_said(tmp_path):
    """No fourth kind of absence for it, and no error either."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER, currency=None)

    assert payload(call(runtime, 'list_positions'))['base_currency'] is None


def test_terminal_rides_on_every_position(tmp_path):
    """Every row, not the priceless ones — a reader cannot ask for it per row."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    rows = payload(call(runtime, 'list_positions'))['positions']

    assert rows
    for row in rows:
        assert 'terminal' in row


def test_an_empty_ledger_is_a_successful_answer_that_still_names_the_currency(tmp_path):
    """``200`` + nothing held, never an error and never a null head.
    """
    runtime, _ = build_runtime(tmp_path, events=None, currency='EUR')

    body = payload(call(runtime, 'list_positions'))

    assert body['positions'] == []
    assert body['base_currency'] == 'EUR'


def test_the_accounts_list_always_holds_at_least_one_row(tmp_path):
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    body = payload(call(runtime, 'list_accounts'))

    assert body['declared'] is False
    assert len(body['accounts']) >= 1


def test_the_agent_and_the_browser_are_served_the_same_account(tmp_path):
    """One store, two surfaces, **the same members on a row** (#920).

    The tool used to re-assemble this payload by hand and stopped where the perf
    figures stop, so every member #752, #918 and #948 hung on an account reached
    the panel and not the agent — eight of them by the time anybody counted, the
    taxation model among them, which is why an agent could say nothing about a
    wrapper it could see.

    What is held here is **not the list of eight**. It is that the two key sets
    are equal, so a ninth member added to one surface and not the other fails
    here rather than in the next ticket. The account carries a model so the
    comparison is not made between two rows that both lost the same thing.
    """
    runtime, opened = build_runtime(tmp_path, events=LEDGER)
    model = accounts_module.create_model(opened, 'Flat', 'flat_realised',
                                         {'rate': 0.3})
    accounts_module.set_taxation_model(
        opened, accounts_module.DEFAULT_ACCOUNT, model.id)

    served = create_app(runtime).test_client().get('/api/accounts').get_json()
    read = payload(call(runtime, 'list_accounts'))

    assert read['declared'] == served['declared']
    by_id = {row['id']: row for row in served['accounts']}
    assert {row['id'] for row in read['accounts']} == set(by_id)
    for row in read['accounts']:
        assert set(row) == set(by_id[row['id']]), row['id']

    carrying = by_id[accounts_module.DEFAULT_ACCOUNT]
    assert carrying['taxation_model'] == model.id
    assert carrying['taxation_kind'] == 'flat_realised'


def test_the_agent_reads_the_day_each_accounts_index_is_based_at(tmp_path):
    """``twr_since`` **on the wire**, and not merely in the description (#887).

    The shared-payload test above computes no series, so the member is absent on
    both surfaces and their key sets agree on its absence — which is agreement
    about nothing. The description tells a model to read ``twr_since`` before it
    puts two indexes in one sentence, so a model that cannot find the member has
    been given an instruction it cannot follow; this is what holds the member
    there.

    Anchored on the first day the index **exists** and not on the first row of
    the series: a day the perf job wrote with a null index is not a base of 100.
    The per-account claim itself — that two wrappers carry two anchors — is held
    on the browser's side of the same payload, where accounts can be declared.
    """
    runtime, opened = build_runtime(tmp_path, events=LEDGER)
    perf_series.write_account_metrics(opened, [
        AccountMetricPoint(account=accounts_module.DEFAULT_ACCOUNT,
                           day=date(2019, 10, 30), total_value=1000.0,
                           twr_index=None),
        AccountMetricPoint(account=accounts_module.DEFAULT_ACCOUNT,
                           day=date(2024, 1, 15), total_value=1100.0,
                           twr_index=100.0),
        AccountMetricPoint(account=accounts_module.DEFAULT_ACCOUNT,
                           day=date(2024, 9, 15), total_value=1200.0,
                           twr_index=120.0),
    ])

    rows = {row['id']: row
            for row in payload(call(runtime, 'list_accounts'))['accounts']}

    assert rows[accounts_module.DEFAULT_ACCOUNT]['twr_since'] == '2024-01-15'


def test_totals_are_null_rather_than_absent_when_nothing_is_computed(tmp_path):
    """One shape for two causes, and the head keeps its subject either way."""
    runtime, _ = build_runtime(tmp_path, events=None, currency='EUR')

    body = payload(call(runtime, 'get_portfolio_totals'))

    assert body['totals'] is None
    assert body['base_currency'] == 'EUR'


def test_the_agent_reads_the_day_the_portfolio_index_is_based_at(tmp_path):
    """``twr_since`` on the totals, **on the wire** (#887).

    `list_accounts`' description sends the agent here — it says this tool
    carries the same member for the portfolio-wide index, and that reading both
    anchors is what stands between it and ranking two figures that measure
    different periods. A description pointing at a member the payload does not
    carry is worse than no description: it is an instruction that cannot be
    followed.

    Anchored on the first day the index exists, like the per-account one: a day
    the perf job wrote with a null index is not a base of 100.
    """
    runtime, opened = build_runtime(tmp_path, events=LEDGER)
    perf_series.write_portfolio_totals(opened, [
        PortfolioTotalPoint(day=date(2019, 10, 30), cash_balance=0.0,
                            holdings_value=1000.0, total_value=1000.0,
                            net_contributed=1000.0, xirr=None,
                            gain_absolu=0.0, twr_index=None),
        PortfolioTotalPoint(day=date(2024, 1, 15), cash_balance=0.0,
                            holdings_value=1100.0, total_value=1100.0,
                            net_contributed=1000.0, xirr=0.1,
                            gain_absolu=100.0, twr_index=100.0),
        PortfolioTotalPoint(day=date(2024, 9, 15), cash_balance=0.0,
                            holdings_value=1200.0, total_value=1200.0,
                            net_contributed=1000.0, xirr=0.12,
                            gain_absolu=200.0, twr_index=120.0),
    ])

    totals = payload(call(runtime, 'get_portfolio_totals'))['totals']

    assert totals['twr_since'] == '2024-01-15'
    assert totals['twr_index'] == 120.0


def test_a_hand_edited_model_row_fails_in_words_like_any_other_fault(tmp_path):
    """The shared payload took this tool somewhere ``break_store`` cannot reach.

    ``list_accounts`` now runs `read_models`, whose `json.loads` raises
    `ValueError` on a row no writer in this app could have produced — and the
    SDK reports anything that is not a `ToolError` as *"Error executing tool
    <name>"*, with the cause discarded. Every other fault test here drops a
    table and gets a `duckdb.Error`, so that arm of :func:`reading` had nothing
    standing on it.
    """
    runtime, opened = build_runtime(tmp_path, events=LEDGER)
    # Parameters that are not JSON at all, which only a hand edit of the store
    # file can leave behind — and which no writer here could produce.
    write_legacy_taxation_model(opened, kind='flat_realised',
                                parameters='not json')

    result = call(runtime, 'list_accounts')

    assert result.is_error is True
    assert 'could not answer this read' in _text(result)
    assert 'no figure to give' in _text(result)


def test_the_history_defaults_to_a_year_and_honours_a_window(tmp_path):
    """The global series is one point per calendar day, so a month of it is thirty."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    wide = payload(call(runtime, 'get_portfolio_history'))
    narrow = payload(call(runtime, 'get_portfolio_history',
                          {'from_day': '2024-01-01', 'to_day': '2024-02-01'}))

    stop = date.fromisoformat(wide['to'][:10])
    start = date.fromisoformat(wide['from'][:10])
    assert (stop - start).days == 365
    assert narrow['from'].startswith('2024-01-01')
    assert narrow['to'].startswith('2024-02-01')


# --------------------------------------------------------------------- #
# The ledger — the one departure from /api
# --------------------------------------------------------------------- #

def test_the_ledger_is_bounded_and_says_how_much_it_left_out(tmp_path):
    """A slice without its total is worse than no bound at all.

    It produces a reader that states *"you have made two operations"* in perfect
    confidence, which is the failure this member exists against.
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    body = payload(call(runtime, 'list_events', {'limit': 2}))

    assert body['total'] == len(LEDGER)
    assert body['returned'] == 2
    assert len(body['events']) == 2


def test_the_ledger_is_bounded_by_default(tmp_path):
    """The default is a bound, not the absence of one."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    body = payload(call(runtime, 'list_events'))

    assert body['returned'] == len(LEDGER)
    assert mcp_server.DEFAULT_EVENT_LIMIT == 100


def test_the_ledger_comes_back_newest_first(tmp_path):
    """A bound that kept the oldest hundred of a ten-year history answers nothing."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    body = payload(call(runtime, 'list_events', {'limit': 2}))

    dates = [event['date'] for event in body['events']]
    assert dates == ['2024-09-15', '2024-06-15']


def test_the_ledger_narrows_by_symbol_and_the_total_narrows_with_it(tmp_path):
    """``total`` counts what matched the filters, not what the ledger holds."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    body = payload(call(runtime, 'list_events', {'symbol': 'MSFT'}))

    assert body['total'] == 1
    assert {event['symbol'] for event in body['events']} == {'MSFT'}


def test_the_ledger_narrows_by_calendar_day(tmp_path):
    """Both bounds are inclusive, and a day is a day and never a midnight."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    body = payload(call(runtime, 'list_events',
                        {'from_day': '2024-02-01', 'to_day': '2024-06-15'}))

    dates = [event['date'] for event in body['events']]
    assert dates == ['2024-06-15', '2024-03-01', '2024-02-01']


def test_the_ledgers_rows_come_from_the_snapshot_and_not_from_the_store(tmp_path):
    """``/api/events``' contract for the rows, inherited whole.

    The portfolio's tables are gone here and the ledger still answers, because
    the rows are the ones the aggregator ran on rather than a fresh query — so
    the ledger an agent sees is the ledger every other figure was computed from.

    **The head is another matter**, and this test used to be named as though it
    were not: the reporting currency is a setting, so this tool does open the
    store for that one value and fails with it when it cannot. See the test
    below.
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER, break_store=True)

    assert payload(call(runtime, 'list_events'))['total'] == len(LEDGER)


def test_the_ledger_fails_like_the_rest_when_there_is_no_store_at_all(tmp_path):
    """Because its head names a currency, and a currency is a setting.

    The honest half of the test above. `/api/events` gains something real from
    opening nothing — the shares page's chart markers survive a storage fault —
    and there is no equivalent stake here, where a broken store has already
    taken the other four tools with it.
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER)
    runtime.store = None

    result = call(runtime, 'list_events')

    assert result.is_error is True
    assert 'not available' in _text(result)


def test_a_storage_fault_arrives_in_words_and_not_as_a_bare_failure(tmp_path):
    """The other half of the ``ToolError`` rule, and the half that was missing.

    ``_store`` raised :class:`ToolError` for the store that is not there, which
    made the *absent* store speak — but a store whose **query** fails raises
    ``duckdb.Error``, and the SDK reports anything that is not a ``ToolError`` as
    *"Error executing tool <name>"* with the cause discarded. So the one case an
    owner is most likely to meet said the least, and this asserts on the words
    rather than only on the flag (issue #877 review).
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER, break_store=True)

    result = call(runtime, 'list_positions')

    assert result.is_error is True
    assert 'could not answer this read' in _text(result)
    assert 'no figure to give' in _text(result)
    # The exception's own text rides along: a DuckDB error names the table it
    # could not read, which is what turns "something failed" into a bug report.
    assert 'position' in _text(result).lower()


# --------------------------------------------------------------------- #
# Refusals — and the message surviving them
# --------------------------------------------------------------------- #

@pytest.mark.parametrize('tool', ['list_positions', 'get_portfolio_totals',
                                  'get_portfolio_history', 'list_accounts'])
def test_a_store_that_cannot_answer_is_an_error_and_never_an_empty_payload(tmp_path, tool):
    """An agent handed ``[]`` reports that the owner holds nothing. Every tool
    that opens the store therefore fails loudly when it cannot.
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER, break_store=True)

    result = call(runtime, tool)

    assert result.is_error is True
    assert result.structured_content is None


def test_an_absent_store_says_so_in_words_the_caller_receives(tmp_path):
    """:class:`ToolError` and not a bare exception, or the message is dropped.

    The SDK reports anything else as *"Error executing tool <name>"* with the
    cause discarded — and a model told that much cannot tell an unreadable store
    from a malformed date.
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER)
    runtime.store = None

    result = call(runtime, 'list_positions')

    assert result.is_error is True
    assert 'not available' in _text(result)
    assert 'not an empty portfolio' in _text(result)


@pytest.mark.parametrize('value', ['20240115', '2024-01-15T00:00:00Z',
                                   'yesterday', '2024-1-15', '', '   '])
def test_only_one_spelling_of_a_calendar_day_is_taken(tmp_path, value):
    """#764's rule, and the reason it is not ``date.fromisoformat`` alone.

    That function accepts several other spellings since 3.11 — a bare
    ``20260210``, a whole instant — and a bound that arrived as an instant is
    what silently drops the first day of every window.

    **The empty string is in this list and not in the omitted case** (issue #877
    review). The contract takes an absent argument or a calendar day; ``''`` is
    neither, and reading it as *no bound* widens a window the caller meant to
    narrow — which is the one wrong answer that looks like a right one.
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    result = call(runtime, 'list_events', {'from_day': value})

    assert result.is_error is True
    assert 'YYYY-MM-DD' in _text(result)


def test_a_window_of_one_day_is_a_window(tmp_path):
    """The narrowest question the tool exists to answer, and it was refused.

    ``from_day == to_day`` used to raise. The store bounds a series inclusively
    at both ends, so an equal pair asks for exactly that day's point — and a
    tool whose whole unit is the calendar day cannot decline to be asked for one
    of them (issue #877 review).
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    body = payload(call(runtime, 'get_portfolio_history',
                        {'from_day': '2024-06-15', 'to_day': '2024-06-15'}))

    assert body['from'].startswith('2024-06-15')
    assert body['to'].startswith('2024-06-15')


def test_an_inverted_window_is_refused_in_words(tmp_path):
    """An empty window is a mistake to report, never an empty answer to return."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    result = call(runtime, 'get_portfolio_history',
                  {'from_day': '2024-06-01', 'to_day': '2024-01-01'})

    assert result.is_error is True
    assert 'later' in _text(result)


def test_a_negative_bound_is_refused_in_words(tmp_path):
    """A negative slice would silently answer nothing, which reads as *you did nothing*."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    result = call(runtime, 'list_events', {'limit': -1})

    assert result.is_error is True
    assert 'negative' in _text(result)


# --------------------------------------------------------------------- #
# The investment rhythm (issue #751)
# --------------------------------------------------------------------- #

def rhythmic(count, unit_price, *, account=None, symbol='AAPL'):
    """One purchase a month for ``count`` months, ending in the current one.

    The tool reads the wall clock, the window being *the last twelve calendar
    months*, so the fixture is written against it rather than against fixed days
    that would answer a different question every month. The **first** of each
    month, that day never being ahead of the clock: the measure stops at
    ``now``, and a later day would leave the current month uncovered for as
    long as it had not arrived.
    """
    today = datetime.now(timezone.utc).date()
    events = []
    for offset in reversed(range(count)):
        index = today.year * 12 + (today.month - 1) - offset
        events.append(Event(date(index // 12, index % 12 + 1, 1),
                            EventType.BUY, symbol, 'A share',
                            quantity=1, unit_price=unit_price, account=account))
    return events


def test_the_rhythm_tool_answers_the_amount_with_its_coverage(tmp_path):
    """The pair, and the breakdown beside it."""
    runtime, _ = build_runtime(tmp_path, events=rhythmic(6, 500.0))

    body = payload(call(runtime, 'get_investment_rhythm'))

    assert body['monthly_amount'] == 500.0
    assert body['months_covered'] == 6
    assert body['months_observed'] == 6
    assert body['base_currency'] == 'EUR'
    assert [row['account'] for row in body['accounts']] == ['default']


def test_the_rhythm_tool_and_the_route_answer_the_same_figures(tmp_path):
    """One store, one primitive, two surfaces — and they cannot disagree.

    A figure computed a second way on either side fails here rather than in
    front of a reader.
    """
    from api import create_app

    runtime, _ = build_runtime(tmp_path, events=rhythmic(4, 250.0))

    over_http = create_app(runtime).test_client() \
        .get('/api/investment-rhythm').get_json()
    over_the_tool = payload(call(runtime, 'get_investment_rhythm'))

    assert over_http == over_the_tool


def test_a_portfolio_that_bought_nothing_reports_no_amount(tmp_path):
    """A null, a null and a coverage of zero — never a rhythm of zero."""
    runtime, _ = build_runtime(tmp_path, events=[
        Event(date(2024, 3, 1), EventType.DIVIDEND, 'AAPL', 'Apple Inc',
              amount=2.40)])

    body = payload(call(runtime, 'get_investment_rhythm'))

    assert body['monthly_amount'] is None
    assert body['dispersion'] is None
    assert body['months_covered'] == 0


def test_the_rhythm_description_carries_the_three_things_it_must(tmp_path):
    """The description is payload, and this is what it has to say.

    Three sentences a model gets wrong by default, and each of them produces a
    confident-and-wrong statement about the reader's own money: quoting the
    amount without its coverage (and so multiplying it by twelve), reading a
    ``null`` as a zero, and treating the figure as money that entered the
    portfolio when an arbitrage inflates it.
    """
    runtime, _ = build_runtime(tmp_path)

    described = {tool.name: tool.description or ''
                 for tool in listed(runtime)}['get_investment_rhythm']

    assert 'months_covered' in described and 'months_observed' in described
    assert 'NOT 6000' in described
    assert 'SELLS ARE NOT SUBTRACTED' in described
    assert 'NO PURCHASE IN THE WINDOW' in described
    assert 'dollar-cost averaging' in described


def test_a_broken_store_is_a_failed_read_and_not_an_absent_rhythm(tmp_path):
    """The currency is the one read this tool makes, and it fails in words.

    An agent handed a rhythm with a null currency would report amounts in no
    unit at all and say the app was fine.
    """
    runtime, opened = build_runtime(tmp_path, events=rhythmic(2, 500.0))
    opened.execute('DROP TABLE setting')

    result = call(runtime, 'get_investment_rhythm')

    assert result.is_error is True
    assert 'could not answer' in _text(result)


# --------------------------------------------------------------------- #
# The schema the tools publish (#958)
# --------------------------------------------------------------------- #

def served(runtime):
    """Every tool listed and called once through the client, with no
    argument: ``{name: (tool, result)}``."""
    async def _run():
        """One session for the listing and the six calls."""
        async with Client(mcp_server.build_server(runtime)) as client:
            tools = (await client.list_tools()).tools
            return {tool.name: (tool, await client.call_tool(tool.name, {}))
                    for tool in tools}
    return asyncio.run(_run())


def schema_paths(schema):
    """Every member path an ``outputSchema`` declares, ``[]`` marking the
    items of an array — through ``$defs``, ``anyOf`` and ``items``."""
    defs = schema.get('$defs', {})

    def _walk(node, prefix):
        """One node of the schema, under the path that reached it."""
        if '$ref' in node:
            node = defs[node['$ref'].rsplit('/', 1)[-1]]
        for option in node.get('anyOf', ()):
            yield from _walk(option, prefix)
        if node.get('type') == 'array':
            yield from _walk(node['items'], prefix + '[]')
        for name, child in node.get('properties', {}).items():
            path = f'{prefix}.{name}' if prefix else name
            yield path
            yield from _walk(child, path)
    return set(_walk(schema, ''))


def observed_paths(value, prefix=''):
    """The member paths a payload carries **with a value** — a null is a
    member the fixture did not exercise."""
    if isinstance(value, dict):
        for name, child in value.items():
            path = f'{prefix}.{name}' if prefix else name
            if child is not None:
                yield path
            yield from observed_paths(child, path)
    elif isinstance(value, list):
        for item in value:
            yield from observed_paths(item, prefix + '[]')


def rich_runtime(tmp_path):
    """A portfolio that makes **every** published member carry a value.

    Most of them are absent or null until data produces them — ``twr_since``,
    ``ytd``, ``closed_at``, ``market_cap``, the whole projection — and a check
    run on a thin ledger agrees with the schema about nothing. So: two
    declared accounts, a USD line on an EUR base with its fundamentals, a line
    sold to zero, twelve months of buys, a projecting model whose rate change
    is still ahead, and a perf series that crosses a year end. **Every day is
    counted from today**, because the rhythm's window and ``ytd`` both end
    today and fixed days would rot.
    """
    today = datetime.now(timezone.utc).date()
    opened = store_module.open_store(tmp_path / 'store.duckdb')
    opened.execute("INSERT INTO setting (key, value) "
                   "VALUES ('base_currency', 'EUR')")
    accounts_module.create_account(opened, 'pea', 'Mon PEA')
    accounts_module.create_account(opened, 'cto')
    entries.create_many(opened, [
        Event(today - timedelta(days=400), EventType.DEPOSIT, amount=5000.0,
              fee=1.0, account='pea'),
        Event(today - timedelta(days=300), EventType.BUY, 'MSFT', 'Microsoft',
              quantity=5, unit_price=300.0, fee=2.0,
              notes='a line sold since', account='cto'),
        Event(today - timedelta(days=100), EventType.SELL, 'MSFT',
              'Microsoft', quantity=5, unit_price=350.0, fee=2.0,
              account='cto'),
        Event(today - timedelta(days=50), EventType.DIVIDEND, 'AAPL',
              'Apple Inc', amount=2.4, account='pea'),
    ] + rhythmic(12, 150.0, account='pea', symbol='AAPL'))
    accounts_module.set_opened_on(opened, 'pea', today - timedelta(days=410))
    model = accounts_module.create_model(
        opened, 'PEA', 'aged_flat_realised',
        {'rate_before': 0.128, 'rate_after': 0.0, 'threshold_years': 5,
         'age_basis': 'first_payment', 'social_rate': 0.172})
    accounts_module.set_taxation_model(opened, 'pea', model.id)
    quotes.record_quote(
        opened, 'AAPL', datetime.now(timezone.utc) - timedelta(hours=1),
        200.0, {'currency': 'USD', 'exchange': 'NMS', 'quote_type': 'EQUITY',
                'dividend_yield': 0.005, 'pe_ratio': 30.0,
                'market_cap': 3.0e12, 'sector': 'Technology',
                'industry': 'Consumer Electronics',
                'country': 'United States'},
        184.0, 0.92)
    year_end = date(today.year - 1, 12, 31)
    perf_series.write_portfolio_totals(opened, [
        PortfolioTotalPoint(day=day, cash_balance=100.0, holdings_value=1000.0,
                            total_value=1100.0, net_contributed=1000.0,
                            xirr=0.05, gain_absolu=gain, twr_index=index)
        for day, gain, index in ((year_end, 100.0, 100.0),
                                 (today, 220.0, 108.0))])
    perf_series.write_account_metrics(opened, [
        AccountMetricPoint(account='pea', day=day, cash_balance=10.0,
                           holdings_value=1000.0, total_value=1010.0,
                           net_contributed=1000.0, xirr=0.05,
                           gain_absolu=10.0, twr_index=index)
        for day, index in ((year_end, 100.0), (today, 105.0))])
    manager = main.ConfigurationManager(config_dir=str(tmp_path),
                                        opened_store=opened)
    runtime = main.Runtime(manager, None)
    runtime.store = opened
    manager.reload()
    return runtime


def test_every_member_a_tool_publishes_is_served_with_a_value(tmp_path):
    """**Schema ⊆ observed**, per tool, on the rich portfolio.

    A member declared and never emitted fails here, and so does a fixture
    that rotted until some member stopped carrying a value — which is what
    keeps every other check in this section meaning something.
    """
    for name, (tool, result) in served(rich_runtime(tmp_path)).items():
        assert result.is_error is False, (name, _text(result))
        unseen = (schema_paths(tool.output_schema)
                  - set(observed_paths(result.structured_content)))
        assert not unseen, (name, sorted(unseen))


def test_the_structured_copy_is_the_text_copy(tmp_path):
    """**Nothing is dropped or changed between the two copies of an answer.**

    The SDK holds the structured copy to the declared schema and sends the
    text copy as the body returned it, so a member a builder gains without a
    declaration here vanishes from one and stays in the other — silently.
    Compared by value, with Python's equality: a ``5`` served as ``5.0`` is
    the same figure, and a ``"3"`` served as ``3.0`` is not.
    """
    for name, (_, result) in served(rich_runtime(tmp_path)).items():
        assert result.is_error is False, (name, _text(result))
        assert json.loads(_text(result)) == result.structured_content, name


def test_a_nan_is_served_as_a_null_and_not_as_a_crash(tmp_path, monkeypatch):
    """Under a plain ``float`` the SDK dumps a NaN as ``null`` and the
    **client** then refuses its own answer, so the call raises instead of
    answering. Under ``Optional`` it is the null the absence rule already means.

    The store is not where it comes from: the reader already turns a stored
    NaN into None (``store_reads._stamp``), and that is asserted first so this
    test keeps saying which guard it is about. What it holds is the second one
    — a NaN that a builder's own arithmetic would produce.
    """
    from application.store_reads import PortfolioReader

    runtime, opened = build_runtime(tmp_path, events=LEDGER)
    opened.execute("UPDATE position SET quantity = 'NaN'::DOUBLE "
                   "WHERE symbol = 'MSFT'")
    (row,) = PortfolioReader(opened).positions('MSFT')
    assert row['quantity'] is None

    built = mcp_server.portfolio_view.build_positions
    monkeypatch.setattr(
        mcp_server.portfolio_view, 'build_positions',
        lambda *args: [{**row, 'cost_basis': math.nan}
                       for row in built(*args)])

    rows = payload(call(runtime, 'list_positions'))['positions']

    assert rows and all(row['cost_basis'] is None for row in rows)


def test_an_answer_the_schema_refuses_arrives_in_words(tmp_path, monkeypatch):
    """The fixture foresees what it foresees; the rest must still speak.

    Left to the SDK, a value of the wrong kind comes back as a bare *"Error
    executing tool <name>"*. Held to the schema in ``reading()`` first, the
    refusal names the member, and it does not read as a broken store.
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER)
    built = mcp_server.portfolio_view.build_positions
    monkeypatch.setattr(
        mcp_server.portfolio_view, 'build_positions',
        lambda *args: [{**row, 'quantity': 'ten'} for row in built(*args)])

    result = call(runtime, 'list_positions')

    assert result.is_error is True
    assert 'does not match the schema' in _text(result)
    assert 'quantity' in _text(result)
    assert 'store could not answer' not in _text(result)


# --------------------------------------------------------------------- #
# Every citation resolves, and every member is cited (#958)
# --------------------------------------------------------------------- #
#
# A description is the only schema a model reads closely, and nothing held it
# to the schema the tool publishes: #955 corrected eight false claims, seven of
# them found by driving the tools. The convention that makes it checkable is
# the backtick — **a member in backticks is served**. The three checks below
# are functions of a text and the tools' schemas, so the #955 defects can be
# fed to them as text and watched failing, for as long as this suite runs.

#: The one shape a citation may take: a member, or a dotted path to one.
CITATION = re.compile(r'[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*')

#: A token outside backticks that *could* be a member: snake_case or dotted.
#: One-word members cannot be told from English there, and are not checked.
BARE = re.compile(r'(?<![`\w.])[a-z][a-z0-9]*(?:[_.][a-z0-9]+)+(?![`\w])')


def surface(tools):
    """``{tool: (arguments, member paths)}`` — what a description may cite."""
    return {tool.name: (set((tool.input_schema or {}).get('properties', {})),
                        schema_paths(tool.output_schema))
            for tool in tools}


def named(token, paths):
    """The paths a token names — **one resolver for every rule here**.

    Its full spelling (``accounts.monthly_amount``, ``[]`` dropped) names that
    path; otherwise a partial suffix names the one path it ends, and names
    nothing when it ends several. A bare `currency` on ``list_positions`` ends
    three paths and says which of them it means about none.
    """
    spelt = {path: path.replace('[]', '') for path in paths}
    whole = {path for path, spelling in spelt.items() if spelling == token}
    if whole:
        return whole
    tail = {path for path, spelling in spelt.items()
            if spelling.endswith('.' + token)}
    return tail if len(tail) == 1 else set()


def elsewhere(token, tools):
    """The paths a ``<tool>.<member>`` token names in that other tool."""
    head, _, rest = token.partition('.')
    return named(rest, tools[head][1]) if rest and head in tools else set()


def unresolved_citations(text, tool, tools):
    """Every backtick span that is not a tool, an argument, a member of this
    tool, or ``<tool>.<member>`` of another. ``tool`` is None for the server's
    instructions, which belong to no tool."""
    arguments, paths = tools[tool] if tool is not None else (set(), set())
    for token in re.findall(r'`([^`]*)`', text):
        if not CITATION.fullmatch(token):
            yield token
        elif not (token in tools or token in arguments
                  or named(token, paths) or elsewhere(token, tools)):
            yield token


def served_but_bare(text, tool, tools):
    """Every token outside backticks that names a served member — which is
    what keeps a sentence *without* backticks honest when it says there is
    no such member."""
    paths = tools[tool][1] if tool is not None else set()
    for token in BARE.findall(re.sub(r'`[^`]*`', ' ', text)):
        token = token.rstrip('.')
        if named(token, paths) or elsewhere(token, tools):
            yield token


def uncited(text, tool, tools):
    """Every member this tool publishes that no citation names alone."""
    paths = tools[tool][1]
    cited = set()
    for token in re.findall(r'`([^`]*)`', text):
        cited |= named(token, paths)
    return paths - cited


def instructions(runtime):
    """The server's instructions, as the client receives them."""
    async def _handshake():
        """Through the client, as :func:`listed` is."""
        async with Client(mcp_server.build_server(runtime)) as client:
            return client.instructions or ''
    return asyncio.run(_handshake())


def test_every_tool_publishes_the_schema_of_what_it_serves(tmp_path):
    """Not the ``{"result": object}`` every tool published while it was
    annotated ``Dict[str, Any]`` — the members themselves."""
    runtime, _ = build_runtime(tmp_path)

    for tool in listed(runtime):
        assert 'result' not in tool.output_schema['properties'], tool.name
        assert len(schema_paths(tool.output_schema)) > 5, tool.name


def test_every_citation_in_a_description_is_served(tmp_path):
    """A member in backticks is a promise, and this is who keeps it."""
    runtime, _ = build_runtime(tmp_path)
    tools = listed(runtime)
    known = surface(tools)

    for tool in tools:
        assert not list(unresolved_citations(tool.description, tool.name,
                                             known)), tool.name
    assert not list(unresolved_citations(instructions(runtime), None, known))


def test_no_served_member_is_named_outside_backticks(tmp_path):
    """The converse, and the only thing standing behind a negation.

    "THERE IS NO market_value MEMBER" is written bare because it is not
    served; the day it is, this sentence fails here instead of lying.
    """
    runtime, _ = build_runtime(tmp_path)
    tools = listed(runtime)
    known = surface(tools)

    for tool in tools:
        assert not list(served_but_bare(tool.description, tool.name,
                                        known)), tool.name
    assert not list(served_but_bare(instructions(runtime), None, known))


def test_every_served_member_is_cited(tmp_path):
    """The reverse direction: a member a builder gains while the description
    stays behind fails here — and so does a citation too vague to say which
    member it means."""
    runtime, _ = build_runtime(tmp_path)
    tools = listed(runtime)
    known = surface(tools)

    for tool in tools:
        assert not uncited(tool.description, tool.name, known), \
            (tool.name, sorted(uncited(tool.description, tool.name, known)))


# The #955 defects, as text, fed to the same three checks. Each case is a
# sentence the published descriptions once carried or could carry, and each
# must fail — otherwise the checks above pass because the descriptions are
# right today, not because anything would notice them going wrong.

def _positions(tmp_path):
    """The real surface, and the real ``list_positions`` description."""
    runtime, _ = build_runtime(tmp_path)
    tools = listed(runtime)
    return surface(tools), {tool.name: tool.description
                            for tool in tools}['list_positions']


def test_a_member_the_row_does_not_carry_fails_as_a_citation(tmp_path):
    known, _ = _positions(tmp_path)

    said = 'Each row carries `unit_cost` and `market_value`.'

    assert list(unresolved_citations(said, 'list_positions', known)) == \
        ['unit_cost', 'market_value']


def test_dropping_the_currency_of_price_and_fundamentals_fails_as_uncited(
        tmp_path):
    known, described = _positions(tmp_path)

    said = (described.replace('`price.currency`', 'its currency')
                     .replace('`fundamentals.currency`', 'its own currency'))

    assert {path.replace('[]', '')
            for path in uncited(said, 'list_positions', known)} == \
        {'positions.price.currency', 'positions.fundamentals.currency'}


def test_a_served_member_written_bare_fails(tmp_path):
    known, _ = _positions(tmp_path)

    said = 'The holding is worth quantity x converted.value.'

    assert list(served_but_bare(said, 'list_positions', known)) == \
        ['converted.value']


def test_a_citation_that_names_several_members_names_none(tmp_path):
    known, _ = _positions(tmp_path)

    said = 'The instrument is quoted in `currency`.'

    assert list(unresolved_citations(said, 'list_positions', known)) == \
        ['currency']
