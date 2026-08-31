"""The price source the performance recompute is fed through (issue #844).

One table, read **once** for every symbol at once. The recompute used to call
:func:`quotes.price_series` in a comprehension over the ledger's symbols, and
each of those is a ``WHERE symbol = ?`` on ``price_point`` — a table with
neither index nor key (ADR-0007), not clustered by symbol, so every call reads
it whole. Forty lines meant forty full scans, every 120 s and again after every
``/api`` write, each of them holding the single connection's ``RLock``.

Nothing about the figures moves, and that is the other half of this module: the
aggregated read already applied the same filter, read the same column and kept
the same survivor of the day. So the tests come in pairs — one on **what is
asked of the store**, one on **what is written to it** — and the second is an
equivalence against the per-symbol implementation, expressed through
:func:`quotes.price_series` itself, which this ticket leaves untouched precisely
so it can stand as the reference.

The seam is the suite's usual one: a real DuckDB store in ``tmp_path``, a real
:class:`workloads.Workloads`, and every assertion on the rows the pass
wrote. The one double is the *old implementation*, injected at the reader so the
two can be run over the same store — it stands for what the app used to do, not
for what it was asked to do.

Prior art: ``tests/test_workloads.py``, ``tests/test_fx.py``, ``tests/test_replay_perf.py``.
"""
from contextlib import contextmanager
from datetime import date, datetime, timezone

import pytest

from application import quotes
from application import store_reads
from application import workloads
from application.events.schemas import Event, EventType

UTC = timezone.utc

#: The day every recompute below is pinned to. The series runs to *today*, so a
#: floating one would change the shape of the assertions tomorrow.
_TODAY = date(2024, 6, 20)


class _ConfigManager:
    """The surface :meth:`workloads.Workloads._rebuild_series` needs.

    It reads the **store** and the clock and nothing else since #707, so the
    manager is down to two gestures here: handing the open store out, and the
    writers' mutex the final upsert takes.
    """

    def __init__(self, opened):
        self._store = opened

    @property
    def store(self):
        return self._store

    @contextmanager
    def writing(self):
        yield self._store


class _Recorder:
    """Every statement the store is handed during a pass, in order.

    The one thing no row can testify to: *the queries that were not run*. The
    cost this ticket removes leaves no trace in ``account_metrics`` — the figures
    are identical either way — so the count of statements against ``price_point``
    is the only place the change is observable, which is the exception
    ``CLAUDE.md`` names for an internal double.

    The four entry points are shadowed on the **instance**, so the class methods
    come back by deleting the attributes rather than by remembering them.
    """

    _METHODS = ('query', 'arrow', 'execute', 'executemany')

    def __init__(self, opened):
        self._store = opened
        self.statements = []

    def __enter__(self):
        for name in self._METHODS:
            setattr(self._store, name, self._recording(getattr(self._store, name)))
        return self

    def __exit__(self, *exc_info):
        for name in self._METHODS:
            self._store.__dict__.pop(name, None)
        return False

    def _recording(self, real):
        def recorded(sql, *args, **kwargs):
            self.statements.append(' '.join(sql.split()))
            return real(sql, *args, **kwargs)
        return recorded

    def touching(self, table):
        return [sql for sql in self.statements if table in sql]


def _fixed_today(mocker):
    """The perf pass's clock, pinned — UTC-qualified, like every read of it."""
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(_TODAY.year, _TODAY.month, _TODAY.day, 12, 0, tzinfo=tz)
    mocker.patch("application.perf_job.datetime", _FixedDatetime)


def _metrics(opened, mocker):
    """A real metrics object over a real store, its reporting currency answered."""
    _fixed_today(mocker)
    metrics = workloads.Workloads(_ConfigManager(opened))
    metrics.base_currency = 'EUR'
    return metrics


def _quote(opened, symbol, currency='EUR'):
    """The ``symbol_quote`` row ``first_quoted_days`` joins on."""
    opened.execute(
        'INSERT INTO symbol_quote (symbol, currency) VALUES (?, ?) '
        'ON CONFLICT (symbol) DO UPDATE SET currency = excluded.currency',
        [symbol, currency])


def _price(opened, symbol, day, native, converted=None):
    """One observation, written where the market writer would write it."""
    opened.execute(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted,'
        '                         fx_rate) VALUES (?, ?, ?, ?, ?)',
        [symbol, datetime(day.year, day.month, day.day, 17, 0, tzinfo=UTC),
         native, converted, 1.0 if converted is not None else None])


def _ledger(symbols):
    """A deposit and one purchase per symbol — the smallest priced portfolio."""
    events = [Event(date(2024, 6, 3), EventType.DEPOSIT, amount=10000.0)]
    for offset, symbol in enumerate(symbols):
        events.append(
            Event(date(2024, 6, 4), EventType.BUY, symbol, symbol,
                  quantity=10, unit_price=100.0 + offset))
    return events


def _written(opened):
    """The two perf tables, in full — what a recompute is judged on."""
    return (
        opened.query('SELECT * FROM account_metrics ORDER BY day, account'),
        opened.query('SELECT * FROM portfolio_totals ORDER BY day'),
    )


@contextmanager
def _the_per_symbol_implementation(symbols):
    """Run the pass over the price source it had **before** this ticket.

    ``quotes.price_series`` is called once per symbol and its answers are folded
    into the shape the aggregated read hands back, so the only thing that differs
    between the two runs is the query the store was asked for. It is the
    reference this module measures identity against, and it stays honest for as
    long as ``price_series`` is left alone — which is why the ticket forbids
    touching it.
    """
    def daily_closes(self, start=None, stop=None):
        rows = [{'day': day, 'symbol': symbol, 'price': price}
                for symbol in symbols
                for day, price in quotes.price_series(self._store, symbol).items()]
        return sorted(rows, key=lambda row: (row['day'], row['symbol']))

    aggregated = store_reads.PortfolioReader.daily_closes
    store_reads.PortfolioReader.daily_closes = daily_closes
    try:
        yield
    finally:
        store_reads.PortfolioReader.daily_closes = aggregated


# --------------------------------------------------------------------------- #
# What is asked of the store
# --------------------------------------------------------------------------- #

def test_the_recompute_reads_the_price_table_once_for_every_symbol(
        store, mocker, declare_ledger):
    """One statement for the whole price source, and no ``WHERE symbol = ?``.

    The shape of the query is the assertion, not a number of milliseconds: the
    per-symbol read is recognisable by the equality it filters on, and its
    absence is what makes the scan count independent of the portfolio's size.
    """
    symbols = ['AAPL', 'ASML', 'MSFT', 'SAN', 'TTE']
    events = _ledger(symbols)
    declare_ledger(store, events)
    for symbol in symbols:
        _quote(store, symbol)
        _price(store, symbol, date(2024, 6, 5), 100.0, 100.0)
    metrics = _metrics(store, mocker)

    with _Recorder(store) as recorded:
        metrics.update_account_metrics()

    price_reads = recorded.touching('price_point')
    assert [sql for sql in price_reads if 'symbol = ?' in sql] == []
    assert len([sql for sql in price_reads
                if 'PARTITION BY CAST(ts AS DATE), symbol' in sql]) == 1


def test_the_number_of_price_scans_does_not_follow_the_portfolio(
        store, mocker, declare_ledger):
    """Five symbols cost exactly what one costs.

    The ticket's own measure. The pass reads ``price_point`` for three different
    questions — the daily closes, the backfill's anchor, the first quoted day —
    and all three are whole-portfolio aggregates; what mattered is that none of
    them is paid per line any more.
    """
    def scans(opened, symbols):
        declare_ledger(opened, _ledger(symbols))
        for symbol in symbols:
            _quote(opened, symbol)
            _price(opened, symbol, date(2024, 6, 5), 100.0, 100.0)
        with _Recorder(opened) as recorded:
            _metrics(opened, mocker).update_account_metrics()
        return len(recorded.touching('price_point'))

    alone = scans(store, ['AAPL'])
    store.execute('DELETE FROM event')
    together = scans(store, ['ASML', 'MSFT', 'SAN', 'TTE'])

    assert together == alone


# --------------------------------------------------------------------------- #
# What is written to it
# --------------------------------------------------------------------------- #

def test_a_multi_symbol_series_is_identical_to_the_per_symbol_one(
        store, mocker, declare_ledger):
    """Point for point, account by account, and the totals with them.

    The optimisation's whole claim. Three lines, priced on different days, so a
    grouping that lost a day or crossed two symbols would move a figure.
    """
    symbols = ['AAPL', 'MSFT', 'TTE']
    declare_ledger(store, _ledger(symbols))
    for offset, symbol in enumerate(symbols):
        _quote(store, symbol)
        for day in (date(2024, 6, 5), date(2024, 6, 7), date(2024, 6, 12)):
            _price(store, symbol, day, 100.0 + offset + day.day,
                   100.0 + offset + day.day)

    with _the_per_symbol_implementation(symbols):
        _metrics(store, mocker).update_account_metrics()
        before = _written(store)

    _metrics(store, mocker).update_account_metrics()

    assert _written(store) == before
    # And the comparison is not between two empty tables: the days are there and
    # the three lines are valued, at the last close each of them carries.
    accounts, _ = before
    assert len(accounts) > 1
    (valued,) = store.query(
        'SELECT holdings_value FROM portfolio_totals WHERE day = ?', [_TODAY])
    assert valued[0] == pytest.approx(10 * (112.0 + 113.0 + 114.0))


def test_a_symbol_with_no_converted_price_invents_no_valuation(
        store, mocker, declare_ledger):
    """Quoted natively, never converted — and the days it was held stay unwritten.

    The state #706 refuses to carry: the quote is known, the rate is not, so the
    absence is *transitory* and the honest reading is to block rather than to
    count the line at nothing beside a cash ledger that has already paid for it.
    The grouping must keep that symbol **out** of the pair table rather than key
    it with an empty list, and what the store shows is the consequence: the
    series stops the day before the purchase, and no day of the holding is
    written at all — not a zero, not a ``NULL`` row.
    """
    declare_ledger(store, _ledger(['AAPL', 'MSFT']))
    for symbol in ('AAPL', 'MSFT'):
        _quote(store, symbol)
    _price(store, 'AAPL', date(2024, 6, 5), 110.0, 110.0)
    _price(store, 'MSFT', date(2024, 6, 5), 210.0, None)

    # The store itself says the unconverted symbol has no close, which is what
    # the grouping must not turn into a key.
    closes = store_reads.PortfolioReader(store).daily_closes()
    assert {row['symbol'] for row in closes} == {'AAPL'}

    with _the_per_symbol_implementation(['AAPL', 'MSFT']):
        _metrics(store, mocker).update_account_metrics()
        before = _written(store)

    _metrics(store, mocker).update_account_metrics()

    assert _written(store) == before
    # The purchase is on 4 June and no day from there on carries a figure: the
    # unconvertible line blocks its own days rather than counting zero.
    assert store.query(
        'SELECT day, holdings_value FROM portfolio_totals ORDER BY day') == [
        (date(2024, 6, 3), 0.0)]
