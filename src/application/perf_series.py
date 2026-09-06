"""The perf job's own two tables: ``account_metrics`` / ``portfolio_totals``."""
from datetime import date
from typing import Any, Mapping, Optional, Sequence, Tuple

from logfmt_logger import getLogger

from application.store import finite

logger = getLogger("perf_series")

VALUE_COLUMNS = (
    'cash_balance', 'holdings_value', 'total_value', 'net_contributed',
    'xirr', 'gain_absolu', 'twr_index',
)

ACCOUNT_COLUMNS = ('account', 'day') + VALUE_COLUMNS
TOTALS_COLUMNS = ('day',) + VALUE_COLUMNS


def _upsert(store, table: str, columns: Sequence[str], keys: Sequence[str],
            rows: Sequence[Sequence[Any]]) -> int:
    """One block upsert. Returns how many rows were handed to it."""
    if not rows:
        return 0
    updated = [name for name in columns if name not in keys]
    assignments = ', '.join(f'{name} = excluded.{name}' for name in updated)
    store.executemany(
        f'INSERT INTO {table} ({", ".join(columns)}) '
        f'VALUES ({", ".join("?" * len(columns))}) '
        f'ON CONFLICT ({", ".join(keys)}) DO UPDATE SET {assignments}',
        rows)
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
