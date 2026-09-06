"""The market's own two tables: ``symbol_quote`` and ``price_point`` (issue #700)."""
from datetime import date, datetime, timezone
from typing import (Dict, Iterable, List, Mapping, Optional, Sequence, Set,
                    Tuple)

from logfmt_logger import getLogger

from application import carrying
from application import instants
from application import retention
from application.store import finite

logger = getLogger("quotes")

QUOTE_ATTRIBUTES = (
    'currency', 'exchange', 'quote_type',
    'dividend_yield', 'pe_ratio', 'market_cap',
)


def truncate(moment: datetime) -> datetime:
    """One instant, in UTC and truncated to the second."""
    stamped = moment if moment.tzinfo is not None else moment.replace(
        tzinfo=timezone.utc)
    return stamped.astimezone(timezone.utc).replace(microsecond=0)


def _advance_latest(store, symbol: str, ts: datetime,
                    price_native: Optional[float],
                    price_converted: Optional[float] = None,
                    fx_rate: Optional[float] = None) -> None:
    """Apply the ``latest`` maintenance rule for one inserted point."""
    store.execute(
        'UPDATE symbol_quote '
        '   SET last_price_native = ?, last_price_converted = ?, '
        '       last_fx_rate = ?, last_price_ts = ? '
        ' WHERE symbol = ? '
        '   AND (last_price_ts IS NULL OR ? >= last_price_ts)',
        [price_native, price_converted, fx_rate, ts, symbol, ts])


def _ensure_row(store, symbol: str) -> None:
    """Make sure the symbol has a ``symbol_quote`` row, attributes or not."""
    store.execute(
        'INSERT INTO symbol_quote (symbol) VALUES (?) '
        'ON CONFLICT (symbol) DO NOTHING', [symbol])


def record_quote(store, symbol: str, moment: datetime,
                 price_native: Optional[float],
                 attributes: Optional[Mapping] = None,
                 price_converted: Optional[float] = None,
                 fx_rate: Optional[float] = None) -> None:
    """One live observation: a ``price_point`` appended, ``symbol_quote`` refreshed."""
    ts = truncate(moment)
    values = dict(attributes or {})
    native = finite(price_native)
    converted = finite(price_converted)
    rate = finite(fx_rate)

    refreshed = ('fetched_at',) + QUOTE_ATTRIBUTES
    assignments = ', '.join(f'{name} = excluded.{name}' for name in refreshed)
    with store.transaction():
        store.execute(
            f'INSERT INTO symbol_quote (symbol, {", ".join(refreshed)}) '
            f'VALUES (?{", ?" * len(refreshed)}) '
            f'ON CONFLICT (symbol) DO UPDATE SET {assignments}',
            [symbol, ts,
             *(finite(values.get(name)) for name in QUOTE_ATTRIBUTES)])
        store.execute(
            'INSERT INTO price_point '
            '  (symbol, ts, price_native, price_converted, fx_rate) '
            'VALUES (?, ?, ?, ?, ?)',
            [symbol, ts, native, converted, rate])
        _advance_latest(store, symbol, ts, native, converted, rate)


def record_attributes(store, symbol: str, moment: datetime,
                      attributes: Mapping) -> None:
    """Write what the instrument **is**, with no price claimed beside it (#773)."""
    refreshed = ('fetched_at',) + QUOTE_ATTRIBUTES
    assignments = ', '.join(f'{name} = excluded.{name}' for name in refreshed)
    store.execute(
        f'INSERT INTO symbol_quote (symbol, {", ".join(refreshed)}) '
        f'VALUES (?{", ?" * len(refreshed)}) '
        f'ON CONFLICT (symbol) DO UPDATE SET {assignments}',
        [symbol, truncate(moment),
         *(finite(attributes.get(name)) for name in QUOTE_ATTRIBUTES)])


def record_history(store, symbol: str, points: Sequence[Mapping]) -> int:
    """Write one fetched chunk of history. Returns how many points landed."""
    rows = []
    for point in points:
        price = point.get('price')
        if price is None:
            continue
        price = finite(float(price))
        if price is None:
            continue
        rows.append((symbol, truncate(point['timestamp']), price,
                     finite(point.get('converted')), finite(point.get('rate'))))
    if not rows:
        return 0

    oldest = min(row[1] for row in rows)
    newest = max(row[1] for row in rows)

    with store.transaction():
        _ensure_row(store, symbol)
        store.execute(
            'DELETE FROM price_point '
            ' WHERE symbol = ? AND ts >= ? AND ts <= ?',
            [symbol, oldest, newest])
        store.executemany(
            'INSERT INTO price_point '
            '  (symbol, ts, price_native, price_converted, fx_rate) '
            'VALUES (?, ?, ?, ?, ?)',
            rows)
        latest = [row for row in rows if row[1] == newest][-1]
        _advance_latest(store, symbol, newest, latest[2], latest[3], latest[4])

    logger.debug(f"Wrote {len(rows)} historical price(s) for {symbol}")
    return len(rows)


def collapse_to_ladder(store, now: datetime) -> int:
    """Age the whole series onto the ladder, in place. Returns rows removed."""
    hourly_wall, daily_wall = retention.walls(now)
    bands = (
        ("time_bucket(INTERVAL '1 hour', ts)", 'ts <= ? AND ts >= ?',
         [hourly_wall, daily_wall]),
        ('CAST(ts AS DATE)', 'ts < ?', [daily_wall]),
    )

    survivor = ('(price_converted IS NOT NULL) DESC, ts DESC, rowid DESC')

    removed = 0
    with store.transaction():
        for bucket, bound, parameters in bands:
            result = store.execute(
                'DELETE FROM price_point WHERE rowid IN ('
                '  SELECT rowid FROM ('
                '    SELECT rowid, ROW_NUMBER() OVER ('
                f'             PARTITION BY symbol, {bucket}'
                f'              ORDER BY {survivor}) AS rn'
                '      FROM price_point'
                f'     WHERE {bound}'
                '  ) WHERE rn > 1)',
                parameters)
            removed += int(result.fetchone()[0])

    if removed:
        logger.debug(f"Aged {removed} price point(s) onto the retention ladder")
    return removed


def unconverted_span(store, symbol: str) -> Optional[Tuple[date, date, int]]:
    """``(oldest day, newest day, how many)`` of the points missing a conversion."""
    rows = store.query(
        'SELECT min(CAST(ts AS DATE)), max(CAST(ts AS DATE)), count(*) '
        '  FROM price_point '
        ' WHERE symbol = ? AND price_native IS NOT NULL '
        '   AND price_converted IS NULL', [symbol])
    if not rows or rows[0][2] in (None, 0):
        return None
    oldest, newest, count = rows[0]
    return oldest, newest, int(count)


def unconverted_days(store, symbol: str, first: date,
                     last: date) -> List[date]:
    """The calendar days of ``[first, last]`` carrying a point to repair."""
    return [row[0] for row in store.query(
        'SELECT DISTINCT CAST(ts AS DATE) AS day FROM price_point '
        ' WHERE symbol = ? AND price_native IS NOT NULL '
        '   AND price_converted IS NULL '
        '   AND CAST(ts AS DATE) BETWEEN ? AND ? '
        ' ORDER BY day', [symbol, first, last])]


def repair_conversions(store, symbol: str,
                       factors: Mapping[date, float]) -> int:
    """Give a day's points the conversion they were written without. Returns rows."""
    days = sorted(day for day, factor in factors.items() if factor is not None)
    if not days:
        return 0

    placeholders = ', '.join('?' * len(days))
    predicate = (
        ' WHERE symbol = ? AND price_native IS NOT NULL '
        '   AND price_converted IS NULL '
        f'  AND CAST(ts AS DATE) IN ({placeholders})')

    with store.transaction():
        rows = store.query(
            'SELECT count(*), max(ts) FROM price_point' + predicate,
            [symbol, *days])
        repaired, newest = (int(rows[0][0]), rows[0][1]) if rows else (0, None)
        if not repaired:
            return 0

        store.executemany(
            'UPDATE price_point '
            '   SET price_converted = price_native * ?, fx_rate = ? '
            ' WHERE symbol = ? AND price_native IS NOT NULL '
            '   AND price_converted IS NULL AND CAST(ts AS DATE) = ?',
            [(factors[day], factors[day], symbol, day) for day in days])

        latest = store.query(
            'SELECT price_native, price_converted, fx_rate FROM price_point '
            ' WHERE symbol = ? AND ts = ? AND price_converted IS NOT NULL '
            ' ORDER BY rowid DESC LIMIT 1', [symbol, newest])
        if latest:
            _advance_latest(store, symbol, instants.utc(newest), *latest[0])

    logger.debug(f"Repaired {repaired} conversion(s) for {symbol}")
    return repaired


def record_window_tried(store, symbol: str, oldest: date) -> None:
    """Remember that the backward pass has attempted a window starting at ``oldest``."""
    with store.transaction():
        _ensure_row(store, symbol)
        store.execute(
            'UPDATE symbol_quote '
            '   SET oldest_window_tried = ? '
            ' WHERE symbol = ? '
            '   AND (oldest_window_tried IS NULL OR ? < oldest_window_tried)',
            [oldest, symbol, oldest])


def oldest_window_tried(store, symbol: str) -> Optional[date]:
    """The oldest window the backward pass has attempted, or ``None``."""
    rows = store.query(
        'SELECT oldest_window_tried FROM symbol_quote WHERE symbol = ?',
        [symbol])
    return rows[0][0] if rows and rows[0][0] is not None else None


def terminal_symbols(store, windows: Mapping[str, Tuple[date, Optional[date]]],
                     now: datetime) -> Set[str]:
    """Which symbols the backward pass has **finished** with — issue #706."""
    if not windows:
        return set()

    oldest_stored = {
        symbol: instants.utc(value)
        for symbol, value in store.query(
            'SELECT symbol, min(ts) FROM price_point GROUP BY symbol')
        if value is not None
    }
    oldest_tried = {
        symbol: value
        for symbol, value in store.query(
            'SELECT symbol, oldest_window_tried FROM symbol_quote '
            ' WHERE oldest_window_tried IS NOT NULL')
    }

    finished = set()
    for symbol, (acquired, exited) in windows.items():
        target, ceiling = carrying.holding_bounds(acquired, exited, now)
        anchor = carrying.backward_anchor(
            ceiling, oldest_stored.get(symbol), oldest_tried.get(symbol))
        if carrying.is_terminal(anchor, target):
            finished.add(symbol)
    return finished


def first_quoted_days(store) -> Dict[str, date]:
    """``{symbol: first calendar day carrying a quote}`` — one query, whole store."""
    return {
        symbol: value
        for symbol, value in store.query(
            'SELECT p.symbol, min(CAST(p.ts AS DATE)) '
            '  FROM price_point p '
            '  JOIN symbol_quote q ON q.symbol = p.symbol '
            " WHERE p.price_native IS NOT NULL AND q.currency IS NOT NULL "
            "   AND q.currency <> '' "
            ' GROUP BY p.symbol')
        if value is not None
    }


def quote_currency(store, symbol: str) -> Optional[str]:
    """The currency the exchange quotes a symbol in, or ``None``."""
    rows = store.query(
        'SELECT currency FROM symbol_quote WHERE symbol = ?', [symbol])
    return rows[0][0] if rows and rows[0][0] else None


def quote_exchanges(store, symbols: Iterable[str]) -> Dict[str, Optional[str]]:
    """``{symbol: venue | None}`` for the symbols asked — **one query** (#851)."""
    wanted = sorted(set(symbols))
    if not wanted:
        return {}
    stored = dict(store.query(
        'SELECT symbol, exchange FROM symbol_quote '
        ' WHERE symbol IN (%s)' % ', '.join('?' * len(wanted)), wanted))
    return {symbol: (stored.get(symbol) or None) for symbol in wanted}


def oldest_ts(store, symbol: str) -> Optional[datetime]:
    """The oldest stored instant of a symbol's series, or ``None``."""
    rows = store.query(
        'SELECT min(ts) FROM price_point WHERE symbol = ?', [symbol])
    return instants.utc(rows[0][0]) if rows and rows[0][0] is not None else None


def newest_ts(store, symbol: str) -> Optional[datetime]:
    """The newest **price-bearing** instant of a symbol's series, or ``None``."""
    rows = store.query(
        'SELECT max(ts) FROM price_point '
        ' WHERE symbol = ? AND price_native IS NOT NULL', [symbol])
    return instants.utc(rows[0][0]) if rows and rows[0][0] is not None else None


def last_price(store, symbol: str) -> Optional[float]:
    """The newest stored **native** price of a symbol, or ``None``."""
    rows = store.query(
        'SELECT last_price_native FROM symbol_quote WHERE symbol = ?', [symbol])
    return rows[0][0] if rows and rows[0][0] is not None else None


def price_series(store, symbol: str) -> Dict[date, float]:
    """``{day: close}`` — one entry per calendar day that has a **converted** price."""
    table = store.arrow(
        'SELECT day, price FROM ('
        '  SELECT CAST(ts AS DATE) AS day, price_converted AS price,'
        '         ROW_NUMBER() OVER ('
        '             PARTITION BY CAST(ts AS DATE) ORDER BY ts DESC) AS rn'
        '    FROM price_point'
        '   WHERE symbol = ? AND price_converted IS NOT NULL'
        ') WHERE rn = 1 ORDER BY day', [symbol])
    days = table.column('day').to_pylist()
    prices = table.column('price').to_pylist()
    return {day: float(price) for day, price in zip(days, prices)}


def read_quote(store, symbol: str) -> Optional[Dict]:
    """One ``symbol_quote`` row as a dict, or ``None`` when there is none."""
    columns = ('symbol',) + QUOTE_ATTRIBUTES + (
        'fetched_at', 'last_price_native', 'last_price_converted',
        'last_fx_rate', 'last_price_ts')
    rows = store.query(
        f'SELECT {", ".join(columns)} FROM symbol_quote WHERE symbol = ?',
        [symbol])
    if not rows:
        return None
    row = dict(zip(columns, rows[0]))
    row['fetched_at'] = instants.utc(row['fetched_at'])
    row['last_price_ts'] = instants.utc(row['last_price_ts'])
    return row


def forget_symbol(store, symbol: str) -> int:
    """Drop every market row of one symbol — its series and its quote row."""
    (points,) = store.query(
        'SELECT count(*) FROM price_point WHERE symbol = ?', [symbol])[0]
    store.execute('DELETE FROM price_point WHERE symbol = ?', [symbol])
    store.execute('DELETE FROM symbol_quote WHERE symbol = ?', [symbol])
    return int(points)


__all__ = [
    'QUOTE_ATTRIBUTES', 'truncate',
    'record_quote', 'record_attributes', 'record_history',
    'collapse_to_ladder',
    'unconverted_span', 'unconverted_days', 'repair_conversions',
    'record_window_tried', 'oldest_window_tried', 'terminal_symbols',
    'first_quoted_days',
    'quote_currency',
    'oldest_ts', 'newest_ts', 'last_price', 'price_series', 'read_quote',
    'forget_symbol',
]
