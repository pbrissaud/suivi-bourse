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
# --------------------------------------------------------------------------- #
class _CashConfigManager:
    """Fake config manager exposing accounts + events for account_metrics."""

    def __init__(self, shares, events, accounts, opened_store=None):
        self._shares = shares
        self._events = events
        self._accounts = accounts
        self._store = opened_store

    @property
    def store(self):
        return self._store

    @contextmanager
    def writing(self):
        yield self._store

    def current(self):
        import main
        return main.ConfigSnapshot(shares=self._shares, events=self._events,
                                   accounts=self._accounts, cache_key=None)

    def reload(self, force=False):
        return self.current()

    def load_shares(self, force=False):
        return self._shares

    def get_mode(self):
        return "events"

    def get_first_buy_date(self, symbol):
        return None

    def get_events(self):
        return self._events

    def load_accounts(self):
        return self._accounts


def _metrics(store, shares, events, accounts):
    import main
    for account in (accounts.accounts if accounts else []):
        store.execute(
            "INSERT INTO account (id, type, label) VALUES (?, ?, ?) "
            "ON CONFLICT (id) DO NOTHING",
            [account.id, account.type, account.label])
    for share in shares:
        store.execute(
            "INSERT INTO symbol (symbol) VALUES (?) "
            "ON CONFLICT (symbol) DO NOTHING", [share["symbol"]])
    cfg = _CashConfigManager(shares, events, accounts, opened_store=store)
    metrics = main.SuiviBourseMetrics(cfg)
    # The one question the app asks (#702, ADR-0021). Without an answer the perf
    # job writes **nothing at all** — not zeros, not NULLs — because every figure
    # it computes is money and an amount with no settled unit is not a figure.
    # ``test_no_base_currency_writes_no_performance_at_all`` is where that is
    # asserted; everything else here is about the arithmetic behind it.
    metrics.base_currency = 'EUR'
    return metrics


def test_update_account_metrics_gated_on_declared_accounts(store):
    # No accounts -> nothing written.
    m = _metrics(store, shares=[], events=[
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=100.0, account="A")],
        accounts=None)
    m.update_account_metrics()
    assert store.query("SELECT count(*) FROM account_metrics") == [(0,)]


def test_update_account_metrics_writes_series_with_midnight_stamp(
        store, mocker):
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 2), EventType.BUY, "AAPL", "Apple", quantity=2,
              unit_price=100.0, account="PEA"),
    ]
    shares = [{"name": "Apple", "symbol": "AAPL", "account": "PEA",
               "purchase": {"quantity": 2, "cost_price": 100.0, "fee": 0.0},
               "estate": {"quantity": 2, "received_dividend": 0.0}}]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    # Price series: AAPL at 110 from 2024-01-02.
    _seed_price(store, "AAPL", date(2024, 1, 2), 110.0)

    m = _metrics(store, shares, events, portfolio)

    # Freeze "today" to 2024-01-02 while keeping real datetime construction.
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 1, 2, 15, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)

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


def test_update_account_metrics_is_idempotent(store, mocker):
    """Two cycles with no new event produce the identical (tags, time) point set."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])

    m = _metrics(store, shares=[], events=events, accounts=portfolio)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 1, 1, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)

    m.update_account_metrics()
    first = store.query("SELECT * FROM account_metrics ORDER BY day")
    m.update_account_metrics()
    second = store.query("SELECT * FROM account_metrics ORDER BY day")

    # The upsert overwrites its own key rather than appending a second row.
    assert first == second


def test_update_account_metrics_writes_portfolio_totals_single_currency(
        store, mocker):
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])

    m = _metrics(store, shares=[], events=events, accounts=portfolio)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 1, 2, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)

    m.update_account_metrics()

    assert store.query("SELECT count(*) FROM portfolio_totals") == [(2,)]


def test_two_accounts_are_pooled_because_they_cannot_disagree_on_a_currency(
        store, mocker):
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

    m = _metrics(store, shares=[], events=events, accounts=portfolio)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 1, 2, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)

    m.update_account_metrics()

    assert store.query(
        "SELECT total_value FROM portfolio_totals ORDER BY day DESC LIMIT 1") \
        == [(1500.0,)]
    assert store.query("SELECT count(*) FROM account_metrics")[0][0] > 0


def test_no_base_currency_writes_no_performance_at_all(store, mocker):
    """Not zeros, not `NULL`s, not a partial series — **nothing** (#702, ADR-0002).

    Prices go on being collected natively the whole time, so answering late
    costs nothing; writing a total with no unit would cost a chart that means
    nothing, drawn before anyone could say so.
    """
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0,
                    account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])

    m = _metrics(store, shares=[], events=events, accounts=portfolio)
    m.base_currency = None
    _fixed_today(mocker, 2024, 1, 2)

    m.update_account_metrics()

    assert store.query("SELECT count(*) FROM account_metrics") == [(0,)]
    assert store.query("SELECT count(*) FROM portfolio_totals") == [(0,)]

    # ...and answering it is all it takes: the next cycle writes the series it
    # was withholding, with nothing to replay and nothing to repair.
    m.base_currency = 'EUR'
    m.update_account_metrics()

    assert store.query("SELECT count(*) FROM account_metrics")[0][0] > 0
    assert store.query("SELECT count(*) FROM portfolio_totals")[0][0] > 0


def test_account_metrics_perf_fields_only_on_latest_point(
        store, mocker):
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=100.0, account="PEA"),
    ]
    shares = [{"name": "Apple", "symbol": "AAPL", "account": "PEA",
               "purchase": {"quantity": 10, "cost_price": 100.0, "fee": 0.0},
               "estate": {"quantity": 10, "received_dividend": 0.0}}]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    _seed_price(store, "AAPL", date(2024, 1, 1), 100.0)
    _seed_price(store, "AAPL", date(2024, 1, 2), 110.0)

    m = _metrics(store, shares, events, portfolio)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 1, 2, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)

    m.update_account_metrics()

    rows = store.query(
        "SELECT day, twr_index, gain_absolu FROM account_metrics ORDER BY day")
    # twr_index present on every point; gain_absolu only on the latest.
    assert all(row[1] is not None for row in rows)
    assert rows[0][2] is None
    assert rows[-1][2] == pytest.approx(100.0)   # 10*110 - 1000
    assert rows[-1][1] == pytest.approx(110.0)


# --------------------------------------------------------------------------- #
# Incremental perf-series write (issue #597): a steady cycle rewrites only the
# stale tail. The reason it existed — a full rewrite landing never-compacted
# Parquet files on InfluxDB 3 Core — leaves with the database, and the window
# itself leaves with #707, where an upsert on a primary key makes it pointless.
# What it must not do meanwhile is change meaning.
# --------------------------------------------------------------------------- #
def _fixed_today(mocker, y, mo, d):
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(y, mo, d, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)


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


def test_update_account_metrics_second_cycle_writes_only_today(
        store, mocker):
    """First cycle writes the full series; a steady second cycle (no backfill,
    no event change) rewrites ONLY today's point — the fix for #597."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, shares=[], events=events, accounts=portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()
    assert _acc_days(store) == {date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 3)}

    _mark_all(store)
    m.update_account_metrics()
    assert _acc_days(store) == {date(2024, 1, 3)}


def test_backfill_dirty_mark_widens_the_incremental_window(
        store, mocker):
    """A backfill that fills an earlier day re-arms the watermark so the next
    cycle rewrites the whole tail from that day through today (TWR compounds
    forward, so the tail must be recomputed)."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, shares=[], events=events, accounts=portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()                 # full
    m.update_account_metrics()                 # today only

    m._mark_perf_dirty(date(2024, 1, 2))       # backfill filled 01-02
    _mark_all(store)
    m.update_account_metrics()
    assert _acc_days(store) == {date(2024, 1, 2), date(2024, 1, 3)}


def test_update_account_metrics_full_rewrite_on_event_reload(
        store, mocker):
    """When the events cache is reloaded (files changed), the next cycle rewrites
    the full series — a new/edited event can shift any past day (cash, holdings,
    contributions), not just today."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, shares=[], events=events, accounts=portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()                 # full
    m.update_account_metrics()                 # today only

    # Simulate an event-file reload: get_events() now returns a NEW list object.
    m.config_manager._events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    _mark_all(store)
    m.update_account_metrics()
    assert _acc_days(store) == {date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 3)}


def test_write_failure_re_arms_the_dirty_watermark(
        store, mocker):
    """If the account_metrics write raises, the stale tail must not be lost: the
    watermark is re-armed so the next cycle retries the same slice (#597)."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, shares=[], events=events, accounts=portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()                 # first full write succeeds
    m._mark_perf_dirty(date(2024, 1, 2))       # backfill filled 01-02
    mocker.patch.object(main.perf_series, "write_account_metrics",
                        side_effect=RuntimeError("the store is unwritable"))

    with pytest.raises(RuntimeError):
        m.update_account_metrics()

    # Tail [01-02 .. today] preserved for the next cycle, not silently dropped.
    assert m._perf_dirty_from == date(2024, 1, 2)


def test_portfolio_totals_second_cycle_writes_only_today(
        store, mocker):
    """The global portfolio_totals series is incremental too (same #597 fix)."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "Mon PEA")])
    m = _metrics(store, shares=[], events=events, accounts=portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()
    _mark_all(store)
    m.update_account_metrics()
    assert _totals_days(store) == {date(2024, 1, 3)}


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
    # No `account_currency` label since #702: an account has no currency of its
    # own, and the one it used to carry was an always-empty third level.
    assert reg.get_sample_value("sb_account_info", {
        "account": "PEA", "account_type": "PEA"}) == 1.0
