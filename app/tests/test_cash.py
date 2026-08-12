"""
Unit tests for cash events and the per-account cash ledger (issue #576).

Covers:
  * validator — DEPOSIT/WITHDRAWAL required/forbidden fields
  * replay ledger — the six cash rules, net_contributed, SELL crediting cash,
    per-account siloing, CashFlow emission
  * Timeline.cash_at forward-fill
  * InfluxDBWriter.get_price_series / write_account_metrics SQL & tags
  * SuiviBourseMetrics.update_account_metrics wiring (gate, midnight stamp,
    holdings valuation, negative-balance warning)

No network, no real InfluxDB.
"""

from contextlib import contextmanager
from dataclasses import replace
from datetime import date, datetime, time, timezone

import pytest

import main
import perf_series
import quotes
from events import (
    EventAggregator, EventValidator, Event, EventType, CashFlow, Account, Portfolio,
    AccountMetricPoint, PortfolioTotalPoint,
)


def _seed_price(store, symbol, day, price):
    """One closing price on a calendar day, through the real writer.

    Written **converted as well as native** (#702). The perf job reads the
    converted column, because every figure it computes is money in the reporting
    currency; a point carrying only a native price is one whose conversion has
    not landed yet, and it is deliberately invisible to that read. Here the
    security is quoted in the reporting currency, so the rate is 1.
    """
    store.execute("INSERT INTO symbol (symbol) VALUES (?) "
                  "ON CONFLICT (symbol) DO NOTHING", [symbol])
    quotes.record_history(store, symbol, [{
        "timestamp": datetime.combine(day, time(16, 0), tzinfo=timezone.utc),
        "price": price, "converted": price, "rate": 1.0}])


# --------------------------------------------------------------------------- #
# Validator: DEPOSIT / WITHDRAWAL
# --------------------------------------------------------------------------- #
def _deposit(**kw):
    base = dict(amount=1000.0, account="PEA")
    base.update(kw)
    return Event(date(2024, 1, 15), EventType.DEPOSIT, **base)


def test_cash_event_valid():
    ok, errors = EventValidator().validate([_deposit()])
    assert ok, errors


def test_cash_event_requires_positive_amount():
    ok, errors = EventValidator().validate([_deposit(amount=None)])
    assert not ok and any("amount is required" in e for e in errors)
    ok, errors = EventValidator().validate([_deposit(amount=0)])
    assert not ok and any("amount must be positive" in e for e in errors)


def test_a_cash_event_without_an_account_falls_into_default(tmp_path):
    """v4 demanded an account here even with none declared. #698 does not.

    Under the new rule a blank ``account`` column *means* ``default`` until
    something is declared, so keeping the per-type requirement would have forced
    a single-account v4 user to write ``default`` into a cell whose only legal
    value is the one it already implies — and their files are supposed to import
    without a single edit.
    """
    ok, errors = EventValidator().validate([_deposit(account=None)])
    assert ok, errors


def test_a_cash_event_without_an_account_is_refused_once_accounts_exist():
    """The other half of the same rule: after a declaration, blank is an error."""
    validator = EventValidator(account_ids={"default", "PEA"},
                               accounts_declared=True)
    ok, errors = validator.validate([_deposit(account=None)])
    assert not ok and any("account is required" in e for e in errors)


def test_cash_event_forbids_share_fields():
    ok, errors = EventValidator().validate([_deposit(symbol="AAPL", quantity=1)])
    assert not ok
    assert any("not allowed" in e and "symbol" in e and "quantity" in e for e in errors)


def test_cash_event_negative_fee_rejected():
    ok, errors = EventValidator().validate([_deposit(fee=-1)])
    assert not ok and any("fee cannot be negative" in e for e in errors)


def test_withdrawal_valid():
    ev = Event(date(2024, 2, 1), EventType.WITHDRAWAL, amount=500.0, account="PEA")
    ok, errors = EventValidator().validate([ev])
    assert ok, errors


def test_share_event_still_requires_symbol_and_name():
    # The loader no longer enforces symbol/name; the validator must.
    ev = Event(date(2024, 1, 1), EventType.BUY, quantity=1, unit_price=10.0)
    ok, errors = EventValidator().validate([ev])
    assert not ok
    assert any("symbol is required" in e for e in errors)
    assert any("name is required" in e for e in errors)


# --------------------------------------------------------------------------- #
# Ledger rules (replay)
# --------------------------------------------------------------------------- #
def _cash(tl, account, on):
    state = tl.cash_at(account, on)
    return state.cash_balance if state else 0.0


def test_ledger_applies_the_six_rules():
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, fee=1.0, account="A"),
        Event(date(2024, 1, 2), EventType.BUY, "AAPL", "Apple", quantity=2,
              unit_price=100.0, fee=2.0, account="A"),
        Event(date(2024, 1, 3), EventType.DIVIDEND, "AAPL", "Apple", amount=5.0,
              fee=0.5, account="A"),
        Event(date(2024, 1, 4), EventType.SELL, "AAPL", "Apple", quantity=1,
              unit_price=120.0, fee=1.5, account="A"),
        Event(date(2024, 1, 5), EventType.GRANT, "AAPL", "Apple", quantity=1, account="A"),
        Event(date(2024, 1, 6), EventType.WITHDRAWAL, amount=100.0, fee=2.0, account="A"),
    ]
    tl = EventAggregator().replay(events)

    # DEPOSIT +999; BUY -202; DIVIDEND +4.5; SELL +118.5; GRANT 0; WITHDRAWAL -102
    assert _cash(tl, "A", date(2024, 1, 1)) == pytest.approx(999.0)
    assert _cash(tl, "A", date(2024, 1, 2)) == pytest.approx(797.0)
    assert _cash(tl, "A", date(2024, 1, 3)) == pytest.approx(801.5)
    assert _cash(tl, "A", date(2024, 1, 4)) == pytest.approx(920.0)
    assert _cash(tl, "A", date(2024, 1, 5)) == pytest.approx(920.0)  # GRANT cash-neutral
    assert _cash(tl, "A", date(2024, 1, 6)) == pytest.approx(818.0)


def test_net_contributed_excludes_fees():
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, fee=5.0, account="A"),
        Event(date(2024, 1, 2), EventType.WITHDRAWAL, amount=300.0, fee=2.0, account="A"),
    ]
    tl = EventAggregator().replay(events)
    state = tl.cash_at("A", date(2024, 1, 2))
    # net_contributed = 1000 - 300 (fees excluded); cash = 995 - 302 = 693
    assert state.net_contributed == pytest.approx(700.0)
    assert state.cash_balance == pytest.approx(693.0)


def test_cash_is_siloed_per_account():
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 2), EventType.DEPOSIT, amount=500.0, account="CTO"),
    ]
    tl = EventAggregator().replay(events)
    assert _cash(tl, "PEA", date(2024, 1, 2)) == pytest.approx(1000.0)
    assert _cash(tl, "CTO", date(2024, 1, 2)) == pytest.approx(500.0)


def test_cash_at_none_before_first_event():
    events = [Event(date(2024, 6, 1), EventType.DEPOSIT, amount=100.0, account="A")]
    tl = EventAggregator().replay(events)
    assert tl.cash_at("A", date(2024, 1, 1)) is None
    assert tl.cash_at("A", date(2024, 6, 1)).cash_balance == pytest.approx(100.0)


def test_negative_balance_allowed():
    # BUY without a prior DEPOSIT drives cash negative — permitted, no error.
    events = [
        Event(date(2024, 1, 2), EventType.BUY, "AAPL", "Apple", quantity=1,
              unit_price=100.0, account="A"),
    ]
    tl = EventAggregator().replay(events)
    assert _cash(tl, "A", date(2024, 1, 2)) == pytest.approx(-100.0)


def test_replay_emits_signed_cashflows():
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="A"),
        Event(date(2024, 1, 2), EventType.WITHDRAWAL, amount=300.0, account="A"),
    ]
    flows = [f for f in EventAggregator().replay(events).flows
             if isinstance(f, CashFlow)]
    assert [(f.account, f.amount) for f in flows] == [("A", 1000.0), ("A", -300.0)]


# --------------------------------------------------------------------------- #
# The store's own two halves: the price series the perf job reads, and the
# series it writes. Both were InfluxDB client assertions until #700; both are
# asserted on the rows now.
# --------------------------------------------------------------------------- #
def test_the_price_series_is_read_by_symbol_alone(store):
    """A market price belongs to no account, and since #700 that is not a rule
    to remember — there is no account column on the series to forget."""
    store.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")
    quotes.record_history(store, "AAPL", [
        {"timestamp": datetime(2024, 1, 2, 16, 0, tzinfo=timezone.utc),
         "price": 100.0, "converted": 100.0, "rate": 1.0},
        {"timestamp": datetime(2024, 1, 3, 16, 0, tzinfo=timezone.utc),
         "price": 110.0, "converted": 110.0, "rate": 1.0},
    ])

    assert quotes.price_series(store, "AAPL") == {
        date(2024, 1, 2): 100.0, date(2024, 1, 3): 110.0}


def test_the_price_series_keeps_the_last_point_of_each_day(store):
    """The survivor rule every daily read in the product follows — and the one
    #705's ladder will inherit. A survivor chosen otherwise makes the value jump
    when a day is collapsed."""
    store.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")
    quotes.record_history(store, "AAPL", [
        {"timestamp": datetime(2024, 1, 2, 9, 0, tzinfo=timezone.utc),
         "price": 100.0, "converted": 100.0, "rate": 1.0},
        {"timestamp": datetime(2024, 1, 2, 17, 30, tzinfo=timezone.utc),
         "price": 104.0, "converted": 104.0, "rate": 1.0},
    ])

    assert quotes.price_series(store, "AAPL") == {date(2024, 1, 2): 104.0}


def test_account_metrics_are_upserted_on_the_day_they_describe(store):
    """The write is an ``UPSERT`` on the primary key (ADR-0011): a second cycle
    rewrites the row rather than appending one. Measured on a thousand cycles, a
    ``DELETE``+``INSERT`` replacement takes the file to 44,8 MB for a 1,6 MB
    table."""
    store.execute("INSERT INTO account (id, type, label) VALUES "
                  "('PEA', 'PEA', 'Mon PEA')")
    point = AccountMetricPoint(
        account="PEA", account_type="PEA",
        day=date(2024, 1, 15), cash_balance=100.0, holdings_value=900.0,
        total_value=1000.0, net_contributed=800.0)

    assert perf_series.write_account_metrics(store, [point]) == 1
    perf_series.write_account_metrics(
        store, [replace(point, holdings_value=950.0, total_value=1050.0)])

    rows = store.query(
        "SELECT day, cash_balance, holdings_value, total_value, "
        "       net_contributed, xirr FROM account_metrics")
    assert rows == [(date(2024, 1, 15), 100.0, 950.0, 1050.0, 800.0, None)]


def test_a_field_that_was_never_computable_is_null_not_missing(store):
    """ADR-0001, and the death of ``_ABSENT_SCHEMA`` with it.

    In InfluxDB a field never written was a *column that did not exist*, so
    naming ``xirr`` in a SELECT turned "this account has no deposits" into a
    query error — and, after #696, into a 503 that took the whole table with it.
    Here the column is declared at creation and reads ``NULL``.
    """
    store.execute("INSERT INTO account (id, type, label) VALUES "
                  "('PEA', 'PEA', 'Mon PEA')")
    perf_series.write_account_metrics(store, [AccountMetricPoint(
        account="PEA", account_type="PEA",
        day=date(2024, 1, 15), cash_balance=100.0, holdings_value=900.0,
        total_value=1000.0, net_contributed=800.0)])

    rows = store.query("SELECT xirr, gain_absolu, twr_index FROM account_metrics")
    assert rows == [(None, None, None)]


def test_portfolio_totals_is_keyed_by_the_day_alone(store):
    """A table of its own rather than a synthetic ``account`` row: the InfluxDB
    constraint that made it untagged is gone, but its columns will diverge the
    day the global level carries something the per-account one does not."""
    assert perf_series.write_portfolio_totals(store, [PortfolioTotalPoint(
        day=date(2024, 1, 15), cash_balance=100.0, holdings_value=900.0,
        total_value=1000.0, net_contributed=800.0, xirr=0.12,
        gain_absolu=200.0, twr_index=120.0)]) == 1

    rows = store.query(
        "SELECT day, total_value, xirr, twr_index FROM portfolio_totals")
    assert rows == [(date(2024, 1, 15), 1000.0, 0.12, 120.0)]


# --------------------------------------------------------------------------- #
# SuiviBourseMetrics.update_account_metrics wiring
#
# The job's **only inputs are the store and the clock** (issue #707), so every
# test below lays its ledger into the store and reads the answer back out of it.
# The configuration manager is down to what the job actually asks it for: the
# open store, and the writers' mutex.
# --------------------------------------------------------------------------- #
class _CashConfigManager:
    """The two members the perf job uses: the read handle and the write mutex."""

    def __init__(self, opened_store):
        self._store = opened_store

    @property
    def store(self):
        return self._store

    @contextmanager
    def writing(self):
        yield self._store


def _metrics(store, declare_ledger, events, accounts):
    import main
    declare_ledger(store, events, accounts.accounts if accounts else None)
    metrics = main.SuiviBourseMetrics(_CashConfigManager(store))
    # The one question the app asks (#702, ADR-0021). Without an answer the perf
    # job writes **nothing at all** — not zeros, not NULLs — because every figure
    # it computes is money and an amount with no settled unit is not a figure.
    # ``test_no_base_currency_writes_no_performance_at_all`` is where that is
    # asserted; everything else here is about the arithmetic behind it.
    metrics.base_currency = 'EUR'
    return metrics


def _fixed_today(mocker, y, mo, d):
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(y, mo, d, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)


def test_the_seeded_default_account_gets_a_series_like_any_other(
        store, declare_ledger):
    """**The opt-in guard is gone** (issue #708), and this is what it hid.

    It read ``declared_portfolio``, whose ``None`` means *"nothing beyond the
    seed"* — and ADR-0013 seeds a ``default`` row at the creation of the schema
    and never removes it, so the condition had lost its subject. What it produced
    meanwhile was not an opt-in: a single-account install, the ordinary shape of
    a v4 coming over, had **no performance series at all**, with nothing on
    screen and nothing in the log to say why.
    """
    m = _metrics(store, declare_ledger, events=[
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=100.0)],
        accounts=None)
    m.update_account_metrics()
    (day, cash, total) = store.query(
        "SELECT day, cash_balance, total_value FROM account_metrics "
        " WHERE account = 'default' ORDER BY day LIMIT 1")[0]
    assert day == date(2024, 1, 1)
    assert cash == pytest.approx(100.0)
    assert total == pytest.approx(100.0)


def test_an_account_with_no_cash_event_writes_holdings_and_gain_and_nothing_else(
        store, declare_ledger, mocker):
    """The per-field rule, through the writer (issue #708, ADR-0018).

    A ledger of purchases alone: the replay debits the cash on every buy without
    touching the contributions, so ``cash_balance = −invested`` and
    ``net_contributed = 0`` — and ``total_value`` would then publish the **latent
    gain under the label "total value"**. Those four are ``NULL`` and the two
    that stay exact are written: ``holdings_value``, and ``gain_absolu``, which
    with no contribution at all is ``holdings − invested`` — 220 − 200 here.
    """
    events = [
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=2,
              unit_price=100.0, account="PEA"),
    ]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    _seed_price(store, "AAPL", date(2024, 1, 1), 110.0)

    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 1)

    m.update_account_metrics()

    (cash, holdings, total, net, xirr, gain, twr) = store.query(
        "SELECT cash_balance, holdings_value, total_value, net_contributed, "
        "       xirr, gain_absolu, twr_index FROM account_metrics "
        " WHERE account = 'PEA'")[0]
    assert holdings == pytest.approx(220.0)
    assert gain == pytest.approx(20.0)
    assert (cash, total, net, xirr, twr) == (None, None, None, None, None)


def test_an_account_with_a_deposit_keeps_every_field(
        store, declare_ledger, mocker):
    """The other side of the same rule: nothing is withheld from an account whose
    ledger says where the money came from."""
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=2,
              unit_price=100.0, account="PEA"),
    ]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    _seed_price(store, "AAPL", date(2024, 1, 1), 110.0)

    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 1)

    m.update_account_metrics()

    (cash, holdings, total, net, gain, twr) = store.query(
        "SELECT cash_balance, holdings_value, total_value, net_contributed, "
        "       gain_absolu, twr_index FROM account_metrics "
        " WHERE account = 'PEA'")[0]
    assert cash == pytest.approx(800.0)
    assert holdings == pytest.approx(220.0)
    assert total == pytest.approx(1020.0)
    assert net == pytest.approx(1000.0)
    assert gain == pytest.approx(20.0)
    assert twr == pytest.approx(100.0)


def test_the_global_is_written_from_the_max_of_the_horizons(
        store, declare_ledger, mocker):
    """Criterion 4, through the writer: ``portfolio_totals`` starts where the
    **last** account starts, never where the first one does.

    PEA holds a share priced only from 01-03; CTO holds cash alone and is
    writable from its first day. Summing what is available on 01-02 would draw a
    step nothing caused — the portfolio apparently gaining PEA's whole value
    overnight — so the global waits for both.
    """
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=500.0, account="CTO"),
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=2,
              unit_price=100.0, account="PEA"),
    ]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA"),
                           Account("CTO", "CTO", "My CTO")])
    _seed_price(store, "AAPL", date(2024, 1, 3), 110.0)

    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    horizons = m.update_account_metrics()

    assert horizons == {'PEA': date(2024, 1, 3), 'CTO': None, 'default': None}
    # PEA's series starts at its horizon, CTO's at its first day…
    assert store.query(
        "SELECT min(day) FROM account_metrics WHERE account = 'PEA'"
    ) == [(date(2024, 1, 3),)]
    assert store.query(
        "SELECT min(day) FROM account_metrics WHERE account = 'CTO'"
    ) == [(date(2024, 1, 1),)]
    # …and the global waits for the later of the two.
    assert store.query("SELECT day FROM portfolio_totals ORDER BY day") == [
        (date(2024, 1, 3),)]


def test_update_account_metrics_writes_series_with_midnight_stamp(
        store, declare_ledger, mocker):
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 2), EventType.BUY, "AAPL", "Apple", quantity=2,
              unit_price=100.0, account="PEA"),
    ]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    # Price series: AAPL at 110 from 2024-01-02.
    _seed_price(store, "AAPL", date(2024, 1, 2), 110.0)

    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 2)

    m.update_account_metrics()

    rows = {row[0]: row for row in store.query(
        "SELECT day, cash_balance, holdings_value, total_value, "
        "       net_contributed FROM account_metrics")}
    # Two calendar days: 01-01 (cash only) and 01-02 (cash + holdings). The
    # column is a DATE and not a midnight instant: the store has two kinds of
    # time and never mixes them (#700).
    assert set(rows) == {date(2024, 1, 1), date(2024, 1, 2)}
    assert rows[date(2024, 1, 1)][1] == pytest.approx(1000.0)
    assert rows[date(2024, 1, 1)][2] == pytest.approx(0.0)
    d2 = rows[date(2024, 1, 2)]
    assert d2[1] == pytest.approx(800.0)    # 1000 - 2*100
    assert d2[2] == pytest.approx(220.0)    # 2 * 110
    assert d2[3] == pytest.approx(1020.0)
    assert d2[4] == pytest.approx(1000.0)


def test_update_account_metrics_is_idempotent(store, declare_ledger, mocker):
    """Two cycles with no new event produce the identical point set."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])

    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 1)

    m.update_account_metrics()
    first = store.query("SELECT * FROM account_metrics ORDER BY day")
    m.update_account_metrics()
    second = store.query("SELECT * FROM account_metrics ORDER BY day")

    # The upsert overwrites its own key rather than appending a second row.
    assert first == second


def test_update_account_metrics_writes_portfolio_totals_single_currency(
        store, declare_ledger, mocker):
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])

    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 2)

    m.update_account_metrics()

    assert store.query("SELECT count(*) FROM portfolio_totals") == [(2,)]


def test_two_accounts_are_pooled_because_they_cannot_disagree_on_a_currency(
        store, declare_ledger, mocker):
    """The mixed-currency refusal is **gone** with `Account.currency` (#702).

    It used to withhold `portfolio_totals` whenever two declared accounts named
    different currencies. An account names none: there is one reporting currency
    for the install, every stored figure is already in it, and the pooling has
    nothing left to refuse. What can still make the global series unwritable is
    that currency being unanswered — and that gate is above, on the whole
    recompute, because it is true of every figure at once.
    """
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=500.0, account="CTO"),
    ]
    portfolio = Portfolio([
        Account("PEA", "PEA", "Mon PEA"),
        Account("CTO", "CTO", "My CTO"),
    ])
    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 2)

    m.update_account_metrics()

    assert store.query(
        "SELECT total_value FROM portfolio_totals ORDER BY day DESC LIMIT 1") \
        == [(1500.0,)]
    assert store.query("SELECT count(*) FROM account_metrics")[0][0] > 0


def test_no_base_currency_writes_no_performance_at_all(
        store, declare_ledger, mocker):
    """Not zeros, not `NULL`s, not a partial series — **nothing** (#702, ADR-0002).

    Prices go on being collected natively the whole time, so answering late
    costs nothing; writing a total with no unit would cost a chart that means
    nothing, drawn before anyone could say so.
    """
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0,
                    account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])

    m = _metrics(store, declare_ledger, events, portfolio)
    m.base_currency = None
    _fixed_today(mocker, 2024, 1, 2)

    m.update_account_metrics()

    assert store.query("SELECT count(*) FROM account_metrics") == [(0,)]

    # ...and answering it is all it takes: the next cycle writes the series it
    # was withholding, with nothing to replay and nothing to repair.
    m.base_currency = 'EUR'
    m.update_account_metrics()

    assert store.query("SELECT count(*) FROM portfolio_totals")[0][0] > 0


def test_account_metrics_perf_fields_only_on_latest_point(
        store, declare_ledger, mocker):
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=100.0, account="PEA"),
    ]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    _seed_price(store, "AAPL", date(2024, 1, 1), 100.0)
    _seed_price(store, "AAPL", date(2024, 1, 2), 110.0)

    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 2)

    m.update_account_metrics()

    rows = store.query(
        "SELECT day, twr_index, gain_absolu FROM account_metrics ORDER BY day")
    # twr_index present on every point; gain_absolu only on the latest.
    assert all(row[1] is not None for row in rows)
    assert rows[0][2] is None
    assert rows[-1][2] == pytest.approx(100.0)   # 10*110 - 1000
    assert rows[-1][1] == pytest.approx(110.0)


# --------------------------------------------------------------------------- #
# The series is a cache: integral recompute, block upsert, bounded prune
# (issue #707, ADR-0011). The incremental write window #597 introduced is gone,
# and so is the gate that decided whether to run at all — what replaces both is
# a cycle that costs 0,4 % of its own tick and can always be thrown away.
# --------------------------------------------------------------------------- #

#: A value no computation produces, used to mark the rows a cycle leaves alone.
_MARKER = -12345.0


def _mark_all(store):
    store.execute("UPDATE account_metrics SET cash_balance = ?", [_MARKER])
    store.execute("UPDATE portfolio_totals SET cash_balance = ?", [_MARKER])


def _acc_days(store):
    """The days the last cycle actually wrote.

    Asserted on the store rather than on a call, which means asserting on what a
    cycle *changed*: :func:`_mark_all` stamps every row with a value no
    computation produces, and the days that no longer carry it are the ones the
    cycle rewrote.
    """
    return {row[0] for row in store.query(
        "SELECT day FROM account_metrics WHERE cash_balance IS DISTINCT FROM ?",
        [_MARKER])}


def _totals_days(store):
    return {row[0] for row in store.query(
        "SELECT day FROM portfolio_totals WHERE cash_balance IS DISTINCT FROM ?",
        [_MARKER])}


def test_every_cycle_rewrites_the_whole_series(store, declare_ledger, mocker):
    """A steady second cycle rewrites **every** day, not just today's point.

    The incremental window's replacement is nothing at all: the recompute is
    integral and unconditional, and an upsert on a primary key is what makes
    that affordable (ADR-0011).
    """
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    whole = {date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 3)}
    m.update_account_metrics()
    assert _acc_days(store) == whole

    _mark_all(store)
    m.update_account_metrics()
    assert _acc_days(store) == whole
    assert _totals_days(store) == whole


def test_the_series_is_dense_over_calendar_days(store, declare_ledger, mocker):
    """Weekends and holidays carry a point, prices carried forward.

    "No point on a non-trading day" is a property of *observed* prices and never
    of a derived daily series: TWR chains over consecutive days, and a weekend
    deposit needs somewhere to land. 2024-01-06/07 is a Saturday and a Sunday,
    and the price series only ever saw the Friday.
    """
    events = [
        Event(date(2024, 1, 5), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 5), EventType.BUY, "AAPL", "Apple", quantity=2,
              unit_price=100.0, account="PEA"),
        Event(date(2024, 1, 6), EventType.DEPOSIT, amount=500.0, account="PEA"),
    ]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    _seed_price(store, "AAPL", date(2024, 1, 5), 110.0)   # Friday, and only it

    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 8)
    m.update_account_metrics()

    rows = {row[0]: row for row in store.query(
        "SELECT day, cash_balance, holdings_value, twr_index "
        "  FROM account_metrics ORDER BY day")}
    assert set(rows) == {date(2024, 1, d) for d in (5, 6, 7, 8)}
    # The Saturday deposit landed on the Saturday.
    assert rows[date(2024, 1, 6)][1] == pytest.approx(1300.0)
    # The Friday close is carried across the weekend rather than left absent.
    for day in (6, 7, 8):
        assert rows[date(2024, 1, day)][2] == pytest.approx(220.0)
        assert rows[date(2024, 1, day)][3] is not None


def test_deleting_the_rows_is_enough_to_rebuild(store, declare_ledger, mocker):
    """A rebuild needs no gesture: drop the rows, the next cycle rewrites them.

    This is what "it is a cache" buys, and it is why the page that would have
    designed a *rebuild* button has nothing left to design.
    """
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()
    before = store.query("SELECT * FROM account_metrics ORDER BY account, day")
    totals_before = store.query("SELECT * FROM portfolio_totals ORDER BY day")
    assert before and totals_before

    store.execute("DELETE FROM account_metrics")
    store.execute("DELETE FROM portfolio_totals")

    m.update_account_metrics()
    assert store.query(
        "SELECT * FROM account_metrics ORDER BY account, day") == before
    assert store.query("SELECT * FROM portfolio_totals ORDER BY day") == totals_before


def test_the_file_does_not_drift_over_many_cycles(store, declare_ledger, mocker):
    """N cycles must not grow the file: the write is an upsert, not a replace.

    ADR-0011 measured a ``DELETE``+``INSERT`` replacement at **44,8 MB for a
    1,6 MB table** over a thousand cycles (~11 GB a year, which a checkpoint does
    not give back). This is that measurement in miniature — a real store on a
    real file, which is the whole reason the fixture refuses ``:memory:``.
    """
    events = [
        Event(date(2023, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2023, 1, 2), EventType.BUY, "AAPL", "Apple", quantity=2,
              unit_price=100.0, account="PEA"),
    ]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    _seed_price(store, "AAPL", date(2023, 1, 2), 110.0)
    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 1)          # a year of daily points

    def _bytes():
        store.execute("CHECKPOINT")
        return sum(p.stat().st_size for p in
                   [store.path, store.path.with_suffix(".duckdb.wal")]
                   if p.exists())

    m.update_account_metrics()
    settled = _bytes()
    for _ in range(20):
        m.update_account_metrics()
    assert _bytes() == settled


def test_a_day_that_left_the_series_is_pruned(store, declare_ledger, mocker):
    """The prune is bounded by what the cycle wrote, and catches the orphan.

    An event withdrawn moves the account's first day forward; without the prune
    the days before it would stand for ever, describing a portfolio nobody
    declares — the same defect ``positions.write_state`` avoids by replacing.
    """
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 3), EventType.DEPOSIT, amount=10.0, account="PEA"),
    ]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 4)

    m.update_account_metrics()
    assert _acc_days(store) == {date(2024, 1, d) for d in (1, 2, 3, 4)}

    # The first deposit is forgotten: the series now starts on the 3rd.
    store.execute("DELETE FROM event WHERE date = ?", [date(2024, 1, 1)])
    m.update_account_metrics()
    assert _acc_days(store) == {date(2024, 1, 3), date(2024, 1, 4)}
    assert _totals_days(store) == {date(2024, 1, 3), date(2024, 1, 4)}


def test_an_account_that_stops_being_written_is_pruned(
        store, declare_ledger, mocker):
    """An account the ledger no longer produces loses its cached days.

    Its **declaration stands** — that is the whole case: the account row is
    undeletable while the perf job has written for it (the foreign key), and the
    real deletion path drops the cache first (``perf_series.forget_account``).
    What is left here is the account that is still declared and computes to
    nothing, whose days no reader could otherwise tell from current ones. It has
    no span, so it is entirely outside the written set — the same predicate as
    the orphaned day, in the same statement.
    """
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=500.0, account="CTO"),
    ]
    portfolio = Portfolio([
        Account("PEA", "PEA", "Mon PEA"),
        Account("CTO", "CTO", "My CTO"),
    ])
    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 2)

    m.update_account_metrics()
    assert {row[0] for row in store.query(
        "SELECT DISTINCT account FROM account_metrics")} == {"PEA", "CTO"}

    store.execute("DELETE FROM event WHERE account = ?", ["CTO"])
    m.update_account_metrics()
    assert {row[0] for row in store.query(
        "SELECT DISTINCT account FROM account_metrics")} == {"PEA"}


def test_an_emptied_ledger_empties_both_tables(store, declare_ledger, mocker):
    """Forgetting the last import takes the cache with it, global series included.

    An empty ``spans`` is not a guard to add but the honest reading of an
    integral recompute: producing no point for anybody means the ledger produces
    no series. A table left standing would go on describing a portfolio nobody
    declares — the rule ``positions.write_state`` already follows.
    """
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 2)

    m.update_account_metrics()
    assert store.query("SELECT count(*) FROM portfolio_totals")[0][0] == 2

    store.execute("DELETE FROM event")
    m.update_account_metrics()
    assert store.query("SELECT count(*) FROM account_metrics") == [(0,)]
    assert store.query("SELECT count(*) FROM portfolio_totals") == [(0,)]


def test_an_emptied_ledger_takes_the_gauges_with_the_rows(
        store, declare_ledger, mocker):
    """Criterion 8 of #708, at the level of the **row** rather than the field.

    The store and ``/metrics`` have to say the same thing in the same cycle. The
    per-field rule lives inside ``update_account``, which is only ever reached
    for a row the cycle produced — so an account that stops producing one is
    never visited, and its seven gauges would keep the last values they ever had
    for the life of the process while ``prune_account_metrics`` emptied the
    table beside them. A stale *real* figure is worse than the zero the rule was
    written against: a scraper cannot tell it from a current one. Same argument,
    same cycle, for the unlabelled ``sb_portfolio_*``.
    """
    from prometheus_client import generate_latest
    from prometheus_exporter import PrometheusExporter

    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0,
                    account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, declare_ledger, events, portfolio)
    m.prometheus = PrometheusExporter()
    _fixed_today(mocker, 2024, 1, 2)

    m.update_account_metrics()
    assert m.prometheus.registry.get_sample_value(
        'sb_account_total_value', {'account': 'PEA'}) == 1000.0
    assert m.prometheus.registry.get_sample_value(
        'sb_portfolio_total_value', {}) == 1000.0

    store.execute("DELETE FROM event")
    m.update_account_metrics()

    # A *labelled* family stays declared with no child, which is how Prometheus
    # spells an absent series: `# HELP` and `# TYPE`, and not one sample. The
    # unlabelled seven have no child to remove, so their absence is the family
    # leaving the registry altogether — the mechanism #708 had to add.
    samples = [sample.name
               for metric in m.prometheus.registry.collect()
               for sample in metric.samples
               if sample.name.startswith(('sb_account_', 'sb_portfolio_'))]
    assert samples == []
    assert 'sb_portfolio_' not in generate_latest(m.prometheus.registry).decode()


def test_a_failed_write_leaves_the_previous_cache_whole(
        store, declare_ledger, mocker):
    """One transaction for the upsert and the prune, so a failure rolls both back.

    There is nothing to re-arm afterwards — the two ``except`` blocks that put a
    watermark back went with the watermark (issue #707). The previous cache is a
    *complete* one, and the next tick rebuilds it whatever happened here.
    """
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, declare_ledger, events, portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()
    before = store.query("SELECT * FROM account_metrics ORDER BY day")

    mocker.patch.object(main.perf_series, "prune_account_metrics",
                        side_effect=RuntimeError("the store is unwritable"))
    with pytest.raises(RuntimeError):
        m.update_account_metrics()

    assert store.query("SELECT * FROM account_metrics ORDER BY day") == before


def test_prometheus_update_portfolio_sets_unlabeled_gauges():
    from prometheus_client import CollectorRegistry
    from prometheus_exporter import PrometheusExporter

    exp = PrometheusExporter(registry=CollectorRegistry())
    exp.update_portfolio(PortfolioTotalPoint(
        day=date(2024, 1, 2),
        cash_balance=100.0, holdings_value=900.0, total_value=1000.0,
        net_contributed=800.0, xirr=0.12, gain_absolu=200.0, twr_index=120.0,
    ))
    reg = exp.registry
    assert reg.get_sample_value("sb_portfolio_total_value") == 1000.0
    assert reg.get_sample_value("sb_portfolio_xirr") == 0.12
    assert reg.get_sample_value("sb_portfolio_twr_index") == 120.0


def test_prometheus_update_account_sets_gauges():
    from prometheus_client import CollectorRegistry
    from prometheus_exporter import PrometheusExporter

    exp = PrometheusExporter(registry=CollectorRegistry())
    exp.update_account(AccountMetricPoint(
        account="PEA", account_type="PEA",
        day=date(2024, 1, 15),
        cash_balance=100.0, holdings_value=900.0,
        total_value=1000.0, net_contributed=800.0,
    ))

    reg = exp.registry
    assert reg.get_sample_value("sb_account_cash_balance", {"account": "PEA"}) == 100.0
    assert reg.get_sample_value("sb_account_holdings_value", {"account": "PEA"}) == 900.0
    assert reg.get_sample_value("sb_account_total_value", {"account": "PEA"}) == 1000.0
    assert reg.get_sample_value("sb_account_net_contributed", {"account": "PEA"}) == 800.0
    assert reg.get_sample_value("sb_account_info", {
        "account": "PEA", "account_type": "PEA"}) == 1.0
