"""The perf tables' block write: one statement over Arrow, not one per row (#972).

``perf_series._upsert`` is the cost of a **write request**, not of a background
tick: ``main.replay_after_write`` rewrites the whole series inside the request
that recorded the event. Row by row it measured 0.741 ms a point — 9.7 s for the
13 146 points of six accounts over six years — and that is where the 30 to 45 s
of a deletion went, not into the ledger replay (48 ms) or the computation.

The seam is the suite's usual one: a real DuckDB store in ``tmp_path``, the
production writers, and every assertion on the rows that came back. What is
pinned here is what the Arrow block can break and ``executemany`` could not: a
column is now typed **once for the whole block** rather than per value, so a
series that is merely sparse — and they all are — has to cross unchanged.

Prior art: ``tests/test_replay_perf.py``, ``tests/test_perf_job.py``.
"""
from datetime import date, timedelta

from application import perf_series
from application.events.schemas import AccountMetricPoint, PortfolioTotalPoint


def _day(offset: int) -> date:
    """``offset`` days after the first of January — through the end of it.

    ``date(2024, 1, 1 + offset)`` is the version that reads the same and
    raises past the 30th, which is where a series of any realistic length
    goes: the ones this module describes run 2 190 days.
    """
    return date(2024, 1, 1) + timedelta(days=offset)


def test_a_column_no_point_fills_is_still_written_as_a_number(store):
    """An account with no cash ledger leaves six of the seven values empty.

    ``writable_fields`` blanks whatever the account cannot answer for, so a
    grant-only account writes ``None`` in ``cash_balance`` on **every** day of
    its series, and ``xirr`` is empty on every day but the last of any series at
    all. Typed per value that was nobody's problem; typed once for the block it
    is the block's type, and this is the case that decides it — Arrow infers
    ``null`` for a column with nothing in it, and what this pins is that DuckDB
    takes it into a ``DOUBLE``. It is the assumption ``_upsert`` rests on since
    the declared schema came back out, so it fails here first if a version ever
    stops casting.
    """
    written = perf_series.write_account_metrics(store, [
        AccountMetricPoint(account='default', day=_day(i), holdings_value=10.0 * i)
        for i in range(3)])

    assert written == 3
    assert store.query(
        'SELECT day, cash_balance, holdings_value, xirr FROM account_metrics '
        ' ORDER BY day') == [
        (_day(0), None, 0.0, None),
        (_day(1), None, 10.0, None),
        (_day(2), None, 20.0, None),
    ]


def test_the_block_upserts_rather_than_duplicating(store):
    """The second pass over the same days corrects them, and adds no row.

    The whole series is rewritten every pass, so every point but the newest
    conflicts. ``ON CONFLICT … DO UPDATE`` is what makes that a correction; an
    insert would make it a duplicate key, and an insert that ignored the
    conflict would leave yesterday's wrong figure standing.
    """
    perf_series.write_account_metrics(store, [
        AccountMetricPoint(account='default', day=_day(i), total_value=1.0)
        for i in range(3)])
    perf_series.write_account_metrics(store, [
        AccountMetricPoint(account='default', day=_day(i), total_value=2.0)
        for i in range(4)])

    assert store.query(
        'SELECT day, total_value FROM account_metrics ORDER BY day') == [
        (_day(0), 2.0), (_day(1), 2.0), (_day(2), 2.0), (_day(3), 2.0)]


def test_the_totals_are_written_the_same_way_without_an_account(store):
    """``portfolio_totals`` is keyed on the day alone — one column fewer."""
    perf_series.write_portfolio_totals(
        store, [PortfolioTotalPoint(day=_day(0), total_value=5.0)])
    perf_series.write_portfolio_totals(
        store, [PortfolioTotalPoint(day=_day(0), total_value=6.0),
                PortfolioTotalPoint(day=_day(1), total_value=7.0)])

    assert store.query(
        'SELECT day, total_value, xirr FROM portfolio_totals ORDER BY day') == [
        (_day(0), 6.0, None), (_day(1), 7.0, None)]


def test_an_empty_block_writes_nothing_and_binds_nothing(store, mocker):
    """No rows, no statement — the pass runs on an empty ledger every boot.

    The spy is the whole test. Row counts and return values survive the guard's
    removal — an ``INSERT … SELECT`` over an empty block is a legal no-op that
    inserts nothing and answers the same — so *"nothing was bound"* is only
    observable at the seam that would have bound it.
    """
    block = mocker.spy(store, 'write_arrow')

    assert perf_series.write_account_metrics(store, []) == 0
    assert perf_series.write_portfolio_totals(store, []) == 0

    assert block.call_count == 0
    assert store.query('SELECT count(*) FROM account_metrics') == [(0,)]


def test_a_column_only_the_last_day_fills_keeps_that_day_and_no_other(store):
    """``xirr`` is the sparse shape the series really has, and it is mixed.

    Not a column of ``None`` (that is the case above) and not a full one: a
    rate of return needs a terminal valuation, so the pass writes it on the
    **last** point of the series and leaves it empty on the 2 190 before it.
    Row by row that column was seven separate values of two separate types;
    as one Arrow array it is one ``DOUBLE`` array with nulls in it, and what
    has to come back is the number on the day that had one and nothing on the
    days that did not.
    """
    perf_series.write_account_metrics(store, [
        AccountMetricPoint(account='default', day=_day(0), total_value=1.0),
        AccountMetricPoint(account='default', day=_day(1), total_value=2.0),
        AccountMetricPoint(account='default', day=_day(2), total_value=3.0,
                           xirr=0.0712, twr_index=101.5),
    ])

    assert store.query(
        'SELECT day, xirr, twr_index FROM account_metrics ORDER BY day') == [
        (_day(0), None, None),
        (_day(1), None, None),
        (_day(2), 0.0712, 101.5),
    ]


def test_one_day_twice_in_the_same_block_keeps_the_last_of_them(store):
    """A block cannot conflict with itself, so ``_last_per_key`` arbitrates first.

    Row by row, the second of two points on the same day *corrected* the first:
    each row was its own statement, and the second one's ``DO UPDATE`` saw the
    row the first had just written. In one ``INSERT … SELECT`` the two arrive
    together, ``ON CONFLICT`` only arbitrates against what is already stored,
    and one of the two is dropped — silently, at any block size, first-wins.
    That is a behaviour change the block write would have smuggled in, so the
    rows are reduced on their key before they are handed over.

    ``2.0`` and not ``1.0`` is the whole assertion: last-wins is what the row
    loop did. And ``written`` is ``1``, because the count this returns is the
    count the log prints — an upper bound would say two rows were written to a
    table holding one.
    """
    written = perf_series.write_account_metrics(store, [
        AccountMetricPoint(account='default', day=_day(0), total_value=1.0),
        AccountMetricPoint(account='default', day=_day(0), total_value=2.0),
    ])

    assert written == 1
    assert store.query(
        'SELECT day, total_value FROM account_metrics') == [(_day(0), 2.0)]
