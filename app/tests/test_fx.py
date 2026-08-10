"""The reporting currency and the rate that reaches it (issue #702, ADR-0002).

Two halves, and they are tested at two different heights on purpose.

The **pure module** (:mod:`fx`) is tested the way :mod:`scheduling` and
:mod:`performance` are: with literals and an injected fetch, no store and no
network. What earns a test here is what would be silently wrong rather than
loudly broken — ``GBp`` off by a factor of a hundred, a wave of symbols
converted at N different rates, a rate borrowed across a gap.

The **wiring** is tested on a real store with a faked yfinance, which is the
v5 seam (spec #695): the assertion is on the row that landed, never on the fact
that a method was called. The three cases the ticket names are here — a position
quoted in ``GBp``, a position whose rate cannot be had, and the passage from
*"no reporting currency"* to *"one is answered"*.
"""
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

import pytest

import fx
import main
import quotes
import settings as settings_module
import settings_registry


UTC = timezone.utc
NOW = datetime(2024, 6, 3, 15, 30, tzinfo=UTC)


# =========================================================================== #
# The pure module
# =========================================================================== #

class _Clock:
    """A hand-wound clock, so a TTL is tested without sleeping through one."""

    def __init__(self, at=0.0):
        self.at = at

    def __call__(self):
        return self.at


class _Fetch:
    """A counting fetch — the injection point, and what the TTL is measured on."""

    def __init__(self, answers=None):
        self.answers = answers or {}
        self.calls = []

    def __call__(self, pair):
        self.calls.append(pair)
        return self.answers.get(pair)


# --- GBp, the one that is wrong by a hundred -------------------------------- #

def test_gbp_pence_is_normalised_before_any_pair_is_named():
    """`GBpEUR=X` does not exist, and asking for it is wrong by a factor of 100.

    The normalisation happens *before* the lookup — the pair asked for is
    `GBPEUR=X` — and the hundredth is folded into the **rate**, so that
    `price_converted == price_native × fx_rate` stays true of the stored row. A
    row whose three numbers do not reconcile is not a journal.
    """
    fetch = _Fetch({'GBPEUR=X': 1.20})
    rates = fx.Rates(fetch, clock=_Clock())

    rate = rates.rate('GBp', 'EUR')

    assert fetch.calls == ['GBPEUR=X']
    assert rate == pytest.approx(0.012)
    # 250 pence at 1,20 €/£ is 3,00 €, not 300.
    assert 250.0 * rate == pytest.approx(3.0)


def test_the_pence_code_is_matched_case_sensitively():
    """`GBp` and `GBP` differ by one letter's case and by a factor of a hundred.

    Any `upper()` on this path turns pence into pounds silently, which is why
    the subunit table is matched exactly as yfinance spells it.
    """
    assert fx.normalise('GBp') == ('GBP', 100.0)
    assert fx.normalise('GBP') == ('GBP', 1.0)
    assert fx.normalise('gbp') == ('GBP', 1.0)


def test_an_absent_currency_is_not_convertible_rather_than_assumed():
    assert fx.normalise(None) == (None, 1.0)
    assert fx.normalise('  ') == (None, 1.0)
    assert fx.Rates(_Fetch()).rate(None, 'EUR') is None
    assert fx.Rates(_Fetch()).rate('USD', None) is None


# --- The TTL, and what it is for -------------------------------------------- #

def test_a_wave_of_symbols_shares_one_fetch_which_is_what_makes_them_comparable():
    """Converted at N slightly different rates, one wave's positions do not add
    up to their own total. The TTL is that property, not a cache optimisation."""
    fetch = _Fetch({'USDEUR=X': 0.92})
    clock = _Clock()
    rates = fx.Rates(fetch, ttl=300.0, clock=clock)

    answers = [rates.rate('USD', 'EUR') for _ in range(40)]

    assert answers == [0.92] * 40
    assert fetch.calls == ['USDEUR=X']


def test_the_rate_is_refetched_once_the_ttl_has_passed():
    fetch = _Fetch({'USDEUR=X': 0.92})
    clock = _Clock()
    rates = fx.Rates(fetch, ttl=300.0, clock=clock)

    rates.rate('USD', 'EUR')
    clock.at = 299.0
    rates.rate('USD', 'EUR')
    clock.at = 301.0
    rates.rate('USD', 'EUR')

    assert fetch.calls == ['USDEUR=X', 'USDEUR=X']


def test_an_unresolvable_pair_is_remembered_for_the_ttl_too():
    """Forty symbols quoted in a currency no pair resolves would otherwise ask
    Yahoo forty times a cycle, forever, for a ticker that does not exist — the
    exact herd the TTL exists against, in the one case where the answer cannot
    change."""
    fetch = _Fetch({})
    rates = fx.Rates(fetch, ttl=300.0, clock=_Clock())

    assert [rates.rate('XYZ', 'EUR') for _ in range(10)] == [None] * 10
    assert fetch.calls == ['XYZEUR=X']


def test_a_fetch_that_raises_is_a_missing_rate_and_never_an_exception():
    def explode(pair):
        raise RuntimeError('Yahoo said no')

    assert fx.Rates(explode, clock=_Clock()).rate('USD', 'EUR') is None


def test_the_reporting_currency_needs_no_pair_and_therefore_cannot_fail():
    """The common case — a portfolio reported in the currency its securities are
    quoted in — must not depend on Yahoo answering anything."""
    fetch = _Fetch()
    assert fx.Rates(fetch, clock=_Clock()).rate('EUR', 'EUR') == 1.0
    assert fetch.calls == []
    # ...and the subunit still applies: pence into pounds is a hundredth, with
    # no pair either.
    assert fx.Rates(fetch, clock=_Clock()).rate('GBp', 'GBP') == pytest.approx(0.01)
    assert fetch.calls == []


# --- The historical half ----------------------------------------------------- #

def test_a_past_day_is_converted_at_its_own_rate_not_at_todays():
    """Converting a five-year-old close at today's rate puts a currency move
    into a chart of a share price."""
    history = {
        'USDEUR=X': {date(2024, 1, 2): 0.90, date(2024, 6, 3): 0.92},
    }
    rates = fx.Rates(_Fetch({'USDEUR=X': 0.95}),
                     lambda pair, start, end: history[pair], clock=_Clock())

    rates.series('USD', 'EUR', date(2024, 1, 1), date(2024, 6, 30))

    assert rates.rate('USD', 'EUR', date(2024, 1, 2)) == 0.90
    assert rates.rate('USD', 'EUR', date(2024, 6, 3)) == 0.92
    # And "now" is still the live one, which is a different question.
    assert rates.rate('USD', 'EUR') == 0.95


def test_a_day_with_no_close_of_its_own_takes_the_last_one_before_it():
    """A rate is a market series: a Sunday has no close, and the rate that
    applied on it *is* Friday's. Bounded by what was actually fetched, so a day
    before anything known is not silently borrowed from the wrong side."""
    fetched = []

    def history(pair, start, end):
        fetched.append((start, end))
        return {date(2024, 6, 7): 0.92}

    rates = fx.Rates(_Fetch(), history, clock=_Clock())
    rates.series('USD', 'EUR', date(2024, 6, 1), date(2024, 6, 10))

    # Saturday and Sunday both read Friday's close, with no second fetch.
    assert rates.rate('USD', 'EUR', date(2024, 6, 8)) == 0.92
    assert rates.rate('USD', 'EUR', date(2024, 6, 9)) == 0.92
    assert len(fetched) == 1
    # A day before the window is a hole, not Friday's rate reaching backwards.
    assert rates.rate('USD', 'EUR', date(2024, 5, 1)) is None


def test_convert_answers_both_halves_together_or_neither():
    """A converted price with no rate beside it is a figure nobody could explain
    three years later, which is precisely what storing the rate is for."""
    rates = fx.Rates(_Fetch({'USDEUR=X': 0.92}), clock=_Clock())

    assert fx.convert(100.0, 'USD', 'EUR', rates) == (pytest.approx(92.0), 0.92)
    assert fx.convert(100.0, 'USD', None, rates) == (None, None)
    assert fx.convert(None, 'USD', 'EUR', rates) == (None, None)
    assert fx.convert(100.0, 'XYZ', 'EUR', rates) == (None, None)


# =========================================================================== #
# The dial: no default, ISO-4217 shaped, fixed from the first event
# =========================================================================== #

def test_the_reporting_currency_has_no_default_and_is_never_seeded(store):
    """*Not answered yet* and *answered* have to stay two states: a default here
    would silently interpret every amount already imported."""
    assert settings_registry.default_for('base_currency') is None
    assert 'base_currency' not in settings_registry.seeded_defaults()
    assert store.setting('base_currency') is None


def test_a_code_that_is_not_a_currency_is_refused_with_its_key(store):
    """Shape only, and never a closed list of codes: a list would refuse a
    currency the day it is created, and would be a second authority on what a
    currency is beside the exchange that quotes one."""
    for refused in ('EURO', '€', 'E', '12'):
        with pytest.raises(settings_registry.InvalidSetting) as raised:
            settings_module.save(store, {'base_currency': refused})
        assert raised.value.key == 'base_currency'

    assert store.setting('base_currency') is None


def test_the_answer_is_stored_upper_cased_so_one_dial_has_one_spelling(store):
    settings_module.save(store, {'base_currency': 'eur'})

    assert store.setting('base_currency') == 'EUR'


def test_it_can_be_answered_after_an_import_and_is_fixed_from_the_first_event(store):
    """The amendment ADR-0021 makes to ADR-0002, and the direction matters.

    Locking on *any event exists* would shut an owner who imported before
    answering out of their own currency for good. What is unrecoverable is
    **reinterpreting** amounts, never answering late — so: free until answered,
    free while the ledger is empty, fixed once both are true.
    """
    settings_module.save(store, {'base_currency': 'EUR'})
    assert store.setting('base_currency') == 'EUR'
    # Still free: nothing has been interpreted, because there is nothing to
    # interpret.
    settings_module.save(store, {'base_currency': 'USD'})
    assert store.setting('base_currency') == 'USD'

    store.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")
    store.execute(
        "INSERT INTO event (id, date, event_type, account, symbol, quantity, "
        "unit_price) VALUES (1, DATE '2024-01-15', 'BUY', 'default', 'AAPL', "
        "10, 150.0)")

    with pytest.raises(settings_registry.InvalidSetting) as raised:
        settings_module.save(store, {'base_currency': 'GBP'})

    assert raised.value.key == 'base_currency'
    assert store.setting('base_currency') == 'USD'
    # And answering it for the *first* time after an import is not a change:
    # nothing was interpreted while the key was absent.
    store.execute("DELETE FROM setting WHERE key = 'base_currency'")
    settings_module.save(store, {'base_currency': 'EUR'})
    assert store.setting('base_currency') == 'EUR'


# =========================================================================== #
# The wiring: a real store, a faked yfinance, assertions on the rows
# =========================================================================== #

def _share(symbol='AAPL', account='default', quantity=10):
    return {'name': 'Apple', 'symbol': symbol, 'account': account,
            'quantity': quantity, 'cost_basis': 1500.0,
            'realized_gain': 0.0, 'received_dividend': 0.0}


class _FakeConfigManager:
    def __init__(self, shares, opened_store):
        self._shares = shares
        self._store = opened_store
        self._events = []

    def current(self):
        return main.ConfigSnapshot(shares=self._shares, events=self._events,
                                   accounts=None, cache_key=None)

    def reload(self, force=False):
        return self.current()

    def load_shares(self, force=False):
        return self._shares

    def load_accounts(self):
        return None

    def get_events(self):
        return self._events

    @property
    def store(self):
        return self._store

    @contextmanager
    def writing(self):
        yield self._store


def _metrics(store, mocker, shares=None, base_currency=None):
    shares = shares if shares is not None else [_share()]
    for share in shares:
        store.execute(
            "INSERT INTO account (id, type, label) VALUES (?, 'CTO', ?) "
            "ON CONFLICT (id) DO NOTHING",
            [share['account'], share['account']])
        store.execute("INSERT INTO symbol (symbol) VALUES (?) "
                      "ON CONFLICT (symbol) DO NOTHING", [share['symbol']])
    metrics = main.SuiviBourseMetrics(
        _FakeConfigManager(shares, store),
        prometheus_exporter=mocker.MagicMock())
    metrics.base_currency = base_currency
    return metrics


def _point(store, symbol='AAPL'):
    return store.query(
        'SELECT price_native, price_converted, fx_rate FROM price_point '
        ' WHERE symbol = ? ORDER BY ts', [symbol])


def _fixed_rate(metrics, mapping):
    """Replace the injected live fetch, leaving the TTL cache itself real."""
    metrics.rates = fx.Rates(lambda pair: mapping.get(pair))


def test_a_london_position_is_converted_from_pence_and_says_so(
        store, mocker, monkeypatch, fake_ticker):
    """The case that is wrong by a factor of a hundred and looks plausible.

    The row is a journal and is asserted as one: 250 pence at 1,20 €/£ is
    3,00 €, and `price_native × fx_rate` gives it back.
    """
    metrics = _metrics(store, mocker, shares=[_share('VOD.L')],
                       base_currency='EUR')
    _fixed_rate(metrics, {'GBPEUR=X': 1.20})
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=250.0, market_state='REGULAR', info={'currency': 'GBp'}))

    metrics._scrape_symbol('VOD.L', now=NOW)

    (native, converted, rate), = _point(store, 'VOD.L')
    assert native == 250.0
    assert converted == pytest.approx(3.0)
    assert rate == pytest.approx(0.012)
    assert native * rate == pytest.approx(converted)


def test_a_missing_rate_writes_the_point_with_no_converted_price(
        store, mocker, monkeypatch, fake_ticker):
    """Never *no point*. The quote is the thing that cannot be re-fetched later —
    Yahoo gives nothing under the hour past 60 days — while the conversion can be
    repaired by the lateral pass, which is the only reason a `NULL` here is
    viable at all."""
    metrics = _metrics(store, mocker, base_currency='EUR')
    _fixed_rate(metrics, {})          # the pair resolves to nothing
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=185.0, market_state='REGULAR', info={'currency': 'USD'}))

    metrics._scrape_symbol('AAPL', now=NOW)

    assert _point(store) == [(185.0, None, None)]
    # The `latest` row agrees with it rather than keeping an older conversion.
    assert store.query(
        'SELECT last_price_native, last_price_converted, last_fx_rate '
        '  FROM symbol_quote WHERE symbol = ?', ['AAPL']) == [(185.0, None, None)]


def test_no_reporting_currency_scrapes_natively_and_converts_nothing(
        store, mocker, monkeypatch, fake_ticker):
    """Nothing refuses while the question is unanswered — that is the whole
    design. Prices go on being collected, so answering late costs no history."""
    metrics = _metrics(store, mocker, base_currency=None)
    fetched = []
    metrics.rates = fx.Rates(lambda pair: fetched.append(pair))
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=185.0, market_state='REGULAR', info={'currency': 'USD'}))

    metrics._scrape_symbol('AAPL', now=NOW)

    assert _point(store) == [(185.0, None, None)]
    # And no pair was even asked for: there is nothing to convert *into*.
    assert fetched == []


def test_answering_the_currency_converts_from_the_next_cycle_on(
        store, mocker, monkeypatch, fake_ticker):
    """The passage from *absent* to *posed*, which is the state change the whole
    ticket turns on.

    The points already collected keep their native price and their empty
    conversion — repairing those is #704's lateral pass — and the very next
    write carries all three columns. Nothing had to be replayed for that.
    """
    metrics = _metrics(store, mocker, base_currency=None)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=185.0, market_state='REGULAR', info={'currency': 'USD'}))

    metrics._scrape_symbol('AAPL', now=NOW)
    assert _point(store) == [(185.0, None, None)]

    # One `PUT /api/settings` away, and this is what it does to the process.
    settings_module.save(store, {'base_currency': 'EUR'})
    metrics.apply_dials(settings_module.read_all(store))
    _fixed_rate(metrics, {'USDEUR=X': 0.92})

    metrics._scrape_symbol('AAPL', now=NOW + timedelta(seconds=120))

    assert metrics.base_currency == 'EUR'
    assert _point(store) == [
        (185.0, None, None),
        (185.0, pytest.approx(170.2), 0.92),
    ]


def test_a_rebuilt_chunk_is_converted_at_the_rate_of_each_point_s_own_day(
        store, mocker, monkeypatch, fake_ticker):
    """The rebuild fetches the pair's history beside the price history.

    Converting a five-year-old close at today's rate would put a currency move
    into a chart of a share price — and the point is a journal, so the rate on
    each row has to be the one that row's figure came from.
    """
    metrics = _metrics(store, mocker, base_currency='EUR')
    metrics._share_info_cache['AAPL'] = {'currency': 'USD'}
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=102.0, rows=3, start='2024-01-02'))

    windows = []

    def history(pair, start, end):
        windows.append(pair)
        return {date(2024, 1, 2): 0.90, date(2024, 1, 3): 0.91,
                date(2024, 1, 4): 0.92}

    metrics.rates = fx.Rates(lambda pair: 1.0, history)

    metrics._fetch_and_store(
        'AAPL', datetime(2024, 1, 1, tzinfo=UTC), datetime(2024, 1, 5, tzinfo=UTC))

    assert _point(store) == [
        (100.0, pytest.approx(90.0), 0.90),
        (101.0, pytest.approx(91.91), 0.91),
        (102.0, pytest.approx(93.84), 0.92),
    ]
    # One prefetch for the whole chunk, not one request per point.
    assert windows == ['USDEUR=X']


def test_an_event_amount_is_never_converted_because_it_is_already_the_debit(
        store, mocker, monkeypatch, fake_ticker):
    """`unit_price` / `fee` / `amount` are amounts **in the reporting currency**.

    That is what makes the cost basis exact instead of re-estimated from a
    historical rate, and it removes historical FX from the past entirely: only
    prices are ever converted. So a London position quoted in pence keeps the
    basis its file recorded, untouched, beside a price that is divided by a
    hundred and multiplied by a rate.
    """
    metrics = _metrics(store, mocker, shares=[_share('VOD.L')],
                       base_currency='EUR')
    _fixed_rate(metrics, {'GBPEUR=X': 1.20})
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=250.0, market_state='REGULAR', info={'currency': 'GBp'}))

    metrics._scrape_symbol('VOD.L', now=NOW)

    # The ledger's own figure, exactly as the replay wrote it.
    assert [s['cost_basis'] for s in metrics.shares] == [1500.0]


def test_the_rate_costs_no_job_no_table_and_no_symbol_in_the_scheduler(
        store, mocker, monkeypatch, fake_ticker):
    """The three things the rate is deliberately **not** (spec #695 § 10).

    Not a pseudo-symbol `USDEUR=X` armed like a holding — a pair has no
    `marketState` that projects onto the equity cadence model, and it would show
    up on the shares page as something the owner does not hold. Not an
    `fx_rates` table — the rate that was used is stored on the point it
    produced, which is what a read-time join would have cost the hottest query
    of the product. And not a fifth job.
    """
    metrics = _metrics(store, mocker, base_currency='EUR')
    metrics.scheduler = mocker.MagicMock()
    _fixed_rate(metrics, {'USDEUR=X': 0.92})
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=185.0, market_state='REGULAR', info={'currency': 'USD'}))

    metrics._scrape_symbol('AAPL', now=NOW)
    metrics._reconcile_jobs()

    armed = {call.kwargs['id']
             for call in metrics.scheduler.add_job.call_args_list}
    assert armed == {main._scrape_job_id('AAPL')}
    assert metrics._held_symbols() == {'AAPL'}
    assert 'fx_rates' not in store.table_names()
    assert store.query(
        "SELECT count(*) FROM symbol WHERE symbol LIKE '%=X'") == [(0,)]

    scheduler = mocker.MagicMock()
    main.register_interval_jobs(scheduler, metrics, 60)
    assert [c.kwargs['id'] for c in scheduler.add_job.call_args_list] \
        == ['backfill', 'perf']


def test_the_injected_fetches_are_the_real_ones_and_read_yahoo_s_last_close(
        store, mocker, monkeypatch, fake_ticker):
    """The two production fetches, exercised rather than replaced.

    Every test above swaps `metrics.rates` for a fixed table, which is what
    makes the arithmetic assertable — so the wire between the module and
    yfinance needs one test of its own, or the whole feature is green against a
    fetch nobody ever calls.
    """
    metrics = _metrics(store, mocker, base_currency='EUR')
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=0.92, rows=3, start='2024-06-01'))

    assert metrics._fetch_fx_rate('USDEUR=X') == pytest.approx(0.92)
    assert metrics._fetch_fx_series(
        'USDEUR=X', date(2024, 6, 1), date(2024, 6, 4)) == {
        date(2024, 6, 1): pytest.approx(-1.08),
        date(2024, 6, 2): pytest.approx(-0.08),
        date(2024, 6, 3): pytest.approx(0.92),
    }
    # A pair yfinance cannot answer for is a missing rate, never an exception.
    monkeypatch.setattr(main.yf, 'Ticker',
                        lambda s: (_ for _ in ()).throw(RuntimeError('nope')))
    assert metrics._fetch_fx_rate('XYZEUR=X') is None
    assert metrics._fetch_fx_series(
        'XYZEUR=X', date(2024, 6, 1), date(2024, 6, 4)) == {}


def test_the_freshness_sonde_still_watches_the_native_price(
        store, mocker, monkeypatch, fake_ticker):
    """A converted price moves whenever the rate does, so watching it would let
    a currency tick pass for a price that is still being refreshed — the sonde
    would answer *fresh* about a symbol frozen since Tuesday (spec #695 § 7)."""
    metrics = _metrics(store, mocker, base_currency='EUR')
    _fixed_rate(metrics, {'USDEUR=X': 0.92})
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=185.0, market_state='REGULAR', info={'currency': 'USD'}))
    metrics._scrape_symbol('AAPL', now=NOW)

    assert quotes.last_price(store, 'AAPL') == 185.0
