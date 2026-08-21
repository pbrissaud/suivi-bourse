"""The carrying price — issue #706, ADR-0004, spec #695 § 9.

A position held on a day nothing priced, and nothing ever will, is valued at its
own cost. Everything below pins one of the ticket's criteria, and three of them
are the ones that rot silently if left untested:

* the predicate has **two** terms, so the convention must *not* fire while a
  reconstruction is running;
* the two readings of the same portfolio — the shares page and the valuation —
  must reconcile to the cent, which is what one shared implementation buys;
* the backward anchor must not overshoot the first acquisition, or the
  forward-fill would supply a price on the purchase day and the rule would never
  fire at all.

The store is real, as everywhere in the v5 suite: terminality is derived from
rows, so a fake would be asserting the derivation against itself.
"""

from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

import pytest

import carrying
import main
import performance
import portfolio_view
import quotes
from carrying import carrying_price
from events import EventAggregator
from events.schemas import Account, Event, EventType


UTC = timezone.utc
PEA = Account("PEA", "PEA", "Mon PEA")


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

class _FakeConfigManager:
    """The surface ``SuiviBourseMetrics`` needs from the manager, over a real store."""

    def __init__(self, opened_store):
        self._store = opened_store

    @property
    def store(self):
        return self._store

    @contextmanager
    def writing(self):
        yield self._store

    def current(self):
        return main.ConfigSnapshot(shares=[], events=[], accounts=None,
                                   cache_key=None)


def _metrics(store, mocker):
    m = main.SuiviBourseMetrics(_FakeConfigManager(store),
                                prometheus_exporter=mocker.MagicMock())
    m.backfill_delay = 0
    m.backfill_chunk_days = 365
    return m


def _record_unit(store, symbol='AAPL', currency='USD'):
    """The unit the exchange quotes ``symbol`` in — ``symbol_quote.currency``.

    Written by the scrape in production, and by the lateral pass since #773. It
    is a **fact of the fixture** rather than a convenience: since that ticket a
    quote is a number *and* a unit, so a series of ``price_native`` with no
    currency beside it is not the *waiting for a rate* state a test means to set
    up — it is the third one, and it is carried at cost.
    """
    quotes.record_attributes(store, symbol, datetime(2024, 1, 15, tzinfo=UTC),
                             {'currency': currency})


def _declare_symbol(store, symbol):
    store.execute('INSERT INTO symbol (symbol) VALUES (?) '
                  'ON CONFLICT (symbol) DO NOTHING', [symbol])


_SAME = object()


def _p1_row(symbol='AAPL', account='default', quantity=10.0, cost_basis=1000.0,
            price=None, price_native=_SAME):
    """One P1 row in the shape :meth:`store_reads.PortfolioReader.positions` returns.

    ``price`` is the **converted** column and ``price_native`` the quote as the
    exchange gave it; they move together unless a test parts them, which is the
    *waiting for a rate* row (#702, #706).
    """
    return {
        'account': account, 'symbol': symbol, 'name': 'Apple',
        'quantity': quantity, 'cost_basis': cost_basis,
        'realized_gain': 0.0, 'received_dividend': 0.0,
        'currency': 'USD', 'exchange': 'NMS', 'quote_type': 'EQUITY',
        'dividend_yield': None, 'pe_ratio': None, 'market_cap': None,
        'price': price,
        'price_native': price if price_native is _SAME else price_native,
        'fx_rate': None, 'price_time': None,
    }


def _no_price(_symbol, _day):
    """A price source that has never observed anything — the ticket's subject."""
    return None


# --------------------------------------------------------------------------- #
# The helper itself — one function, three answers
# --------------------------------------------------------------------------- #

def test_the_observed_price_wins_over_the_cost():
    assert carrying_price(187.5, True, 10.0, 1000.0) == 187.5


def test_a_position_with_no_price_is_carried_at_its_weighted_average_cost():
    """The PMP, never the execution price — that is what makes the day neutral."""
    assert carrying_price(None, False, 10.0, 1000.0) == pytest.approx(100.0)


def test_the_carrying_price_is_the_weighted_mean_and_not_the_last_paid():
    """Bought 1 at 100 then 9 at 200: carried at 190, the figure the tax rule names."""
    assert carrying_price(None, False, 10.0,
                          100.0 + 9 * 200.0) == pytest.approx(190.0)


def test_a_quote_with_no_rate_is_waiting_and_never_carried():
    """The first term is *no cours observed*, not *no converted price*.

    A security whose quote is known and whose conversion is not — the base
    currency unanswered, or a pair that does not resolve — is *waiting for a
    rate*, which ``CONTEXT.md`` § Absence names as a different kind of absence
    from *carried at cost*, never rendered alike. Carrying it would answer a
    valuation the app does not have, and durably: an unresolvable pair keeps its
    ``price_converted`` ``NULL`` until #704's lateral pass.
    """
    assert carrying_price(None, True, 10.0, 1000.0) is None


def test_a_sold_position_has_no_carrying_price():
    """Quantity zero: no unit cost, no carrying price — it has a realized gain."""
    assert carrying_price(None, False, 0.0, 0.0) is None
    assert carrying_price(None, False, None, 250.0) is None


def test_a_dilution_grant_is_carried_at_zero_which_is_a_figure():
    """Cost nothing, therefore worth nothing until the market says otherwise.

    ``0.0`` and not ``None``: absence is kept for what could not be computed at
    all, and this one was computed.
    """
    assert carrying_price(None, False, 10.0, 0.0) == 0.0
    assert carrying_price(None, False, 10.0, None) == 0.0


def test_a_day_is_quoted_from_the_first_observation_on():
    """The series form of the first term, forward-filled like the price beside it.

    A valuation asks what was last known on a day, not whether that day traded —
    so once a symbol has been quoted, every later day counts as observed even
    when its conversion is missing. A symbol never quoted is ``False`` on every
    day, which is the ticket's own subject.
    """
    first = date(2024, 3, 1)

    assert carrying.was_quoted(first, date(2024, 2, 29)) is False
    assert carrying.was_quoted(first, first) is True
    assert carrying.was_quoted(first, date(2026, 8, 10)) is True
    assert carrying.was_quoted(None, date(2024, 3, 1)) is False


def test_there_is_one_implementation():
    """The ticket's second criterion, asserted on the source.

    Two implementations would make two users of the same software see two curves
    for the same portfolio, with nothing on screen able to say so. The valuation
    and the shares page therefore hold the **same function object**.
    """
    assert performance.carrying_price is carrying_price
    assert portfolio_view.carrying_price is carrying_price


# --------------------------------------------------------------------------- #
# The second term — the symbol's backfill is terminal
# --------------------------------------------------------------------------- #

def test_a_reconstruction_in_progress_is_not_terminal(store):
    """Half a window fetched is not a finished history (issue #706, ADR-0009)."""
    _declare_symbol(store, 'AAPL')
    quotes.record_window_tried(store, 'AAPL', date(2022, 6, 1))
    windows = {'AAPL': (date(2020, 1, 2), None)}

    assert quotes.terminal_symbols(
        store, windows, datetime(2024, 1, 15, tzinfo=UTC)) == set()


def test_a_finished_reconstruction_is_terminal(store):
    """The anchor has reached the first acquisition: nothing more is coming."""
    _declare_symbol(store, 'AAPL')
    quotes.record_window_tried(store, 'AAPL', date(2020, 1, 2))
    windows = {'AAPL': (date(2020, 1, 2), None)}

    assert quotes.terminal_symbols(
        store, windows, datetime(2024, 1, 15, tzinfo=UTC)) == {'AAPL'}


def test_a_symbol_with_nothing_attempted_is_not_terminal(store):
    """A fresh install is *waiting*, not finished — the crater's own guard."""
    _declare_symbol(store, 'AAPL')
    windows = {'AAPL': (date(2024, 1, 15), None)}

    assert quotes.terminal_symbols(
        store, windows, datetime(2024, 1, 16, tzinfo=UTC)) == set()


def test_stored_history_older_than_the_acquisition_is_terminal(store):
    """The pre-#703 install: no window was ever *tried*, but the rows are there.

    Dropping the oldest stored point from the anchor would leave every such
    install non-terminal for ever, and its priceless days at an em dash with
    nothing able to clear them.
    """
    _declare_symbol(store, 'AAPL')
    store.execute(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted, '
        '                         fx_rate) VALUES (?, ?, ?, ?, ?)',
        ['AAPL', datetime(2019, 5, 4, tzinfo=UTC), 100.0, 100.0, 1.0])
    windows = {'AAPL': (date(2020, 1, 2), None)}

    assert quotes.terminal_symbols(
        store, windows, datetime(2024, 1, 15, tzinfo=UTC)) == {'AAPL'}


def test_a_symbol_the_ledger_never_acquired_is_not_in_the_answer(store):
    """No holding window, nothing to be finished with."""
    assert quotes.terminal_symbols(
        store, {}, datetime(2024, 1, 15, tzinfo=UTC)) == set()


def test_a_closed_position_measures_its_own_ceiling(store):
    """A sold line's window ends the day after its last sale, not today.

    With *now* as the ceiling the symbol would read as still-unfinished for
    years after the owner left it, and its held days would never be carried.
    """
    _declare_symbol(store, 'ALO')
    quotes.record_window_tried(store, 'ALO', date(2020, 3, 2))
    windows = {'ALO': (date(2020, 3, 2), date(2022, 5, 4))}

    assert quotes.terminal_symbols(
        store, windows, datetime(2026, 8, 10, tzinfo=UTC)) == {'ALO'}


# --------------------------------------------------------------------------- #
# The convention does not fire during a reconstruction
# --------------------------------------------------------------------------- #

#: 1 000 € deposited and 10 shares bought the same day, priced by nobody — the
#: crater, in the smallest ledger that draws one.
_BOUGHT_ON_A_DAY_NOBODY_PRICED = [
    Event(date(2024, 1, 15), EventType.DEPOSIT, amount=1000.0, account='PEA'),
    Event(date(2024, 1, 15), EventType.BUY, 'AAPL', 'Apple', quantity=10,
          unit_price=100.0, account='PEA'),
]


def _bought_with_no_price():
    return EventAggregator().replay(_BOUGHT_ON_A_DAY_NOBODY_PRICED)


def test_nothing_is_carried_while_the_history_is_still_being_fetched():
    """The predicate's second term, seen from the figure it protects.

    Carried unconditionally, a reconstruction would replay a portfolio
    flat-at-cost for four years, take off, and correct itself — with the owner
    having done nothing.
    """
    perf = performance.compute_account(
        _bought_with_no_price(), PEA, {'AAPL'}, _no_price,
        start=date(2024, 1, 15), today=date(2024, 1, 15))

    assert perf.daily[0].holdings_value == pytest.approx(0.0)


def test_a_terminal_symbol_makes_the_purchase_day_exactly_neutral():
    """The ticket's fourth criterion, on the curve that used to show the crater."""
    perf = performance.compute_account(
        _bought_with_no_price(), PEA, {'AAPL'}, _no_price,
        start=date(2024, 1, 15), today=date(2024, 1, 15), carried={'AAPL'})

    day = perf.daily[0]
    # Cash paid the 1 000 €, the holding carries it back: the total does not move.
    assert day.cash_balance == pytest.approx(0.0)
    assert day.holdings_value == pytest.approx(1000.0)
    assert day.total_value == pytest.approx(1000.0)
    # And the day is not a gain either: contributed 1 000, worth 1 000.
    assert perf.gain_absolu == pytest.approx(0.0)


def test_the_latent_gain_is_identically_zero_while_the_fallback_holds():
    rows = [_p1_row(quantity=10.0, cost_basis=1000.0, price=None)]

    (share,) = portfolio_view.build_shares(rows, carried={'AAPL'})

    assert share.plus_value_latente == pytest.approx(0.0)
    assert share.unit_gain == pytest.approx(0.0)


# --------------------------------------------------------------------------- #
# What the shares page shows — and what it deliberately does not
# --------------------------------------------------------------------------- #

def test_the_price_column_stays_absent_while_the_value_does_not():
    """The app states a convention; it does not invent a quote (criterion 5)."""
    rows = [_p1_row(quantity=10.0, cost_basis=1000.0, price=None)]

    (share,) = portfolio_view.build_shares(rows, carried={'AAPL'})

    assert share.price is None
    assert share.price_native is None
    assert share.market_value == pytest.approx(1000.0)


def test_a_carried_value_is_not_marked_at_the_point():
    """Criterion 6: no badge, no flag, no extra field — the em dash is the signal.

    Asserted on the payload rather than on a screen: a marker would have to be
    published to be rendered, so its absence here is the whole of it.
    """
    rows = [_p1_row(price=None)]

    (share,) = portfolio_view.build_shares(rows, carried={'AAPL'})

    assert set(share.to_dict()) == set(
        portfolio_view.build_shares([_p1_row(price=120.0)])[0].to_dict())


def test_the_breakdown_carries_each_account_at_its_own_cost():
    """The PMP is a weighted mean, so two accounts carry the same share differently.

    One figure applied to both would make the breakdown stop adding up to the
    row above it.
    """
    rows = [
        _p1_row(account='PEA', quantity=10.0, cost_basis=1000.0),
        _p1_row(account='CTO', quantity=10.0, cost_basis=3000.0),
    ]

    (share,) = portfolio_view.build_shares(rows, carried={'AAPL'})

    by_account = {a.account: a for a in share.accounts}
    assert by_account['PEA'].market_value == pytest.approx(1000.0)
    assert by_account['CTO'].market_value == pytest.approx(3000.0)
    assert share.market_value == pytest.approx(4000.0)


def test_a_symbol_outside_the_carried_set_keeps_its_em_dash():
    rows = [_p1_row(price=None)]

    (share,) = portfolio_view.build_shares(rows)

    assert share.market_value is None
    assert share.plus_value_latente is None


def test_a_terminal_symbol_waiting_for_a_rate_is_not_carried():
    """A cours *was* observed; only its conversion is missing (issue #706).

    The predicate's first term reads ``price_native``, never the converted
    column. Reading the converted one carries a position whose quote the app has
    — every install whose backfill finished while ``base_currency`` is still
    unanswered, and every symbol whose pair does not resolve, until #704's
    lateral pass. *Waiting* and *carried at cost* are two of the four kinds of
    absence ``CONTEXT.md`` says are never rendered alike.
    """
    rows = [_p1_row(quantity=10.0, cost_basis=1000.0,
                    price=None, price_native=187.5)]

    (share,) = portfolio_view.build_shares(rows, carried={'AAPL'})

    assert share.price is None
    assert share.price_native == 187.5
    assert share.market_value is None
    assert share.plus_value_latente is None
    assert share.unit_gain is None


def test_the_breakdown_of_a_row_waiting_for_a_rate_is_absent_too():
    """The per-account rows read the same term, or the two stop agreeing."""
    rows = [
        _p1_row(account='PEA', price=None, price_native=187.5),
        _p1_row(account='CTO', price=None, price_native=187.5),
    ]

    (share,) = portfolio_view.build_shares(rows, carried={'AAPL'})

    assert [a.market_value for a in share.accounts] == [None, None]
    assert share.market_value is None


# --------------------------------------------------------------------------- #
# The two readings reconcile — the reason there is one implementation
# --------------------------------------------------------------------------- #

def test_the_two_readings_reconcile_to_the_cent_on_a_position_with_no_price():
    """Criterion 5's own test: the shares page and the valuation agree.

    The shares page reads P1 and folds it; the dashboard reads the perf series,
    which is computed from the replay. Two implementations of the carrying rule
    would put a plausible-looking gap between two screens open at the same
    instant, and nothing on either would say which one to believe.
    """
    events = [
        Event(date(2024, 1, 15), EventType.DEPOSIT, amount=2500.0, account='PEA'),
        Event(date(2024, 1, 15), EventType.BUY, 'AAPL', 'Apple', quantity=7,
              unit_price=137.13, fee=2.5, account='PEA'),
    ]
    timeline = EventAggregator().replay(events)
    position = timeline.current()[0]

    perf = performance.compute_account(
        timeline, PEA, {'AAPL'}, _no_price,
        start=date(2024, 1, 15), today=date(2024, 1, 15), carried={'AAPL'})
    (share,) = portfolio_view.build_shares(
        [_p1_row(quantity=position['quantity'],
                 cost_basis=position['cost_basis'], price=None)],
        carried={'AAPL'})

    assert perf.daily[-1].holdings_value == pytest.approx(
        share.market_value, abs=0.005)
    # And both equal what the position cost, to the cent.
    assert share.market_value == pytest.approx(position['cost_basis'], abs=0.005)


def test_the_valuation_curve_and_the_shares_page_agree_on_the_purchase_day():
    """The same reconciliation through the ``titres`` curve, which had the crater."""
    events = [
        Event(date(2024, 1, 15), EventType.BUY, 'AAPL', 'Apple', quantity=10,
              unit_price=100.0, account='default'),
    ]
    timeline = EventAggregator().replay(events)
    closes = [{'day': date(2024, 1, 15), 'symbol': 'MSFT', 'price': 40.0}]

    (point,) = portfolio_view.valuation_series(
        closes, timeline.at, carried={'AAPL'})
    (share,) = portfolio_view.build_shares(
        [_p1_row(quantity=10.0, cost_basis=1000.0, price=None)],
        carried={'AAPL'})

    assert point['value'] == pytest.approx(share.market_value)
    # The crater is exactly this: value and invested no longer part company.
    assert point['value'] == pytest.approx(point['invested'])


def test_the_valuation_curve_leaves_the_hole_when_only_the_rate_is_missing():
    """The curve reads the *converted* series, so it needs the first term told.

    ``daily_closes`` returns ``price_converted``, and a day missing from it is
    either a day nobody quoted or a day whose rate never landed. ``first_quoted``
    is what parts them: the symbol was quoted on the purchase day, so the day is
    observed and worth nothing computable — not carried at its cost.
    """
    events = [
        Event(date(2024, 1, 15), EventType.BUY, 'AAPL', 'Apple', quantity=10,
              unit_price=100.0, account='default'),
    ]
    timeline = EventAggregator().replay(events)
    closes = [{'day': date(2024, 1, 15), 'symbol': 'MSFT', 'price': 40.0}]

    (point,) = portfolio_view.valuation_series(
        closes, timeline.at, carried={'AAPL'},
        first_quoted={'AAPL': date(2024, 1, 15)})

    assert point['value'] is None
    assert point['invested'] == pytest.approx(1000.0)


def test_the_valuation_curve_carries_the_days_before_the_first_quote():
    """And the same series is carried where the symbol was genuinely unquoted.

    ``first_quoted`` is forward-filled, so the day before the first observation
    has no cours and never will — the ticket's own case — while the day of it
    does.
    """
    events = [
        Event(date(2024, 1, 15), EventType.BUY, 'AAPL', 'Apple', quantity=10,
              unit_price=100.0, account='default'),
    ]
    timeline = EventAggregator().replay(events)
    closes = [
        {'day': date(2024, 1, 15), 'symbol': 'MSFT', 'price': 40.0},
        {'day': date(2024, 1, 16), 'symbol': 'MSFT', 'price': 40.0},
    ]

    first, second = portfolio_view.valuation_series(
        closes, timeline.at, carried={'AAPL'},
        first_quoted={'AAPL': date(2024, 1, 16)})

    assert first['value'] == pytest.approx(1000.0)
    assert second['value'] is None


def test_the_valuation_curve_leaves_the_hole_while_the_rebuild_runs():
    events = [
        Event(date(2024, 1, 15), EventType.BUY, 'AAPL', 'Apple', quantity=10,
              unit_price=100.0, account='default'),
    ]
    timeline = EventAggregator().replay(events)
    closes = [{'day': date(2024, 1, 15), 'symbol': 'MSFT', 'price': 40.0}]

    (point,) = portfolio_view.valuation_series(closes, timeline.at)

    assert point['value'] is None
    assert point['invested'] == pytest.approx(1000.0)


def test_the_perf_recompute_carries_a_terminal_symbol(
        store, declare_ledger, mocker):
    """The whole path, through the job that writes the cache.

    The store is the job's only input (#707), so the terminality it reads is the
    one it derives from these rows — never a snapshot handed to it.
    """
    declare_ledger(store, _BOUGHT_ON_A_DAY_NOBODY_PRICED, [PEA])
    quotes.record_window_tried(store, 'AAPL', date(2024, 1, 15))
    metrics = _metrics(store, mocker)
    metrics.base_currency = 'EUR'

    metrics.update_account_metrics()

    (holdings, total) = store.query(
        'SELECT holdings_value, total_value FROM account_metrics '
        " WHERE account = 'PEA' ORDER BY day LIMIT 1")[0]
    assert holdings == pytest.approx(1000.0)
    assert total == pytest.approx(1000.0)


def test_a_symbol_waiting_for_a_rate_is_not_written_at_zero(
        store, declare_ledger, mocker):
    """A stored quote with no conversion: the day is **not written at all**.

    Reachable on any install whose pair does not resolve — the point is written
    with ``price_converted`` ``NULL`` rather than not written (#702), and #704 is
    what repairs the stock. ``price_at`` sees nothing there, and
    ``carrying_price`` refuses the row on purpose (#706: a security whose quote
    is known and whose rate is not is *waiting*, not priceless). So the position
    can be given no figure, and the only two answers are *no row* or *a row
    counting it at nothing*.

    It used to be the second, and that is the crater #708 measured and #773 half
    repaired: zero holdings beside a cash ledger that has already paid, chained
    forward by a time-weighted index — two accounts on the real portfolio read
    −99,98 % and −29 120,25 %. #773 took the **no-unit** half of that population
    into the carrying convention and left this half pinned at zero, which is why
    it is the same defect and not a second one.

    Nothing is written instead. An account holding a security it cannot value in
    the reporting currency cannot state its performance, which is what a horizon
    *is* (``CONTEXT.md`` § Horizon), and ``unconvertible`` is the notice that
    asks the owner to act. The block lifts by itself the moment a rate lands.
    """
    declare_ledger(store, _BOUGHT_ON_A_DAY_NOBODY_PRICED, [PEA])
    store.execute(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted, '
        '                         fx_rate) VALUES (?, ?, ?, ?, ?)',
        ['AAPL', datetime(2024, 1, 15, 16, 0, tzinfo=UTC), 187.5, None, None])
    _record_unit(store)
    metrics = _metrics(store, mocker)
    metrics.base_currency = 'EUR'

    metrics.update_account_metrics()

    assert store.query(
        "SELECT count(*) FROM account_metrics WHERE account = 'PEA'") == [(0,)]


def test_the_perf_recompute_carries_a_symbol_quoted_in_no_nameable_unit(
        store, declare_ledger, mocker):
    """The same rows as the test above, minus the unit — issue #773.

    A number with no currency beside it is not a quote a valuation can spend:
    every figure the perf job computes is money in the reporting currency, and
    nothing turns an unnamed unit into one — there is no pair to fetch a rate
    for. Left in the *waiting* state the position counted **zero** on every day
    it was held while the cash ledger had already paid for it, which is the
    crater ADR-0004 exists to fill; measured on staging as two accounts reading
    −99,98 % and −29 120,25 %.

    So the third state joins the **carrying** convention rather than becoming a
    fourth kind of absence (ADR-0021), and #706's second term is what makes the
    reading permanent rather than premature: the symbol is terminal here, and a
    terminal symbol with no recorded unit is one Yahoo has been asked about.
    """
    declare_ledger(store, _BOUGHT_ON_A_DAY_NOBODY_PRICED, [PEA])
    store.execute(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted, '
        '                         fx_rate) VALUES (?, ?, ?, ?, ?)',
        ['AAPL', datetime(2024, 1, 15, 16, 0, tzinfo=UTC), 187.5, None, None])
    metrics = _metrics(store, mocker)
    metrics.base_currency = 'EUR'

    metrics.update_account_metrics()

    (holdings, total) = store.query(
        'SELECT holdings_value, total_value FROM account_metrics '
        " WHERE account = 'PEA' ORDER BY day LIMIT 1")[0]
    assert holdings == pytest.approx(1000.0)
    assert total == pytest.approx(1000.0)


def test_a_p1_row_quoted_in_no_nameable_unit_is_carried_at_its_cost():
    """The shares page reads the rule the valuation does — issue #773, #706.

    One implementation is the acceptance criterion, and it covers the *term* as
    much as the function: a position carried at cost in the curve and left at an
    em dash in the table is two users of one software seeing two figures for one
    holding. ``price_native`` alone said *a number was observed* and nothing
    about the unit, so this row read as *waiting for a rate* — permanently, since
    no rate is coming for a pair nobody can name.
    """
    rows = [_p1_row(quantity=10.0, cost_basis=1000.0,
                    price=None, price_native=187.5)]
    rows[0]['currency'] = None

    (share,) = portfolio_view.build_shares(rows, carried={'AAPL'})

    assert share.price is None                       # no quote is invented
    assert share.market_value == pytest.approx(1000.0)
    assert share.plus_value_latente == pytest.approx(0.0)
    assert [a.market_value for a in share.accounts] == [pytest.approx(1000.0)]


def test_a_symbol_waiting_for_a_rate_holds_the_horizon_back(
        store, declare_ledger, mocker):
    """*Settled* is terminal **and valuable**, and this symbol is not valuable.

    Quoted, in a nameable unit, and not converted: ``price_at`` answers nothing
    and ``carrying_price`` refuses to invent one (#706 — the app owes a
    conversion rather than a convention). A day whose only position can be given
    no figure is a day nothing honest can be said about, so the horizon holds and
    no row is written.

    It used to settle, on the argument that blocking would pin the horizon at
    today for ever, the repair being #704's lateral pass rather than any cycle of
    the reconstruction. The argument is sound and the conclusion was not: what it
    bought was every one of those days written with the position counted at
    **zero**, which is the crater the test above now pins. Between a figure that
    is wrong and no figure, this repository answers the same way everywhere else
    (ADR-0026, and the recompute's own rule under the horizon).
    """
    declare_ledger(store, _BOUGHT_ON_A_DAY_NOBODY_PRICED, [PEA])
    store.execute(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted, '
        '                         fx_rate) VALUES (?, ?, ?, ?, ?)',
        ['AAPL', datetime(2024, 1, 15, 16, 0, tzinfo=UTC), 187.5, None, None])
    _record_unit(store)
    metrics = _metrics(store, mocker)
    metrics.base_currency = 'EUR'

    horizons = metrics.update_account_metrics()

    # The horizon has not arrived: the day after the last day it could not
    # write, which is the shape #708 gives an account with nothing publishable.
    assert horizons['PEA'] is not None
    assert store.query(
        "SELECT count(*) FROM account_metrics WHERE account = 'PEA'") == [(0,)]


def test_the_perf_recompute_writes_nothing_at_all_under_the_horizon(
        store, declare_ledger, mocker):
    """Same ledger, nothing attempted yet: the day is **not written**.

    It used to be written hollow, and #708 is where that was measured on the real
    portfolio: a purchase day with no price yet takes ``holdings_value`` to zero
    beside a cash ledger that has already paid, and a time-weighted index
    *chains* the crater forward — ``twr_index`` 0,057 on 2020-09-28, the head
    reading **−100,00 %** on a portfolio worth eleven thousand euros.

    #706's second term does not catch it, and could not: it is right about an
    absence that is **permanent** and silent about one that is **transitory**. The
    horizon is the transitory half, and under it the honest figure is no row at
    all — which is also what keeps ``carrying_price``'s domain exactly *terminal
    symbol, any day*.
    """
    declare_ledger(store, _BOUGHT_ON_A_DAY_NOBODY_PRICED, [PEA])
    metrics = _metrics(store, mocker)
    metrics.base_currency = 'EUR'

    horizons = metrics.update_account_metrics()

    assert store.query(
        "SELECT count(*) FROM account_metrics WHERE account = 'PEA'") == [(0,)]
    # And the horizon says so, from process memory: the day after the last day
    # the line was held with no price, which on a position still standing is
    # tomorrow.
    assert horizons['PEA'] > date(2024, 1, 15)


def test_carrying_is_never_invoked_under_the_horizon(
        store, declare_ledger, mocker):
    """Criterion 3 of #708: its domain reduces to *terminal symbol, any day*.

    Two lines bought on the same day. ``ALO`` is terminal on zero point — nothing
    will ever price it, so it is carried at its cost; ``AAPL`` is still being
    reconstructed and its earliest usable price is 2024-01-18, which is where the
    account's horizon lands. Below that day nothing is computed at all, so the
    carrying convention cannot be asked about a day the cache will not carry — and
    the days it *is* asked about are exactly the ones the reader will see.
    """
    events = [
        Event(date(2024, 1, 15), EventType.DEPOSIT, amount=5000.0, account='PEA'),
        Event(date(2024, 1, 15), EventType.BUY, 'AAPL', 'Apple', quantity=10,
              unit_price=100.0, account='PEA'),
        Event(date(2024, 1, 15), EventType.BUY, 'ALO', 'Alstom', quantity=5,
              unit_price=40.0, account='PEA'),
    ]
    declare_ledger(store, events, [PEA])
    # ALO: the backward pass has been to the acquisition and brought nothing.
    quotes.record_window_tried(store, 'ALO', date(2024, 1, 15))
    # AAPL: one converted point, three days after the purchase.
    quotes.record_history(store, 'AAPL', [{
        'timestamp': datetime(2024, 1, 18, 16, 0, tzinfo=UTC),
        'price': 110.0, 'converted': 110.0, 'rate': 1.0}])
    metrics = _metrics(store, mocker)
    metrics.base_currency = 'EUR'
    spy = mocker.spy(performance, 'carrying_price')

    horizons = metrics.update_account_metrics()

    assert horizons['PEA'] == date(2024, 1, 18)
    assert spy.call_count > 0            # ALO *is* carried, above the horizon
    assert store.query(
        "SELECT min(day) FROM account_metrics WHERE account = 'PEA'"
    ) == [(date(2024, 1, 18),)]


# --------------------------------------------------------------------------- #
# The anchor does not overshoot (criterion 7)
# --------------------------------------------------------------------------- #

def test_the_backward_pass_never_asks_for_a_window_before_the_acquisition(
        store, mocker):
    """Fetching even a week earlier would short-circuit the whole convention.

    The forward-fill would then have a close to carry onto the purchase day, the
    fallback would never fire there, and a convention that only triggers in rare
    cases is a convention that rots with no test noticing.
    """
    _declare_symbol(store, 'AAPL')
    metrics = _metrics(store, mocker)
    fetch = mocker.patch.object(metrics, '_fetch_historical_data',
                                return_value=[])
    target = datetime(2024, 1, 15, tzinfo=UTC)
    ceiling = datetime(2024, 12, 31, tzinfo=UTC)

    metrics._backfill_backward('AAPL', target, ceiling)

    (called_symbol, start, end), _ = fetch.call_args
    assert called_symbol == 'AAPL'
    assert start >= target
    # And the anchor it persists is bounded the same way.
    assert quotes.oldest_window_tried(store, 'AAPL') >= target.date()


def test_a_long_chunk_is_clamped_to_the_acquisition(store, mocker):
    """The clamp is what keeps a 365-day chunk from reaching back past the target."""
    _declare_symbol(store, 'AAPL')
    metrics = _metrics(store, mocker)
    metrics.backfill_chunk_days = 3650
    fetch = mocker.patch.object(metrics, '_fetch_historical_data',
                                return_value=[])
    target = datetime(2024, 1, 15, tzinfo=UTC)

    metrics._backfill_backward('AAPL', target,
                               datetime(2024, 6, 1, tzinfo=UTC))

    (_, start, _end), _ = fetch.call_args
    assert start == target


# --------------------------------------------------------------------------- #
# Where carrying diverges from a valuation (criterion 8)
# --------------------------------------------------------------------------- #

def test_a_purchase_and_a_dilution_grant_are_carried_at_half(store):
    """The one case worth stating, pinned so nobody rediscovers it as a bug.

    Ten bought at 100 and ten granted by dilution, both inside the window with no
    price: quantity 20 for a basis of 1 000, therefore a PMP of 50 against a
    market that would say 100. The app knows what the position cost and does not
    know what it is worth — carrying at cost is still the honest answer, and it
    takes both events within the few days before the symbol's first quote.
    """
    events = [
        Event(date(2024, 1, 15), EventType.BUY, 'AAPL', 'Apple', quantity=10,
              unit_price=100.0, account='default'),
        Event(date(2024, 1, 16), EventType.GRANT, 'AAPL', 'Apple', quantity=10,
              account='default'),
    ]
    position = EventAggregator().replay(events).current()[0]

    assert position['quantity'] == pytest.approx(20.0)
    assert position['cost_basis'] == pytest.approx(1000.0)
    assert carrying_price(None, False, position['quantity'],
                          position['cost_basis']) == pytest.approx(50.0)


# --------------------------------------------------------------------------- #
# The anchor has one definition
# --------------------------------------------------------------------------- #

def test_the_backward_anchor_is_the_minimum_of_the_three():
    ceiling = datetime(2024, 6, 1, tzinfo=UTC)
    stored = datetime(2023, 3, 1, tzinfo=UTC)

    assert carrying.backward_anchor(ceiling, stored, None) == stored
    assert carrying.backward_anchor(ceiling, stored, date(2022, 1, 1)) == \
        datetime(2022, 1, 1, tzinfo=UTC)
    assert carrying.backward_anchor(ceiling, None, None) == ceiling


def test_a_holding_window_that_is_still_open_ends_now():
    now = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)

    target, ceiling = carrying.holding_bounds(date(2020, 3, 2), None, now)

    assert target == datetime(2020, 3, 2, tzinfo=UTC)
    assert ceiling == now


def test_a_closed_holding_window_ends_the_day_after_the_last_sale():
    """yfinance reads a range's end as exclusive, and the day one sells is history."""
    target, ceiling = carrying.holding_bounds(
        date(2020, 3, 2), date(2022, 5, 4), datetime(2026, 8, 10, tzinfo=UTC))

    assert target == datetime(2020, 3, 2, tzinfo=UTC)
    assert ceiling == datetime(2022, 5, 4, tzinfo=UTC) + timedelta(days=1)
