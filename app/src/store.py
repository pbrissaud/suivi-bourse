"""The store — one embedded DuckDB file, and the app does not boot without it.

Issue #696, spec #695, ADR-0001 / ADR-0007 / ADR-0014.

v5 replaces InfluxDB *and* the configuration files with a single embedded store.
This module owns the file: the connection, the DDL of the twelve tables, and the
seed. Nothing reads or writes rows through it yet — the jobs and the API arrive
in the tickets that follow — but every one of them branches off what is here.

Three things about it are decisions rather than defaults.

**The DDL is declared once, as text, and applied with ``IF NOT EXISTS``.** There
is no migration machinery and there will not be one for a dial: the settings
table is completed at every boot by an idempotent insert (see :func:`prepare`),
which is exactly what ADR-0014 buys by keeping the registry in code.

**``price_point`` carries no primary key and no foreign key** while the other
eleven tables keep theirs. This is the one asymmetry in the schema, so it is
written where a contributor meets it — next to the table, in
:data:`_DDL_PRICE_POINT` — and not only in the ADR.

**The connection does not cross ``fork()``.** ``build_runtime`` opens the store
in the gunicorn master, which is what turns an unreadable file into a single
named exit before the arbiter has anything to respawn; it then **closes** it,
and the worker opens its own in ``post_fork``. Keeping the master's connection
open would leave the same file locked by the parent while the child tried to
use buffers it no longer owns — and DuckDB refuses a second process precisely
because that is not survivable.
"""
import math
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, List, Optional, Sequence

import duckdb
from logfmt_logger import getLogger

import boot_env
import settings_registry

logger = getLogger("store")

#: The file inside the store directory. One file: a backup is a file copy
#: (user story 3), and there is nothing else to remember to take with it.
STORE_FILENAME = 'suivi-bourse.duckdb'

#: Where the store lives when nothing says otherwise. ADR-0015 gives the store
#: its own boot variable — it is one of the handful of things the environment
#: still configures, because the process must know it *before* it can open the
#: store and ask the store anything. The name and the default are
#: :mod:`boot_env`'s since #740, which is where the four of them are said once;
#: these two aliases stay because the store is where a reader looks for them.
STORE_DIR_VAR = boot_env.STORE_DIR
DEFAULT_STORE_DIR = boot_env.DEFAULT_STORE_DIR


class StoreUnavailable(Exception):
    """The store could not be opened, or could not be brought to its schema.

    Its own class because its handling is its own: in the master this is the
    named exit (:func:`main.log_fatal`), and nothing downstream is allowed to
    treat it as "empty portfolio".
    """


# --------------------------------------------------------------------------- #
# The DDL — spec #695 § Le DDL, which is authoritative
# --------------------------------------------------------------------------- #
#
# The rule that generates it: **declaration and derived state never share a
# row**, so every row has exactly one writer. The four groups below are those
# writers, in order: the configuration path, the ingestion (replay of events),
# the scrape/backfill, and the performance job.
#
# Two types of time and never a third: ``TIMESTAMPTZ``, always UTC, for an
# **observed instant**; ``DATE`` for a **calendar day**. The single seam is the
# perf job filing an instant under a UTC day, and it is written once, in the
# pure module. A Sydney close therefore lands on the previous UTC day, which is
# an accepted consequence rather than an oversight.

_DDL_DECLARED = """
CREATE TABLE IF NOT EXISTS account (
    id         VARCHAR PRIMARY KEY,
    type       VARCHAR NOT NULL,                    -- PEA | CTO | …
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

#: The one table with no key of any kind, and the reason is measured rather than
#: stylistic (ADR-0007). A DuckDB ART index is a *second copy of the data* whose
#: buffers are **not** managed by the buffer manager: they are resident memory,
#: not disk. A primary key here costs +563 MB on a 319 MB base, a foreign key
#: +153 MB more, an integer surrogate key saves nothing (the cost follows row
#: count, not key width), and the rebuild goes 15× slower (18 s against 1,2).
#:
#: Uniqueness moves to the writers instead — the backfill deletes its range then
#: inserts it, the live writer appends and never rewrites its own timestamp, and
#: timestamps stay truncated to the second so re-running one cycle is idempotent.
#: The integrity an index would have bought is bought for free elsewhere: this is
#: the only table no human-written file feeds, so a typo'd ticker is refused on
#: the event row, where it enters.
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

_DDL_SETTINGS_AND_ADVISORIES = """
CREATE TABLE IF NOT EXISTS setting (key VARCHAR PRIMARY KEY, value VARCHAR);

CREATE TABLE IF NOT EXISTS advisory (
    key              VARCHAR PRIMARY KEY,
    first_seen_at    TIMESTAMPTZ NOT NULL,
    acknowledged_at  TIMESTAMPTZ);
"""

DDL = ''.join((
    _DDL_DECLARED,
    _DDL_DERIVED_FROM_EVENTS,
    _DDL_DERIVED_FROM_MARKET,
    _DDL_PRICE_POINT,
    _DDL_DERIVED_FROM_COMPUTATION,
    _DDL_SETTINGS_AND_ADVISORIES,
))

#: Every table the DDL creates, so a caller can assert the shape without parsing
#: SQL. Eleven, and the count is meaningful: it is the whole product. It was
#: twelve while a file was a *mounted truth* that had to be named to be revoked;
#: an uploaded file is a payload, dead the instant it is parsed, so there is no
#: ``import_source`` left to declare (ADR-0032).
TABLES = (
    'account', 'symbol', 'event',
    'position', 'account_state',
    'symbol_quote', 'price_point',
    'account_metrics', 'portfolio_totals',
    'setting', 'advisory',
)

#: The account every event falls into until one is declared (ADR-0008: an empty
#: ``account`` column means ``default``, which is what lets a single-account v4's
#: files import without a single edit). Seeded **at creation only**, and never
#: removed either. There is always at least one account (ADR-0013), which is what
#: lets nothing in the app branch on "are accounts declared" — so the seed
#: happens once and the row then has no way of disappearing that would need it to
#: happen twice.
#:
#: Both strings here are **documentation, not display**. ``label`` and ``type``
#: are ``NOT NULL``, so this row cannot decline to name itself, and it is the one
#: row *every* install owns — the default setup and the headless one alike. A
#: value seeded once into a file can never follow the reader's language, so the
#: interface renders this pair from its own catalogue whenever ``id`` is
#: ``default`` (#745) and never reads what is stored. What is stored is what a
#: person dumping the database should see, which is why it is English like the
#: rest of the code: seeding ``Compte par défaut`` — as spec #695 first wrote it
#: — put a French noun in the English interface, the exact fault ADR-0024 exists
#: against.
DEFAULT_ACCOUNT_ROW = ('default', 'OTHER', 'Default account')


class Store:
    """The open store: a DuckDB connection and the few gestures #696 needs.

    Deliberately thin. It is not a repository and it does not know the domain —
    the read primitives and the writers are their own modules, each owning its
    half of the error contract. What lives here is what belongs to the *file*:
    opening it, bringing it to the schema, seeding it, and closing it.
    """

    def __init__(self, path: Path, connection: 'duckdb.DuckDBPyConnection'):
        self.path = path
        self._connection = connection
        # **One thread inside this connection at a time** (issue #700), for two
        # reasons that arrive together and that a single reentrant lock answers.
        #
        # A DuckDB connection carries **one** pending result: ``execute`` stores
        # it on the connection and ``fetchall`` collects it, so two threads
        # calling the pair concurrently can have the second's ``execute`` replace
        # the first's result before it is fetched — silently handing thread A
        # thread B's rows.
        #
        # And a transaction on one connection is **visible to every thread using
        # it**. A reader landing between another thread's ``DELETE`` and its
        # ``INSERT`` reads the hole: a backward chunk rewriting a year of
        # ``price_point`` would make a chart lose that year for the length of the
        # write, and the perf job would compute ``holdings_value`` from a
        # half-deleted series and *persist* the wrong daily total. In v4 the
        # readers were a second process against another database, so the problem
        # had no expression; it appears the moment one embedded store holds both
        # halves.
        #
        # Hence: every statement takes this lock, and :meth:`transaction` holds
        # it from ``BEGIN`` to ``COMMIT``. **Reentrant**, so a writer's own
        # statements pass straight through the transaction it is inside. It is
        # not the writers' mutex — :meth:`main.ConfigurationManager.writing`
        # groups gestures that span several statements *without* a transaction —
        # and the two are always taken in that order, so they cannot cycle.
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ #
    # Execution
    # ------------------------------------------------------------------ #

    # There is deliberately no accessor for the raw connection. It existed for
    # "the modules that own a write path", and :meth:`transaction` is what they
    # own now — a handle that bypassed the lock would be a way to reintroduce
    # exactly the two defects the lock exists against, on the one object where
    # they are invisible until production.

    @contextmanager
    def transaction(self):
        """``BEGIN`` … ``COMMIT``, with every other thread kept outside it.

        The one way to open a transaction on this store, and the reason it is a
        context manager rather than three ``execute`` calls: the lock has to be
        held across the whole of it. A reader that slipped in between a
        ``DELETE`` and its ``INSERT`` would read the hole — and, in the perf
        job's case, write a daily total computed from it.

        Rolls back and re-raises on any exception, so a failed write leaves the
        previous state whole.
        """
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
        """Run one statement over many parameter sets, in one round trip.

        The block form matters where it is used (issue #700, ADR-0011): the same
        insert of a few thousand rows is milliseconds in one call and does not
        finish in two minutes row by row.
        """
        if not rows:
            return
        with self._lock:
            self._connection.executemany(sql, [list(row) for row in rows])

    def query(self, sql: str,
              parameters: Optional[Sequence[Any]] = None) -> List[tuple]:
        """Run one statement and materialise its rows as tuples.

        For a handful of rows. A **wide** read goes through :meth:`arrow`
        instead — see the note there.
        """
        with self._lock:
            if parameters is None:
                return self._connection.execute(sql).fetchall()
            return self._connection.execute(sql, list(parameters)).fetchall()

    def arrow(self, sql: str, parameters: Optional[Sequence[Any]] = None):
        """Run one statement and materialise its rows as an Arrow table.

        The frontier a wide read crosses (issue #700, spec #695 § 1). Building
        Python tuples out of a ``TIMESTAMPTZ`` column costs **8×** what Arrow
        costs — 382 ms against 47 for 254 280 points in rows, 2,4 against 2,9 ms
        in Arrow — because every instant becomes an individual ``datetime``
        object on the way out. Arrow hands back columns; the caller turns the
        ones it needs into lists in one vectorised call.

        It is a constraint on the read primitives, not a revision of the column
        type: ``TIMESTAMPTZ`` is still what an observed instant is stored as.
        """
        with self._lock:
            if parameters is None:
                return self._connection.execute(sql).fetch_arrow_table()
            return self._connection.execute(
                sql, list(parameters)).fetch_arrow_table()

    def ping(self) -> None:
        """Touch the store, and raise if it cannot be touched.

        What ``/health`` runs. It is a *read of a table the schema declares*
        rather than ``SELECT 1``: a connection object can answer a constant long
        after the file behind it has become unreadable, and a healthcheck that
        stays green through that is the blind spot the probe exists to close.
        """
        self.query('SELECT count(*) FROM setting')

    # ------------------------------------------------------------------ #
    # Shape and content
    # ------------------------------------------------------------------ #

    def table_names(self) -> List[str]:
        """The tables this file actually carries, sorted."""
        rows = self.query(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main' ORDER BY table_name")
        return [row[0] for row in rows]

    def setting(self, key: str):
        """The value of a dial: the stored row, or the code's default.

        The direction is the point (ADR-0014). The table is asked first because
        it is where a human's answer lands, but an absent — or blank — row is not
        a hole to report, it is the registry's value. There is exactly one place
        that says what a setting is worth, and the table is its mirror.
        """
        rows = self.query('SELECT value FROM setting WHERE key = ?', [key])
        stored = rows[0][0] if rows else None
        return settings_registry.resolve(key, stored)

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #

    def close(self) -> None:
        """Close the connection. Safe to call twice.

        **Under the lock**, like every other touch of the connection (issue
        #700). ``shutdown_runtime`` stops the scheduler with ``wait=False`` — a
        scrape in flight must not hold the shutdown open for a whole yfinance
        timeout — so a job can still be inside a write when the worker starts
        tearing down. Before this ticket that was harmless, the scheduled jobs
        writing to another database entirely; they write *here* now, and freeing
        the connection under them is a segfault-shaped way to end a process.
        """
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None


def finite(value):
    """A number on its way into — or out of — a ``DOUBLE`` column, or ``None``.

    The one place that says **a number JSON cannot spell is not a number**, and
    it is a boundary rule rather than arithmetic. v4 carried it on both sides of
    the InfluxDB path (``influx_sql.is_valid_number``) and both sides need it for
    the same two reasons, which is why it is one function and not two:

    * on the way **in**, yfinance hands back a NaN for a fundamental it does not
      have — a ``trailingPE`` on a fund, a yield on a share that pays none —
      and a NaN stored in a column is a value that compares false against
      itself, so ``WHERE x IS NOT NULL`` says it is there and every arithmetic
      it touches becomes NaN;
    * on the way **out**, **JSON has neither NaN nor infinity**. ``jsonify``
      emits a bare ``NaN`` or ``Infinity`` token, which Python's own parser
      accepts and a browser's ``JSON.parse`` refuses outright — so the response
      is a ``200`` whose body the page cannot read, with nothing in the log to
      say why.

    **The infinity is not a second case bolted on, it is the same one.** The
    rule was written against the NaN and spelled ``value != value``, which is a
    NaN test and not a *is this a number JSON can carry* test — so ``Infinity``
    walked through both boundaries and reached a browser. Measured on a real
    install: one Paris-listed share whose earnings round to nothing publishes
    ``trailingPE`` as ``+inf``, it was stored, and ``/api/positions`` answered a
    ``200`` whose body ``JSON.parse`` refused whole — every page of the app
    blank, no console error, no band, because a read that never lands is not a
    fact and the four blocks correctly rendered nothing. The predicate is
    therefore :func:`math.isfinite`, which is the sentence the docstring was
    already making.

    ``None`` is the honest answer in both directions: the field was not
    observed, which is what an absent value means everywhere else in the store.
    """
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def store_path() -> Path:
    """Where the store file is, from the environment.

    ``SB_STORE_DIR`` names a **directory**, not a file: the app owns the name of
    what it writes there, and an operator who points two installs at one
    directory gets two files rather than one silently shared database. It is
    also what removes the class of mistake where the path given exists but its
    parent is not mounted (#740).
    """
    return boot_env.directory(
        os.environ, STORE_DIR_VAR, DEFAULT_STORE_DIR) / STORE_FILENAME


def file_size(path: Path) -> Optional[int]:
    """What this store occupies on disk, write-ahead log included.

    Two files and not one, and the sum is the honest figure rather than a
    refinement: DuckDB writes into ``<file>.wal`` between checkpoints, so a
    reading of the database file alone jumps down at a checkpoint that freed
    nothing at all — the whole class of misreading this figure already invites.

    ``None`` when the file is not there, which is a real state on a store that
    has never been written, and never a zero. The figure is displayed **beside
    the sentence that says what a purge does not do**: measured, 79 % of the
    rows of a real store were purged for zero bytes returned, DuckDB reusing its
    blocks rather than shrinking the file. Shown bare next to a purge button it
    is a lie by juxtaposition; hidden, the number is still there — ``du`` finds
    it — and only its explanation is gone.
    """
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
    """Bring an open connection to the current schema and seed it.

    Returns ``True`` when the file was brand new (the DDL had something to
    create), which is what decides the one seed that happens **once**.

    It opens by **pinning the session to UTC**, which is the other half of
    "``TIMESTAMPTZ``, always UTC" and is *not* bought by the type. DuckDB takes
    ``TimeZone`` from the host, so a bare literal — ``ts = '2024-01-01
    10:00:00'`` — is read in whatever the host says and stored an hour off on a
    machine in ``Europe/Paris``, silently, and differently from the container.
    An *aware* datetime round-trips correctly either way; the literal is the
    trap, and the writers that follow are written in literals (the backfill's
    ``DELETE … WHERE ts >= ? AND ts < ?`` range, spec #695 § 5).

    The rest of the order matters and is the whole design of the function:

    1. **is it new?** — asked of ``information_schema`` rather than of the file
       system, so a file that exists but carries no schema (an interrupted first
       boot) is treated as new instead of as broken;
    2. **the DDL**, with ``IF NOT EXISTS`` throughout, so an existing store is
       untouched and a store from a version with fewer tables gains the ones it
       lacks;
    3. **the account seed**, only when new;
    4. **the settings seed, at every boot**, as an insert that ignores what is
       already there. That last one is what makes adding a dial in a later
       version cost no migration at all: the key that did not exist yesterday is
       inserted today, and the key the user has already answered is left alone.
    """
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
        # ON CONFLICT DO NOTHING, not an UPSERT: completing the table must never
        # overwrite the answer a human gave. The two together — insert what is
        # missing, touch nothing else — are the whole "no migration" claim.
        connection.execute(
            'INSERT INTO setting (key, value) VALUES (?, ?) '
            'ON CONFLICT (key) DO NOTHING', [key, value])

    return is_new


def open_store(path: Optional[Path] = None) -> Store:
    """Open the store, create it if it is not there, and return it ready to use.

    Raises:
        StoreUnavailable: the directory could not be created, the file could not
            be opened, or the schema could not be applied. One class for the
            three because the caller's answer is the same and must be a *named*
            one — an unreadable store is the end of the boot, not a portfolio
            that happens to be empty.
    """
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
    'DDL', 'TABLES', 'STORE_FILENAME', 'STORE_DIR_VAR', 'DEFAULT_STORE_DIR',
    'DEFAULT_ACCOUNT_ROW',
]
