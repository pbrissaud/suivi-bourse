"""The comparison assembled, on a real store.

The interesting assertions here are the ones about *not* answering. A payload
that states a gap it has no right to state is the shipping bug of #760: the
number looks ordinary, it sits beside a real portfolio figure that is correct,
and it repairs itself an hour later so nobody who saw it can reproduce it.
"""

from datetime import date, datetime, timedelta, timezone

import pytest

from application import benchmark_view
from application import counterfactual
from application import main
from application import quotes
from application.events.schemas import Account, Event, EventType, Portfolio

UTC = timezone.utc
NOW = datetime(2024, 3, 1, 18, 0, tzinfo=UTC)

REFERENCE = 'CW8.PA'


def _follow(store, *symbols):
    """Follow the references, and display the first: what a PUT leaves behind."""
    symbols = symbols or (REFERENCE,)
    for key, value in (('benchmark_symbol', symbols[0]),
                       ('benchmark_symbols', ','.join(symbols))):
        store.execute("INSERT INTO setting (key, value) VALUES (?, ?) "
                      "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                      [key, value])


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
    # The split history, **established and empty** — which is a different fact
    # from never asked, and the one the comparison refuses to compute without.
    quotes.record_splits(store, symbol, {})


def _write_curve(store, account, first='2024-01-01', last='2024-02-29',
                 value=1000.0, cash=0.0):
    """The account's own curve — `holdings_value` is what #1018 compares."""
    store.execute('INSERT INTO account (id, label) VALUES (?, ?) '
                  'ON CONFLICT (id) DO NOTHING', [account, account])
    day = date.fromisoformat(first)
    end = date.fromisoformat(last)
    while day <= end:
        store.execute(
            'INSERT INTO account_metrics (account, day, holdings_value, '
            'total_value, cash_balance) VALUES (?, ?, ?, ?, ?)',
            [account, day, value, value + cash, cash])
        day += timedelta(days=1)


def _invest(day, account, amount, symbol='AAPL'):
    """Money into the securities, or — negative — money back out of them.

    A purchase on the way in; a **dividend** on the way out rather than a sale,
    because a sale has to own the shares it sells and the amount is all these
    tests are about. Both are the same signed flow to the replay (#1018).
    """
    if amount >= 0:
        return Event(date.fromisoformat(day), EventType.BUY, symbol, symbol,
                     quantity=amount, unit_price=1.0, account=account)
    return Event(date.fromisoformat(day), EventType.DIVIDEND, symbol, symbol,
                 amount=-amount, account=account)


@pytest.fixture
def named(store):
    """A store with the reference named, quoted and terminal."""
    _follow(store)
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
    assert 'reason' not in payload


def test_a_reference_still_backfilling_publishes_a_bar_and_no_figure(store):
    """The load-bearing rule of the whole ticket.

    A gap computed over a half-built series is a **wrong** number, not a short
    one: it reads −38 %, it sits beside a portfolio figure that is right, and
    it repairs itself an hour later. The figure and the right to display it
    ride on one payload so the two cannot disagree between two reads.
    """
    _follow(store)
    store.execute('INSERT INTO symbol (symbol) VALUES (?)', [REFERENCE])
    quotes.record_history(store, REFERENCE, [
        {'timestamp': datetime(2024, 2, 1, tzinfo=UTC), 'price': 100.0,
         'converted': 100.0, 'rate': 1.0}])
    _write_curve(store, 'pea')

    payload = benchmark_view.comparison(
        store, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.REBUILDING
    assert payload['rebuild']['symbol'] == REFERENCE
    # The later of the fund's inception (2009-06-16) and the ledger's first day:
    # the backfill stops there, so a bar aimed further back never fills.
    assert payload['rebuild']['target'] == '2024-01-01'
    assert 'gap_gross' not in payload
    assert 'reason' not in payload


def test_terminality_is_read_from_the_store_and_survives_a_restart(named):
    """`runtime_state.Recorder` is a per-process dict wiped on every boot.

    Built from it, the bar is empty on every restart of a job that runs for
    hours — and worse, the figure it gates would appear after one deploy and
    vanish on the next. Nothing here touches the recorder.
    """
    _write_curve(named, 'pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.READY


def test_a_perimeter_with_no_written_day_has_nothing_to_compare(named):
    """A reference fetched and an empty ledger is not an error state."""
    payload = benchmark_view.comparison(named, _snapshot([]), NOW)

    assert payload['state'] == benchmark_view.NOTHING_TO_COMPARE
    assert payload['reason'] == benchmark_view.NO_EVENTS
    assert 'per_account' not in payload


# --------------------------------------------------------------------------- #
# Why there is nothing to compare (#1207): only one cause is an empty ledger
# --------------------------------------------------------------------------- #

def test_events_the_perf_pass_has_not_written_yet_are_not_computed(named):
    """Right after an import: events, and no `account_metrics` row yet."""
    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.NOTHING_TO_COMPARE
    assert payload['reason'] == benchmark_view.NOT_COMPUTED


def test_written_days_with_nothing_held_name_that_and_not_the_ledger(named):
    """Days written, none with securities held while the fund was quoted."""
    _write_curve(named, 'pea', value=0.0, cash=1000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.NOTHING_TO_COMPARE
    assert payload['reason'] == benchmark_view.NOTHING_HELD


def test_an_account_seeded_on_a_close_with_no_rate_says_so(store):
    """Path 2c: the only account's seed day carries an unconverted close."""
    _follow(store)
    _quote_the_reference(store)
    quotes.record_history(store, REFERENCE, [
        {'timestamp': datetime(2024, 1, 2, tzinfo=UTC), 'price': 100.0,
         'converted': None, 'rate': None}])
    _write_curve(store, 'pea', first='2024-01-02')

    payload = benchmark_view.comparison(
        store, _snapshot([_invest('2024-01-02', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.NOTHING_TO_COMPARE
    assert payload['reason'] == benchmark_view.NO_RATE_ON_SEED


def test_a_whole_portfolio_with_no_seed_keeps_its_rows_and_says_why(
        named, monkeypatch):
    """Path 3: the accounts replayed, the merged replay did not.

    `_merged` seeds on a priced day, so this is forced rather than built; the
    branch stays, and it has to name its cause like the others.
    """
    _write_curve(named, 'pea')
    monkeypatch.setattr(benchmark_view, '_merged', lambda *_: None)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.NOTHING_TO_COMPARE
    assert payload['reason'] == benchmark_view.NO_RATE_ON_SEED
    assert [row['account'] for row in payload['per_account']] == ['pea']


def test_a_ready_comparison_carries_no_reason(named):
    """The cause belongs to `nothing_to_compare` alone."""
    _write_curve(named, 'pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.READY
    assert 'reason' not in payload


# --------------------------------------------------------------------------- #
# The gap
# --------------------------------------------------------------------------- #

def test_a_flat_reference_and_a_flat_portfolio_end_level(named):
    """The plainest comparison: nothing moved on either side."""
    _write_curve(named, 'pea', value=1000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['portfolio_value'] == pytest.approx(1000.0)
    assert payload['reference_value'] == pytest.approx(1000.0)
    assert payload['gap_gross'] == pytest.approx(0.0)
    assert payload['covered_from'] == '2024-01-01'
    assert payload['covered_to'] == '2024-02-29'


def test_a_deposit_that_never_bought_anything_stays_out_of_both_sides(named):
    """#1018's whole point, in one payload.

    Five hundred euros land in the account and buy nothing. The reference is
    handed the thousand that bought shares and not the fifteen hundred that
    arrived, so it is invested exactly when the owner was — and the cash sitting
    beside the securities is out of both sides rather than named in a footnote.
    """
    _write_curve(named, 'pea', value=1000.0, cash=500.0)

    payload = benchmark_view.comparison(
        named,
        _snapshot([Event(date(2024, 1, 1), EventType.DEPOSIT, None, None,
                         amount=1500.0, account='pea'),
                   _invest('2024-01-01', 'pea', 1000.0)]),
        NOW)

    assert payload['portfolio_value'] == pytest.approx(1000.0)
    assert payload['reference_value'] == pytest.approx(1000.0)
    assert payload['gap_gross'] == pytest.approx(0.0)
    # The cash was never published and is not silently loaded on either side.
    assert 'idle_cash' not in payload


def test_an_account_funded_weeks_before_it_buys_is_seeded_on_its_purchase(
        named):
    """#1025: the days a wrapper is open and empty are not a comparison.

    Every wrapper is opened by a deposit and buys days or weeks later, so since
    #1018 its first written days carry a `holdings_value` of `0.0`. Seeded
    there, the replay opens on nothing, reads it as an exhausted reference and
    closes the same day — and that one-day window ends the period for the
    whole perimeter, so a second account is enough to take the screen down to
    a single day over a ledger that has years in it.
    """
    _write_curve(named, 'pea', first='2024-01-01', last='2024-01-21',
                 value=0.0, cash=1000.0)
    _write_curve(named, 'pea', first='2024-01-22', last='2024-02-29',
                 value=1000.0)
    _write_curve(named, 'cto', first='2024-02-01', last='2024-02-29',
                 value=500.0)

    payload = benchmark_view.comparison(
        named,
        _snapshot([Event(date(2024, 1, 1), EventType.DEPOSIT, None, None,
                         amount=1000.0, account='pea'),
                   _invest('2024-01-22', 'pea', 1000.0),
                   _invest('2024-02-01', 'cto', 500.0)],
                  accounts=('pea', 'cto')),
        NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['covered_from'] == '2024-01-22'
    assert payload['covered_to'] == '2024-02-29'
    assert payload['gap_gross'] == pytest.approx(0.0)
    # And the account's own row runs from its first purchase, not from the
    # deposit: the three weeks it held cash are not days the reference ran.
    rows = {row['account']: row for row in payload['per_account']}
    assert rows['pea']['covered_from'] == '2024-01-22'
    assert rows['pea']['ended'] is None


def test_a_dividend_takes_the_same_money_out_of_the_reference(named):
    """The negative flow is what makes the rule hold.

    The money left the securities on the owner's side, so for both sides to
    keep the same euros deployed on the same days the reference has to take the
    same money out — `counterfactual.replay`'s existing withdrawal handling,
    and no new arithmetic. Two hundred out of a thousand at a flat hundred a
    share leaves eight hundred on each side.
    """
    _write_curve(named, 'pea', first='2024-01-01', last='2024-01-31',
                 value=1000.0)
    _write_curve(named, 'pea', first='2024-02-01', last='2024-02-29',
                 value=800.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0),
                          _invest('2024-02-01', 'pea', -200.0)]), NOW)

    assert payload['reference_value'] == pytest.approx(800.0)
    assert payload['gap_gross'] == pytest.approx(0.0)


def test_the_two_returns_share_the_denominator_they_are_compared_on(named):
    """Both sides ran the same flows from the same seed, so both fractions have
    the same bottom — otherwise the difference of two returns is not the gap
    the head figure states four lines up."""
    _write_curve(named, 'pea', first='2024-01-01', last='2024-01-31',
                 value=1000.0)
    _write_curve(named, 'pea', first='2024-02-01', last='2024-02-29',
                 value=1500.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['portfolio_return'] == pytest.approx(0.5)
    assert payload['reference_return'] == pytest.approx(0.0)


def test_the_period_runs_from_the_first_account_to_the_last_measured_day(
        named):
    """The earliest of the starts and the earliest of the ends.

    The head replays every euro put into securities, so it starts with the
    first account to hold any — an account opened in February simply has no
    money in either side in January. The end still binds on every account: a
    figure summed over a day one of its terms was not measured on is a total
    missing a term, which is not a smaller total.
    """
    _write_curve(named, 'pea', first='2024-01-01', last='2024-02-29')
    _write_curve(named, 'cto', first='2024-02-01', last='2024-02-20')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0),
                          _invest('2024-02-01', 'cto', 500.0)],
                         accounts=('pea', 'cto')), NOW)

    assert payload['covered_from'] == '2024-01-01'
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
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0),
                          _invest('2024-02-01', 'pea', -5000.0)]), NOW)

    assert payload['ended'] == counterfactual.EXHAUSTED
    assert payload['covered_to'] == '2024-02-01'


def test_a_reference_a_day_behind_ends_the_comparison_on_its_last_close(
        store):
    """#1050: the reference is backfilled, the portfolio is scraped.

    The reference's last close is yesterday's while the portfolio is written
    through today. Carried forward, that close would put today's live portfolio
    against an index standing still — so the comparison ends on the last day
    both sides were measured, and the period printed under it says so.
    """
    _follow(store)
    _quote_the_reference(store, last='2024-02-28')
    _write_curve(store, 'pea', last='2024-02-28', value=1000.0)
    _write_curve(store, 'pea', first='2024-02-29', last='2024-02-29',
                 value=1200.0)

    payload = benchmark_view.comparison(
        store, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['covered_to'] == '2024-02-28'
    assert payload['portfolio_value'] == pytest.approx(1000.0)
    assert payload['gap_gross'] == pytest.approx(0.0)
    assert payload['series'][-1]['t'] == '2024-02-28'
    assert payload['per_account'][0]['covered_to'] == '2024-02-28'
    assert payload['per_account'][0]['portfolio_value'] == pytest.approx(1000.0)


def test_a_trailing_close_awaiting_its_rate_still_says_why_it_ended(store):
    """#1050's bound must not swallow `AWAITING_RATE`.

    The last close is stored and has no rate yet. Bounded on the converted
    closes alone, the window would end the evening before it and the period
    would read as complete; reaching it, the replay names what it waits for.
    """
    _follow(store)
    _quote_the_reference(store, last='2024-02-28')
    quotes.record_history(store, REFERENCE, [
        {'timestamp': datetime(2024, 2, 29, tzinfo=UTC), 'price': 100.0,
         'converted': None, 'rate': None}])
    _write_curve(store, 'pea', value=1000.0)

    payload = benchmark_view.comparison(
        store, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['covered_to'] == '2024-02-28'
    assert payload['ended'] == counterfactual.AWAITING_RATE
    assert payload['per_account'][0]['ended'] == counterfactual.AWAITING_RATE


def test_the_curves_are_published_on_one_day_axis(named):
    """The chart reads the area between them as the gap, so they share days."""
    _write_curve(named, 'pea', value=1000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['series'][0] == {'t': '2024-01-01', 'portfolio': 1000.0,
                                    'reference': 1000.0}
    assert len(payload['series']) == 60          # every calendar day of Jan+Feb


# --------------------------------------------------------------------------- #
# The perimeter
# --------------------------------------------------------------------------- #

def test_a_grant_at_no_declared_price_is_the_portfolio_s_edge(named):
    """A free share is not replayed: the reference is handed nothing that day.

    Leaving the price blank declares a grant that cost nothing, and the
    comparison takes it at its word. The account stays in the perimeter, the
    portfolio keeps the shares, and their value is a gap in its favour — which
    is what free shares are.
    """
    _write_curve(named, 'pea', last='2024-01-14', value=1000.0)
    _write_curve(named, 'pea', first='2024-01-15', value=1300.0)
    granted = Event(date(2024, 1, 15), EventType.GRANT, 'AAPL', 'Apple',
                    quantity=3, account='pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0), granted]),
        NOW)

    assert payload['state'] == benchmark_view.READY
    assert 'excluded_accounts' not in payload
    assert payload['accounts'] == ['pea']
    assert payload['reference_value'] == pytest.approx(1000.0)
    assert payload['portfolio_value'] == pytest.approx(1300.0)
    assert payload['gap_gross'] == pytest.approx(300.0)


def _grant(day, account, quantity=3, unit_price=None):
    return Event(date.fromisoformat(day), EventType.GRANT, 'AAPL', 'Apple',
                 quantity=quantity, unit_price=unit_price, account=account)


def test_a_grant_at_a_declared_price_is_still_replayed_into_the_reference(
        named):
    """#1194 changes nothing for a priced grant: it enters at its value, so
    the reference is bought the same shares and there is no edge."""
    _write_curve(named, 'pea', last='2024-01-14', value=1000.0)
    _write_curve(named, 'pea', first='2024-01-15', value=1300.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0),
                          _grant('2024-01-15', 'pea', unit_price=100.0)]),
        NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['reference_value'] == pytest.approx(1300.0)
    assert payload['gap_gross'] == pytest.approx(0.0)


def test_a_free_grant_that_opens_the_pot_is_seeded_like_any_first_holding(
        named):
    """#1194: the seed-day rule stands — the grant is **not** the owner's edge.

    The pot starts on the first day it holds anything, and the seed is that
    day's closing `holdings_value`, granted shares included. The reference is
    seeded with the same value, so the day carries no gap; the purchase that
    follows is replayed as usual. A grant *after* the seed day is the edge
    (see above) — the asymmetry is the cost of not repricing granted lots.
    """
    _write_curve(named, 'pea', last='2024-01-09', value=300.0)
    _write_curve(named, 'pea', first='2024-01-10', value=1300.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_grant('2024-01-01', 'pea'),
                          _invest('2024-01-10', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['series'][0] == {'t': '2024-01-01', 'portfolio': 300.0,
                                    'reference': 300.0}
    assert payload['reference_value'] == pytest.approx(1300.0)
    assert payload['gap_gross'] == pytest.approx(0.0)


def test_an_account_holding_only_free_shares_is_compared_on_their_value(
        named):
    """Seeded on the grant's value, so it replays and does not vanish."""
    _write_curve(named, 'pea', value=300.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_grant('2024-01-01', 'pea')]), NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['accounts'] == ['pea']
    assert payload['reference_value'] == pytest.approx(300.0)
    assert payload['gap_gross'] == pytest.approx(0.0)


def test_the_shared_period_seeds_a_late_free_grant_account_on_its_value(
        named):
    """The head follows the same rule: the later account's pot enters the
    shared reference at its seed-day value, free shares included."""
    _write_curve(named, 'pea', value=1000.0)
    _write_curve(named, 'cto', first='2024-01-20', value=300.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0),
                          _grant('2024-01-20', 'cto')],
                         accounts=('pea', 'cto')), NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['accounts'] == ['cto', 'pea']
    assert payload['reference_value'] == pytest.approx(1300.0)
    assert payload['portfolio_value'] == pytest.approx(1300.0)
    assert sum(row['gap_gross'] for row in payload['per_account']) == (
        pytest.approx(payload['gap_gross']))


def test_a_reference_whose_splits_were_never_read_publishes_no_figure(named):
    """The defect a store in circulation would have shipped with.

    It fetched this symbol before #760 persisted the ratios, so it holds zero
    rows — indistinguishable from a symbol that never split. A replay taking
    the first for the second walks through a four-for-one and divides the
    holding by four, silently, beside a portfolio figure that is right. Same
    class as a gap over a half-built series, so the same answer: no figure.
    """
    named.execute("UPDATE symbol_quote SET splits_read_at = NULL "
                  "WHERE symbol = ?", [REFERENCE])
    _write_curve(named, 'pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.SPLITS_UNKNOWN
    assert 'gap_gross' not in payload
    assert 'reason' not in payload
    assert payload['rebuild']['symbol'] == REFERENCE


def test_the_next_fetch_establishes_the_history_and_the_figure_returns(named):
    """The state repairs itself, and by the ordinary cycle rather than a chore."""
    named.execute("UPDATE symbol_quote SET splits_read_at = NULL "
                  "WHERE symbol = ?", [REFERENCE])
    _write_curve(named, 'pea')
    snapshot = _snapshot([_invest('2024-01-01', 'pea', 1000.0)])

    assert benchmark_view.comparison(
        named, snapshot, NOW)['state'] == benchmark_view.SPLITS_UNKNOWN

    quotes.record_splits(named, REFERENCE, {})

    assert benchmark_view.comparison(
        named, snapshot, NOW)['state'] == benchmark_view.READY


def test_the_fund_is_blamed_for_a_short_period_only_when_it_is_the_cause(named):
    """Two truncations, one date, two sentences — and the wrong one misleads.

    A comparison that starts in 2024 because the fund launched then, and one
    that starts in 2024 because the account did, look identical on screen. Told
    it is *this fund's first close*, an owner whose fund has been quoted since
    2009 goes looking for a history that is sitting right there.
    """
    # The account opens well after the fund's first quoted day here.
    _write_curve(named, 'pea', first='2024-02-01', last='2024-02-29')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-02-01', 'pea', 1000.0)]), NOW)

    assert payload['portfolio_from'] == '2024-02-01'
    assert payload['truncated_by_fund'] is False


def test_the_fund_is_named_when_the_portfolio_predates_it(named):
    """The other half: the perimeter was written before the fund was quoted."""
    _write_curve(named, 'pea', first='2023-06-01', last='2024-02-29')
    # The backward pass has tried past the ledger's own first day and found
    # nothing older — which is what *finished* means for a fund younger than
    # the portfolio, and the only way this state is reachable at all.
    quotes.record_window_tried(named, REFERENCE, date(2023, 6, 1))

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2023-06-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['portfolio_from'] == '2023-06-01'
    assert payload['truncated_by_fund'] is True
    assert payload['covered_from'] == '2024-01-01'


def test_nothing_followed_is_no_reference_even_with_a_displayed_choice_stored(
        store):
    """`NO_REFERENCE` means nothing is followed: the choice alone is not enough."""
    store.execute("INSERT INTO setting (key, value) VALUES "
                  "('benchmark_symbol', ?)", [REFERENCE])

    payload = benchmark_view.comparison(store, _snapshot([]), NOW)

    assert payload['state'] == benchmark_view.NO_REFERENCE
    assert payload['followed'] == [] and payload['ready'] == []


def test_the_page_falls_back_to_the_first_ready_followed_reference(named):
    """The choice that is not ready (or not followed) is not displayed."""
    _follow(named, 'CSPX.AS', REFERENCE)       # chosen: CSPX.AS, never quoted
    _write_curve(named, 'pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['reference'] == REFERENCE
    assert payload['followed'] == ['CSPX.AS', REFERENCE]
    assert payload['ready'] == [REFERENCE]
    assert payload['state'] == benchmark_view.READY


def test_followed_with_none_ready_names_the_one_being_downloaded(store):
    _follow(store, 'CSPX.AS', REFERENCE)

    payload = benchmark_view.comparison(
        store, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.REBUILDING
    assert payload['reference'] == 'CSPX.AS'
    assert payload['ready'] == []


def test_followed_on_an_empty_ledger_has_nothing_to_compare(store):
    _follow(store)

    payload = benchmark_view.comparison(store, _snapshot([]), NOW)

    assert payload['state'] == benchmark_view.NOTHING_TO_COMPARE
    assert payload['reason'] == benchmark_view.NO_EVENTS


def test_complete_is_the_comparison_gate_and_not_a_full_ratio(named):
    """A ledger starting in 2024 completes a fund quoted since 2009."""
    snapshot = _snapshot([_invest('2024-01-01', 'pea', 1000.0)])

    assert benchmark_view.ready(named, snapshot, REFERENCE, NOW) is True
    assert benchmark_view.ready(named, snapshot, 'CSPX.AS', NOW) is False
    # And not before the splits were read, even on a terminal, priced series.
    named.execute('UPDATE symbol_quote SET splits_read_at = NULL '
                  'WHERE symbol = ?', [REFERENCE])
    assert benchmark_view.ready(named, snapshot, REFERENCE, NOW) is False


def test_downloads_run_one_at_a_time_in_the_order_they_were_turned_on(named):
    _follow(named, 'CSPX.AS', REFERENCE, 'C40.PA')
    snapshot = _snapshot([_invest('2024-01-01', 'pea', 1000.0)])

    complete, downloading = benchmark_view.downloads(named, snapshot, NOW)

    assert complete == [REFERENCE]
    assert downloading == 'CSPX.AS'      # not C40.PA, which waits its turn


def test_the_references_say_why_an_incomplete_one_is_not_moving(named):
    _follow(named, 'CSPX.AS', REFERENCE, 'C40.PA')
    snapshot = _snapshot([_invest('2024-01-01', 'pea', 1000.0)])

    rows = {row['symbol']: row
            for row in benchmark_view.references(named, snapshot, NOW)}

    assert list(rows) == ['CW8.PA', 'CSPX.AS', 'MSE.PA', 'C40.PA', 'AEEM.PA']
    assert rows[REFERENCE]['ready'] and rows[REFERENCE]['waiting'] is None
    assert rows['CSPX.AS']['waiting'] is None and not rows['CSPX.AS']['ready']
    assert rows['C40.PA']['waiting'] == 'queued'
    assert rows['C40.PA']['after'] == 'CSPX.AS'
    assert rows['MSE.PA']['followed'] is False
    assert rows['MSE.PA']['waiting'] is None


def test_an_empty_ledger_downloads_nothing_and_says_so(store):
    _follow(store)

    rows = benchmark_view.references(store, _snapshot([]), NOW)

    assert rows[0]['waiting'] == benchmark_view.NO_EVENTS
    assert rows[0]['ratio'] is None


def test_a_withdrawal_one_account_could_not_fund_is_funded_by_the_others(
        named):
    """The money is the owner's, not the wrapper's.

    `pea`'s own reference holds 1 000 € when 1 500 € leave it: its row ends
    there, exhausted, and says so. The head holds both accounts' money in one
    reference — 2 000 € — so it funds the withdrawal and runs to the end.
    """
    _write_curve(named, 'pea', first='2024-01-01', last='2024-01-31',
                 value=1000.0)
    _write_curve(named, 'pea', first='2024-02-01', last='2024-02-29',
                 value=0.0)
    _write_curve(named, 'cto', value=1000.0)

    payload = benchmark_view.comparison(
        named,
        _snapshot([_invest('2024-01-01', 'pea', 1000.0),
                   _invest('2024-02-01', 'pea', -1500.0),
                   _invest('2024-01-01', 'cto', 1000.0)],
                  accounts=('pea', 'cto')),
        NOW)

    rows = {row['account']: row for row in payload['per_account']}
    assert rows['pea']['ended'] == counterfactual.EXHAUSTED
    assert payload['ended'] is None
    assert payload['covered_to'] == '2024-02-29'
    # A flat fund: 2 000 € in, 1 500 € out.
    assert payload['reference_value'] == pytest.approx(500.0)
    assert payload['portfolio_value'] == pytest.approx(1000.0)


def test_an_account_opened_after_the_period_ends_is_in_neither_side(named):
    """The end binds on every account, so a later one can fall past it.

    `old` was measured through 20 January only, which ends the period there;
    `new` bought its first securities on 1 February. Its money is in neither
    side of the head, the period printed under it says where it stops, and its
    own row still answers it.
    """
    _write_curve(named, 'old', first='2024-01-01', last='2024-01-20')
    _write_curve(named, 'new', first='2024-02-01', last='2024-02-29')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'old', 1000.0),
                          _invest('2024-02-01', 'new', 1000.0)],
                         accounts=('old', 'new')), NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['accounts'] == ['old']
    assert payload['covered_from'] == '2024-01-01'
    assert payload['covered_to'] == '2024-01-20'
    assert payload['reference_value'] == pytest.approx(1000.0)
    assert [row['account'] for row in payload['per_account']] == ['new', 'old']
    assert payload['per_account'][0]['covered_from'] == '2024-02-01'


def test_the_end_reason_belongs_to_the_account_that_ended_the_period(named):
    """An account that ran out *after* the boundary did not stop anything.

    The period closes at the earliest end. Naming a later account's reason
    against that day tells the owner a withdrawal emptied the reference on a
    day nothing happened — the same mistake as blaming the fund for a
    truncation its accounts caused.
    """
    # `short` simply has fewer written days and ends naturally on 10 February.
    _write_curve(named, 'short', first='2024-01-01', last='2024-02-10')
    # `long` runs to the end of the window and exhausts its reference *later*.
    _write_curve(named, 'long', first='2024-01-01', last='2024-02-29')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'short', 1000.0),
                          _invest('2024-01-01', 'long', 1000.0),
                          _invest('2024-02-20', 'long', -5000.0)],
                         accounts=('short', 'long')), NOW)

    assert payload['covered_to'] == '2024-02-10'
    assert payload['ended'] is None


# --------------------------------------------------------------------------- #
# A reference that moves
# --------------------------------------------------------------------------- #

def _double_the_reference_in_february(store):
    """A hundred through January, two hundred through February.

    A flat fund values every schedule the same, which is exactly the series
    that cannot tell a working comparison from a broken one.
    """
    quotes.record_history(store, REFERENCE, [
        {'timestamp': datetime.combine(day, datetime.min.time(), tzinfo=UTC),
         'price': 200.0, 'converted': 200.0, 'rate': 1.0}
        for day in (date(2024, 2, 1) + timedelta(days=n) for n in range(29))])


# --------------------------------------------------------------------------- #
# Each account's own window (#1014)
# --------------------------------------------------------------------------- #

def test_a_younger_account_shortens_neither_the_head_nor_the_older_row(named):
    """Opening a second account is an ordinary act.

    `pea` has run since 1 January and `cto` since 1 February. Neither the head
    nor the PEA's row loses January: the head starts with the first money in,
    and each row with its own.
    """
    _write_curve(named, 'pea', first='2024-01-01', last='2024-02-29')
    _write_curve(named, 'cto', first='2024-02-01', last='2024-02-29')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0),
                          _invest('2024-02-01', 'cto', 500.0)],
                         accounts=('pea', 'cto')), NOW)

    assert payload['covered_from'] == '2024-01-01'
    rows = {row['account']: row for row in payload['per_account']}
    assert rows['pea']['covered_from'] == '2024-01-01'
    assert rows['cto']['covered_from'] == '2024-02-01'
    assert [row['covered_to'] for row in payload['per_account']] == [
        '2024-02-29', '2024-02-29']


def test_a_row_is_read_on_its_own_last_day_and_not_on_the_covered_one(named):
    """No all-or-nothing rule: a row is not a term of a sum.

    `short` stops on 10 February and closes the aggregate there. `long` ran to
    the 29th and its row says so — including the 500 € it received on the 20th,
    which the aggregate is right to leave out of its own denominator.
    """
    _write_curve(named, 'short', first='2024-01-01', last='2024-02-10')
    _write_curve(named, 'long', first='2024-01-01', last='2024-02-29')

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'short', 1000.0),
                          _invest('2024-01-01', 'long', 1000.0),
                          _invest('2024-02-20', 'long', 500.0)],
                         accounts=('short', 'long')), NOW)

    assert payload['covered_to'] == '2024-02-10'
    rows = {row['account']: row for row in payload['per_account']}
    assert rows['long']['covered_to'] == '2024-02-29'
    # A flat fund: the reference ends at what went into it, seed included.
    assert rows['long']['reference_value'] == pytest.approx(1500.0)
    assert rows['short']['reference_value'] == pytest.approx(1000.0)
    # And the aggregate's denominator still stops at the covered day.
    assert payload['reference_value'] == pytest.approx(2000.0)


def test_a_row_says_why_its_own_period_ended_early(named):
    """The aggregate names the boundary account's reason; a row names its own.

    `pea` empties its reference on 1 February and `cto` runs to the end. The
    aggregate stops on the 1st — and the row that stopped it is the only one
    carrying `exhausted`, so a reader cannot take the aggregate's reason for
    the other account's.
    """
    _write_curve(named, 'pea', value=1000.0)
    _write_curve(named, 'cto', value=1000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0),
                          _invest('2024-02-01', 'pea', -5000.0),
                          _invest('2024-01-01', 'cto', 1000.0)],
                         accounts=('pea', 'cto')), NOW)

    rows = {row['account']: row for row in payload['per_account']}
    assert rows['pea']['ended'] == counterfactual.EXHAUSTED
    assert rows['pea']['covered_to'] == '2024-02-01'
    assert rows['cto']['ended'] is None
    assert rows['cto']['covered_to'] == '2024-02-29'


def test_a_row_carries_the_gap_and_the_two_returns_of_its_own_account(named):
    """The three figures the screen reads, on the account's own denominator.

    The portfolio doubles to 2 000 € against a flat fund holding 1 000 €: the
    row is ahead by a thousand, +100 % against 0 %.
    """
    _write_curve(named, 'pea', first='2024-01-01', last='2024-01-31',
                 value=1000.0)
    _write_curve(named, 'pea', first='2024-02-01', last='2024-02-29',
                 value=2000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0)]), NOW)

    row, = payload['per_account']
    assert row['portfolio_value'] == pytest.approx(2000.0)
    assert row['gap_gross'] == pytest.approx(1000.0)
    assert row['portfolio_return'] == pytest.approx(1.0)
    assert row['reference_return'] == pytest.approx(0.0)


# --------------------------------------------------------------------------- #
# The head is the sum of the rows
# --------------------------------------------------------------------------- #

def test_the_rows_add_up_to_the_head(named):
    """The table under the head is read as its breakdown, so it has to be one.

    `pea` holds 1 000 € of flat securities since 1 January and the fund
    doubles on 1 February, the day `cto` puts 500 € in. The PEA's January is
    inside the head — the owner's money, in the owner's portfolio — so the
    PEA is a thousand euros behind on its row and on the head alike, and the
    CTO, opened at the new price, is level.
    """
    _double_the_reference_in_february(named)
    _write_curve(named, 'pea', first='2024-01-01', last='2024-02-29',
                 value=1000.0)
    _write_curve(named, 'cto', first='2024-02-01', last='2024-02-29',
                 value=500.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0),
                          _invest('2024-02-01', 'cto', 500.0)],
                         accounts=('pea', 'cto')), NOW)

    assert payload['covered_from'] == '2024-01-01'
    assert payload['reference_value'] == pytest.approx(2500.0)
    assert payload['gap_gross'] == pytest.approx(-1000.0)
    rows = {row['account']: row for row in payload['per_account']}
    assert rows['pea']['gap_gross'] == pytest.approx(-1000.0)
    assert rows['cto']['gap_gross'] == pytest.approx(0.0)
    for term in ('portfolio_value', 'reference_value', 'gap_gross'):
        assert sum(row[term] for row in payload['per_account']) == (
            pytest.approx(payload[term]))
    # Both sides open on the same euro, on the first day of the period.
    first = payload['series'][0]
    assert first['t'] == '2024-01-01'
    assert first['reference'] == pytest.approx(first['portfolio'])


def test_an_account_opened_on_a_closed_market_enters_at_its_own_price(named):
    """It buys the reference where its own row did, or the two disagree.

    `cto` buys on 3 February, a day the fund has no close, and the fund has
    doubled by its next close on the 4th. The row's replay lands the seed on
    that next quoted day, at 200. Carried in at the 2nd's 100 instead, the head
    would hold twice the shares the row does.
    """
    named.execute('DELETE FROM price_point WHERE symbol = ? '
                  'AND CAST(ts AS DATE) >= ?', [REFERENCE, date(2024, 2, 3)])
    quotes.record_history(named, REFERENCE, [
        {'timestamp': datetime.combine(day, datetime.min.time(), tzinfo=UTC),
         'price': 200.0, 'converted': 200.0, 'rate': 1.0}
        for day in (date(2024, 2, 4) + timedelta(days=n) for n in range(26))])
    _write_curve(named, 'pea', value=1000.0)
    _write_curve(named, 'cto', first='2024-02-03', last='2024-02-29',
                 value=500.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_invest('2024-01-01', 'pea', 1000.0),
                          _invest('2024-02-03', 'cto', 500.0)],
                         accounts=('pea', 'cto')), NOW)

    rows = {row['account']: row for row in payload['per_account']}
    assert rows['cto']['reference_value'] == pytest.approx(500.0)
    assert payload['reference_value'] == pytest.approx(
        rows['pea']['reference_value'] + 500.0)
    assert sum(row['gap_gross'] for row in payload['per_account']) == (
        pytest.approx(payload['gap_gross']))


def test_an_unfollowed_series_is_kept_until_the_owner_stops_keeping_it(named):
    from application import ledger
    snapshot = _snapshot([_invest('2024-01-01', 'pea', 1000.0)])
    named.execute("INSERT INTO setting (key, value) VALUES "
                  "('benchmark_symbols', '')  ON CONFLICT (key) "
                  "DO UPDATE SET value = excluded.value")
    ledger.record_consulted_benchmark(named, REFERENCE)

    row = benchmark_view.references(named, snapshot, NOW)[0]
    assert (row['followed'], row['kept'], row['freed']) == (False, True, False)

    ledger.forget_consulted_benchmark(named, REFERENCE)
    row = benchmark_view.references(named, snapshot, NOW)[0]
    assert (row['kept'], row['freed']) == (False, True)
    # Nothing downloaded, nothing to keep or to release.
    assert benchmark_view.references(named, snapshot, NOW)[1]['freed'] is False
