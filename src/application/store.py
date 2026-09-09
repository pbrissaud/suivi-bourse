"""The store — one embedded DuckDB file, and the app does not boot without it."""
import math
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import duckdb
from logfmt_logger import getLogger

from application import boot_env
from application import settings_registry

logger = getLogger("store")

STORE_FILENAME = 'suivi-bourse.duckdb'

STORE_DIR_VAR = boot_env.STORE_DIR
DEFAULT_STORE_DIR = boot_env.DEFAULT_STORE_DIR


class StoreUnavailable(Exception):
    """The store could not be opened, or could not be brought to its schema."""


_DDL_DECLARED = """
CREATE TABLE IF NOT EXISTS account (
    id         VARCHAR PRIMARY KEY,
    type       VARCHAR NOT NULL,        -- schemas.ACCOUNT_TYPES, or a legacy word
    label      VARCHAR NOT NULL);

CREATE TABLE IF NOT EXISTS symbol (symbol VARCHAR PRIMARY KEY);

CREATE TABLE IF NOT EXISTS event (
    id            BIGINT  PRIMARY KEY,
    date          DATE    NOT NULL,
    event_type    VARCHAR NOT NULL,
    account       VARCHAR NOT NULL REFERENCES account(id),
    symbol        VARCHAR REFERENCES symbol(symbol),  -- NULL on DEPOSIT/WITHDRAWAL
    name          VARCHAR,
    quantity      DOUBLE,
    unit_price    DOUBLE,      -- an amount in the reporting currency; optional on GRANT
    fee           DOUBLE,
    amount        DOUBLE,
    notes         VARCHAR);
"""

_DDL_DERIVED_FROM_EVENTS = """
CREATE TABLE IF NOT EXISTS position (
    account            VARCHAR NOT NULL REFERENCES account(id),
    symbol             VARCHAR NOT NULL REFERENCES symbol(symbol),
    name               VARCHAR,
    quantity           DOUBLE  NOT NULL,
    cost_basis         DOUBLE  NOT NULL,            -- an *amount*; the unit WAC is derived
    realized_gain      DOUBLE  NOT NULL,
    received_dividend  DOUBLE  NOT NULL,
    PRIMARY KEY (account, symbol));

CREATE TABLE IF NOT EXISTS account_state (
    account          VARCHAR PRIMARY KEY REFERENCES account(id),
    cash_balance     DOUBLE NOT NULL,
    net_contributed  DOUBLE NOT NULL);
"""

_DDL_DERIVED_FROM_MARKET = """
CREATE TABLE IF NOT EXISTS symbol_quote (
    symbol                VARCHAR PRIMARY KEY REFERENCES symbol(symbol),
    currency              VARCHAR,
    exchange              VARCHAR,
    quote_type            VARCHAR,
    dividend_yield        DOUBLE,
    pe_ratio              DOUBLE,
    market_cap            DOUBLE,
    fetched_at            TIMESTAMPTZ,
    last_price_native     DOUBLE,                   -- the `latest` row
    last_price_converted  DOUBLE,
    last_fx_rate          DOUBLE,
    last_price_ts         TIMESTAMPTZ,
    oldest_window_tried   DATE);                    -- the persisted backward-pass anchor
"""

_DDL_PRICE_POINT = """
CREATE TABLE IF NOT EXISTS price_point (
    symbol           VARCHAR     NOT NULL,
    ts               TIMESTAMPTZ NOT NULL,
    price_native     DOUBLE,
    price_converted  DOUBLE,                        -- NULL = transient, repaired later
    fx_rate          DOUBLE);
"""

_DDL_DERIVED_FROM_COMPUTATION = """
CREATE TABLE IF NOT EXISTS account_metrics (
    account          VARCHAR NOT NULL REFERENCES account(id),
    day              DATE    NOT NULL,
    cash_balance     DOUBLE, holdings_value DOUBLE, total_value DOUBLE,
    net_contributed  DOUBLE, xirr DOUBLE, gain_absolu DOUBLE, twr_index DOUBLE,
    PRIMARY KEY (account, day));

CREATE TABLE IF NOT EXISTS portfolio_totals (
    day              DATE PRIMARY KEY,
    cash_balance     DOUBLE, holdings_value DOUBLE, total_value DOUBLE,
    net_contributed  DOUBLE, xirr DOUBLE, gain_absolu DOUBLE, twr_index DOUBLE);
"""

_DDL_SETTINGS_AND_FACTS = """
CREATE TABLE IF NOT EXISTS setting (key VARCHAR PRIMARY KEY, value VARCHAR);

CREATE TABLE IF NOT EXISTS installation_fact (
    key              VARCHAR PRIMARY KEY,
    first_seen_at    TIMESTAMPTZ NOT NULL,
    acknowledged_at  TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS advisory_ack (
    key              VARCHAR PRIMARY KEY,
    acknowledged_at  TIMESTAMPTZ NOT NULL,
    expires_at       TIMESTAMPTZ NOT NULL);
"""

DDL = ''.join((
    _DDL_DECLARED,
    _DDL_DERIVED_FROM_EVENTS,
    _DDL_DERIVED_FROM_MARKET,
    _DDL_PRICE_POINT,
    _DDL_DERIVED_FROM_COMPUTATION,
    _DDL_SETTINGS_AND_FACTS,
))

TABLES = (
    'account', 'symbol', 'event',
    'position', 'account_state',
    'symbol_quote', 'price_point',
    'account_metrics', 'portfolio_totals',
    'setting', 'installation_fact', 'advisory_ack',
)

#: The tables whose surrogate key this store hands out — see
#: :meth:`Store.reserve`. ``event`` is the only one, and the tuple is what says
#: so: every other table is keyed by something the domain already names.
KEYED_TABLES = ('event',)

DEFAULT_ACCOUNT_ROW = ('default', 'OTHER', 'Default account')


class Store:
    """The open store: a DuckDB connection and the few gestures #696 needs."""

    def __init__(self, path: Path, connection: 'duckdb.DuckDBPyConnection'):
        self.path = path
        self._connection = connection
        self._lock = threading.RLock()
        #: The high-water mark per keyed table — memory, never a row
        #: (ADR-0027), and read **at the open**: seeded on first use instead,
        #: a row deleted before this store had written anything would seed the
        #: mark *below its own key* and hand it straight back — which is the
        #: defect, inside the very window the mark exists to hold.
        self._reserved: Dict[str, int] = {
            table: connection.execute(
                f'SELECT coalesce(max(id), 0) FROM {table}').fetchone()[0]
            for table in KEYED_TABLES}

    def reserve(self, table: str, count: int = 1) -> int:
        """The first of ``count`` fresh keys for ``table`` (ADR-0027, #785).

        **The one allocator, and it only ever climbs.** ``max(id) + 1`` handed
        the highest deleted row's key straight to the next writer, so a client
        holding a key it had just read could correct or delete *the row that
        took its place*. The mark is read from ``max(id)`` **when the store is
        opened** and never descends afterwards, which is what makes
        ``UnknownEntry`` mean what it says: a write aiming at a row that has
        gone is refused rather than landing on a stranger.

        **The guarantee is scoped to the life of the process.** The mark is
        memory: a restart re-seeds from ``max(id)`` and can reissue a key freed
        before it. A client holding a key across a restart is holding it across
        an app that went down, which is not the window this buys.

        It takes the store's own lock — reentrant, so its callers pay nothing —
        rather than trusting every caller to already hold one.
        """
        if table not in self._reserved:
            raise KeyError(f"{table!r} is not a table this store keys")
        if count < 1:
            raise ValueError(f"a range of {count} keys is not a range")
        with self._lock:
            mark = self._reserved[table]
            self._reserved[table] = mark + count
            return mark + 1

    def issued(self, table: str, key: int) -> bool:
        """Whether this store has ever handed ``key`` out for ``table``.

        The other half of :meth:`reserve`, and the reason a refusal can say
        *which* refusal it is: a key at or below the mark named a row once, and
        a key above it has never named anything. The bound is the mark's own —
        a store reopened has forgotten the keys it retired, so an old one reads
        as never issued, which is the window ADR-0027 declines to buy.
        """
        with self._lock:
            return 0 < key <= self._reserved.get(table, 0)

    @contextmanager
    def transaction(self):
        """``BEGIN`` … ``COMMIT``, with every other thread kept outside it."""
        with self._lock:
            self._connection.execute('BEGIN TRANSACTION')
            try:
                yield self
            except Exception:
                self._connection.execute('ROLLBACK')
                raise
            self._connection.execute('COMMIT')

    def execute(self, sql: str, parameters: Optional[Sequence[Any]] = None):
        """Run one statement. Errors propagate — this is not a read layer."""
        with self._lock:
            if parameters is None:
                return self._connection.execute(sql)
            return self._connection.execute(sql, list(parameters))

    def executemany(self, sql: str, rows: Sequence[Sequence[Any]]) -> None:
        """Run one statement over many parameter sets, in one round trip."""
        if not rows:
            return
        with self._lock:
            self._connection.executemany(sql, [list(row) for row in rows])

    def query(self, sql: str,
              parameters: Optional[Sequence[Any]] = None) -> List[tuple]:
        """Run one statement and materialise its rows as tuples."""
        with self._lock:
            if parameters is None:
                return self._connection.execute(sql).fetchall()
            return self._connection.execute(sql, list(parameters)).fetchall()

    def arrow(self, sql: str, parameters: Optional[Sequence[Any]] = None):
        """Run one statement and materialise its rows as an Arrow table."""
        with self._lock:
            if parameters is None:
                return self._connection.execute(sql).fetch_arrow_table()
            return self._connection.execute(
                sql, list(parameters)).fetch_arrow_table()

    def ping(self) -> None:
        """Touch the store, and raise if it cannot be touched."""
        self.query('SELECT count(*) FROM setting')

    def setting(self, key: str):
        """The value of a dial: the stored row, or the code's default."""
        rows = self.query('SELECT value FROM setting WHERE key = ?', [key])
        stored = rows[0][0] if rows else None
        return settings_registry.resolve(key, stored)

    def close(self) -> None:
        """Close the connection. Safe to call twice."""
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None


def finite(value):
    """A number on its way into — or out of — a ``DOUBLE`` column, or ``None``."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def store_path() -> Path:
    """Where the store file is, from the environment."""
    return boot_env.directory(
        os.environ, STORE_DIR_VAR, DEFAULT_STORE_DIR) / STORE_FILENAME


def file_size(path: Path) -> Optional[int]:
    """What this store occupies on disk, write-ahead log included."""
    total = 0
    seen = False
    for candidate in (path, path.with_name(path.name + '.wal')):
        try:
            total += candidate.stat().st_size
        except OSError:
            continue
        seen = True
    return total if seen else None


def prepare(connection: 'duckdb.DuckDBPyConnection') -> bool:
    """Bring an open connection to the current schema and seed it."""
    connection.execute("SET TimeZone='UTC'")

    existing = {
        row[0] for row in connection.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main'").fetchall()
    }
    is_new = 'account' not in existing

    connection.execute(DDL)

    if is_new:
        connection.execute(
            'INSERT INTO account (id, type, label) VALUES (?, ?, ?)',
            list(DEFAULT_ACCOUNT_ROW))

    for key, value in settings_registry.seeded_defaults().items():
        connection.execute(
            'INSERT INTO setting (key, value) VALUES (?, ?) '
            'ON CONFLICT (key) DO NOTHING', [key, value])

    return is_new


def open_store(path: Optional[Path] = None) -> Store:
    """Open the store, create it if it is not there, and return it ready to use."""
    target = Path(path) if path is not None else store_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        connection = duckdb.connect(str(target))
    except Exception as exc:
        raise StoreUnavailable(
            f"Cannot open the store at {target}: {exc}") from exc

    try:
        created = prepare(connection)
    except Exception as exc:
        connection.close()
        raise StoreUnavailable(
            f"The store at {target} could not be brought to its schema: {exc}"
        ) from exc

    if created:
        logger.info(f"Created a new store at {target} with {len(TABLES)} tables")
    else:
        logger.info(f"Opened the store at {target}")
    return Store(target, connection)


__all__ = [
    'Store', 'StoreUnavailable', 'open_store', 'prepare', 'store_path',
    'file_size', 'finite',
    'DDL', 'TABLES', 'KEYED_TABLES', 'STORE_FILENAME', 'STORE_DIR_VAR', 'DEFAULT_STORE_DIR',
    'DEFAULT_ACCOUNT_ROW',
]
