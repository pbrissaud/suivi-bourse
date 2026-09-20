"""The comparison assembled, on a real store.

The interesting assertions here are the ones about *not* answering. A payload
that states a gap it has no right to state is the shipping bug of #760: the
number looks ordinary, it sits beside a real portfolio figure that is correct,
and it repairs itself an hour later so nobody who saw it can reproduce it.
"""

from datetime import date, datetime, timedelta, timezone

import pytest

from application import accounts as accounts_module
from application import benchmark_view
from application import counterfactual
from application import main
from application import quotes
from application import taxation
from application.events.schemas import Account, Event, EventType, Portfolio

UTC = timezone.utc
NOW = datetime(2024, 3, 1, 18, 0, tzinfo=UTC)

REFERENCE = 'CW8.PA'


def _snapshot(events, accounts=('pea',)):
    return main.ConfigSnapshot(
        shares=[], events=list(events),
        accounts=Portfolio(accounts=[Account(id=name, label=name)
                                     for name in accounts]),
        cache_key=None)


def _quote_the_reference(store, first='2024-01-01', last='2024-02-29',
                         price=100.0, symbol=REFERENCE):
    """A convertible close a day, and the anchors that make it terminal."""
    store.execute('INSERT INTO symbol (symbol) VALUES (?) '
                  'ON CONFLICT (symbol) DO NOTHING', [symbol])
    day = date.fromisoformat(first)
    end = date.fromisoformat(last)
    points = []
    while day <= end:
        points.append({'timestamp': datetime.combine(day, datetime.min.time(),
                                                     tzinfo=UTC),
                       'price': price, 'converted': price, 'rate': 1.0})
        day += timedelta(days=1)
    quotes.record_history(store, symbol, points)
    # The backward pass has tried past the window's own start, which is what
    # `terminal_symbols` reads as *finished* — off the store, not off a dict
    # this process happens to be holding.
    quotes.record_window_tried(store, symbol, date.fromisoformat(first))
    quotes.record_forward_window_tried(store, symbol, end)


def _write_curve(store, account, first='2024-01-01', last='2024-02-29',
                 value=1000.0, cash=0.0):
    store.execute('INSERT INTO account (id, label) VALUES (?, ?) '
                  'ON CONFLICT (id) DO NOTHING', [account, account])
    day = date.fromisoformat(first)
    end = date.fromisoformat(last)
    while day <= end:
        store.execute(
            'INSERT INTO account_metrics (account, day, total_value, '
            'cash_balance) VALUES (?, ?, ?, ?)', [account, day, value, cash])
        day += timedelta(days=1)


def _deposit(day, account, amount):
    return Event(date.fromisoformat(day), EventType.DEPOSIT, None, None,
                 amount=amount, account=account)


@pytest.fixture
def named(store):
    """A store with the reference named, quoted and terminal."""
    store.execute("INSERT INTO setting (key, value) VALUES "
                  "('benchmark_symbol', ?)", [REFERENCE])
    _quote_the_reference(store)
    return store


# --------------------------------------------------------------------------- #
# The states that publish no figure
# --------------------------------------------------------------------------- #

def test_no_reference_named_offers_the_list_and_states_nothing_else(store):
    """The untouched dial is not a failure, and the empty state's action is
    the selector — so the list has to arrive with the emptiness."""
    payload = benchmark_view.comparison(store, _snapshot([]), NOW)

    assert payload['state'] == benchmark_view.NO_REFERENCE
    assert payload['reference'] is None
    assert [entry['symbol'] for entry in payload['offered']][:1] == [REFERENCE]
    assert 'gap_gross' not in payload


def test_a_reference_still_backfilling_publishes_a_bar_and_no_figure(store):
    """The load-bearing rule of the whole ticket.

    A gap computed over a half-built series is a **wrong** number, not a short
    one: it reads −38 %, it sits beside a portfolio figure that is right, and
    it repairs itself an hour later. The figure and the right to display it
    ride on one payload so the two cannot disagree between two reads.
    """
    store.execute("INSERT INTO setting (key, value) VALUES "
                  "('benchmark_symbol', ?)", [REFERENCE])
    store.execute('INSERT INTO symbol (symbol) VALUES (?)', [REFERENCE])
    quotes.record_history(store, REFERENCE, [
        {'timestamp': datetime(2024, 2, 1, tzinfo=UTC), 'price': 100.0,
         'converted': 100.0, 'rate': 1.0}])
    _write_curve(store, 'pea')

    payload = benchmark_view.comparison(
        store, _snapshot([_deposit('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.REBUILDING
    assert payload['rebuild']['symbol'] == REFERENCE
    assert payload['rebuild']['target'] == '2009-06-16'   # the fund's own
    assert 'gap_gross' not in payload


def test_terminality_is_read_from_the_store_and_survives_a_restart(named):
    """`runtime_state.Recorder` is a per-process dict wiped on every boot.

    Built from it, the bar is empty on every restart of a job that runs for
    hours — and worse, the figure it gates would appear after one deploy and
    vanish on the next. Nothing here touches the recorder.
    """
    _write_curve(named, 'pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.READY


def test_a_perimeter_with_no_written_day_has_nothing_to_compare(named):
    """A reference fetched and an empty ledger is not an error state."""
    payload = benchmark_view.comparison(named, _snapshot([]), NOW)

    assert payload['state'] == benchmark_view.NOTHING_TO_COMPARE


# --------------------------------------------------------------------------- #
# The gap
# --------------------------------------------------------------------------- #

def test_a_flat_reference_and_a_flat_portfolio_end_level(named):
    """The plainest comparison: nothing moved on either side."""
    _write_curve(named, 'pea', value=1000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['portfolio_value'] == pytest.approx(1000.0)
    assert payload['reference_value'] == pytest.approx(1000.0)
    assert payload['gap_gross'] == pytest.approx(0.0)
    assert payload['covered_from'] == '2024-01-01'
    assert payload['covered_to'] == '2024-02-29'


def test_the_two_returns_share_the_denominator_they_are_compared_on(named):
    """Both sides ran the same flows from the same seed, so both fractions have
    the same bottom — otherwise the difference of two returns is not the gap
    the head figure states four lines up."""
    _write_curve(named, 'pea', first='2024-01-01', last='2024-01-31',
                 value=1000.0)
    _write_curve(named, 'pea', first='2024-02-01', last='2024-02-29',
                 value=1500.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['portfolio_return'] == pytest.approx(0.5)
    assert payload['reference_return'] == pytest.approx(0.0)


def test_the_period_is_the_intersection_of_the_accounts_own(named):
    """The latest of the starts and the earliest of the ends.

    An account opened in February has nothing to say about January, and a
    figure summed over a day one of its terms does not cover is a total missing
    a term — which is not a smaller total.
    """
    _write_curve(named, 'pea', first='2024-01-01', last='2024-02-29')
    _write_curve(named, 'cto', first='2024-02-01', last='2024-02-20')

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0),
                          _deposit('2024-02-01', 'cto', 500.0)],
                         accounts=('pea', 'cto')), NOW)

    assert payload['covered_from'] == '2024-02-01'
    assert payload['covered_to'] == '2024-02-20'
    assert payload['accounts'] == ['cto', 'pea']


def test_a_reference_exhausted_in_one_account_closes_the_whole_period(named):
    """The aggregate ends at the earliest end, and says why.

    A withdrawal the reference could not have funded ends its account's replay;
    carrying the other accounts past it would compare a live perimeter against
    a frozen one.
    """
    _write_curve(named, 'pea', value=1000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0),
                          _deposit('2024-02-01', 'pea', -5000.0)]), NOW)

    assert payload['ended'] == counterfactual.EXHAUSTED
    assert payload['covered_to'] == '2024-02-01'


def test_the_curves_are_published_on_one_day_axis(named):
    """The chart reads the area between them as the gap, so they share days."""
    _write_curve(named, 'pea', value=1000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['series'][0] == {'t': '2024-01-01', 'portfolio': 1000.0,
                                    'reference': 1000.0}
    assert len(payload['series']) == 60          # every calendar day of Jan+Feb


def test_idle_cash_is_published_rather_than_corrected_for(named):
    """The replay puts every euro to work the day it lands.

    A portfolio sitting on cash is compared against a reference that never did.
    Correcting for it would answer a question nobody asked; hiding it would let
    the comparison look unfair with nothing on screen saying why.
    """
    _write_curve(named, 'pea', value=1000.0, cash=250.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['idle_cash'] == pytest.approx(250.0)


# --------------------------------------------------------------------------- #
# The perimeter, and the net
# --------------------------------------------------------------------------- #

def test_an_account_granted_shares_at_no_declared_price_leaves_the_perimeter(
        named):
    """`declared_value` answers `0.0` on purpose, and here that is the wrong
    answer: the portfolio gained shares on a day the reference is handed
    nothing, so it trails by the whole undeclared amount for ever. The account
    leaves, and the screen names it."""
    _write_curve(named, 'pea')
    granted = Event(date(2024, 1, 15), EventType.GRANT, 'AAPL', 'Apple',
                    quantity=3, account='pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0), granted]),
        NOW)

    assert payload['state'] == benchmark_view.NOTHING_TO_COMPARE
    assert payload['excluded_accounts'] == [
        {'account': 'pea', 'reason': 'undeclared_grant', 'symbols': 'AAPL'}]


def test_an_account_with_no_taxation_model_removes_the_net_entirely(named):
    """All or nothing, and the account is named.

    A net summed over the accounts that happened to project is a figure the
    owner reads as their own and that is short by a wrapper — the shape of
    error nobody catches, on the one screen of this product carrying a tax
    number.
    """
    _write_curve(named, 'pea', value=1500.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['gap_net'] is None
    assert payload['net_unavailable'] == [
        {'account': 'pea', 'reason': 'no_model'}]
    assert payload['gap_gross'] is not None      # the gross side is unaffected


def _flat_model(store, account, rate=0.3):
    """A flat-rate wrapper on ``account``, created through the real write path."""
    model = accounts_module.create_model(store, 'Flat', taxation.FLAT_REALISED,
                                         {'rate': rate})
    accounts_module.set_taxation_model(store, account, model.id)
    return model


def test_the_net_taxes_each_side_on_its_own_latent_gain(named):
    """Two projections per account, never one rate applied to a difference.

    `_bracketed` is not linear, so an effective rate averaged out of the real
    side and applied to the reference is the same mistake made one module
    further out. Each side carries its own gain into `projected_tax`.
    """
    _write_curve(named, 'pea', first='2024-01-01', last='2024-01-31',
                 value=1000.0)
    _write_curve(named, 'pea', first='2024-02-01', last='2024-02-29',
                 value=1400.0)
    _flat_model(named, 'pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0)]), NOW)

    # The reference is flat, so it owes nothing; the portfolio has no position
    # rows, so its own assiette is a known zero. Both sides projected, and the
    # net gap is the gross one less two taxes rather than one netted rate.
    assert payload['net_unavailable'] == []
    assert payload['reference_tax'] == pytest.approx(0.0)
    assert payload['gap_net'] == pytest.approx(
        payload['gap_gross'] - payload['portfolio_tax'])


def test_one_account_short_of_a_model_removes_the_net_for_all_of_them(named):
    """All or nothing across the perimeter, and both accounts keep their gross."""
    _write_curve(named, 'pea')
    _write_curve(named, 'cto')
    _flat_model(named, 'pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0),
                          _deposit('2024-01-01', 'cto', 500.0)],
                         accounts=('pea', 'cto')), NOW)

    assert payload['gap_net'] is None
    assert payload['net_unavailable'] == [{'account': 'cto',
                                           'reason': 'no_model'}]
    assert payload['gap_gross'] is not None
