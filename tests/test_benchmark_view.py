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
    # The split history, **established and empty** — which is a different fact
    # from never asked, and the one the comparison refuses to compute without.
    quotes.record_splits(store, symbol, {})


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


def _flat_model_on(store, account, rate=0.3):
    """Attach a second account to the model the first one created."""
    model = accounts_module.read_models(store)[0]
    accounts_module.set_taxation_model(store, account, model.id)
    return model


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
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.SPLITS_UNKNOWN
    assert 'gap_gross' not in payload
    assert payload['rebuild']['symbol'] == REFERENCE


def test_the_next_fetch_establishes_the_history_and_the_figure_returns(named):
    """The state repairs itself, and by the ordinary cycle rather than a chore."""
    named.execute("UPDATE symbol_quote SET splits_read_at = NULL "
                  "WHERE symbol = ?", [REFERENCE])
    _write_curve(named, 'pea')
    snapshot = _snapshot([_deposit('2024-01-01', 'pea', 1000.0)])

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
        named, _snapshot([_deposit('2024-02-01', 'pea', 1000.0)]), NOW)

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
        named, _snapshot([_deposit('2023-06-01', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['portfolio_from'] == '2023-06-01'
    assert payload['truncated_by_fund'] is True
    assert payload['covered_from'] == '2024-01-01'


def test_an_off_list_reference_gets_no_progress_bar_it_cannot_honour(named):
    """`PUT /api/settings` stays open, so the screen meets tickers off the list.

    `oldest_window_tried` is where the backward pass has **got to**, not where
    it is going: it moves with the series, so a ratio taken against it reads
    full from the first chunk and stays there. An owner would watch a finished
    bar wait for a figure that is hours away. Better no bar than a lying one.
    """
    named.execute("INSERT INTO setting (key, value) VALUES "
                  "('benchmark_symbol', 'IWDA.AS') "
                  "ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    named.execute("INSERT INTO symbol (symbol) VALUES ('IWDA.AS')")
    _quote_the_reference(named, first='2024-02-20', last='2024-02-29',
                         symbol='IWDA.AS')
    _write_curve(named, 'pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0)]), NOW)

    assert payload['index'] is None          # off the list, and rendered anyway
    assert payload['state'] == benchmark_view.REBUILDING
    assert payload['rebuild']['target'] is None
    assert payload['rebuild']['ratio'] is None
    assert payload['rebuild']['reached'] == '2024-02-20'


def test_an_account_that_ended_early_closes_the_period_for_every_term(named):
    """The aggregate reads each account **on the covered day**, not on its own.

    One account's reference is exhausted in February while the other runs to
    the end. The period stops at the earlier date, and a term taken from the
    longer replay's last day would mix in months the screen says are not in
    the comparison — the contribution behind the return, and the gain the tax
    rests on.
    """
    _write_curve(named, 'pea', value=1000.0)
    _write_curve(named, 'cto', value=1000.0)
    _flat_model(named, 'pea')
    _flat_model_on(named, 'cto')

    payload = benchmark_view.comparison(
        named,
        _snapshot([_deposit('2024-01-01', 'pea', 1000.0),
                   # Empties the reference on 1 February, closing the period.
                   _deposit('2024-02-01', 'pea', -5000.0),
                   _deposit('2024-01-01', 'cto', 1000.0),
                   # Paid in *after* the period ends: must not reach any term.
                   _deposit('2024-02-15', 'cto', 10_000.0)],
                  accounts=('pea', 'cto')),
        NOW)

    assert payload['ended'] == counterfactual.EXHAUSTED
    assert payload['covered_to'] == '2024-02-01'
    # Two accounts seeded at 1 000 €, and the February contribution is outside
    # the period — so the denominator is 2 000 € and not 12 000 €.
    assert payload['reference_value'] == pytest.approx(2000.0)
    assert payload['portfolio_return'] == pytest.approx(0.0)


def test_two_accounts_whose_periods_never_overlap_have_nothing_to_compare(named):
    """An intersection can be empty, and then there is no period to sum over.

    One account closed in January, another opened in February: the latest start
    falls after the earliest end. Every term would be read at a day one of them
    never lived, and the screen would state a period running backwards.
    """
    _write_curve(named, 'old', first='2024-01-01', last='2024-01-20')
    _write_curve(named, 'new', first='2024-02-01', last='2024-02-29')

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'old', 1000.0),
                          _deposit('2024-02-01', 'new', 1000.0)],
                         accounts=('old', 'new')), NOW)

    assert payload['state'] == benchmark_view.NOTHING_TO_COMPARE
    assert 'gap_gross' not in payload


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
        named, _snapshot([_deposit('2024-01-01', 'short', 1000.0),
                          _deposit('2024-01-01', 'long', 1000.0),
                          _deposit('2024-02-20', 'long', -5000.0)],
                         accounts=('short', 'long')), NOW)

    assert payload['covered_to'] == '2024-02-10'
    assert payload['ended'] is None


def test_no_net_when_the_portfolio_kept_living_past_the_covered_day(named):
    """The two assiettes would be months apart, so neither is published.

    `positions` and `symbol_quote` hold the portfolio as it stands, not as it
    stood: there is no per-day cost basis in this store. While the period runs
    to the portfolio's own last written day the two dates coincide — every
    ordinary comparison — and when it does not, taxing one side today and the
    other in February and publishing the difference is the kind of figure
    nobody can check.
    """
    _write_curve(named, 'pea', first='2024-01-01', last='2024-02-29')
    _flat_model(named, 'pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0),
                          # Closes the period on 1 February; the ledger and the
                          # curve run on to the 29th.
                          _deposit('2024-02-01', 'pea', -5000.0)]), NOW)

    assert payload['covered_to'] == '2024-02-01'
    assert payload['gap_net'] is None
    assert payload['net_unavailable'] == [
        {'account': 'pea', 'reason': 'basis_after_period'}]
    # The gross side is untouched: it reads both curves on the covered day.
    assert payload['gap_gross'] is not None


# --------------------------------------------------------------------------- #
# The decomposition (#983)
# --------------------------------------------------------------------------- #

def _double_the_reference_in_february(store):
    """A hundred through January, two hundred through February.

    A flat fund makes every schedule agree, which is exactly the series that
    cannot tell a working decomposition from a broken one.
    """
    quotes.record_history(store, REFERENCE, [
        {'timestamp': datetime.combine(day, datetime.min.time(), tzinfo=UTC),
         'price': 200.0, 'converted': 200.0, 'rate': 1.0}
        for day in (date(2024, 2, 1) + timedelta(days=n) for n in range(29))])


def test_the_dates_are_worth_what_the_schedule_would_not_have_caught(named):
    """The third replay, hand-computed end to end.

    The seed buys ten shares at a hundred on 1 January. A thousand euros land
    on the 15th, still at a hundred: ten more shares. The smoothed schedule
    holds one instalment — 1 February, the only month-end inside the window —
    and by then the fund costs two hundred, so the same thousand buys five.
    Twenty shares against fifteen, at two hundred on the last covered day: four
    thousand against three, and the thousand euros of difference is what the
    **dates** earned.

    `gap_gross` is the other half and is untouched by any of this: same dates,
    same flows, different securities.
    """
    _double_the_reference_in_february(named)
    _write_curve(named, 'pea', value=1000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0),
                          _deposit('2024-01-15', 'pea', 1000.0)]), NOW)

    assert payload['state'] == benchmark_view.READY
    assert payload['reference_value'] == pytest.approx(4000.0)
    assert payload['smoothed_value'] == pytest.approx(3000.0)
    assert payload['date_effect'] == pytest.approx(1000.0)


def test_a_schedule_the_owner_already_follows_earns_nothing(named):
    """The fixed point, read on the payload rather than on the primitive.

    One deposit, on the window's only month-end: smoothing it moves nothing,
    so the whole gap belongs to the securities and the screen says the dates
    cost zero rather than saying nothing about them.
    """
    _double_the_reference_in_february(named)
    _write_curve(named, 'pea', value=1000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0),
                          _deposit('2024-02-01', 'pea', 1000.0)]), NOW)

    assert payload['date_effect'] == pytest.approx(0.0)
    assert payload['smoothed_value'] == pytest.approx(
        payload['reference_value'])


def test_the_dates_are_taxed_through_the_same_model_as_the_two_other_sides(named):
    """The toggle governs all three replays or it lies about one of them.

    Four thousand against three on the same wrapper: the real dates carry two
    thousand of latent gain and the schedule one, so a flat thirty per cent
    takes six hundred against three hundred and the dates are worth seven
    hundred net of the wrapper rather than a thousand. A net averaged out of
    one rate would answer a thousand times zero-seven and be wrong the moment
    the ladder stops being flat.
    """
    _double_the_reference_in_february(named)
    _write_curve(named, 'pea', value=1000.0)
    _flat_model(named, 'pea')

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0),
                          _deposit('2024-01-15', 'pea', 1000.0)]), NOW)

    assert payload['net_unavailable'] == []
    assert payload['reference_tax'] == pytest.approx(600.0)
    assert payload['smoothed_tax'] == pytest.approx(300.0)
    assert payload['date_effect_net'] == pytest.approx(700.0)


def test_no_model_takes_the_net_side_of_the_dates_with_it(named):
    """Same all-or-nothing rule as `gap_net`, and the gross survives it."""
    _double_the_reference_in_february(named)
    _write_curve(named, 'pea', value=1000.0)

    payload = benchmark_view.comparison(
        named, _snapshot([_deposit('2024-01-01', 'pea', 1000.0),
                          _deposit('2024-01-15', 'pea', 1000.0)]), NOW)

    assert payload['smoothed_tax'] is None
    assert payload['date_effect_net'] is None
    assert payload['date_effect'] == pytest.approx(1000.0)
