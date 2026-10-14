"""The store — one embedded DuckDB file, and the app does not boot without it."""
import math
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import duckdb
import pyarrow
from logfmt_logger import getLogger

from application import boot_env
from application import settings_registry
from application.incoming import INCOMING
from application.store_ddl import (
    DDL, DEFAULT_ACCOUNT_ROW, KEYED_TABLES, TABLES)
from application.store_steps import STEPS, apply_steps, rebuilding

logger = getLogger("store")

STORE_FILENAME = 'suivi-bourse.duckdb'

STORE_DIR_VAR = boot_env.STORE_DIR
DEFAULT_STORE_DIR = boot_env.DEFAULT_STORE_DIR


class StoreUnavailable(Exception):
    """The store could not be opened, or could not be brought to its schema."""


class Store:
    """The open store: a DuckDB connection and the few gestures #696 needs."""

    def __init__(self, path: Path, connection: 'duckdb.DuckDBPyConnection'):
        self.path = path
        self._connection = connection
        self._lock = threading.RLock()
        #: The high-water mark per keyed table — memory, never a row,
        #: and read **at the open**: seeded on first use instead,
        #: a row deleted before this store had written anything would seed the
        #: mark *below its own key* and hand it straight back — which is the
        #: defect, inside the very window the mark exists to hold.
        self._reserved: Dict[str, int] = {
            table: connection.execute(
                f'SELECT coalesce(max(id), 0) FROM {table}').fetchone()[0]
            for table in KEYED_TABLES}
        #: This thread's read view, and the views handed out so far — see
        #: :meth:`reader`. The list is what :meth:`close` gives back; it holds
        #: one entry per thread that has ever read, which is the server's
        #: worker pool and not a number that climbs with traffic.
        self._readers = threading.local()
        self._views: List['ReadView'] = []

    def reader(self) -> 'ReadView':
        """This thread's read view on the same database (#967).

        ``connection.cursor()`` is a **second connection** on the same database
        instance, so DuckDB's MVCC hands it a snapshot instead of making it wait
        behind the writers' transaction. Measured on a 40 k-row upsert with a
        reader polling every 20 ms: on the writer's connection 3 reads landed,
        the worst at 39.6 s; on a cursor, 771 landed, the worst at 0.8 ms.

        **One cursor per thread, because a connection is not thread-safe.** A
        single shared reader connection would be the serialisation point this
        removes, moved rather than gone.

        Creating the cursor takes the store's lock, so the *first* read on a
        thread can still wait for a write in flight — once per thread, against
        every read today. Reaching into the connection while another thread is
        executing on it is the thing not worth saving that from.
        """
        view = getattr(self._readers, 'view', None)
        # ``closed`` in the condition and not around it: a thread holding a view
        # from before the shutdown falls through to ``_live()``, so asking for a
        # reader on a closed store is refused by name here too (#858).
        if view is not None and not self.closed:
            return view
        with self._lock:
            cursor = self._live().cursor()
            # The zone is a *session* setting and a cursor is a session of its
            # own: without this it reads bare literals in the host's zone,
            # which is the failure ``test_the_connection_speaks_utc…`` pins.
            cursor.execute("SET TimeZone='UTC'")
            view = ReadView(self, cursor)
            self._views.append(view)
        self._readers.view = view
        return view

    def reserve(self, table: str, count: int = 1) -> int:
        """The first of ``count`` fresh keys for ``table`` (#785).

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
        a key above it has never named anything.
        """
        with self._lock:
            return 0 < key <= self._reserved.get(table, 0)

    @property
    def closed(self) -> bool:
        """Whether :meth:`close` has already given the connection back."""
        return self._connection is None

    def _live(self):
        """The connection, or the refusal a closed store owes its callers (#858).

        The shutdown closes the store while jobs are still in flight —
        ``scheduler.shutdown(wait=False)`` does not interrupt them — so a read
        or a write arriving late is the ordinary case, not a defect. It gets a
        named error, the one the blueprint already answers ``503`` to, instead
        of ``'NoneType' object has no attribute 'execute'``.
        """
        if self._connection is None:
            raise StoreUnavailable(f"The store at {self.path} is closed")
        return self._connection

    @contextmanager
    def transaction(self):
        """``BEGIN`` … ``COMMIT``, with every other thread kept outside it."""
        with self._lock:
            connection = self._live()
            connection.execute('BEGIN TRANSACTION')
            try:
                yield self
            except Exception:
                connection.execute('ROLLBACK')
                raise
            connection.execute('COMMIT')

    def execute(self, sql: str, parameters: Optional[Sequence[Any]] = None):
        """Run one statement. Errors propagate — this is not a read layer."""
        with self._lock:
            if parameters is None:
                return self._live().execute(sql)
            return self._live().execute(sql, list(parameters))

    def executemany(self, sql: str, rows: Sequence[Sequence[Any]]) -> None:
        """Run one statement over many parameter sets — **one per row**.

        It reads like a block write and is not one: DuckDB executes the
        prepared statement once per parameter set, which #972 measured at
        0.741 ms a row upserting into a table with a primary key. For a block
        of rows that is a loop with a round trip in it — :meth:`write_arrow`
        is the one statement.
        """
        if not rows:
            return
        with self._lock:
            self._live().executemany(sql, [list(row) for row in rows])

    def query(self, sql: str,
              parameters: Optional[Sequence[Any]] = None) -> List[tuple]:
        """Run one statement and materialise its rows as tuples."""
        with self._lock:
            if parameters is None:
                return self._live().execute(sql).fetchall()
            return self._live().execute(sql, list(parameters)).fetchall()

    def arrow(self, sql: str, parameters: Optional[Sequence[Any]] = None):
        """Run one statement and materialise its rows as an Arrow table."""
        with self._lock:
            if parameters is None:
                return self._live().execute(sql).fetch_arrow_table()
            return self._live().execute(
                sql, list(parameters)).fetch_arrow_table()

    def write_arrow(self, sql: str, columns: Sequence[str],
                    rows: Sequence[Sequence[Any]],
                    parameters: Optional[Sequence[Any]] = None) -> None:
        """Run one statement over ``rows`` bound as ``incoming`` (#972).

        The other direction of :meth:`arrow`, and the frontier is the same one
        ``pyarrow`` was taken on: a block of rows crosses into DuckDB **once**,
        as columns, instead of once per row. :meth:`executemany` hands the
        connection one prepared statement per row — measured at 0.741 ms a row
        upserting into a table with a primary key, 0.156 ms inserting into one,
        and 0.132 ms deleting from one by key. The same blocks cross here in
        constant time, so the gain grows with the block: ×100 at 20 000 rows,
        ×218 at 50 000.

        It **builds** the table rather than taking one, because five callers in
        three modules would otherwise each spell the same transpose and each
        need the same guard against an empty block. The types are inferred: the
        cast belongs to the column's own declaration, and that is here, in the
        DDL above. An instant carries its zone through Arrow, which is what a
        bare literal does not do (#696).

        The bound name is fixed rather than chosen by the caller: whoever chose
        it would be choosing an identifier the SQL beside it has to spell the
        same way. ``parameters`` is for the rest of the statement — the values
        that are not part of the block, like the symbol an ``UPDATE`` narrows
        to. The registration is undone in a ``finally``, so a failed statement
        leaves no view standing on a buffer nothing holds any more.
        """
        if not rows:
            return
        incoming = pyarrow.table(dict(zip(columns, zip(*rows))))
        with self._lock:
            connection = self._live()
            connection.register(INCOMING, incoming)
            try:
                if parameters is None:
                    connection.execute(sql)
                else:
                    connection.execute(sql, list(parameters))
            finally:
                connection.unregister(INCOMING)

    def ping(self) -> None:
        """Touch the store, and raise if it cannot be touched."""
        self.query('SELECT count(*) FROM setting')

    def setting(self, key: str):
        """The value of a dial: the stored row, or the code's default."""
        rows = self.query('SELECT value FROM setting WHERE key = ?', [key])
        stored = rows[0][0] if rows else None
        return settings_registry.resolve(key, stored)

    def close(self) -> None:
        """Close the connection, readers included. Safe to call twice."""
        with self._lock:
            for view in self._views:
                with view._lock:
                    view._connection.close()
                    view._connection = None
            self._views = []
            if self._connection is not None:
                self._connection.close()
                self._connection = None


class ReadView(Store):
    """A read path's own connection on the store's database (#967).

    Every read gesture is :class:`Store`'s, unchanged; the connection under it
    is the whole difference. It is handed out by :meth:`Store.reader` and
    belongs to **the API read path only**: a cursor is its own transaction, so
    it sees committed rows and not the ones the thread inside
    ``ConfigurationManager.writing()`` has yet to commit. A job that reads what
    it is about to write must stay on :meth:`Store.query`.
    """

    def __init__(self, owner: Store, connection):
        self.path = owner.path
        self._owner = owner
        self._connection = connection
        self._lock = threading.RLock()   # this thread's alone, never contended
        self._reserved: Dict[str, int] = {}   # keys are the writer's to issue
        self._readers = threading.local()
        self._views: List['ReadView'] = []

    @property
    def closed(self) -> bool:
        """Closed when the store it reads is — one shutdown, one answer."""
        return self._owner.closed

    def _live(self):
        """The cursor, or the refusal a closed store owes its readers (#858)."""
        if self._owner.closed:
            raise StoreUnavailable(f"The store at {self.path} is closed")
        return super()._live()

    def reader(self) -> 'ReadView':
        """Itself: a read view of a read view is the same connection."""
        return self

    def transaction(self):
        """Refused. A write here would land outside the writers' mutex."""
        raise StoreUnavailable(
            f"The read view on {self.path} does not write")

    def execute(self, sql: str, parameters: Optional[Sequence[Any]] = None):
        """Refuse a write-capable statement on the read connection."""
        raise StoreUnavailable(
            f"The read view on {self.path} does not write")

    def executemany(self, sql: str, rows: Sequence[Sequence[Any]]) -> None:
        """Refuse batched statements on the read connection."""
        raise StoreUnavailable(
            f"The read view on {self.path} does not write")

    def write_arrow(self, sql: str, columns: Sequence[str],
                    rows: Sequence[Sequence[Any]],
                    parameters: Optional[Sequence[Any]] = None) -> None:
        """Refuse a block write here too — it is a write like any other."""
        raise StoreUnavailable(
            f"The read view on {self.path} does not write")


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


def prepare(connection: 'duckdb.DuckDBPyConnection', steps=None) -> bool:
    """Bring an open connection to the current schema and seed it.

    ``steps`` defaults to the store's own :data:`STEPS`, read at the call.
    """
    connection.execute("SET TimeZone='UTC'")

    existing = {
        row[0] for row in connection.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main'").fetchall()
    }
    is_new = 'account' not in existing

    connection.execute(DDL)

    # Right after the DDL and before anything is seeded (#926): the DDL is what
    # declares ``schema_step``, and what a step rebuilds must not be holding a
    # row this boot has just put there.
    ran = apply_steps(connection, STEPS if steps is None else steps)
    if ran and not is_new:
        # Said out loud only where it *did* something. A new file walks the
        # same list and records the same marks, but nothing was brought
        # forward and a line claiming so would be a line to chase.
        logger.info(f"Brought the store forward: {', '.join(ran)}")

    if is_new:
        connection.execute(
            'INSERT INTO account (id, label) VALUES (?, ?)',
            list(DEFAULT_ACCOUNT_ROW))

    for key, value in settings_registry.seeded_defaults().items():
        connection.execute(
            'INSERT INTO setting (key, value) VALUES (?, ?) '
            'ON CONFLICT (key) DO NOTHING', [key, value])

    return is_new


def open_store(path: Optional[Path] = None, steps=None) -> Store:
    """Open the store, create it if it is not there, and return it ready to use.

    The app passes its complete list of ``steps``; without one, the store walks
    only its own (see :func:`prepare`).
    """
    target = Path(path) if path is not None else store_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        connection = duckdb.connect(str(target))
    except Exception as exc:
        raise StoreUnavailable(
            f"Cannot open the store at {target}: {exc}") from exc

    try:
        created = prepare(connection, steps)
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
    'Store', 'ReadView', 'StoreUnavailable', 'open_store', 'prepare', 'store_path',
    'file_size', 'finite',
    'DDL', 'TABLES', 'KEYED_TABLES', 'STORE_FILENAME', 'STORE_DIR_VAR', 'DEFAULT_STORE_DIR',
    'DEFAULT_ACCOUNT_ROW', 'STEPS', 'apply_steps', 'rebuilding',
]
