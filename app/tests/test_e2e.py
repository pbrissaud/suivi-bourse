"""
True end-to-end wiring tests for SuiviBourse.

These exercise the *whole* application with **one** external boundary faked:

  * yfinance  -> monkeypatched ``main.yf.Ticker`` returning canned frames/info
  * time.sleep-> no-op (so rate-limit pauses never actually sleep)

A real ``ConfigurationManager`` reads a real CSV written into ``tmp_path``, a
real store holds what comes of it, and a real ``SuiviBourseMetrics`` drives the
full pipeline loader -> validator -> aggregator -> scrape / backfill.

This is the seam v5 descends from (spec #695), and #700 completes it: the mock
of the writer is gone with the writer, so the assertions moved from *what the
job meant to write* to *what the store contains*. That is the whole difference
between the two, and it is not a matter of taste — a transaction and an upsert
are exactly the kind of thing a mock reports as having happened and only a
database reports as correct.

No network is ever touched.
"""

from pathlib import Path

import pytest

import ledger
import main
import portfolio_view
import quotes
import store_reads
from main import ConfigurationManager, SuiviBourseMetrics

from datetime import datetime, timezone


# --------------------------------------------------------------------------- #
# Canonical events CSV used by the events-mode tests.
#
# Columns match docker-compose/events/example.csv. Hand-computed end state
# (verified against the real EventAggregator), in the v5 shape — one quantity
# and a cost basis that has absorbed the acquisition fees (#699):
#
#   AAPL: quantity=18, cost_basis=2 469.00, realized_gain=+156.50,
#         received_dividend=2.40
#   MSFT: quantity=5,  cost_basis=1 902.50, realized_gain=0,
#         received_dividend=5.00
#
# Intermediate AAPL state on 2024-06-20 (before the 2024-09-15 SELL):
#   quantity=21, cost_basis=2 880.50, received_dividend=2.40
# --------------------------------------------------------------------------- #
# 5×100 + 1 · 10×150 + 2,50 · a free share · 5×175 + 2 = 21 shares, 2 880,50 €.
AAPL_BASIS_BEFORE_SALE = 2880.50
AAPL_QUANTITY_BEFORE_SALE = 21
AAPL_UNIT_COST = AAPL_BASIS_BEFORE_SALE / AAPL_QUANTITY_BEFORE_SALE
AAPL_BASIS = AAPL_BASIS_BEFORE_SALE - 3 * AAPL_UNIT_COST
MSFT_BASIS = 5 * 380.0 + 2.50
EVENTS_CSV = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2023-06-01,BUY,AAPL,Apple Inc,5,100.00,1.00,,Very early purchase\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
    "2024-02-01,BUY,MSFT,Microsoft,5,380.00,2.50,,Initial purchase\n"
    "2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,2.40,Q1 2024 dividend\n"
    "2024-06-01,GRANT,AAPL,Apple Inc,1,,,,Bonus share\n"
    "2024-06-15,BUY,AAPL,Apple Inc,5,175.00,2.00,,Additional purchase\n"
    "2024-09-15,SELL,AAPL,Apple Inc,3,190.00,2.00,,Partial sale\n"
    "2025-01-30,DIVIDEND,MSFT,Microsoft,,,,5.00,New dividend\n"
)

# Per-symbol last-close prices returned by the fake ticker in scrape tests.
TICKER_CLOSE = {"AAPL": 190.0, "MSFT": 400.0}


# --------------------------------------------------------------------------- #
# Local helpers (kept in this module so parallel agents' conftest is untouched)
# --------------------------------------------------------------------------- #
def _make_fake_ticker(fake_ticker, close):
    """Build a yfinance.Ticker stand-in with a given last-close price."""
    return fake_ticker(close=close)


def _patch_ticker(monkeypatch, fake_ticker):
    """Route ``main.yf.Ticker(symbol)`` to a per-symbol fake ticker."""
    def factory(symbol):
        return _make_fake_ticker(fake_ticker, TICKER_CLOSE.get(symbol, 100.0))
    monkeypatch.setattr(main.yf, "Ticker", factory)


def _no_sleep(monkeypatch):
    """Make every ``time.sleep`` in main a no-op (deterministic + fast)."""
    monkeypatch.setattr(main.time, "sleep", lambda *a, **k: None)


def _config_with_declared_source(tmp_path):
    """Real ConfigurationManager reading a source settings.yaml names."""
    config_dir = tmp_path / "config"
    events_dir = config_dir / "events"
    events_dir.mkdir(parents=True)
    (events_dir / "2024.csv").write_text(EVENTS_CSV, encoding="utf-8")
    (config_dir / "settings.yaml").write_text(
        "events:\n"
        f"  source: {events_dir}\n",
        encoding="utf-8",
    )
    return ConfigurationManager(config_dir=str(config_dir))


def _config_with_default_source(tmp_path, csv_text=EVENTS_CSV):
    """Real ConfigurationManager on the default ``<config_dir>/events`` source.

    No settings.yaml at all — the setup every install that never declared one
    runs, and since #711 the only one there is.
    """
    config_dir = tmp_path / "config"
    events_dir = config_dir / "events"
    events_dir.mkdir(parents=True)
    (events_dir / "2024.csv").write_text(csv_text, encoding="utf-8")
    return ConfigurationManager(config_dir=str(config_dir))


# --------------------------------------------------------------------------- #
# 1. The full chain: loader -> validator -> aggregator -> scrape
# --------------------------------------------------------------------------- #
def test_the_full_chain_writes_the_position_and_the_quote(
    tmp_path, monkeypatch, fake_ticker
):
    """The whole pipeline: the ledger replays into ``position``, the scrape into
    ``symbol_quote`` and ``price_point``, and the two only meet at read time."""
    _no_sleep(monkeypatch)
    _patch_ticker(monkeypatch, fake_ticker)

    config_manager = _config_with_declared_source(tmp_path)

    assert config_manager.get_events_source().endswith("/events")

    sb = SuiviBourseMetrics(config_manager)
    # The one question the app asks (#702, ADR-0021). The fake quotes in USD and
    # this install reports in USD, so the conversion is the identity: the chain
    # is asserted end to end without a second faked fetch, and the point still
    # carries the three columns rather than two.
    sb.base_currency = "USD"

    # The shares came through the real loader -> validator -> aggregator chain.
    shares_by_symbol = {s["symbol"]: s for s in sb.shares}
    assert set(shares_by_symbol) == {"AAPL", "MSFT"}

    aapl = shares_by_symbol["AAPL"]
    assert aapl["quantity"] == pytest.approx(18.0)
    assert aapl["cost_basis"] == pytest.approx(AAPL_BASIS)
    assert aapl["realized_gain"] == pytest.approx(3 * 190.0 - 2.0 - 3 * AAPL_UNIT_COST)
    assert aapl["received_dividend"] == pytest.approx(2.4)

    # Drive the real scrape (fetch prices -> write the quote and the point).
    sb.scrape()

    opened = config_manager._require_store()
    prices = dict(opened.query(
        "SELECT symbol, price_native FROM price_point ORDER BY symbol"))
    assert prices == {"AAPL": pytest.approx(190.0), "MSFT": pytest.approx(400.0)}

    aapl_quote = quotes.read_quote(opened, "AAPL")
    assert aapl_quote["currency"] == "USD"
    assert aapl_quote["exchange"] == "NMS"
    assert aapl_quote["quote_type"] == "EQUITY"
    assert aapl_quote["dividend_yield"] == pytest.approx(0.52)  # 0.0052 * 100
    assert aapl_quote["last_price_native"] == pytest.approx(190.0)
    # The three price columns move together (#702): the `latest` row never
    # carries a native price beside a converted one from an earlier point.
    assert aapl_quote["last_price_converted"] == pytest.approx(190.0)
    assert aapl_quote["last_fx_rate"] == pytest.approx(1.0)

    # And the position is what the replay wrote, on its own table. The name is
    # here and not on the quote: it comes from the owner's file, not from Yahoo
    # (#700), which is why renaming a share cannot cut its history in two.
    rows = {row[0]: row for row in opened.query(
        "SELECT symbol, name, quantity, cost_basis, realized_gain, "
        "       received_dividend FROM position ORDER BY symbol")}
    assert rows["AAPL"][1] == "Apple Inc"
    assert rows["AAPL"][2] == pytest.approx(18.0)
    assert rows["AAPL"][3] == pytest.approx(AAPL_BASIS)
    assert rows["AAPL"][5] == pytest.approx(2.4)
    assert rows["MSFT"][1] == "Microsoft"
    assert rows["MSFT"][3] == pytest.approx(MSFT_BASIS)
    assert rows["MSFT"][5] == pytest.approx(5.0)

    # The two halves meet only here, and the join is the shares page (#700).
    shares = portfolio_view.build_shares(
        store_reads.PortfolioReader(opened).positions())
    aapl_row = {s.symbol: s for s in shares}["AAPL"]
    assert aapl_row.price == pytest.approx(190.0)
    assert aapl_row.market_value == pytest.approx(18.0 * 190.0)
    assert aapl_row.plus_value_latente == pytest.approx(18.0 * 190.0 - AAPL_BASIS)


# --------------------------------------------------------------------------- #
# 2. Backfill writes historically-correct portfolio state for an intermediate date
# --------------------------------------------------------------------------- #
def test_backfill_writes_the_price_and_only_the_price(
    tmp_path, monkeypatch, fake_ticker
):
    """A recovered point carries a symbol, an instant and a close — nothing else.

    This test is the shape of #700 stated on the row it changed. It used to
    assert that each historical point had been *enriched* with the position held
    that day, because every price point carried position fields; a market
    observation says nothing about who held what, so the enrichment has no
    subject left and the point is three columns.

    What the position was on that day is still knowable — it is a replay of the
    ledger, asserted below — it simply is not written next to the price.
    """
    _no_sleep(monkeypatch)
    _patch_ticker(monkeypatch, fake_ticker)

    config_manager = _config_with_default_source(tmp_path)
    sb = SuiviBourseMetrics(config_manager)

    intermediate = datetime(2024, 6, 20, 15, 0, tzinfo=timezone.utc)

    # Canned historical fetch: one price point for AAPL on the intermediate
    # date, nothing for MSFT. Assigned as an instance attribute so it shadows
    # the bound method and is called as (symbol, start, end) with no self.
    def canned_fetch(symbol, start, end):
        if symbol == "AAPL":
            return [{"timestamp": intermediate, "price": 180.0}]
        return []

    sb._fetch_historical_data = canned_fetch

    sb.backfill()

    opened = config_manager._require_store()
    assert opened.query(
        "SELECT symbol, ts, price_native FROM price_point ORDER BY symbol") == [
        ("AAPL", intermediate, pytest.approx(180.0))]
    # No account column to carry, and no position fields either: the table has
    # five columns and two of them are #702's business.
    assert opened.query(
        "SELECT price_converted, fx_rate FROM price_point") == [(None, None)]

    # The state on that day comes from the replay, and it is the SELL of
    # 2024-09-15 not having happened yet: 21 shares, not 18.
    from events.aggregator import EventAggregator
    from datetime import date as _date
    held = EventAggregator().replay(
        config_manager.get_events()
    ).position_at("default", "AAPL", _date(2024, 6, 20))
    assert held["quantity"] == pytest.approx(AAPL_QUANTITY_BEFORE_SALE)
    assert held["cost_basis"] == pytest.approx(AAPL_BASIS_BEFORE_SALE)


# --------------------------------------------------------------------------- #
# 3. Negative path: an over-selling CSV surfaces as AggregationError
# --------------------------------------------------------------------------- #
def test_oversell_csv_is_refused_at_import_and_nothing_lands(tmp_path):
    """A SELL exceeding holdings is caught, and the whole file is refused.

    The SELL is otherwise valid (positive quantity/unit_price) so it clears the
    EventValidator and fails only at aggregation time -- proving the check that
    stops it is the replay, not the row validator.

    Since #697 the failure lands at the **import**: the import replays the
    ledger it would make before it commits, so an oversell rolls the whole file
    back. What the user gets is not an exception through ``load_shares`` but an
    unchanged store — including the BUY on the line above the bad one, which is
    the point of refusing a file whole.
    """
    bad_csv = (
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2024-01-15,BUY,AAPL,Apple Inc,5,150.00,2.50,,Buy five\n"
        "2024-02-15,SELL,AAPL,Apple Inc,10,190.00,2.00,,Oversell ten\n"
    )
    config_manager = _config_with_default_source(tmp_path, csv_text=bad_csv)

    assert config_manager.load_shares() == []

    opened = config_manager._require_store()
    assert ledger.read_events(opened) == []
    assert ledger.list_imports(opened) == []

    (outcome,) = ledger.sync_drop_folder(
        opened, Path(config_manager.get_events_source()))
    assert outcome.outcome == ledger.REFUSED
    assert "Cannot sell" in outcome.error or "sell" in outcome.error.lower()
