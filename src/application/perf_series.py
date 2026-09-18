"""The perf job's own two tables: ``account_metrics`` / ``portfolio_totals``."""
from datetime import date
from typing import Any, Mapping, Optional, Sequence, Tuple

import pyarrow
from logfmt_logger import getLogger

from application.store import INCOMING, finite

logger = getLogger("perf_series")

VALUE_COLUMNS = (
    'cash_balance', 'holdings_value', 'total_value', 'net_contributed',
    'xirr', 'gain_absolu', 'twr_index',
)

ACCOUNT_COLUMNS = ('account', 'day') + VALUE_COLUMNS
TOTALS_COLUMNS = ('day',) + VALUE_COLUMNS


def _last_per_key(columns: Sequence[str], keys: Sequence[str],
                  rows: Sequence[Sequence[Any]]) -> Sequence[Sequence[Any]]:
    """The rows, with the **last** of any that share a key (#972).

    A block cannot conflict with itself. ``ON CONFLICT`` arbitrates between the
    rows arriving and the rows already stored, so two points on the same day in
    one block are not a correction of each other: one lands and the other is
    dropped, silently, at any block size. Row by row the second *did* correct
    the first, because each row was its own statement — so keeping the last is
    what the writers above already meant, and it also makes the count this
    function's caller returns the number of rows that were really stored rather
    than an upper bound on it.

    ``rebuild_series`` cannot produce a duplicate today: it walks ``perf.daily``,
    one point per calendar day per account, and the totals come out of a
    ``by_date`` mapping. This is here so the writers stay free to stop being
    careful about it.

    **It arbitrates on Python equality, and the store arbitrates on the key's
    own.** The two agree on the columns that key these tables — ``VARCHAR``
    and ``DATE`` — and that is the whole of its warrant. They part on a float:
    DuckDB reads two ``NaN`` as one key and collapses them, a ``dict`` reads
    them as two, so a float key column would put the silent loss straight back.
    There is none, and a key that is not hashable at all would raise here
    rather than lose a row. This is not a general block deduplicator.
    """
    at = [columns.index(name) for name in keys]
    return list({tuple(row[index] for index in at): row for row in rows}.values())


def _upsert(store, table: str, columns: Sequence[str], keys: Sequence[str],
            rows: Sequence[Sequence[Any]]) -> int:
    """One block upsert. Returns how many rows were handed to it.

    One statement over an Arrow block rather than one per row: a whole series
    is rewritten on every pass **and inside the request that wrote the event**
    (``main.replay_after_write``), so this is the cost of a write. Measured on
    the 13 146 points of six accounts over six years, 9.741 s row by row
    against 0.009 s here (issue #972) — which is what lets the write stay
    synchronous, and a ``200`` keep meaning the figures behind it are current.

    The block is **inferred and not declared**, which is the safer half of the
    choice. A declared schema was written first and taken back out: a column of
    a perf series is routinely all-``None`` — ``xirr`` on every day but the
    last, and six of the seven for an account with no cash ledger — so the fear
    was that the ``null`` type inference gives such a column would be refused
    by a ``DOUBLE``. It is not: duckdb 1.5.5 casts it, verified on the real
    column set. What the declared version did add was a hand-written map with
    ``float64`` as its default for every column it did not name, a copy of the
    DDL that nothing checks and that turns the next non-``DOUBLE`` column into
    an ``ArrowInvalid`` raised inside a write request's transaction. Inference
    would have stored it. The cast belongs to the column's own declaration, and
    that lives in ``store``.
    """
    if not rows:
        return 0
    rows = _last_per_key(columns, keys, rows)
    updated = [name for name in columns if name not in keys]
    assignments = ', '.join(f'{name} = excluded.{name}' for name in updated)
    store.write_arrow(
        f'INSERT INTO {table} ({", ".join(columns)}) '
        f'SELECT {", ".join(columns)} FROM {INCOMING} '
        f'ON CONFLICT ({", ".join(keys)}) DO UPDATE SET {assignments}',
        pyarrow.table(dict(zip(columns, zip(*rows)))))
    return len(rows)


def write_account_metrics(store, points: Sequence[Any]) -> int:
    """Upsert the daily per-account series. Returns how many points were written."""
    written = _upsert(
        store, 'account_metrics', ACCOUNT_COLUMNS, ('account', 'day'),
        [[point.account, point.day, *(finite(getattr(point, name))
                                      for name in VALUE_COLUMNS)]
         for point in points])
    if written:
        logger.info(f"Wrote {written} account_metrics point(s)")
    return written


def write_portfolio_totals(store, points: Sequence[Any]) -> int:
    """Upsert the daily global series. Returns how many points were written."""
    written = _upsert(
        store, 'portfolio_totals', TOTALS_COLUMNS, ('day',),
        [[point.day, *(finite(getattr(point, name)) for name in VALUE_COLUMNS)]
         for point in points])
    if written:
        logger.info(f"Wrote {written} portfolio_totals point(s)")
    return written


Span = Tuple[date, date]


def prune_account_metrics(store, spans: Mapping[str, Span]) -> int:
    """Drop every cached day outside ``spans``. Returns how many rows went."""
    if not spans:
        (removed,) = store.query('SELECT count(*) FROM account_metrics')[0]
        if removed:
            store.execute('DELETE FROM account_metrics')
            logger.info(f"Pruned {removed} cached account_metrics day(s)")
        return removed

    values = ', '.join(['(?, ?, ?)'] * len(spans))
    params = [value
              for account, (first, last) in sorted(spans.items())
              for value in (account, first, last)]
    predicate = (
        'NOT EXISTS (SELECT 1 FROM (VALUES ' + values + ') '
        '            AS w(account, first_day, last_day) '
        '            WHERE w.account = m.account '
        '              AND m.day BETWEEN w.first_day AND w.last_day)')
    (removed,) = store.query(
        f'SELECT count(*) FROM account_metrics AS m WHERE {predicate}',
        params)[0]
    if removed:
        store.execute(
            f'DELETE FROM account_metrics AS m WHERE {predicate}', params)
        logger.info(f"Pruned {removed} cached account_metrics day(s)")
    return removed


def prune_portfolio_totals(store, span: Optional[Span]) -> int:
    """Drop every global day outside ``span``. Returns how many rows went."""
    if span is None:
        (removed,) = store.query('SELECT count(*) FROM portfolio_totals')[0]
        if removed:
            store.execute('DELETE FROM portfolio_totals')
            logger.info(f"Pruned {removed} cached portfolio_totals day(s)")
        return removed

    first, last = span
    (removed,) = store.query(
        'SELECT count(*) FROM portfolio_totals WHERE day < ? OR day > ?',
        [first, last])[0]
    if removed:
        store.execute(
            'DELETE FROM portfolio_totals WHERE day < ? OR day > ?',
            [first, last])
        logger.info(f"Pruned {removed} cached portfolio_totals day(s)")
    return removed


def forget_account(store, account_id: str) -> int:
    """Drop an account's cached figures. Returns how many days went."""
    (removed,) = store.query(
        'SELECT count(*) FROM account_metrics WHERE account = ?',
        [account_id])[0]
    store.execute('DELETE FROM account_metrics WHERE account = ?', [account_id])
    if removed:
        logger.info(
            f"Dropped {removed} cached account_metrics day(s) of {account_id}")
    return removed


__all__ = [
    'VALUE_COLUMNS', 'ACCOUNT_COLUMNS', 'TOTALS_COLUMNS', 'Span',
    'write_account_metrics', 'write_portfolio_totals',
    'prune_account_metrics', 'prune_portfolio_totals', 'forget_account',
]
