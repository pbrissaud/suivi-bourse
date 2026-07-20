"""
Unit tests for the first-class accounts feature (issue #574).

Covers, end to end at the unit level:
  * loader — the ``account`` column is read from CSV and XLSX
  * validator — account required/valid only when accounts are declared
  * aggregator — positions keyed by ``(account, symbol)``; ``default`` fallback
  * ConfigurationManager — the ``accounts:`` settings block, ``load_accounts()``,
    validation errors, and the full events pipeline with accounts
  * schemas — Account / Portfolio helpers

No network, no real InfluxDB. Every ConfigurationManager is built with
``config_dir=str(tmp_path)`` so nothing touches the real ~/.config/SuiviBourse.
"""

from datetime import date

import pytest

from events import EventAggregator, EventLoader, EventValidator, Portfolio, Account
from events.schemas import Event, EventType, ShareState, DEFAULT_ACCOUNT
from events.validator import EventValidationError
from main import ConfigurationManager


# --------------------------------------------------------------------------- #
# Isolation: SB_CONFIG_MODE must never leak in from the real environment.
# --------------------------------------------------------------------------- #
@pytest.fixture(autouse=True)
def _no_config_mode_env(monkeypatch):
    monkeypatch.delenv("SB_CONFIG_MODE", raising=False)


_CSV_WITH_ACCOUNTS = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes,account\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,,PEA\n"
    "2024-01-16,BUY,AAPL,Apple Inc,5,160.00,1.00,,,CTO\n"
)

_SETTINGS_TWO_ACCOUNTS = (
    "mode: events\n"
    "accounts:\n"
    "  - id: PEA\n"
    "    type: PEA\n"
    "    currency: EUR\n"
    "    label: Mon PEA\n"
    "  - id: CTO\n"
    "    type: CTO\n"
    "    currency: EUR\n"
)


def _write(path, text):
    path.write_text(text, encoding="utf-8")


def _events_dir_with_accounts(tmp_path):
    d = tmp_path / "events"
    d.mkdir()
    _write(d / "2024.csv", _CSV_WITH_ACCOUNTS)
    return d


# --------------------------------------------------------------------------- #
# schemas: Account / Portfolio
# --------------------------------------------------------------------------- #
def test_portfolio_ids_and_get():
    pf = Portfolio(accounts=[
        Account(id="PEA", type="PEA", currency="EUR", label="Mon PEA"),
        Account(id="CTO", type="CTO", currency="EUR", label="CTO"),
    ])
    assert pf.ids() == {"PEA", "CTO"}
    assert pf.get("PEA").label == "Mon PEA"
    assert pf.get("UNKNOWN") is None


# --------------------------------------------------------------------------- #
# loader: account column
# --------------------------------------------------------------------------- #
def test_loader_reads_account_column_from_csv(tmp_path):
    csv_path = tmp_path / "events.csv"
    _write(csv_path, _CSV_WITH_ACCOUNTS)

    events = EventLoader(str(csv_path)).load()
    accounts = {e.symbol: e.account for e in events}
    # (sorted by date; both AAPL rows preserved with their own account)
    assert [e.account for e in events] == ["PEA", "CTO"]
    assert accounts == {"AAPL": "CTO"}  # last write wins in the dict comprehension


def test_loader_account_none_when_column_absent(tmp_path):
    csv_path = tmp_path / "events.csv"
    _write(csv_path,
           "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
           "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,\n")
    events = EventLoader(str(csv_path)).load()
    assert events[0].account is None


def test_loader_reads_account_column_from_xlsx(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    xlsx_path = tmp_path / "events.xlsx"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["date", "event_type", "symbol", "name", "quantity",
               "unit_price", "fee", "amount", "notes", "account"])
    ws.append(["2024-01-15", "BUY", "AAPL", "Apple Inc", 10, 150.0, 2.5, None, None, "PEA"])
    ws.append(["2024-01-16", "BUY", "AAPL", "Apple Inc", 5, 160.0, 1.0, None, None, "CTO"])
    wb.save(xlsx_path)

    events = EventLoader(str(xlsx_path)).load()
    assert sorted(e.account for e in events) == ["CTO", "PEA"]


# --------------------------------------------------------------------------- #
# validator: account validation gated on declared accounts
# --------------------------------------------------------------------------- #
def _buy(account=None):
    return Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
                 quantity=10, unit_price=150.0, fee=2.5, account=account)


def test_validator_ignores_account_when_none_declared():
    """Without declared accounts, a missing account is fine."""
    ok, errors = EventValidator().validate([_buy(account=None)])
    assert ok
    assert errors == []


def test_validator_requires_account_when_declared():
    validator = EventValidator(account_ids={"PEA", "CTO"})
    ok, errors = validator.validate([_buy(account=None)])
    assert not ok
    assert any("account is required" in e for e in errors)


def test_validator_rejects_unknown_account_id():
    validator = EventValidator(account_ids={"PEA", "CTO"})
    ok, errors = validator.validate([_buy(account="LIVRETA")])
    assert not ok
    assert any("not a declared account id" in e for e in errors)


def test_validator_accepts_declared_account_id():
    validator = EventValidator(account_ids={"PEA", "CTO"})
    ok, errors = validator.validate([_buy(account="PEA")])
    assert ok
    assert errors == []


# --------------------------------------------------------------------------- #
# aggregator: (account, symbol) keying
# --------------------------------------------------------------------------- #
def test_aggregate_defaults_to_default_account_when_not_declared():
    events = [
        _buy(account="PEA"),  # account values present but ignored
        Event(date(2024, 1, 16), EventType.BUY, "AAPL", "Apple Inc",
              quantity=5, unit_price=160.0, fee=1.0, account="CTO"),
    ]
    shares = EventAggregator().aggregate(events, accounts_declared=False)
    # Both rows collapse under a single 'default' AAPL position (10 + 5).
    assert len(shares) == 1
    assert shares[0]["account"] == DEFAULT_ACCOUNT
    assert shares[0]["estate"]["quantity"] == 15


def test_aggregate_keys_by_account_symbol_when_declared():
    events = [
        _buy(account="PEA"),
        Event(date(2024, 1, 16), EventType.BUY, "AAPL", "Apple Inc",
              quantity=5, unit_price=160.0, fee=1.0, account="CTO"),
    ]
    shares = EventAggregator().aggregate(events, accounts_declared=True)
    by_account = {s["account"]: s for s in shares}
    assert set(by_account) == {"PEA", "CTO"}
    assert by_account["PEA"]["estate"]["quantity"] == 10
    assert by_account["CTO"]["estate"]["quantity"] == 5
    # Each account keeps its own weighted cost price.
    assert by_account["PEA"]["purchase"]["cost_price"] == 150.0
    assert by_account["CTO"]["purchase"]["cost_price"] == 160.0


# --------------------------------------------------------------------------- #
# ConfigurationManager: settings accounts block + load_accounts()
# --------------------------------------------------------------------------- #
def test_load_accounts_none_when_no_block(tmp_path):
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.load_accounts() is None


def test_load_accounts_parses_block(tmp_path):
    _write(tmp_path / "settings.yaml", _SETTINGS_TWO_ACCOUNTS)
    cm = ConfigurationManager(config_dir=str(tmp_path))
    pf = cm.load_accounts()
    assert pf is not None
    assert pf.ids() == {"PEA", "CTO"}
    # label defaults to id when omitted.
    assert pf.get("CTO").label == "CTO"
    assert pf.get("PEA").label == "Mon PEA"


def test_load_accounts_available_even_with_env_mode(tmp_path, monkeypatch):
    """Accounts are read from settings.yaml even when mode comes from env."""
    _write(tmp_path / "settings.yaml", _SETTINGS_TWO_ACCOUNTS)
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.load_accounts().ids() == {"PEA", "CTO"}


def test_invalid_accounts_block_raises(tmp_path):
    # Missing the required 'currency' field.
    _write(tmp_path / "settings.yaml",
           "accounts:\n  - id: PEA\n    type: PEA\n")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    with pytest.raises(ValueError, match="Invalid 'accounts' block"):
        cm.load_accounts()


def test_duplicate_account_ids_raise(tmp_path):
    _write(tmp_path / "settings.yaml",
           "accounts:\n"
           "  - id: PEA\n    type: PEA\n    currency: EUR\n"
           "  - id: PEA\n    type: CTO\n    currency: EUR\n")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    with pytest.raises(ValueError, match="Duplicate account id"):
        cm.load_accounts()


# --------------------------------------------------------------------------- #
# ConfigurationManager: full events pipeline with accounts
# --------------------------------------------------------------------------- #
def test_events_pipeline_aggregates_per_account(tmp_path):
    _write(tmp_path / "settings.yaml", _SETTINGS_TWO_ACCOUNTS)
    _events_dir_with_accounts(tmp_path)

    cm = ConfigurationManager(config_dir=str(tmp_path))
    shares = cm.load_shares()

    by_account = {s["account"]: s for s in shares}
    assert set(by_account) == {"PEA", "CTO"}
    assert by_account["PEA"]["estate"]["quantity"] == 10
    assert by_account["CTO"]["estate"]["quantity"] == 5


def test_events_pipeline_without_accounts_uses_default(tmp_path):
    """Events mode without an accounts block: everything under 'default'."""
    _write(tmp_path / "settings.yaml", "mode: events\n")
    _events_dir_with_accounts(tmp_path)

    cm = ConfigurationManager(config_dir=str(tmp_path))
    shares = cm.load_shares()

    assert len(shares) == 1
    assert shares[0]["account"] == DEFAULT_ACCOUNT
    assert shares[0]["estate"]["quantity"] == 15  # 10 (PEA) + 5 (CTO) merged


def test_events_pipeline_missing_account_raises_when_declared(tmp_path):
    _write(tmp_path / "settings.yaml", _SETTINGS_TWO_ACCOUNTS)
    d = tmp_path / "events"
    d.mkdir()
    # Second row omits the account while accounts are declared.
    _write(d / "2024.csv",
           "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes,account\n"
           "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,,PEA\n"
           "2024-01-16,BUY,AAPL,Apple Inc,5,160.00,1.00,,,\n")

    cm = ConfigurationManager(config_dir=str(tmp_path))
    with pytest.raises(EventValidationError, match="account is required"):
        cm.load_shares()


def test_events_pipeline_unknown_account_raises_when_declared(tmp_path):
    _write(tmp_path / "settings.yaml", _SETTINGS_TWO_ACCOUNTS)
    d = tmp_path / "events"
    d.mkdir()
    _write(d / "2024.csv",
           "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes,account\n"
           "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,,LIVRETA\n")

    cm = ConfigurationManager(config_dir=str(tmp_path))
    with pytest.raises(EventValidationError, match="not a declared account id"):
        cm.load_shares()


# --------------------------------------------------------------------------- #
# aggregate_until_date: account-aware point-in-time replay (backfill)
# --------------------------------------------------------------------------- #
def _two_account_events():
    return [
        Event(date(2024, 1, 15), EventType.BUY, "AAPL", "Apple Inc",
              quantity=10, unit_price=150.0, fee=2.5, account="PEA"),
        Event(date(2024, 1, 16), EventType.BUY, "AAPL", "Apple Inc",
              quantity=5, unit_price=160.0, fee=1.0, account="CTO"),
    ]


def test_aggregate_until_date_scoped_to_account():
    events = _two_account_events()
    agg = EventAggregator()

    pea = agg.aggregate_until_date(events, date(2024, 2, 1), "AAPL",
                                   account="PEA", accounts_declared=True)
    cto = agg.aggregate_until_date(events, date(2024, 2, 1), "AAPL",
                                   account="CTO", accounts_declared=True)

    assert pea["estate"]["quantity"] == 10
    assert pea["account"] == "PEA"
    assert cto["estate"]["quantity"] == 5
    assert cto["account"] == "CTO"


def test_aggregate_until_date_none_before_account_first_event():
    events = _two_account_events()
    # CTO's first event is 2024-01-16; before that it has no state.
    result = EventAggregator().aggregate_until_date(
        events, date(2024, 1, 15), "AAPL", account="CTO", accounts_declared=True)
    assert result is None


def test_aggregate_until_date_merges_all_accounts_when_none():
    """Legacy symbol-scoped call (account=None) merges every account."""
    events = _two_account_events()
    merged = EventAggregator().aggregate_until_date(
        events, date(2024, 2, 1), "AAPL")
    assert merged["estate"]["quantity"] == 15


# --------------------------------------------------------------------------- #
# get_oldest_timestamp: account-scoped SQL (COALESCE, never WHERE account=)
# --------------------------------------------------------------------------- #
def test_get_oldest_timestamp_scopes_query_by_account(mocker):
    from influxdb_writer import InfluxDBWriter

    writer = InfluxDBWriter(host="http://x", token="t", database="db")
    fake_client = mocker.MagicMock()
    fake_client.query.return_value = None
    writer._client = fake_client

    writer.get_oldest_timestamp("AAPL", account="PEA")

    sql = fake_client.query.call_args.kwargs["query"]
    assert "COALESCE(account, 'default') = 'PEA'" in sql
    # Never a bare account filter that would drop pre-tag (NULL) points.
    assert "WHERE account =" not in sql


def test_get_oldest_timestamp_no_account_filter_when_omitted(mocker):
    from influxdb_writer import InfluxDBWriter

    writer = InfluxDBWriter(host="http://x", token="t", database="db")
    fake_client = mocker.MagicMock()
    fake_client.query.return_value = None
    writer._client = fake_client

    writer.get_oldest_timestamp("AAPL")

    sql = fake_client.query.call_args.kwargs["query"]
    assert "account" not in sql


# --------------------------------------------------------------------------- #
# schema.yaml accepts the account key on a share dict
# --------------------------------------------------------------------------- #
def test_share_schema_accepts_account_key(shares_validator):
    share = ShareState(name="Apple", symbol="AAPL", account="PEA").to_dict()
    assert shares_validator.validate({"shares": [share]}), shares_validator.errors
