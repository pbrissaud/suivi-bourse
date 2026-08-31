"""The perf pass's own predicate: which symbols stop bounding the horizon.

``perf_job`` derives ``settled`` — the set of symbols whose absence of a price
is *permanent* rather than transitory — and hands it to
:func:`performance.account_horizon`, which drops those symbols from the blocking
population altogether. The two questions that meet there are asked on different
grains, and that is the whole subject of this module: the horizon reasons **per
day** (a symbol blocks the days it was held and no price answers for), while the
set it is handed can only say *yes* or *no* about a whole symbol. A predicate
that reads *some day of this symbol carries a converted price* therefore settles
a line that is priced from January while the ledger has held it since 2019, and
the six unpriced years are not blocked, not carried, and not skipped: they are
**written with the position counted at nothing** beside a cash ledger that has
already paid for it — ADR-0004's crater, dug by the very set that exists to
avoid it.

The seam is the suite's usual one: a real DuckDB store in ``tmp_path``, a real
:class:`workloads.Workloads`, and every assertion on the rows the pass wrote.
There is no double here at all — what is asserted is the content of
``account_metrics`` and ``portfolio_totals``, which is where the defect is
readable.

Prior art: ``tests/test_perf_price_source.py``, ``tests/test_replay_perf.py``,
``tests/test_performance.py``.
"""
from contextlib import contextmanager
from datetime import date, datetime, timezone

import pytest

from application import workloads
from application.events.schemas import Event, EventType

UTC = timezone.utc

#: The day every recompute below is pinned to. The series runs to *today*, so a
#: floating one would change the shape of the assertions tomorrow.
_TODAY = date(2024, 6, 20)

#: The ledger's own first day, the acquisition, and the day a conversion finally
#: lands on a line that has been held since the acquisition. The gap between the
#: last two is what the horizon has to refuse to write.
_OPENED = date(2024, 1, 1)
_ACQUIRED = date(2024, 1, 2)
_CONVERTED = date(2024, 6, 10)


class _ConfigManager:
    """The surface the perf pass needs: the open store and the writers' mutex."""

    def __init__(self, opened):
        self._store = opened

    @property
    def store(self):
        return self._store

    @contextmanager
    def writing(self):
        yield self._store


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


#: One deposit and one purchase held to this day: ten shares at 100, paid for
#: out of the cash the deposit opened. Every figure below is that position seen
#: from a different day.
_LEDGER = [
    Event(_OPENED, EventType.DEPOSIT, amount=10000.0),
    Event(_ACQUIRED, EventType.BUY, 'AAPL', 'Apple', quantity=10,
          unit_price=100.0),
]


def _totals(opened):
    """``portfolio_totals``, in the order a curve is read in."""
    return opened.query(
        'SELECT day, holdings_value, total_value FROM portfolio_totals '
        ' ORDER BY day')


def test_a_line_converted_late_blocks_the_years_before_the_conversion(
        store, mocker, declare_ledger):
    """Quoted since the acquisition, converted only in June — and January is
    not written at all.

    The defect the ``settled`` predicate carried: a **terminal** symbol whose
    ``price_converted`` starts long after its acquisition answers *yes* to *is
    it in ``oldest_priced``*, so :func:`performance.account_horizon` skipped it
    entirely — and skipping it is not the same thing as finding its block empty.
    The days from the purchase to the conversion are exactly the ones
    :func:`carrying.carrying_price` refuses (#706: the quote is known, the rate
    is not, so the absence is transitory), which makes ``price_at`` answer
    ``None`` while ``was_quoted`` answers ``True``: the position adds nothing to
    ``holdings_value`` while the cash it cost has already left the balance. The
    curve reads the whole holding at a loss of its own purchase price, and the
    TWR chained on it never recovers.

    What the store must show is the refusal: no row before the conversion, and
    every row after it valuing the ten shares.
    """
    declare_ledger(store, _LEDGER)
    _quote(store, 'AAPL')
    # Quoted from the day it was acquired — which is also what makes the
    # backfill terminal, hence the symbol a candidate for ``settled`` at all.
    _price(store, 'AAPL', _ACQUIRED, 100.0, None)
    # And converted only months later: #704's lateral pass repairing the tail
    # one chunk per cycle, or a reporting currency answered late.
    _price(store, 'AAPL', _CONVERTED, 120.0, 120.0)

    horizons = _metrics(store, mocker).update_account_metrics()

    written = _totals(store)
    assert written, 'the days after the conversion are computable'
    # The block is [acquisition, the day before the conversion], so the series
    # resumes on the conversion itself.
    assert min(day for day, _, _ in written) == _CONVERTED
    assert horizons == {'default': _CONVERTED}
    # And not one of the unpriced days is written at nothing.
    assert [row for row in written if row[1] == 0.0] == []
    assert dict((day, holdings) for day, holdings, _ in written)[_TODAY] \
        == pytest.approx(10 * 120.0)


def test_a_line_nobody_ever_quoted_in_a_nameable_unit_is_still_carried(
        store, mocker, declare_ledger):
    """The branch the repair must not narrow: never quoted, hence never waiting.

    ``settled``'s other half (#773): a terminal symbol absent from
    :func:`quotes.first_quoted_days` — no ``price_native``, or one in a unit
    Yahoo names none for — is priceless **permanently**, so ADR-0004 carries it
    at its own cost and every day it was held carries a real figure. It must go
    on settling: made to block, a portfolio holding one such line would have no
    series at all rather than a series drawn at cost.
    """
    declare_ledger(store, _LEDGER)
    # A native observation with no ``symbol_quote`` unit beside it: a number no
    # rate can turn into money, and the backfill is terminal all the same.
    _price(store, 'AAPL', _ACQUIRED, 100.0, None)

    horizons = _metrics(store, mocker).update_account_metrics()

    written = _totals(store)
    assert min(day for day, _, _ in written) == _OPENED
    assert horizons == {'default': None}
    # Carried at its cost — the PMP, ten shares at 100 — from the day it was
    # bought, so the purchase day is cash-neutral.
    holdings = dict((day, value) for day, value, _ in written)
    assert holdings[_ACQUIRED] == pytest.approx(1000.0)
    assert holdings[_TODAY] == pytest.approx(1000.0)
