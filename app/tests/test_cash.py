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


def test_write_account_metrics_tags_and_fields(mocker):
    from influxdb_writer import InfluxDBWriter
    writer = InfluxDBWriter(host="http://x", token="t", database="db")
    fake_client = mocker.MagicMock()
    writer._client = fake_client

    ts = datetime(2024, 1, 15, tzinfo=timezone.utc)
    n = writer.write_account_metrics([{
        "account": "PEA", "account_type": "PEA", "account_currency": "EUR",
        "timestamp": ts, "cash_balance": 100.0, "holdings_value": 900.0,
        "total_value": 1000.0, "net_contributed": 800.0,
    }])

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
    by_day = {p["timestamp"].date(): p for p in points}
    assert set(by_day) == {date(2024, 1, 1), date(2024, 1, 2)}
    # Every point is stamped at midnight, never in the future.
    for p in points:
        ts = p["timestamp"]
        assert (ts.hour, ts.minute, ts.second) == (0, 0, 0)
    d1 = by_day[date(2024, 1, 1)]
    assert d1["cash_balance"] == pytest.approx(1000.0)
    assert d1["holdings_value"] == pytest.approx(0.0)
    d2 = by_day[date(2024, 1, 2)]
    assert d2["cash_balance"] == pytest.approx(800.0)   # 1000 - 2*100
    assert d2["holdings_value"] == pytest.approx(220.0)  # 2 * 110
    assert d2["total_value"] == pytest.approx(1020.0)
    assert d2["net_contributed"] == pytest.approx(1000.0)


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


def test_prometheus_update_account_sets_gauges():
    from prometheus_client import CollectorRegistry
    from prometheus_exporter import PrometheusExporter

    exp = PrometheusExporter(registry=CollectorRegistry())
    exp.update_account({
        "account": "PEA", "account_type": "PEA", "account_currency": "EUR",
        "cash_balance": 100.0, "holdings_value": 900.0,
        "total_value": 1000.0, "net_contributed": 800.0,
    })

    reg = exp.registry
    assert reg.get_sample_value("sb_account_cash_balance", {"account": "PEA"}) == 100.0
    assert reg.get_sample_value("sb_account_holdings_value", {"account": "PEA"}) == 900.0
    assert reg.get_sample_value("sb_account_total_value", {"account": "PEA"}) == 1000.0
    assert reg.get_sample_value("sb_account_net_contributed", {"account": "PEA"}) == 800.0
    assert reg.get_sample_value("sb_account_info", {
        "account": "PEA", "account_type": "PEA", "account_currency": "EUR"}) == 1.0
