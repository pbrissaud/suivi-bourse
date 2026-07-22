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

from datetime import date, datetime, timezone

import pytest

from events import (
    EventAggregator, EventValidator, Event, EventType, CashFlow, Account, Portfolio,
    AccountMetricPoint, PortfolioTotalPoint,
)


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


def test_cash_event_requires_account_when_not_declared():
    ok, errors = EventValidator().validate([_deposit(account=None)])
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
    tl = EventAggregator().replay(events, accounts_declared=True)

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
    tl = EventAggregator().replay(events, accounts_declared=True)
    state = tl.cash_at("A", date(2024, 1, 2))
    # net_contributed = 1000 - 300 (fees excluded); cash = 995 - 302 = 693
    assert state.net_contributed == pytest.approx(700.0)
    assert state.cash_balance == pytest.approx(693.0)


def test_cash_is_siloed_per_account():
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 2), EventType.DEPOSIT, amount=500.0, account="CTO"),
    ]
    tl = EventAggregator().replay(events, accounts_declared=True)
    assert _cash(tl, "PEA", date(2024, 1, 2)) == pytest.approx(1000.0)
    assert _cash(tl, "CTO", date(2024, 1, 2)) == pytest.approx(500.0)


def test_cash_at_none_before_first_event():
    events = [Event(date(2024, 6, 1), EventType.DEPOSIT, amount=100.0, account="A")]
    tl = EventAggregator().replay(events, accounts_declared=True)
    assert tl.cash_at("A", date(2024, 1, 1)) is None
    assert tl.cash_at("A", date(2024, 6, 1)).cash_balance == pytest.approx(100.0)


def test_negative_balance_allowed():
    # BUY without a prior DEPOSIT drives cash negative — permitted, no error.
    events = [
        Event(date(2024, 1, 2), EventType.BUY, "AAPL", "Apple", quantity=1,
              unit_price=100.0, account="A"),
    ]
    tl = EventAggregator().replay(events, accounts_declared=True)
    assert _cash(tl, "A", date(2024, 1, 2)) == pytest.approx(-100.0)


def test_replay_emits_signed_cashflows():
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="A"),
        Event(date(2024, 1, 2), EventType.WITHDRAWAL, amount=300.0, account="A"),
    ]
    flows = [f for f in EventAggregator().replay(events, accounts_declared=True).flows
             if isinstance(f, CashFlow)]
    assert [(f.account, f.amount) for f in flows] == [("A", 1000.0), ("A", -300.0)]


# --------------------------------------------------------------------------- #
# InfluxDBWriter: get_price_series + write_account_metrics
# --------------------------------------------------------------------------- #
def test_get_price_series_queries_symbol_only_never_account(mocker):
    from influxdb_writer import InfluxDBWriter
    writer = InfluxDBWriter(host="http://x", token="t", database="db")
    fake_client = mocker.MagicMock()
    fake_client.query.return_value = None
    writer._client = fake_client

    writer.get_price_series("AAPL")

    sql = fake_client.query.call_args.kwargs["query"]
    assert "share_symbol = 'AAPL'" in sql
    # The 🔒 lock: a market price belongs to no account.
    assert "account" not in sql


def test_get_price_series_returns_full_history(mocker):
    """No account filter -> pre-tag (account NULL) points come back in full."""
    import pandas as pd
    from influxdb_writer import InfluxDBWriter
    writer = InfluxDBWriter(host="http://x", token="t", database="db")
    fake_client = mocker.MagicMock()
    table = mocker.MagicMock()
    table.__len__.return_value = 2
    table.to_pandas.return_value = pd.DataFrame({
        "day": [pd.Timestamp("2024-01-02"), pd.Timestamp("2024-01-03")],
        "price": [100.0, 110.0],
    })
    fake_client.query.return_value = table
    writer._client = fake_client

    series = writer.get_price_series("AAPL")
    assert series == {date(2024, 1, 2): 100.0, date(2024, 1, 3): 110.0}


def test_write_account_metrics_tags_and_fields(mocker):
    from influxdb_writer import InfluxDBWriter
    writer = InfluxDBWriter(host="http://x", token="t", database="db")
    fake_client = mocker.MagicMock()
    writer._client = fake_client

    ts = datetime(2024, 1, 15, tzinfo=timezone.utc)
    n = writer.write_account_metrics([AccountMetricPoint(
        account="PEA", account_type="PEA", account_currency="EUR",
        timestamp=ts, cash_balance=100.0, holdings_value=900.0,
        total_value=1000.0, net_contributed=800.0,
    )])

    assert n == 1
    records = fake_client.write.call_args.kwargs["record"]
    point = records[0]
    assert point._name == "account_metrics"
    assert point._tags == {
        "account": "PEA", "account_type": "PEA", "account_currency": "EUR"}
    assert point._fields["cash_balance"] == 100.0
    assert point._fields["holdings_value"] == 900.0
    assert point._fields["total_value"] == 1000.0
    assert point._fields["net_contributed"] == 800.0


# --------------------------------------------------------------------------- #
# SuiviBourseMetrics.update_account_metrics wiring
# --------------------------------------------------------------------------- #
class _CashConfigManager:
    """Fake config manager exposing accounts + events for account_metrics."""

    def __init__(self, shares, events, accounts):
        self._shares = shares
        self._events = events
        self._accounts = accounts

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


def _metrics(mock_influx, shares_validator, shares, events, accounts):
    import main
    cfg = _CashConfigManager(shares, events, accounts)
    return main.SuiviBourseMetrics(cfg, shares_validator, influxdb_writer=mock_influx)


def test_update_account_metrics_gated_on_declared_accounts(mock_influx, shares_validator):
    # No accounts -> nothing written.
    m = _metrics(mock_influx, shares_validator, shares=[], events=[
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=100.0, account="A")],
        accounts=None)
    m.update_account_metrics()
    mock_influx.write_account_metrics.assert_not_called()


def test_update_account_metrics_writes_series_with_midnight_stamp(
        mock_influx, shares_validator, mocker):
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 2), EventType.BUY, "AAPL", "Apple", quantity=2,
              unit_price=100.0, account="PEA"),
    ]
    shares = [{"name": "Apple", "symbol": "AAPL", "account": "PEA",
               "purchase": {"quantity": 2, "cost_price": 100.0, "fee": 0.0},
               "estate": {"quantity": 2, "received_dividend": 0.0}}]
    portfolio = Portfolio([Account("PEA", "PEA", "EUR", "Mon PEA")])
    # Price series: AAPL at 110 from 2024-01-02.
    mock_influx.get_price_series.return_value = {date(2024, 1, 2): 110.0}

    m = _metrics(mock_influx, shares_validator, shares, events, portfolio)

    # Freeze "today" to 2024-01-02 while keeping real datetime construction.
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 1, 2, 15, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)

    m.update_account_metrics()

    points = mock_influx.write_account_metrics.call_args.args[0]
    # Two calendar days: 01-01 (cash only) and 01-02 (cash + holdings).
    by_day = {p.timestamp.date(): p for p in points}
    assert set(by_day) == {date(2024, 1, 1), date(2024, 1, 2)}
    # Every point is stamped at midnight, never in the future.
    for p in points:
        ts = p.timestamp
        assert (ts.hour, ts.minute, ts.second) == (0, 0, 0)
    d1 = by_day[date(2024, 1, 1)]
    assert d1.cash_balance == pytest.approx(1000.0)
    assert d1.holdings_value == pytest.approx(0.0)
    d2 = by_day[date(2024, 1, 2)]
    assert d2.cash_balance == pytest.approx(800.0)   # 1000 - 2*100
    assert d2.holdings_value == pytest.approx(220.0)  # 2 * 110
    assert d2.total_value == pytest.approx(1020.0)
    assert d2.net_contributed == pytest.approx(1000.0)


def test_update_account_metrics_is_idempotent(mock_influx, shares_validator, mocker):
    """Two cycles with no new event produce the identical (tags, time) point set."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "EUR", "Mon PEA")])
    mock_influx.get_price_series.return_value = {}

    m = _metrics(mock_influx, shares_validator, shares=[], events=events, accounts=portfolio)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 1, 1, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)

    m.update_account_metrics()
    first = mock_influx.write_account_metrics.call_args.args[0]
    m.update_account_metrics()
    second = mock_influx.write_account_metrics.call_args.args[0]

    # Same timestamps, tags and values -> InfluxDB overwrites rather than dupes.
    assert first == second


def test_write_portfolio_totals_is_untagged(mocker):
    from influxdb_writer import InfluxDBWriter
    writer = InfluxDBWriter(host="http://x", token="t", database="db")
    fake_client = mocker.MagicMock()
    writer._client = fake_client

    ts = datetime(2024, 1, 15, tzinfo=timezone.utc)
    n = writer.write_portfolio_totals([PortfolioTotalPoint(
        timestamp=ts, cash_balance=100.0, holdings_value=900.0, total_value=1000.0,
        net_contributed=800.0, xirr=0.12, gain_absolu=200.0, twr_index=120.0,
    )])

    assert n == 1
    point = fake_client.write.call_args.kwargs["record"][0]
    assert point._name == "portfolio_totals"
    assert point._tags == {}  # no tag: a single global series
    assert point._fields["total_value"] == 1000.0
    assert point._fields["xirr"] == 0.12
    assert point._fields["twr_index"] == 120.0


def test_update_account_metrics_writes_portfolio_totals_single_currency(
        mock_influx, shares_validator, mocker):
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "EUR", "Mon PEA")])
    mock_influx.get_price_series.return_value = {}

    m = _metrics(mock_influx, shares_validator, shares=[], events=events, accounts=portfolio)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 1, 2, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)

    m.update_account_metrics()

    mock_influx.write_portfolio_totals.assert_called_once()
    pts = mock_influx.write_portfolio_totals.call_args.args[0]
    assert all(isinstance(p, PortfolioTotalPoint) for p in pts)


def test_update_account_metrics_skips_portfolio_totals_mixed_currency(
        mock_influx, shares_validator, mocker):
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=500.0, account="CTO"),
    ]
    portfolio = Portfolio([
        Account("PEA", "PEA", "EUR", "Mon PEA"),
        Account("CTO", "CTO", "USD", "My CTO"),
    ])
    mock_influx.get_price_series.return_value = {}

    m = _metrics(mock_influx, shares_validator, shares=[], events=events, accounts=portfolio)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 1, 2, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)

    m.update_account_metrics()

    # EUR + USD -> no global series.
    mock_influx.write_portfolio_totals.assert_not_called()
    # ...but per-account metrics are still written.
    mock_influx.write_account_metrics.assert_called_once()


def test_account_metrics_perf_fields_only_on_latest_point(
        mock_influx, shares_validator, mocker):
    events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA"),
        Event(date(2024, 1, 1), EventType.BUY, "AAPL", "Apple", quantity=10,
              unit_price=100.0, account="PEA"),
    ]
    shares = [{"name": "Apple", "symbol": "AAPL", "account": "PEA",
               "purchase": {"quantity": 10, "cost_price": 100.0, "fee": 0.0},
               "estate": {"quantity": 10, "received_dividend": 0.0}}]
    portfolio = Portfolio([Account("PEA", "PEA", "EUR", "Mon PEA")])
    mock_influx.get_price_series.return_value = {
        date(2024, 1, 1): 100.0, date(2024, 1, 2): 110.0}

    m = _metrics(mock_influx, shares_validator, shares, events, portfolio)

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 1, 2, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)

    m.update_account_metrics()

    pts = sorted(mock_influx.write_account_metrics.call_args.args[0],
                 key=lambda p: p.timestamp)
    # twr_index present on every point; gain_absolu only on the latest.
    assert all(p.twr_index is not None for p in pts)
    assert pts[0].gain_absolu is None
    assert pts[-1].gain_absolu == pytest.approx(100.0)   # 10*110 - 1000
    assert pts[-1].twr_index == pytest.approx(110.0)


# --------------------------------------------------------------------------- #
# Incremental perf-series write (issue #597): steady cycles must not rewrite
# the whole daily series (unbounded Parquet fragmentation on InfluxDB 3 Core).
# --------------------------------------------------------------------------- #
def _fixed_today(mocker, y, mo, d):
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(y, mo, d, 12, 0, tzinfo=tz)
    mocker.patch("main.datetime", _FixedDatetime)


def _acc_days(mock_influx):
    return {p.timestamp.date()
            for p in mock_influx.write_account_metrics.call_args.args[0]}


def test_update_account_metrics_second_cycle_writes_only_today(
        mock_influx, shares_validator, mocker):
    """First cycle writes the full series; a steady second cycle (no backfill,
    no event change) rewrites ONLY today's point — the fix for #597."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "EUR", "Mon PEA")])
    mock_influx.get_price_series.return_value = {}
    m = _metrics(mock_influx, shares_validator, shares=[], events=events, accounts=portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()
    assert _acc_days(mock_influx) == {date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 3)}

    m.update_account_metrics()
    assert _acc_days(mock_influx) == {date(2024, 1, 3)}


def test_backfill_dirty_mark_widens_the_incremental_window(
        mock_influx, shares_validator, mocker):
    """A backfill that fills an earlier day re-arms the watermark so the next
    cycle rewrites the whole tail from that day through today (TWR compounds
    forward, so the tail must be recomputed)."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "EUR", "Mon PEA")])
    mock_influx.get_price_series.return_value = {}
    m = _metrics(mock_influx, shares_validator, shares=[], events=events, accounts=portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()                 # full
    m.update_account_metrics()                 # today only
    assert _acc_days(mock_influx) == {date(2024, 1, 3)}

    m._mark_perf_dirty(date(2024, 1, 2))       # backfill filled 01-02
    m.update_account_metrics()
    assert _acc_days(mock_influx) == {date(2024, 1, 2), date(2024, 1, 3)}


def test_update_account_metrics_full_rewrite_on_event_reload(
        mock_influx, shares_validator, mocker):
    """When the events cache is reloaded (files changed), the next cycle rewrites
    the full series — a new/edited event can shift any past day (cash, holdings,
    contributions), not just today."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "EUR", "Mon PEA")])
    mock_influx.get_price_series.return_value = {}
    m = _metrics(mock_influx, shares_validator, shares=[], events=events, accounts=portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()                 # full
    m.update_account_metrics()                 # today only
    assert _acc_days(mock_influx) == {date(2024, 1, 3)}

    # Simulate an event-file reload: get_events() now returns a NEW list object.
    m.config_manager._events = [
        Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    m.update_account_metrics()
    assert _acc_days(mock_influx) == {date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 3)}


def test_write_failure_re_arms_the_dirty_watermark(
        mock_influx, shares_validator, mocker):
    """If the account_metrics write raises, the stale tail must not be lost: the
    watermark is re-armed so the next cycle retries the same slice (#597)."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "EUR", "Mon PEA")])
    mock_influx.get_price_series.return_value = {}
    m = _metrics(mock_influx, shares_validator, shares=[], events=events, accounts=portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()                 # first full write succeeds
    m._mark_perf_dirty(date(2024, 1, 2))       # backfill filled 01-02
    mock_influx.write_account_metrics.side_effect = RuntimeError("influx down")

    with pytest.raises(RuntimeError):
        m.update_account_metrics()

    # Tail [01-02 .. today] preserved for the next cycle, not silently dropped.
    assert m._perf_dirty_from == date(2024, 1, 2)


def test_portfolio_totals_second_cycle_writes_only_today(
        mock_influx, shares_validator, mocker):
    """The global portfolio_totals series is incremental too (same #597 fix)."""
    events = [Event(date(2024, 1, 1), EventType.DEPOSIT, amount=1000.0, account="PEA")]
    portfolio = Portfolio([Account("PEA", "PEA", "EUR", "Mon PEA")])
    mock_influx.get_price_series.return_value = {}
    m = _metrics(mock_influx, shares_validator, shares=[], events=events, accounts=portfolio)
    _fixed_today(mocker, 2024, 1, 3)

    m.update_account_metrics()
    m.update_account_metrics()
    totals = mock_influx.write_portfolio_totals.call_args.args[0]
    assert {p.timestamp.date() for p in totals} == {date(2024, 1, 3)}


def test_prometheus_update_portfolio_sets_unlabeled_gauges():
    from prometheus_client import CollectorRegistry
    from prometheus_exporter import PrometheusExporter

    exp = PrometheusExporter(registry=CollectorRegistry())
    exp.update_portfolio(PortfolioTotalPoint(
        timestamp=datetime(2024, 1, 2, tzinfo=timezone.utc),
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
        account="PEA", account_type="PEA", account_currency="EUR",
        timestamp=datetime(2024, 1, 15, tzinfo=timezone.utc),
        cash_balance=100.0, holdings_value=900.0,
        total_value=1000.0, net_contributed=800.0,
    ))

    reg = exp.registry
    assert reg.get_sample_value("sb_account_cash_balance", {"account": "PEA"}) == 100.0
    assert reg.get_sample_value("sb_account_holdings_value", {"account": "PEA"}) == 900.0
    assert reg.get_sample_value("sb_account_total_value", {"account": "PEA"}) == 1000.0
    assert reg.get_sample_value("sb_account_net_contributed", {"account": "PEA"}) == 800.0
    assert reg.get_sample_value("sb_account_info", {
        "account": "PEA", "account_type": "PEA", "account_currency": "EUR"}) == 1.0
