"""The store — one embedded DuckDB file, and the app does not boot without it."""
import math
import os
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import duckdb
import pyarrow
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
    label      VARCHAR NOT NULL);

CREATE TABLE IF NOT EXISTS symbol (symbol VARCHAR PRIMARY KEY);

-- The owner's own taxation models (#752). Reusable across accounts,
-- so they have an identity of their own rather than living on the account.
-- `parameters` is **one JSON value in one column** and not a column per field,
-- which is what makes a kind added in version n+1 an addition rather than a
-- schema step to write.
CREATE TABLE IF NOT EXISTS taxation_model (
    id          VARCHAR PRIMARY KEY,
    name        VARCHAR NOT NULL,
    kind        VARCHAR NOT NULL,                    -- one of taxation.KINDS
    parameters  VARCHAR NOT NULL);                   -- the kind's own, as JSON

-- What its owner declares **about an account** and no computation can produce
-- (#752). Keyed by the account, one writer, and an **absent row is an
-- absence**: no model declared is not a model of nothing.
CREATE TABLE IF NOT EXISTS account_fact (
    account         VARCHAR PRIMARY KEY REFERENCES account(id),
    taxation_model  VARCHAR REFERENCES taxation_model(id),
    opened_on       DATE);                           -- declared by #918

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
    sector                VARCHAR,                   -- what it does (#964)
    industry              VARCHAR,
    country               VARCHAR,                   -- *not* Yahoo's `region`
    fetched_at            TIMESTAMPTZ,
    last_price_native     DOUBLE,                   -- the `latest` row
    last_price_converted  DOUBLE,
    last_fx_rate          DOUBLE,
    last_price_ts         TIMESTAMPTZ,
    oldest_window_tried   DATE,                     -- the persisted backward-pass anchor
    newest_window_tried   DATE,                     -- and the forward pass's own (#854)
    splits_read_at        TIMESTAMPTZ);             -- when the split history was last read (#760)
"""

_DDL_PRICE_POINT = """
CREATE TABLE IF NOT EXISTS price_point (
    symbol           VARCHAR     NOT NULL,
    ts               TIMESTAMPTZ NOT NULL,
    price_native     DOUBLE,
    price_converted  DOUBLE,                        -- NULL = transient, repaired later
    fx_rate          DOUBLE);

-- The ratios ``price_point`` no longer carries (#760). #988 put every close
-- back in the share the market printed it in, which is what the ledger's
-- quantities are in -- and that correction consumes the split factors and
-- throws them away. Anything counting **units** across a split still needs
-- them: the counterfactual replay buys shares of a reference and holds them
-- for years, so a 1-for-4 it cannot see divides its holding by four in
-- silence. Written where they are already read, as a whole history per
-- symbol: a partial one is worse than none.
CREATE TABLE IF NOT EXISTS symbol_split (
    symbol  VARCHAR NOT NULL,
    day     DATE    NOT NULL,
    ratio   DOUBLE  NOT NULL,
    PRIMARY KEY (symbol, day));
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

-- **What generation this store is** (#926). One row per applied step,
-- and the *absence* of a row is the first generation: every store in the wild
-- predates this table, so no mark is the mark. Created by the DDL like any
-- other table, which is what lets :func:`apply_steps` ask the question a line
-- later on a file that had never heard of it.
CREATE TABLE IF NOT EXISTS schema_step (
    step        VARCHAR PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL);
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
    'account', 'symbol', 'event', 'taxation_model', 'account_fact',
    'position', 'account_state',
    'symbol_quote', 'price_point', 'symbol_split',
    'account_metrics', 'portfolio_totals',
    'setting', 'installation_fact', 'advisory_ack', 'schema_step',
)

#: The tables whose surrogate key this store hands out — see
#: :meth:`Store.reserve`. ``event`` is the only one, and the tuple is what says
#: so: every other table is keyed by something the domain already names.
KEYED_TABLES = ('event',)

DEFAULT_ACCOUNT_ROW = ('default', 'Default account')

#: The name :meth:`Store.write_arrow` binds its Arrow table under, and therefore
#: the name the statement handed to it reads ``FROM``.
INCOMING = 'incoming'


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


# --------------------------------------------------------------------------- #
# The steps: how this store moves from one generation to the next
# --------------------------------------------------------------------------- #

@contextmanager
def rebuilding(connection, table: str):
    """Make ``table`` alterable, run the caller's ``ALTER``, put it back.

    **The one gesture a schema step cannot avoid**. DuckDB refuses to
    alter a table another one references, and almost every table worth altering
    here is referenced by something. So the tables holding a foreign key on
    ``table`` are copied aside and dropped, the caller does its work, the DDL
    declares them again with their keys, and the rows go back::

        with rebuilding(connection, 'account'):
            connection.execute('ALTER TABLE account DROP COLUMN type')

    **Who depends on what is asked of the catalogue, never listed here.** A
    hand-written list is a list that is right until the next table is declared,
    and it would be wrong on exactly the stores a step runs on — old ones, opened
    once, by an app whose CI only ever exercises fresh files where every step is
    a no-op.

    Two things this does that its three lines do not show:

    - **The copies are real tables and not ``CREATE TEMP``.** This runs inside
      the step's transaction, and a temporary table lives outside it — the
      rollback that makes a step atomic would leave the store without its ledger
      and the copy still holding it.
    - **The rows go back by shared column name, never by position.** A store old
      enough carries columns today's DDL does not declare (``event.source_id``
      and its two neighbours, #816's residue), so the copy is wider than the
      table it feeds. Those columns do not survive: a table recreated from the
      DDL is the DDL's table. It is the price of the reconstruction the foreign
      keys impose, and the first thing to check when a step lands — what is swept
      up here is residue nothing reads, and it must stay that.
    """
    dependents = [name for name, in connection.execute(
        "SELECT DISTINCT table_name FROM duckdb_constraints() "
        "WHERE referenced_table = ? AND constraint_type = 'FOREIGN KEY' "
        "ORDER BY table_name", [table]).fetchall()]

    for dependent in dependents:
        connection.execute(
            f'CREATE TABLE _step_{dependent} AS SELECT * FROM {dependent}')
        connection.execute(f'DROP TABLE {dependent}')

    yield

    connection.execute(DDL)

    for dependent in dependents:
        shared = ', '.join(name for name, in connection.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = ? AND column_name IN "
            "  (SELECT column_name FROM information_schema.columns "
            "   WHERE table_name = ?) ORDER BY ordinal_position",
            [dependent, f'_step_{dependent}']).fetchall())
        connection.execute(f'INSERT INTO {dependent} ({shared}) '
                           f'SELECT {shared} FROM _step_{dependent}')
        connection.execute(f'DROP TABLE _step_{dependent}')


def _drop_account_type(connection) -> None:
    """Drop ``account.type`` — the first step, and deliberately the smallest.

    #916 left the column written by the app and read by nobody, so this step has
    no reader to break: it proves the mechanism before anything that matters is
    handed to it.

    The derived tables :func:`rebuilding` carries across are carried rather than
    left to rebuild. They would come back on the next replay, and between the
    boot and that replay the owner would read an empty product — a schema step is
    not a thing anybody should notice.

    ``IF EXISTS`` is what makes it a no-op on a file created today, and there is
    no Python guard beside it: a step runs once per store either way, and the
    reconstruction it skips there is five empty tables.
    """
    with rebuilding(connection, 'account'):
        connection.execute('ALTER TABLE account DROP COLUMN IF EXISTS type')


def _add_newest_window_tried(connection) -> None:
    """Give an already-created store the forward pass's anchor (issue #854).

    ``CREATE TABLE IF NOT EXISTS`` does not reach a table it finds, so the new
    column reaches a **new** file and no other — and CI only ever creates new
    files, where the DDL is the whole schema. Without this step every store in
    circulation opens cleanly and then raises a Binder Error on the first
    forward pass, which is the failure no test could have caught.

    No :func:`rebuilding`: nothing holds a foreign key on ``symbol_quote``, and
    an added column has none of the dependency cost a dropped one has.
    """
    connection.execute('ALTER TABLE symbol_quote '
                       'ADD COLUMN IF NOT EXISTS newest_window_tried DATE')


def _add_symbol_classification(connection) -> None:
    """Give an already-created store what an instrument *is* (issue #964).

    Same shape as :func:`_add_newest_window_tried` and for the same reason:
    ``CREATE TABLE IF NOT EXISTS`` does not reach a table it finds, so the three
    columns added to the DDL reach a **new** file and no other — and CI only
    ever creates new files, where the DDL is the whole schema. Without this step
    every store in circulation opens cleanly and then raises a Binder Error on
    the first read of a quote, which is the failure no test could have caught.

    No :func:`rebuilding`: nothing holds a foreign key on ``symbol_quote``, and
    an added column has none of the dependency cost a dropped one has.
    """
    for column in ('sector', 'industry', 'country'):
        connection.execute(f'ALTER TABLE symbol_quote '
                           f'ADD COLUMN IF NOT EXISTS {column} VARCHAR')


def _add_splits_read_at(connection) -> None:
    """Give an already-created store the mark that says its splits were read (#760).

    Same shape as :func:`_add_newest_window_tried`, and needed for a reason the
    new ``symbol_split`` table did not have: a table the DDL creates reaches
    every store on the next boot, but **an empty split history is ambiguous**.
    Most symbols have never split, so zero rows is the ordinary correct answer
    — and it is also what a store that predates this release holds for every
    symbol it has already fetched. Told apart by nothing, a replay counting
    units would walk straight through a split it cannot see and divide the
    holding by the ratio, silently.

    So the *reading* is recorded rather than inferred from the rows. Absent
    means never asked; present means Yahoo answered, empty or not.

    No :func:`rebuilding`: nothing holds a foreign key on ``symbol_quote``, and
    an added column has none of the dependency cost a dropped one has.
    """
    connection.execute('ALTER TABLE symbol_quote '
                       'ADD COLUMN IF NOT EXISTS splits_read_at TIMESTAMPTZ')


def _drop_split_adjusted_prices(connection) -> None:
    """Throw away a series stored in two shares at once (issue #987).

    Every point written before this release carries the close Yahoo served, and
    Yahoo serves them split-adjusted to today's share while the ledger holds the
    quantity as traded on the day. The two are multiplied together, so a line
    bought before a split was valued at a multiple of what it was worth for the
    whole of its pre-split history — and the store is *mixed*, because a point
    written on the day it happened was in that day's share and a point backfilled
    after a split was not. Nothing in the row says which, so the series cannot be
    corrected in place; it can only be bought again.

    Which is what the anchors are for. The backward pass resumes from the oldest
    point it can see, so deleting the series alone would leave it where it stood:
    both anchors go back to ``NULL`` and the three passes rebuild what they had,
    in printed shares this time, one chunk per symbol per cycle. What the owner
    sees in the meantime is a shorter curve, not a wrong one — and
    ``symbol_quote`` keeps the latest price, which is the one figure no split can
    have moved.

    The two derived series go with it. They are rewritten whole on the first
    perf cycle and pruned to what that cycle could compute, so keeping them would
    buy nothing but a window — one that lasts until the boot's rebuild lands, and
    for as long as this store stands if that rebuild fails.

    A no-op on a file created today, where all four tables are empty.
    """
    connection.execute('DELETE FROM price_point')
    connection.execute('UPDATE symbol_quote '
                       '   SET oldest_window_tried = NULL, '
                       '       newest_window_tried = NULL')
    connection.execute('DELETE FROM account_metrics')
    connection.execute('DELETE FROM portfolio_totals')


#: The schema steps, oldest first (#926). A step is what the ``IF NOT EXISTS``
#: DDL cannot express — dropping a column, renaming one, **adding one to a table
#: that already exists** (the DDL only builds a table it does not find) — and
#: the list is append-only in both directions: **a name is an identity forever**
#: (renaming one runs it a second time) and a step already released is never
#: edited, because the stores that ran it will not run it again.
#:
#: Every step is written to be a **no-op on a store that does not need it**, so
#: a file created today walks the same list, changes nothing and records the
#: same generation as one brought forward. There is one generation, not two.
#:
#: Forward only. This app has one writer and no fleet, and a downgrade is a
#: promise nobody can keep about data a newer version wrote.
STEPS = (
    ('drop_account_type', _drop_account_type),
    ('add_newest_window_tried', _add_newest_window_tried),
    ('add_symbol_classification', _add_symbol_classification),
    ('drop_split_adjusted_prices', _drop_split_adjusted_prices),
    ('add_splits_read_at', _add_splits_read_at),
)


def apply_steps(connection) -> List[str]:
    """Run the steps this store has not run, and name the ones that ran.

    Each step gets **its own transaction, with its own mark inside it**, so the
    schema and the record of it move together: a step that raises rolls both
    back and the store is exactly what it was, down to the mark. The failure
    then propagates — :func:`open_store` turns it into ``StoreUnavailable``,
    because a store the app could not bring forward is a store it must not
    serve from.
    """
    applied = {row[0] for row in connection.execute(
        'SELECT step FROM schema_step').fetchall()}

    ran = []
    for name, step in STEPS:
        if name in applied:
            continue
        connection.execute('BEGIN TRANSACTION')
        try:
            step(connection)
            connection.execute(
                'INSERT INTO schema_step (step, applied_at) VALUES (?, ?)',
                [name, datetime.now(timezone.utc)])
        except Exception:
            connection.execute('ROLLBACK')
            raise
        connection.execute('COMMIT')
        ran.append(name)
    return ran


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

    # Right after the DDL and before anything is seeded (#926): the DDL is what
    # declares ``schema_step``, and what a step rebuilds must not be holding a
    # row this boot has just put there.
    ran = apply_steps(connection)
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
    'Store', 'ReadView', 'StoreUnavailable', 'open_store', 'prepare', 'store_path',
    'file_size', 'finite',
    'DDL', 'TABLES', 'KEYED_TABLES', 'STORE_FILENAME', 'STORE_DIR_VAR', 'DEFAULT_STORE_DIR',
    'DEFAULT_ACCOUNT_ROW', 'STEPS', 'apply_steps', 'rebuilding',
]
