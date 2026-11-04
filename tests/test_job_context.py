"""The jobs' shared context and the market client they are handed (#1253).

The market is the one edge a job test fakes, and since #1253 it is faked by
handing the jobs a client rather than by patching a method of the facade: what
a job does with the market's answer (the info cache, the splits) runs for real.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace

from application import backfill
from application import market
from application import settings_registry
from application.jobs import context
from application.workloads import Workloads


class _Config:
    """The two things the context reads: the snapshot and the writers' mutex."""

    store = None

    def current(self):
        return SimpleNamespace(shares=[{'symbol': 'AAPL', 'quantity': 1}])

    @contextmanager
    def writing(self):
        yield None


class _Market:
    """A client that says what it was asked, and answers canned data."""

    def __init__(self):
        self.asked = []

    def latest_quote(self, symbol, max_retries=3):
        self.asked.append(('quote', symbol))
        return 185.0, {'currency': 'USD'}

    def price_history(self, symbol, start, end, delay=0.0, max_retries=3):
        self.asked.append(('history', symbol, delay))
        return [{'price': 1.0}], {'2024-06-10': 10.0}

    def symbol_attributes(self, symbol):
        self.asked.append(('attributes', symbol))
        return {'quoteType': 'EQUITY'}


def test_the_context_holds_the_dials_at_their_defaults():
    ctx = context.JobContext(_Config())

    defaults = settings_registry.defaults()
    for spec in settings_registry.SETTINGS:
        if spec.attribute is not None:
            assert getattr(ctx, spec.attribute) == defaults[spec.key]
    assert ctx.shares == [{'symbol': 'AAPL', 'quantity': 1}]
    assert isinstance(ctx.market, context.YahooMarket)


def test_the_facade_keeps_its_dials_and_scheduler_on_the_context():
    running = Workloads(_Config())

    running.apply_dials({'regular_interval': 45})
    running.scheduler = 'a scheduler'

    assert running.ctx.regular_interval == 45
    assert running.ctx.scheduler == 'a scheduler'


def test_a_quote_comes_from_the_client_and_fills_the_info_cache():
    client = _Market()
    running = Workloads(_Config(), market_client=client)

    assert running._scrape.fetch_ticker_data('AAPL') == (185.0, {'currency': 'USD'})

    assert client.asked == [('quote', 'AAPL')]
    assert running.ctx.info_cache['AAPL'] == {'currency': 'USD'}


def test_a_history_comes_from_the_client_and_its_splits_are_kept(monkeypatch):
    client = _Market()
    running = Workloads(_Config(), market_client=client)
    running.apply_dials({'backfill_delay': 0.5})
    kept = []
    monkeypatch.setattr(backfill.quotes, 'record_splits',
                        lambda opened, symbol, splits: kept.append((symbol, splits)))
    start = datetime(2024, 1, 1, tzinfo=timezone.utc)

    prices = running._backfill.fetch_historical_data('AAPL', start, start)

    assert prices == [{'price': 1.0}]
    assert client.asked == [('history', 'AAPL', 0.5)]
    assert kept == [('AAPL', {'2024-06-10': 10.0})]


def test_the_yahoo_client_reads_the_market_module_at_call_time(monkeypatch):
    monkeypatch.setattr(market, 'latest_quote', lambda symbol, retries: (1.0, {}))

    assert context.YahooMarket().latest_quote('AAPL') == (1.0, {})
