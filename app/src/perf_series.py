"""The perf job's own two tables: ``account_metrics`` / ``portfolio_totals``.

Issue #700, spec #695 § 3 / § 11, ADR-0011. The fourth and last writer of the
schema rule — the configuration path owns the events, the replay owns the
position, the scrape owns the prices, and what is *computed* from all three is
laid down here.

Two properties of the write are decisions rather than details.

**It is an ``UPSERT`` on the primary key, in one block statement.** ADR-0011
measured the alternatives on a thousand cycles of a job that runs every 120 s: a
``DELETE``+``INSERT`` replacement takes the file to **44,8 MB for a 1,6 MB
table** — roughly 11 GB a year, which a checkpoint does not give back — while the
upsert plateaus at 1,1 MB and is 3,6× faster. And *block* is the other half: the
same 5 478-row upsert is 3 ms in one statement and does not finish in two
minutes row by row. The primary key of ``account_metrics`` is therefore a
**write mechanism** and not only a constraint.

**The day is a ``DATE``.** The two kinds of time never mix (spec #695 § 3): an
observed instant is a ``TIMESTAMPTZ`` in UTC, a calendar day is a ``DATE``. This
series is the one seam where an instant is filed under a UTC day, and v4 spelt
that by stamping a point at midnight — which then had to be un-stamped by every
reader. Here the column says what it is.

What is **not** here yet is #707's business: the gating that decides whether to
recompute at all, the stale-tail window the caller passes, and the bounded prune
that catches a removed account. This module writes what it is handed.
"""
from typing import Any, Sequence

from logfmt_logger import getLogger

from store import finite

logger = getLogger("perf_series")

#: The seven value columns both tables carry, in DDL order. One list, so the two
#: upserts and the reads cannot drift apart.
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
    """Upsert the daily per-account series. Returns how many points were written.

    ``points`` are :class:`events.schemas.AccountMetricPoint`. A field left
    ``None`` — or a NaN, which :func:`store.finite` turns into one — is written
    as ``NULL`` and **not skipped**: in the store a declared
    column that was never written reads as ``NULL`` rather than not existing
    (ADR-0001), so absence is a shape of the data and naming a field in a
    ``SELECT`` is safe again. That is the whole of what ``_ABSENT_SCHEMA`` used
    to work around.
    """
    written = _upsert(
        store, 'account_metrics', ACCOUNT_COLUMNS, ('account', 'day'),
        [[point.account, point.day, *(finite(getattr(point, name))
                                      for name in VALUE_COLUMNS)]
         for point in points])
    if written:
        logger.info(f"Wrote {written} account_metrics point(s)")
    return written


def write_portfolio_totals(store, points: Sequence[Any]) -> int:
    """Upsert the daily global series. Returns how many points were written.

    A table of its own rather than a synthetic ``account`` row, and it stays one
    for a forward-looking reason rather than an inherited one: the InfluxDB
    constraint that made it untagged is gone, but its columns will diverge the
    day the global level carries something the per-account level does not.
    """
    written = _upsert(
        store, 'portfolio_totals', TOTALS_COLUMNS, ('day',),
        [[point.day, *(finite(getattr(point, name)) for name in VALUE_COLUMNS)]
         for point in points])
    if written:
        logger.info(f"Wrote {written} portfolio_totals point(s)")
    return written


def forget_account(store, account_id: str) -> int:
    """Drop an account's cached figures. Returns how many days went.

    Called by the **declaration's** writer when an account leaves, and it lives
    here rather than there because this module owns the table (one writer per
    row). What it settles is a question the foreign key asks and ADR-0013 already
    answered: ``account_metrics.account`` references ``account(id)``, so once the
    perf job has run, deleting an account trips a constraint — and the API's
    designed answer (``200``, or ``409`` naming an event) becomes a ``503``.

    Deleting is right rather than refusing, and the reason is what the series
    *is*: a **cache** (ADR-0011), a pure function of the events, the prices and
    the declaration. Refusing on it would make a figure the next cycle could
    rebuild as binding as a fact the owner recorded — while ADR-0013's refusal is
    about the one thing that cannot be rebuilt, an event naming the account, and
    that refusal is checked first and still stands.
    """
    (removed,) = store.query(
        'SELECT count(*) FROM account_metrics WHERE account = ?',
        [account_id])[0]
    store.execute('DELETE FROM account_metrics WHERE account = ?', [account_id])
    if removed:
        logger.info(
            f"Dropped {removed} cached account_metrics day(s) of {account_id}")
    return removed


# Nothing *reads* these two tables from here, and that is the schema rule seen
# from the writer's side: the perf job recomputes from the events, the prices
# and the declaration — never from its own output, which is a cache. What the
# pages read goes through :mod:`store_reads`, with the error contract a UI needs.


__all__ = [
    'VALUE_COLUMNS', 'ACCOUNT_COLUMNS', 'TOTALS_COLUMNS',
    'write_account_metrics', 'write_portfolio_totals', 'forget_account',
]
