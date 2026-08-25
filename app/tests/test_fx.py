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

import pandas as pd
import pytest

import carrying
import fx
import main
import performance
import portfolio_view
import quotes
import runtime_state
import runtime_view
import scheduling
import store_reads
import settings as settings_module
import settings_registry
from events import EventAggregator
from events.schemas import Event, EventType


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


def test_the_forward_fill_stops_at_the_lookback_and_never_borrows_another_year():
    """A missing conversion is repairable; a wrong one is not.

    The fill used to walk the pair's whole cache, every window confounded. So
    when the window a day needs failed to fetch, the ``bisect`` answered with a
    rate from another year — and that rate is *written down*: the backfill puts
    it on the point and the store persists it, while the lateral pass only ever
    revisits ``price_converted IS NULL``. A 2026 quote converted at a 2020 rate
    is definitive and invisible.

    The same shape occurs with no failure at all: a one-year window Yahoo
    answers ten days of would otherwise carry day ten's rate over the remaining
    355.
    """
    def history(pair, start, end):
        if start.year == 2020:
            return {date(2020, 6, 1): 0.90, date(2020, 6, 2): 0.91}
        raise RuntimeError('Yahoo said no')

    rates = fx.Rates(_Fetch(), history, clock=_Clock())
    rates.series('USD', 'EUR', date(2020, 6, 1), date(2020, 6, 30))

    assert rates.rate('USD', 'EUR', date(2020, 6, 3)) == 0.91
    # Six years later, over a window that did not come back: nothing, rather
    # than June 2020's rate.
    assert rates.rate('USD', 'EUR', date(2026, 6, 15)) is None


def test_a_failed_window_is_not_re_asked_once_per_point_of_the_chunk():
    """An outage costs one request per pair, not one per day of the chunk.

    Only a *successful* fetch records a window, so after a failed prefetch every
    point of the chunk fell through the coverage test and asked for an
    eleven-day window of its own — up to 365 extra requests to Yahoo, emitted by
    the job that already makes more of them than the rest of the application,
    and precisely while it is already failing.
    """
    calls = []

    def history(pair, start, end):
        calls.append((start, end))
        raise RuntimeError('Yahoo said no')

    clock = _Clock()
    rates = fx.Rates(_Fetch(), history, ttl=300.0, clock=clock)

    for offset in range(30):
        rates.rate('USD', 'EUR', date(2026, 6, 1) + timedelta(days=offset))

    assert len(calls) == 1

    # And it is a TTL, not a memory: the pair is asked again once it expires.
    clock.at += 301.0
    rates.rate('USD', 'EUR', date(2026, 6, 1))
    assert len(calls) == 2


# --- The three answers, and why two is not enough (issue #704) -------------- #

def test_a_window_that_came_back_empty_is_a_reply_and_not_a_failure():
    """``rate()`` folds every unanswerable case into ``None`` on purpose — the
    writer writes the point either way. The lateral pass is the one caller for
    which the difference *is* the subject: a pair yfinance has never heard of is
    an answer that will not change, while a fetch that did not complete is
    nothing at all. So :meth:`fx.Rates.observe` keeps them apart."""
    rates = fx.Rates(lambda pair: None, lambda pair, start, end: {})

    outcome, known = rates.observe(
        'XYZ', 'EUR', date(2024, 6, 1), date(2024, 6, 4))

    assert outcome == fx.UNRESOLVED
    assert known == {}


def test_a_fetch_that_raises_is_a_failure_and_concludes_nothing():
    """Nothing was learnt about the pair, so nothing may be concluded about it —
    which is what stops a Yahoo hiccup arming a terminal that tells the owner
    their currency will never resolve."""
    def _boom(pair, start, end):
        raise RuntimeError('nope')

    outcome, known = fx.Rates(lambda pair: None, _boom).observe(
        'USD', 'EUR', date(2024, 6, 1), date(2024, 6, 4))

    assert outcome == fx.FAILED
    assert known == {}


def test_the_reporting_currency_s_own_code_resolves_without_a_fetch():
    """A portfolio reported in the currency its securities are quoted in must
    not depend on Yahoo answering anything — there is no pair to ask about."""
    fetched = []
    rates = fx.Rates(lambda pair: None,
                     lambda pair, start, end: fetched.append(pair) or {})

    assert rates.observe('EUR', 'EUR', date(2024, 6, 1), date(2024, 6, 4)) == (
        fx.RESOLVED, {})
    assert fetched == []


def test_a_missing_code_is_a_failure_and_never_an_unresolvable_pair():
    """The trap #704 writes in black and white, locked twice.

    A ``price_converted`` of ``NULL`` caused by an **unanswered reporting
    currency** is transitory and lifted by a write of the owner's. Reading it as
    a pair that does not resolve would make answering the dial change nothing
    for the whole stock already scraped — so the answer here is the one that
    arms no terminal.
    """
    rates = fx.Rates(lambda pair: None, lambda pair, start, end: {})

    assert rates.observe('USD', None, date(2024, 6, 1), date(2024, 6, 4))[0] \
        == fx.FAILED
    assert rates.observe(None, 'EUR', date(2024, 6, 1), date(2024, 6, 4))[0] \
        == fx.FAILED


def test_a_window_already_asked_for_answers_off_the_cache():
    """What lets a symbol carrying an unresolvable pair re-arm its terminal
    every cycle without emitting a single request — the difference between this
    and #703's silent loop is that no window is ever re-fetched."""
    calls = []

    def _fetch(pair, start, end):
        calls.append(pair)
        return {}

    rates = fx.Rates(lambda pair: None, _fetch)
    window = (date(2024, 6, 1), date(2024, 6, 4))

    assert rates.observe('XYZ', 'EUR', *window)[0] == fx.UNRESOLVED
    assert rates.observe('XYZ', 'EUR', *window)[0] == fx.UNRESOLVED
    assert calls == ['XYZEUR=X']


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


def _metrics(store, shares=None, base_currency=None):
    shares = shares if shares is not None else [_share()]
    for share in shares:
        store.execute(
            "INSERT INTO account (id, type, label) VALUES (?, 'CTO', ?) "
            "ON CONFLICT (id) DO NOTHING",
            [share['account'], share['account']])
        store.execute("INSERT INTO symbol (symbol) VALUES (?) "
                      "ON CONFLICT (symbol) DO NOTHING", [share['symbol']])
    metrics = main.SuiviBourseMetrics(_FakeConfigManager(shares, store))
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
    metrics = _metrics(store, shares=[_share('VOD.L')],
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
    metrics = _metrics(store, base_currency='EUR')
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
    metrics = _metrics(store, base_currency=None)
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
    metrics = _metrics(store, base_currency=None)
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
    metrics = _metrics(store, base_currency='EUR')
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
    metrics = _metrics(store, shares=[_share('VOD.L')],
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
    metrics = _metrics(store, base_currency='EUR')
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
    metrics = _metrics(store, base_currency='EUR')
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=0.92, rows=3, start='2024-06-01'))

    assert metrics._fetch_fx_rate('USDEUR=X') == pytest.approx(0.92)
    assert metrics._fetch_fx_series(
        'USDEUR=X', date(2024, 6, 1), date(2024, 6, 4)) == {
        date(2024, 6, 1): pytest.approx(-1.08),
        date(2024, 6, 2): pytest.approx(-0.08),
        date(2024, 6, 3): pytest.approx(0.92),
    }
    # A pair yfinance answers *nothing* for is a missing rate on both halves —
    # never an exception, and the point is written with no converted price.
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(rows=0))
    assert metrics._fetch_fx_rate('XYZEUR=X') is None
    assert metrics._fetch_fx_series(
        'XYZEUR=X', date(2024, 6, 1), date(2024, 6, 4)) == {}

    # A fetch that *raises* parts the two halves (issue #704). The live one goes
    # on swallowing: its caller writes the point either way. The historical one
    # re-raises, because it is the one the lateral pass reads, and there
    # *"nothing came back"* and *"the request did not complete"* are the two
    # stopping conditions the ticket forbids collapsing — one retries for ever,
    # the other says the pair will never resolve. `fx.Rates` catches it and logs
    # exactly as this method used to, so the rebuild sees no change.
    monkeypatch.setattr(main.yf, 'Ticker',
                        lambda s: (_ for _ in ()).throw(RuntimeError('nope')))
    assert metrics._fetch_fx_rate('XYZEUR=X') is None
    with pytest.raises(RuntimeError):
        metrics._fetch_fx_series('XYZEUR=X', date(2024, 6, 1), date(2024, 6, 4))
    assert fx.Rates(lambda pair: None, metrics._fetch_fx_series).series(
        'XYZ', 'EUR', date(2024, 6, 1), date(2024, 6, 4)) == {}


def test_the_freshness_sonde_still_watches_the_native_price(
        store, mocker, monkeypatch, fake_ticker):
    """A converted price moves whenever the rate does, so watching it would let
    a currency tick pass for a price that is still being refreshed — the sonde
    would answer *fresh* about a symbol frozen since Tuesday (spec #695 § 7)."""
    metrics = _metrics(store, base_currency='EUR')
    _fixed_rate(metrics, {'USDEUR=X': 0.92})
    monkeypatch.setattr(main.yf, 'Ticker', lambda s: fake_ticker(
        close=185.0, market_state='REGULAR', info={'currency': 'USD'}))
    metrics._scrape_symbol('AAPL', now=NOW)

    assert quotes.last_price(store, 'AAPL') == 185.0


# =========================================================================== #
# The lateral pass — what makes a NULL conversion viable (issue #704)
# =========================================================================== #

class _SeriesFetch:
    """The rebuild's historical fetch, counted, and able to fail on demand.

    Three behaviours, because #704 turns on telling them apart: a pair with
    rates (**resolved**), a pair with none (**unresolved** — a reply), and a
    request that does not complete (**failed**).
    """

    def __init__(self, answers=None, raises=None):
        self.answers = answers or {}
        self.raises = raises
        self.calls = []

    def __call__(self, pair, start, end):
        self.calls.append((pair, start, end))
        if self.raises is not None:
            raise self.raises
        return dict(self.answers.get(pair, {}))


class _Instrument:
    """A yfinance stand-in whose ``.info`` **reads** are counted (issue #773).

    The unit is the read and not the ticker: the backward pass builds one ticker
    per chunk, while what #773's criterion bounds is the request for the
    *instrument's attributes* — one per symbol, once, whatever the number of
    chunks or cycles. Doubles as the history source so one object stands in for
    the whole of yfinance, the suite's single faked edge.
    """

    def __init__(self, info=None, frame=None, raises=None):
        self._info = {} if info is None else info
        self._frame = frame
        self._raises = raises
        self.history_metadata = None
        self.reads = 0

    def __call__(self, symbol):
        return self

    def history(self, *args, **kwargs):
        return self._frame

    @property
    def info(self):
        self.reads += 1
        if self._raises is not None:
            raise self._raises
        return self._info


def _unconverted(store, symbol='AAPL', currency='USD', days=(1, 2, 3)):
    """A stored series whose points landed with no conversion — #702's own state.

    ``currency`` is the *security's*, and it is written onto ``symbol_quote``
    because that is where a first successful fetch leaves it; ``None`` is the
    symbol nobody has managed to quote yet.
    """
    quotes.record_history(store, symbol, [
        {'timestamp': datetime(2024, 6, day, 17, 0, tzinfo=UTC),
         'price': 100.0 + day} for day in days])
    if currency is not None:
        store.execute('UPDATE symbol_quote SET currency = ? WHERE symbol = ?',
                      [currency, symbol])


def _lateral(metrics, symbol='AAPL'):
    """One cycle of the pass, and the record it published."""
    written = metrics._backfill_lateral(symbol)
    return written, metrics.recorder.backfill_of(symbol, runtime_state.LATERAL)


def test_the_lateral_pass_repairs_by_update_and_never_by_insert(
        store, mocker, monkeypatch):
    """The pass works on the **same rows** as the series, short of a column.

    That is what makes #702's decision viable at all: a rate that could not be
    had writes the point with ``price_converted NULL`` rather than losing the
    quote — and Yahoo gives nothing back under the hour past sixty days, so the
    quote is what cannot be re-fetched while the conversion can be repaired for
    ever. Each day is converted at the rate of **its own day**, so the stored row
    stays a journal one can read back.
    """
    metrics = _metrics(store, base_currency='EUR')
    _unconverted(store)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    metrics.rates = fx.Rates(lambda pair: None, _SeriesFetch({'USDEUR=X': {
        date(2024, 6, 1): 0.90,
        date(2024, 6, 2): 0.91,
        date(2024, 6, 3): 0.92}}))

    written, record = _lateral(metrics)

    assert written == 3
    assert _point(store) == [
        (101.0, pytest.approx(101.0 * 0.90), 0.90),
        (102.0, pytest.approx(102.0 * 0.91), 0.91),
        (103.0, pytest.approx(103.0 * 0.92), 0.92),
    ]
    assert record.terminal is None and record.failed is False
    assert record.written == 3
    # The next cycle has nothing left to do, and says so rather than going quiet.
    assert _lateral(metrics)[1].skipped == runtime_state.SKIP_NOTHING_TO_REPAIR


def test_an_unanswered_reporting_currency_never_arms_unconvertible(
        store, mocker, monkeypatch):
    """The trap the ticket writes in black and white.

    Every ``price_converted`` in the store is ``NULL`` while the question is
    unanswered, and **none of them is a pair that failed**: the absence is
    transitory and lifted by a write of the owner's. Arming ``unconvertible``
    here would make answering the dial change nothing for the whole stock
    already scraped — which is the one gesture the pass exists to honour.
    """
    metrics = _metrics(store, base_currency=None)
    _unconverted(store)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    fetch = _SeriesFetch()
    metrics.rates = fx.Rates(lambda pair: None, fetch)

    written, record = _lateral(metrics)

    assert written == 0
    assert record.terminal is None
    assert record.skipped == runtime_state.SKIP_NO_BASE_CURRENCY
    assert record.failed is False
    # And nothing was asked of Yahoo: there is nothing to convert *into*.
    assert fetch.calls == []
    assert _point(store) == [(101.0, None, None), (102.0, None, None),
                             (103.0, None, None)]


def test_a_pair_that_does_not_resolve_arms_unconvertible_and_names_itself(
        store, mocker, monkeypatch):
    """A **reply**, not a failure — and the one terminal that asks for an action.

    *"Waiting for a conversion"* and *"will never convert"* are two different
    sentences, and only the second needs the owner. The reason travels with it,
    because a state word with no subject leaves a reader in front of an empty
    column with no explanation.
    """
    metrics = _metrics(store, base_currency='EUR')
    _unconverted(store, currency='XYZ')
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    metrics.rates = fx.Rates(lambda pair: None, _SeriesFetch())

    written, record = _lateral(metrics)

    assert written == 0
    assert record.terminal == runtime_state.TERMINAL_UNCONVERTIBLE
    assert record.failed is False and record.failures == 0
    assert 'XYZEUR=X' in record.reason and 'AAPL' in record.reason
    # Never an error: a fact the owner has to repair does not belong among the
    # transient failures the next cycle clears.
    assert record.error is None


def test_a_failed_rate_fetch_backs_off_like_617_and_retries_indefinitely(
        store, mocker, monkeypatch):
    """#617's guard, transposed onto a pass that rides an interval job.

    The first :data:`scheduling.FAILURE_GRACE` failures wait the base interval,
    then the wait doubles — and there is **no terminal**, ever: nothing was
    learnt about the pair, so nothing may be concluded about it.
    """
    metrics = _metrics(store, base_currency='EUR')
    _unconverted(store)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    metrics.rates = fx.Rates(
        lambda pair: None, _SeriesFetch(raises=RuntimeError('yahoo is down')))

    delays = []
    for _ in range(5):
        at = datetime.now(UTC)
        _lateral(metrics)
        delays.append(
            (metrics._lateral_retry_at['AAPL'] - at).total_seconds())
        # The back-off is honoured against the *clock*; clearing it here counts
        # five attempts rather than five ticks.
        metrics._lateral_retry_at.clear()

    record = metrics.recorder.backfill_of('AAPL', runtime_state.LATERAL)
    assert record.failed is True and record.failures == 5
    assert record.terminal is None
    base = metrics.regular_interval
    assert delays == [pytest.approx(scheduling.backoff_delay(base, n), abs=2)
                      for n in (1, 2, 3, 4, 5)]
    assert delays[:3] == [pytest.approx(base, abs=2)] * 3
    assert delays[4] == pytest.approx(base * 4, abs=2)


def test_a_symbol_inside_its_back_off_is_stepped_over_rather_than_re_counted(
        store, mocker, monkeypatch):
    """Publishing nothing while the delay holds is the point.

    A record with ``failed=False`` would reset the recorder's fold and flatten
    the wait back to the base interval on the very next cycle; one with
    ``failed=True`` would count a cycle nobody attempted. The previous record
    stands, which is the honest reading — the last pass *is* still the last one.
    """
    metrics = _metrics(store, base_currency='EUR')
    _unconverted(store)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    fetch = _SeriesFetch(raises=RuntimeError('yahoo is down'))
    metrics.rates = fx.Rates(lambda pair: None, fetch)

    _lateral(metrics)
    assert len(fetch.calls) == 1
    for _ in range(3):
        _lateral(metrics)

    assert len(fetch.calls) == 1
    assert metrics.recorder.backfill_of(
        'AAPL', runtime_state.LATERAL).failures == 1


def test_the_first_conversion_that_lands_resets_the_back_off(
        store, mocker, monkeypatch):
    """The reset #617 states, on the pass's own terms."""
    metrics = _metrics(store, base_currency='EUR')
    _unconverted(store)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    metrics.rates = fx.Rates(
        lambda pair: None, _SeriesFetch(raises=RuntimeError('yahoo is down')))
    _lateral(metrics)
    assert metrics.recorder.backfill_of(
        'AAPL', runtime_state.LATERAL).failures == 1

    metrics._lateral_retry_at.clear()
    metrics.rates = fx.Rates(lambda pair: None, _SeriesFetch({'USDEUR=X': {
        date(2024, 6, 1): 0.90}}))

    written, record = _lateral(metrics)

    assert written == 3          # one rate, forward-filled onto the three days
    assert record.failures == 0
    assert 'AAPL' not in metrics._lateral_retry_at


def test_a_symbol_yahoo_names_no_currency_for_says_so_instead_of_failing_at_it(
        store, mocker, monkeypatch):
    """``SKIP_NO_QUOTE_CURRENCY`` keeps a subject after #773, and it is this one.

    The pass now *asks* rather than only naming the absence — but a request that
    completes and names no currency is a **reply**, exactly as an unresolvable
    pair is one: neither a failure nor something to conclude a pair from, since
    there is no pair to name yet. #704's distinction is not overwritten by
    #773's repair, and the question is put **once**: without that the pass would
    re-ask on every cycle, for ever, for a symbol Yahoo has nothing to say about.
    """
    metrics = _metrics(store, base_currency='EUR')
    _unconverted(store, currency=None)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    instrument = _Instrument(info={})
    monkeypatch.setattr(main.yf, 'Ticker', instrument)
    fetch = _SeriesFetch()
    metrics.rates = fx.Rates(lambda pair: None, fetch)

    written, record = _lateral(metrics)

    assert written == 0
    assert record.skipped == runtime_state.SKIP_NO_QUOTE_CURRENCY
    assert record.terminal is None and record.failed is False
    assert fetch.calls == []
    # Asked once, then never again — and the answer stays the same one.
    for _ in range(3):
        assert _lateral(metrics)[1].skipped == \
            runtime_state.SKIP_NO_QUOTE_CURRENCY
    assert instrument.reads == 1
    assert quotes.quote_currency(store, 'AAPL') is None


def test_the_pass_walks_one_chunk_a_cycle_from_the_oldest_missing_day(
        store, mocker, monkeypatch):
    """The backward pass's rhythm, applied to a set of rows rather than a window.

    The chunk is the backfill's own dial, and the pass starts from the **oldest**
    day still missing a conversion, so a stock of five years is repaired the way
    it was fetched: one chunk per cycle, on the backfill's cadence.
    """
    metrics = _metrics(store, base_currency='EUR')
    quotes.record_history(store, 'AAPL', [
        {'timestamp': datetime(2022, 6, 1, 17, 0, tzinfo=UTC), 'price': 100.0},
        {'timestamp': datetime(2024, 6, 1, 17, 0, tzinfo=UTC), 'price': 200.0},
    ])
    store.execute("UPDATE symbol_quote SET currency = 'USD'")
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    metrics.backfill_chunk_days = 365
    metrics.rates = fx.Rates(lambda pair: None, _SeriesFetch({'USDEUR=X': {
        date(2022, 6, 1): 0.90, date(2024, 6, 1): 0.92}}))

    assert _lateral(metrics)[0] == 1
    assert _point(store) == [(100.0, pytest.approx(90.0), 0.90),
                             (200.0, None, None)]

    assert _lateral(metrics)[0] == 1
    assert _point(store) == [(100.0, pytest.approx(90.0), 0.90),
                             (200.0, pytest.approx(184.0), 0.92)]


def test_answering_the_reporting_currency_starts_the_repair_of_the_whole_stock(
        store, mocker, monkeypatch):
    """The acceptance criterion: *posing the currency triggers the pass*.

    It is the one dial whose value is **retroactive** — every point written
    before it carries a ``NULL`` conversion — so the effect is *start now* rather
    than *the next cycle will read it*. The pass rides on the backfill, so
    triggering it is bringing that job's next run forward.
    """
    metrics = _metrics(store, base_currency=None)
    _unconverted(store)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    scheduler = mocker.MagicMock()
    metrics.scheduler = scheduler
    runtime = mocker.MagicMock(metrics=metrics, scheduler=scheduler)

    changes = settings_module.save(store, {'base_currency': 'EUR'})
    report = main.apply_settings(runtime, changes)

    assert metrics.base_currency == 'EUR'
    assert report['jobs_rescheduled'] == [main.BACKFILL_JOB_ID]
    assert scheduler.modify_job.call_args.args[0] == main.BACKFILL_JOB_ID
    assert 'next_run_time' in scheduler.modify_job.call_args.kwargs

    # And the cycle it brings forward repairs what was already scraped.
    metrics.rates = fx.Rates(lambda pair: None, _SeriesFetch({'USDEUR=X': {
        date(2024, 6, 1): 0.90}}))
    assert _lateral(metrics)[0] == 3
    assert [converted for _, converted, _ in _point(store)] == [
        pytest.approx(101.0 * 0.90), pytest.approx(102.0 * 0.90),
        pytest.approx(103.0 * 0.90)]


def test_a_declared_currency_taken_from_an_import_triggers_it_too(
        store, mocker, monkeypatch):
    """The same pose, on the road a headless install actually takes (#710).

    An exported ledger states its reporting currency and a store that has none
    takes it — which *is* the answer to the app's one question, so it owes the
    same repair as the one typed into the form.
    """
    metrics = _metrics(store, base_currency=None)
    scheduler = mocker.MagicMock()
    metrics.scheduler = scheduler
    store.execute(
        "INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR')")

    metrics._adopt_declared_currency()

    assert metrics.base_currency == 'EUR'
    assert scheduler.modify_job.call_args.args[0] == main.BACKFILL_JOB_ID


def test_the_lateral_pass_runs_on_a_sold_line_too(store, mocker, monkeypatch):
    """It is gated by nothing the other two passes decide.

    A series can be complete backwards, up to date forwards and entirely
    unconverted; and a sold line is squarely in the subject — its reconstructed
    history is what the account's returns are computed from, so an unconverted
    point there is a day missing from that computation.
    """
    metrics = _metrics(store, shares=[_share(quantity=0)],
                       base_currency='EUR')
    _unconverted(store)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    metrics.rates = fx.Rates(lambda pair: None, _SeriesFetch({'USDEUR=X': {
        date(2024, 6, 1): 0.90}}))

    # The whole of ``_backfill_symbol``, so the gating is the production one:
    # the backward pass reaches its terminal by itself (its anchor is already the
    # first acquisition), the forward one is refused by ``held=False``, and the
    # lateral one runs regardless — which is the claim.
    metrics._backfill_symbol('AAPL', (date(2024, 6, 1), date(2024, 6, 4)),
                             held=False, now=datetime.now(timezone.utc))

    assert metrics.recorder.backfill_of(
        'AAPL', runtime_state.BACKWARD).terminal \
        == runtime_state.TERMINAL_COMPLETE

    assert metrics.recorder.backfill_of(
        'AAPL', runtime_state.LATERAL).written == 3
    # And the forward pass did **not** run: there is no live writer to catch up.
    assert metrics.recorder.backfill_of('AAPL', runtime_state.FORWARD) is None


# =========================================================================== #
# The unit of a reconstructed line the scrape never met (issue #773)
#
# The population #703 brought into the product without bringing it into the
# tests: *what the scrape never sees*. Only ``record_quote`` ever wrote
# ``symbol_quote.currency`` and only the scrape calls it, so a line sold before
# the install existed collected years of reconstructed prices with no unit for
# any of them — and ``no_quote_currency`` was the one lateral condition with no
# exit. Measured on staging: 7 rows of 19, every one of them ``quantity = 0``,
# and two accounts reading −99,98 % and −29 120,25 %.
# =========================================================================== #

def _sold_before_the_install(store, mocker, monkeypatch, closes, info=None):
    """The staging state, rebuilt: a line sold before the first boot.

    Its quantity is zero, so ``_held_symbols`` filters it out of the scrape by
    design (#699) and the cache the rebuild reads is empty for it; its window is
    in the backfill's set all the same (ADR-0009), so Yahoo is asked for its
    prices — and answers.

    ``info`` is the second population of the ticket's fifth criterion: ``{}`` is
    Yahoo answering **cours and no currency at all**, which the repair cannot
    dissolve and which ADR-0004 takes instead.
    """
    frame = pd.DataFrame(
        {'Close': list(closes)},
        index=pd.date_range(start='2024-06-01', periods=len(closes),
                            freq='D', tz=UTC))
    instrument = _Instrument(
        info={'currency': 'USD', 'exchange': 'NMS', 'quoteType': 'EQUITY'}
        if info is None else info,
        frame=frame)
    metrics = _metrics(store, shares=[_share(quantity=0)],
                       base_currency='EUR')
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', instrument)
    metrics.rates = fx.Rates(lambda pair: None, _SeriesFetch({'USDEUR=X': {
        date(2024, 6, 1): 0.90, date(2024, 6, 2): 0.91,
        date(2024, 6, 3): 0.92}}))
    return metrics, instrument


def test_a_line_sold_before_the_install_learns_its_currency_and_is_converted(
        store, mocker, monkeypatch):
    """The whole chain, and the assertion is on the store's own rows.

    Not on the fact that a method was called: what the ticket is about is a
    column that stayed ``NULL`` for ever on a symbol the app had every price of.
    The two modules deferring to each other are exercised in their production
    order — the rebuild writes the chunk unconverted because nothing has met the
    symbol, and the lateral pass, which is the one that *knows* the unit is
    missing, asks for it and writes it where :func:`quotes.quote_currency` reads.
    """
    metrics, instrument = _sold_before_the_install(
        store, mocker, monkeypatch, (101.0, 102.0, 103.0))

    # Nothing has met this symbol, which is the premise of the whole ticket.
    assert metrics._held_symbols() == set()
    assert metrics._share_info_cache == {}

    metrics._backfill_symbol('AAPL', (date(2024, 6, 1), date(2024, 6, 4)),
                             held=False, now=datetime.now(timezone.utc))

    assert store.query(
        'SELECT currency FROM symbol_quote WHERE symbol = ?',
        ['AAPL']) == [('USD',)]
    assert _point(store) == [
        (101.0, pytest.approx(101.0 * 0.90), 0.90),
        (102.0, pytest.approx(102.0 * 0.91), 0.91),
        (103.0, pytest.approx(103.0 * 0.92), 0.92),
    ]
    assert instrument.reads == 1
    # And the rebuild's own cache is filled on the way, so the chunks fetched
    # after this one are converted at write time rather than repaired later.
    assert metrics._share_info_cache['AAPL']['currency'] == 'USD'


def test_the_learnt_currency_is_written_once_and_never_asked_for_again(
        store, mocker, monkeypatch):
    """The cost is **bounded and per symbol** — not per chunk, not per cycle.

    That is what settles #773 against asking from the rebuild's own conversion
    step, whose argument (a second ``.info`` per chunk doubles the rate-limit
    exposure of the job that already emits the most requests) is about a *chunk*
    while the need is one fact per symbol. The store is what makes it once: the
    answer lands in ``symbol_quote``, so the next cycle reads it instead of
    asking.
    """
    metrics = _metrics(store, base_currency='EUR')
    _unconverted(store, currency=None)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    instrument = _Instrument(info={'currency': 'USD'})
    monkeypatch.setattr(main.yf, 'Ticker', instrument)
    metrics.backfill_chunk_days = 1          # so several cycles have work left
    metrics.rates = fx.Rates(lambda pair: None, _SeriesFetch({'USDEUR=X': {
        date(2024, 6, 1): 0.90, date(2024, 6, 2): 0.91,
        date(2024, 6, 3): 0.92}}))

    repaired = [_lateral(metrics)[0] for _ in range(4)]

    assert repaired == [2, 1, 0, 0]          # two days, then the third, then done
    assert instrument.reads == 1
    assert quotes.quote_currency(store, 'AAPL') == 'USD'
    assert [converted for _, converted, _ in _point(store)] == [
        pytest.approx(101.0 * 0.90), pytest.approx(102.0 * 0.91),
        pytest.approx(103.0 * 0.92)]


def test_a_failed_attribute_fetch_backs_off_rather_than_concluding_anything(
        store, mocker, monkeypatch):
    """A request that did not complete taught nothing, so nothing is concluded.

    #704's own rule, applied to the second fetch the pass can make: it is a
    failure and follows #617's back-off, it never arms ``unconvertible`` — no
    pair was named, let alone refused — and it never lands in the *asked, no
    answer* memory either, or one flaky minute would silence the symbol for the
    life of the process.
    """
    metrics = _metrics(store, base_currency='EUR')
    _unconverted(store, currency=None)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    instrument = _Instrument(raises=RuntimeError('yahoo is down'))
    monkeypatch.setattr(main.yf, 'Ticker', instrument)
    fetch = _SeriesFetch()
    metrics.rates = fx.Rates(lambda pair: None, fetch)

    at = datetime.now(UTC)
    written, record = _lateral(metrics)

    assert written == 0
    assert record.failed is True and record.failures == 1
    assert record.terminal is None
    assert 'AAPL' in record.error
    assert fetch.calls == []                 # no pair to ask about yet
    assert (metrics._lateral_retry_at['AAPL'] - at).total_seconds() \
        == pytest.approx(scheduling.backoff_delay(metrics.regular_interval, 1),
                         abs=2)
    # And it is asked again once the back-off has run out, for ever.
    metrics._lateral_retry_at.clear()
    _lateral(metrics)
    assert instrument.reads == 2


def test_the_repaired_line_stops_being_valued_at_zero(
        store, mocker, monkeypatch, declare_ledger):
    """#773's consequence on the figure, which is why it is a defect and not a
    gap in a column.

    ``price_at`` reads ``price_converted`` — every figure the perf job computes
    is money in the reporting currency — so a symbol quoted in a unit nothing
    could learn was priceless to it on **every day it was held**, counted zero
    beside a cash ledger that had already paid for it, with the TWR chaining the
    crater. The repair is the first branch of the criterion: the currency is now
    known, so the position is valued rather than reclassified.
    """
    events = [
        Event(date(2024, 6, 1), EventType.BUY, 'AAPL', 'Apple',
              quantity=10, unit_price=100.0),
        Event(date(2024, 6, 4), EventType.SELL, 'AAPL', 'Apple',
              quantity=10, unit_price=110.0),
    ]
    declare_ledger(store, events)
    timeline = EventAggregator().replay(events)

    def value_on(day):
        pairs = sorted(quotes.price_series(store, 'AAPL').items())
        return performance._holdings_value(
            timeline, 'default', {'AAPL'},
            lambda symbol, at: timeline.state_at(pairs, at) if pairs else None,
            day)

    metrics, _ = _sold_before_the_install(
        store, mocker, monkeypatch, (101.0, 102.0, 103.0))
    metrics._backfill_backward(
        'AAPL', datetime(2024, 6, 1, tzinfo=UTC),
        datetime(2024, 6, 5, tzinfo=UTC))

    # The state the ticket measured: the prices are all there, natively, and the
    # position is worth nothing on a day it held ten shares.
    assert store.query(
        'SELECT count(*) FROM price_point WHERE price_converted IS NULL')[0] \
        == (3,)
    assert value_on(date(2024, 6, 2)) == (0.0, True)

    metrics._backfill_lateral('AAPL')

    assert value_on(date(2024, 6, 2)) == (pytest.approx(10 * 102.0 * 0.91), True)


def test_a_line_yahoo_names_no_unit_for_is_carried_at_its_cost(
        store, mocker, monkeypatch, declare_ledger):
    """The criterion's **second** branch, for the population the first misses.

    Learning the unit repairs every symbol Yahoo names one for. It leaves the
    other one exactly where it was — quoted (``first_quoted_days`` knew it),
    terminal (so the absence is permanent in #706's own sense), never converted,
    absent from ``oldest_priced``, therefore ``settled``, therefore not bounding
    the horizon, therefore counted **zero** on every day it was held while the
    cash ledger had paid. Measured by the review at ``(0.0, True)`` on a line
    worth ten shares.

    So the third state joins one of the two existing conventions rather than
    inventing a fourth (ADR-0021), and it is the **carrying** one: a number with
    no unit is not a cours. #706 refuses to carry *quoted with no rate* because
    that absence is transitory; here Yahoo has been asked and names none, so
    there is no pair, no rate coming, and nothing to wait for. The cost is
    defined in the right unit already — event amounts are the debit in the
    reporting currency (ADR-0002) — so the PMP needs no conversion.

    The two terms are read **from the store**, which is the constraint that
    decided the implementation: the perf job's only inputs are the store and the
    clock (#707), so ``_quote_currency_unknown`` — process memory — could not
    have carried the distinction.
    """
    events = [
        Event(date(2024, 6, 1), EventType.BUY, 'AAPL', 'Apple',
              quantity=10, unit_price=100.0),
        Event(date(2024, 6, 4), EventType.SELL, 'AAPL', 'Apple',
              quantity=10, unit_price=110.0),
    ]
    declare_ledger(store, events)
    timeline = EventAggregator().replay(events)
    window = {'AAPL': (date(2024, 6, 1), date(2024, 6, 4))}

    def value_on(day):
        pairs = sorted(quotes.price_series(store, 'AAPL').items())
        return performance._holdings_value(
            timeline, 'default', {'AAPL'},
            lambda symbol, at: timeline.state_at(pairs, at) if pairs else None,
            day,
            quotes.terminal_symbols(store, window, datetime.now(UTC)),
            quotes.first_quoted_days(store))

    metrics, instrument = _sold_before_the_install(
        store, mocker, monkeypatch, (101.0, 102.0, 103.0), info={})
    metrics._backfill_backward(
        'AAPL', datetime(2024, 6, 1, tzinfo=UTC),
        datetime(2024, 6, 5, tzinfo=UTC))
    _, record = _lateral(metrics)

    # The pass asked and Yahoo named nothing: #704's own state, kept whole.
    assert instrument.reads == 1
    assert record.skipped == runtime_state.SKIP_NO_QUOTE_CURRENCY
    assert record.terminal is None               # never ``unconvertible``
    assert quotes.quote_currency(store, 'AAPL') is None
    assert store.query(
        'SELECT count(*) FROM price_point WHERE price_converted IS NULL')[0] \
        == (3,)

    # The second term of ADR-0004's predicate holds — the backward pass has
    # nothing left to fetch — so the absence is permanent and the day is carried
    # at the position's own cost rather than counted at nothing.
    assert quotes.terminal_symbols(store, window, datetime.now(UTC)) == {'AAPL'}
    assert value_on(date(2024, 6, 2)) == (pytest.approx(10 * 100.0), True)


# =========================================================================== #
# The unit of a symbol quoted in the reporting currency (issue #825)
#
# The population #773's repair could not reach, because the gate that let it be
# reached tested a *symptom*: **a point with no conversion**. A symbol quoted in
# the reporting currency has nothing to convert — the fetch made while its
# market is shut leaves the unit in ``_share_info_cache``, ``_convert_history``
# converts every rebuilt point at 1,0 — so the pass declared
# ``nothing_to_repair`` and stood down one line above the branch that learns the
# unit, while the live scrape's own gate (*not closed and a price*) wrote
# nothing. Measured on staging, markets shut: eleven of the twelve held lines
# rendered at an em dash, valued at their cost, until the Monday.
# =========================================================================== #

_SHUT_MARKET_INFO = {'currency': 'EUR', 'exchange': 'PAR', 'quoteType': 'ETF'}


def _met_with_its_market_shut(store, monkeypatch, info=None,
                              base_currency='EUR'):
    """The staging state, rebuilt: a held line first met with its market shut.

    Three facts, and the defect is the shape they make together. The fetch
    **succeeds** market shut and leaves the unit in ``_share_info_cache``, which
    is why the cache is seeded here rather than left empty as in #773's own
    fixture; the rebuild therefore converts every point it writes, at 1,0, the
    quote currency being the reporting one; and nothing writes that unit to
    ``symbol_quote``, the live scrape having refused to write anything at all.

    ``info`` is what the pass's **own** request answers, and that request is a
    second and later one than the fetch that filled the cache: ``{}`` is Yahoo
    naming no currency for a symbol whose points are already converted.
    """
    frame = pd.DataFrame(
        {'Close': [101.0, 102.0, 103.0]},
        index=pd.date_range(start='2024-06-01', periods=3, freq='D', tz=UTC))
    instrument = _Instrument(
        info=dict(_SHUT_MARKET_INFO) if info is None else info, frame=frame)
    metrics = _metrics(store, base_currency=base_currency)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    monkeypatch.setattr(main.yf, 'Ticker', instrument)
    metrics.rates = fx.Rates(lambda pair: None, _SeriesFetch())
    metrics._share_info_cache['AAPL'] = dict(_SHUT_MARKET_INFO)
    metrics._backfill_backward('AAPL', datetime(2024, 6, 1, tzinfo=UTC),
                               datetime(2024, 6, 4, tzinfo=UTC))
    return metrics, instrument


def test_a_line_quoted_in_the_reporting_currency_learns_its_unit_all_the_same(
        store, monkeypatch):
    """The criterion, and the premise is half of the test.

    Every point carries its conversion — which is exactly what made the defect
    invisible — so the pass has **no span to repair** and learns the unit all the
    same. The trigger is *a point with no conversion or a symbol with no unit*,
    and this row is the second half of that sentence.
    """
    metrics, instrument = _met_with_its_market_shut(store, monkeypatch)

    # The premise: converted at 1,0, and the store knows no unit for them.
    assert _point(store) == [(101.0, 101.0, 1.0), (102.0, 102.0, 1.0),
                             (103.0, 103.0, 1.0)]
    assert quotes.quote_currency(store, 'AAPL') is None
    before = store.query('SELECT count(*) FROM price_point')[0]

    written, _ = _lateral(metrics)

    assert quotes.quote_currency(store, 'AAPL') == 'EUR'
    assert instrument.reads == 1
    # And **not one row was added**, counted rather than argued: the price gate
    # of the live scrape is untouched, which is what keeps a table deliberately
    # without an index from collecting an identical point every 120 s all night.
    assert written == 0
    assert store.query('SELECT count(*) FROM price_point')[0] == before
    assert _point(store) == [(101.0, 101.0, 1.0), (102.0, 102.0, 1.0),
                             (103.0, 103.0, 1.0)]


def test_a_pass_that_only_learnt_a_unit_says_so_and_is_not_a_failure(
        store, monkeypatch):
    """A pass that did the only work there was is not a pass that found none.

    ``nothing_to_repair`` would have been the cheap reuse and it says the
    opposite of what happened, on the one cycle that turns a line from carried at
    cost into quoted. So the vocabulary gains the case rather than borrowing a
    word: a verdict of its own, no failure counted, no terminal armed, and it
    travels to ``/api/runtime`` as the pass's state.
    """
    metrics, _ = _met_with_its_market_shut(store, monkeypatch)

    _, record = _lateral(metrics)

    assert record.skipped == runtime_state.SKIP_UNIT_LEARNT
    assert record.failed is False and record.failures == 0
    assert record.terminal is None and record.error is None
    # No window: there was no span, and dating a repair nobody made would be a
    # claim about rows this pass never touched.
    assert record.window is None
    assert 'AAPL' not in metrics._lateral_retry_at
    assert runtime_view.backfill_progress(
        record, runtime_state.LATERAL, datetime.now(UTC)).state \
        == runtime_state.SKIP_UNIT_LEARNT


def test_the_learnt_unit_makes_the_position_quoted_rather_than_carried(
        store, monkeypatch, declare_positions):
    """The consequence on the screen, read off the payload the front reads.

    *A quote is a number **and** a unit* (#774): before the pass the row carries
    a price with no currency beside it, which ``carrying.is_quoted`` — and
    ``lib/absence.ts`` with it — reads as *carried at its cost*, an em dash and a
    latent gain of zero, indistinguishable from a line the market cannot price.
    The repair belongs to the writer, and this is it landing.
    """
    declare_positions(store, [_share()])
    metrics, _ = _met_with_its_market_shut(store, monkeypatch)

    def published():
        rows = store_reads.PortfolioReader(store).positions()
        return portfolio_view.build_positions(rows, 'EUR')[0]

    before = published()
    assert before['price']['value'] == 103.0
    assert before['price']['currency'] is None
    assert carrying.is_quoted(before['price']['value'],
                              before['price']['currency']) is False

    _lateral(metrics)

    after = published()
    assert after['price']['value'] == 103.0
    assert after['price']['currency'] == 'EUR'
    assert carrying.is_quoted(after['price']['value'],
                              after['price']['currency']) is True
    # The conversion was never the missing half, and it has not moved.
    assert after['converted'] == {'value': 103.0, 'currency': 'EUR',
                                  'rate': 1.0, 'rate_at': after['price']['at']}


def test_the_foreign_currency_twin_goes_on_being_repaired_exactly_as_before(
        store, monkeypatch):
    """The corollary that is also the control (issue #825).

    In a foreign currency the points stay unconverted, the old trigger sees them
    and the repair happens — which is precisely why the defect only ever showed
    on the pair *quote currency = reporting currency*. Widening the trigger must
    move nothing here: the span is still what sizes the work, the unit is still
    learnt on the way, and the pass still reports what it **converted** rather
    than reporting that it learnt a unit.
    """
    metrics = _metrics(store, base_currency='EUR')
    _unconverted(store, currency=None)
    monkeypatch.setattr(main.time, 'sleep', lambda *a, **k: None)
    instrument = _Instrument(info={'currency': 'USD'})
    monkeypatch.setattr(main.yf, 'Ticker', instrument)
    metrics.rates = fx.Rates(lambda pair: None, _SeriesFetch({'USDEUR=X': {
        date(2024, 6, 1): 0.90, date(2024, 6, 2): 0.91,
        date(2024, 6, 3): 0.92}}))

    written, record = _lateral(metrics)

    assert written == 3
    assert quotes.quote_currency(store, 'AAPL') == 'USD'
    assert record.written == 3
    assert record.skipped is None          # never ``unit_learnt``: it converted
    assert record.window is not None
    assert _point(store) == [
        (101.0, pytest.approx(101.0 * 0.90), 0.90),
        (102.0, pytest.approx(102.0 * 0.91), 0.91),
        (103.0, pytest.approx(103.0 * 0.92), 0.92),
    ]


def test_two_cycles_on_a_unit_just_learnt_emit_one_request(
        store, monkeypatch):
    """The guard the widening could have broken, and the reason it does not.

    The three load-bearing guards are what make the trigger *"a symbol with no
    unit"* cost one request per symbol for the life of the install rather than
    one per cycle: the back-off in front of the pass, the memory of a Yahoo that
    named nothing, and — the one at work here — a learnt unit **written to the
    store**, which is what the next cycle reads instead of asking.
    """
    metrics, instrument = _met_with_its_market_shut(store, monkeypatch)

    first = _lateral(metrics)[1]
    second = _lateral(metrics)[1]

    assert instrument.reads == 1
    assert first.skipped == runtime_state.SKIP_UNIT_LEARNT
    # And the cycle after it is the ordinary steady state, which is the honest
    # reading: there is nothing left to repair *and* the unit is known.
    assert second.skipped == runtime_state.SKIP_NOTHING_TO_REPAIR


def test_a_unit_yahoo_names_none_for_is_not_re_asked_every_cycle_either(
        store, monkeypatch):
    """The second half of the same guard, on the branch with **no span at all**.

    Without the memory of a reply that named nothing, a symbol Yahoo says nothing
    about and whose points are all converted would put the question again on
    every cycle for ever — the pass having, this time, no span whose repair could
    ever take it back out of the trigger. ``no_quote_currency`` keeps its
    subject: a reply, durable, and never a failure.
    """
    metrics, instrument = _met_with_its_market_shut(store, monkeypatch, info={})

    records = [_lateral(metrics)[1] for _ in range(3)]

    assert instrument.reads == 1
    assert {record.skipped for record in records} == \
        {runtime_state.SKIP_NO_QUOTE_CURRENCY}
    assert all(record.failed is False for record in records)
    assert quotes.quote_currency(store, 'AAPL') is None


def test_a_failed_request_for_a_unit_alone_backs_off_and_concludes_nothing(
        store, monkeypatch):
    """A request that did not complete taught nothing, span or no span.

    #704's rule, on the branch #825 opens: the back-off is honoured, no terminal
    is armed — no pair was named, let alone refused — and the error names the one
    thing that could not be established rather than claiming a number of points
    it could not convert, there being none.
    """
    metrics, instrument = _met_with_its_market_shut(store, monkeypatch)
    instrument._raises = RuntimeError('yahoo is down')

    at = datetime.now(UTC)
    written, record = _lateral(metrics)

    assert written == 0
    assert record.failed is True and record.failures == 1
    assert record.terminal is None
    assert record.window is None
    assert record.error == \
        'the currency AAPL is quoted in could not be established'
    assert (metrics._lateral_retry_at['AAPL'] - at).total_seconds() \
        == pytest.approx(scheduling.backoff_delay(metrics.regular_interval, 1),
                         abs=2)
    # A failure is not a reply: the symbol is asked again once the back-off has
    # run out, and for ever.
    metrics._lateral_retry_at.clear()
    _lateral(metrics)
    assert instrument.reads == 2
