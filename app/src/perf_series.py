"""The perf job's own two tables: ``account_metrics`` / ``portfolio_totals``.

Issue #700 then #707, spec #695 § 3 / § 11, ADR-0011. The fourth and last writer
of the schema rule — the configuration path owns the events, the replay owns the
position, the scrape owns the prices, and what is *computed* from all three is
laid down here.

Three properties of the write are decisions rather than details.

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

**The upsert is followed by a bounded prune, never by a replacement** (issue
#707). The recompute is integral and unconditional, so the rows the cycle hands
over *are* the series; what a ``DELETE``+``INSERT`` would buy — no row surviving
that the computation no longer produces — is bought instead by deleting exactly
what falls **outside** the written spans, and by nothing else. Two things fall
out of that shape: the file does not drift (the measurement ADR-0011 rests on is
a replacement's, not an upsert's), and a day orphaned by a forgotten import
leaves with the account it belonged to, in the same statement and by the same
predicate.
"""
from datetime import date
from typing import Any, Mapping, Optional, Sequence, Tuple

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


#: The span one cycle wrote for one entity: ``(first_day, last_day)``, both
#: inclusive. What the prune keeps, and therefore what it is bounded by.
Span = Tuple[date, date]


def prune_account_metrics(store, spans: Mapping[str, Span]) -> int:
    """Drop every cached day outside ``spans``. Returns how many rows went.

    ``spans`` is ``{account: (first_day, last_day)}`` — what the upsert just
    wrote, one span per account, taken from the points themselves rather than
    from the window someone asked for. Three cases collapse into this one
    statement, which is the reason it is written as an anti-join rather than as
    a date range (ADR-0011):

    * a **day that fell out of the series** — an event deleted, an import
      forgotten, an account whose first activity moved later;
    * an **account that is no longer written at all** — it has no span, so
      every one of its days is outside the set;
    * and nothing else. A day the cycle rewrote is left alone by construction,
      which is what makes this a prune and not a replacement.

    An **empty** ``spans`` empties the table, and that is the honest reading
    rather than a guard to add: the recompute is integral, so producing no point
    for anybody means the ledger produces no series — the same rule
    :func:`positions.write_state` follows when the last import is forgotten. It
    is safe because the caller only reaches here having *computed* the cycle: a
    failure raises before, inside one transaction, and the previous rows stand.

    Per **account** rather than one global window, because accounts start on
    different days: a global ``[min, max]`` would leave an account's orphaned
    early days standing in the middle of another account's span.
    """
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
    """Drop every global day outside ``span``. Returns how many rows went.

    ``None`` empties the table, and it is the case that matters: the global
    series is written only while all accounts share one currency, so a second
    currency appearing must take the old global days away rather than leave a
    frozen series that reads as current.
    """
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
    'VALUE_COLUMNS', 'ACCOUNT_COLUMNS', 'TOTALS_COLUMNS', 'Span',
    'write_account_metrics', 'write_portfolio_totals',
    'prune_account_metrics', 'prune_portfolio_totals', 'forget_account',
]
