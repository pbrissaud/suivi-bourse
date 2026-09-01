"""The agent's five tools (ADR-0040, issue #749).

**The store is real**, under ``tmp_path``, as it is everywhere else in this
suite; the one faked external edge is still yfinance and nothing here needs it.
The surface is exercised through the SDK's **in-memory client**, which is what
proves a description exists at all — a tool called as a Python function would
pass with an empty one, and the description is payload (ADR-0040).

No test binds a socket. Speaking Streamable HTTP over a real port would re-test
the SDK's transport and nothing of ours; what is ours is the routing, and that is
held in ``test_mcp_wiring.py``.
"""
import asyncio
from datetime import date

import pytest
from mcp import Client

from application import entries
from application import main
from application import mcp_server
from application import store as store_module
from application.events.schemas import Event, EventType


def build_runtime(tmp_path, events=None, currency='EUR', break_store=False):
    """A runtime over a real store — ``build_runtime``'s shape, in miniature.

    The events go in through :func:`entries.create_many`, which is the ledger's
    one writer (ADR-0032) and the function the upload route calls: a fixture that
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
        async with Client(mcp_server.build_server(runtime)) as client:
            return await client.call_tool(tool, arguments or {})
    return asyncio.run(_run())


def payload(result):
    """The structured payload of a successful call.

    The SDK wraps a mapping return under ``result``; unwrapping it here keeps
    that detail in one place rather than in every assertion.
    """
    assert result.is_error is False, _text(result)
    return result.structured_content['result']


def _text(result):
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

def test_the_surface_is_five_tools_and_nothing_else(tmp_path):
    """Five, named, and no sixth arriving by accident.

    The list is asserted **whole** rather than by membership: ADR-0040 makes
    these names a contract, so a tool appearing here is a promise made and a
    tool leaving is a promise broken. Either should fail a test rather than a
    user's setup.
    """
    runtime, _ = build_runtime(tmp_path)

    async def _run():
        async with Client(mcp_server.build_server(runtime)) as client:
            return await client.list_tools()

    names = sorted(tool.name for tool in asyncio.run(_run()).tools)
    assert names == ['get_portfolio_history', 'get_portfolio_totals',
                     'list_accounts', 'list_events', 'list_positions']


def test_every_description_states_the_absence_rule(tmp_path):
    """A description is payload, not documentation (ADR-0040).

    This is the test that stops a description from being trimmed to a stub the
    day somebody finds them long. What it holds is the **one** convention every
    tool here can return and that a model gets wrong by default: a ``null`` is
    not a zero. It is asserted on the text a client actually receives, which is
    the only copy that reaches a model.
    """
    runtime, _ = build_runtime(tmp_path)

    async def _run():
        async with Client(mcp_server.build_server(runtime)) as client:
            return await client.list_tools()

    for tool in asyncio.run(_run()).tools:
        description = tool.description or ''
        assert len(description) > 200, tool.name
        assert 'null' in description, tool.name
        assert 'never zero' in description or 'not priced' in description, tool.name


def test_the_positions_description_carries_both_terms_of_the_carrying_convention(tmp_path):
    """``terminal`` is useless to a model that is not told what it separates.

    ADR-0004's second term (#845) is the difference between *not priced yet* and
    *never priced*, and a reader that has the field but not the sentence reports
    an unpriced holding as worth nothing — which is the defect the field was
    added against, met one layer further out.
    """
    runtime, _ = build_runtime(tmp_path)

    async def _run():
        async with Client(mcp_server.build_server(runtime)) as client:
            return await client.list_tools()

    described = {tool.name: tool.description or ''
                 for tool in asyncio.run(_run()).tools}['list_positions']
    assert 'terminal' in described
    assert 'not fetched a price yet' in described
    assert 'no price will ever come' in described
    assert 'worth zero' in described


# --------------------------------------------------------------------- #
# The figures
# --------------------------------------------------------------------- #

def test_positions_name_the_reporting_currency_in_the_head(tmp_path):
    """One reporting currency, on the payload and never on a row (ADR-0002)."""
    runtime, _ = build_runtime(tmp_path, events=LEDGER, currency='EUR')

    body = payload(call(runtime, 'list_positions'))

    assert body['base_currency'] == 'EUR'
    assert body['positions']
    for row in body['positions']:
        assert 'currency' not in row


def test_a_null_currency_is_how_the_unanswered_question_is_said(tmp_path):
    """No fourth kind of absence for it, and no error either (ADR-0021)."""
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

    The distinction this holds is the one ADR-0040 says an agent cannot be
    allowed to lose: owning nothing and being unable to read are two answers.
    """
    runtime, _ = build_runtime(tmp_path, events=None, currency='EUR')

    body = payload(call(runtime, 'list_positions'))

    assert body['positions'] == []
    assert body['base_currency'] == 'EUR'


def test_the_accounts_list_always_holds_at_least_one_row(tmp_path):
    """ADR-0013: an install that declared nothing still has the seeded account.

    ``declared`` is a designed state and not an empty one, and it is served
    rather than left to a client to synthesise — a model asked *which accounts
    are there* must not be answered *none*, which ADR-0013 says is impossible.
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    body = payload(call(runtime, 'list_accounts'))

    assert body['declared'] is False
    assert len(body['accounts']) >= 1


def test_totals_are_null_rather_than_absent_when_nothing_is_computed(tmp_path):
    """One shape for two causes, and the head keeps its subject either way."""
    runtime, _ = build_runtime(tmp_path, events=None, currency='EUR')

    body = payload(call(runtime, 'get_portfolio_totals'))

    assert body['totals'] is None
    assert body['base_currency'] == 'EUR'


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
# The ledger — the one departure from /api (ADR-0040)
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


def test_the_ledger_reads_the_snapshot_and_therefore_survives_a_broken_store(tmp_path):
    """``/api/events``' contract, inherited whole (ADR-0031).

    It answers from process memory, so it has no storage failure to report — and
    that is a decision rather than an omission: the rows served are the ones the
    aggregator ran on, so the ledger an agent sees is the ledger every other
    figure was computed from.
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER, break_store=True)

    assert payload(call(runtime, 'list_events'))['total'] == len(LEDGER)


# --------------------------------------------------------------------- #
# Refusals — and the message surviving them
# --------------------------------------------------------------------- #

@pytest.mark.parametrize('tool', ['list_positions', 'get_portfolio_totals',
                                  'get_portfolio_history', 'list_accounts'])
def test_a_store_that_cannot_answer_is_an_error_and_never_an_empty_payload(tmp_path, tool):
    """The distinction ADR-0040 will not let a model lose.

    An agent handed ``[]`` reports that the owner holds nothing. Every tool that
    opens the store therefore fails loudly when it cannot.
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
                                   'yesterday', '2024-1-15'])
def test_only_one_spelling_of_a_calendar_day_is_taken(tmp_path, value):
    """#764's rule, and the reason it is not ``date.fromisoformat`` alone.

    That function accepts several other spellings since 3.11 — a bare
    ``20260210``, a whole instant — and a bound that arrived as an instant is
    what silently drops the first day of every window.
    """
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    result = call(runtime, 'list_events', {'from_day': value})

    assert result.is_error is True
    assert 'YYYY-MM-DD' in _text(result)


def test_an_inverted_window_is_refused_in_words(tmp_path):
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    result = call(runtime, 'get_portfolio_history',
                  {'from_day': '2024-06-01', 'to_day': '2024-01-01'})

    assert result.is_error is True
    assert 'earlier' in _text(result)


def test_a_negative_bound_is_refused_in_words(tmp_path):
    runtime, _ = build_runtime(tmp_path, events=LEDGER)

    result = call(runtime, 'list_events', {'limit': -1})

    assert result.is_error is True
    assert 'negative' in _text(result)
