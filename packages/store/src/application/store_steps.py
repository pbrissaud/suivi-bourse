"""The schema steps: how the store moves from one generation to the next."""
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import List

from logfmt_logger import getLogger

from application.events.schemas import canonical_symbol

logger = getLogger("store")


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

    # Read off the store at the call, not imported here: the DDL that put the
    # dependents back must be the one :func:`store.prepare` declared.
    from application import store
    connection.execute(store.DDL)

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
    _buy_the_series_again(connection)


def _drop_dividend_adjusted_prices(connection) -> None:
    """Throw the series away a second time, for the other adjustment (#1008).

    Same defect one adjustment along, and the same remedy for the same reason.
    yfinance defaults ``auto_adjust`` to ``True``, which serves ``Adj Close`` —
    the close **net of every dividend paid since** — under the name ``Close``.
    A dividend is already in the store as a ``DIVIDEND`` event crediting cash,
    so carrying it in the price too counts it twice: every close before an
    ex-date is short by the whole compounded stream behind it, the portfolio
    looks to have grown from lower than it did, and every return derived from it
    is overstated. A custodian's statement of four French lines put it at
    −19,1 % on a day with no event of any kind.

    Mixed exactly as #987 was, and for the same mechanical reason: a point
    written on the day it happened had no later dividend to be net of, one
    backfilled after an ex-date does. Nothing in the row says which, so there is
    no factor to apply and the series can only be bought again — anchors back to
    ``NULL`` so the three passes really rebuild rather than resume past it.

    ``symbol_split`` is left alone: the ratios are a fact about the share count
    and no dividend moves them.
    """
    _buy_the_series_again(connection)


def _refetch_prices_bucketed_in_utc(connection) -> None:
    """Give the deep past back, where a bar was filed one trading day early (#1013).

    A **daily** bar comes stamped at midnight in the exchange's timezone, and
    every reader of ``ts`` buckets in UTC, so a Paris close was stored 22:00Z
    the day before and served under that day. Not a rounding: the point
    labelled 30/06 carried the close of 01/07, and the whole curve with it.

    Unlike #987 and #1008 this one does **not** cost the series whole. Only the
    daily bars are wrong — an intraday bar is stamped at a real trading hour
    and lands on the right UTC day — and the fetch only ever asks for daily
    bars beyond Yahoo's hourly ceiling, so *every* bad point is older than 729
    days and no good one is. The literal is written out rather than read from
    :mod:`scheduling`: a step already released is never edited, so it must not
    move when that ceiling does.

    The two derived series go, as they do in :func:`_buy_the_series_again` and
    for the same reason — they were computed off the shifted closes and are
    rewritten whole on the first perf cycle. ``oldest_window_tried`` goes back
    to ``NULL`` so the backward pass really walks the deleted years again
    instead of resuming past them; ``newest_window_tried`` stays, because what
    it covers was never wrong.

    The clock read is the database's, and it is the only one a step has: a step
    is handed a connection and nothing else. ``now()`` is ``TIMESTAMPTZ`` in
    DuckDB and ``ts`` is too, so the comparison is UTC against UTC — the one
    clock, read through the other hand.
    """
    connection.execute(
        "DELETE FROM price_point WHERE ts < now() - INTERVAL '729 days'")
    connection.execute('UPDATE symbol_quote SET oldest_window_tried = NULL')
    connection.execute('DELETE FROM account_metrics')
    connection.execute('DELETE FROM portfolio_totals')


def _fold_symbol_case(connection) -> None:
    """Bring every stored symbol to the one spelling the writer now keeps (#1068).

    Until this release nothing normalised a ticker, so ``mc.pa`` and ``MC.PA``
    were two securities: two positions, two cost bases, two scrapes. The writer
    folds every new symbol with :func:`canonical_symbol`; this brings the rows
    written before it to the same rule, so the rule holds for the whole ledger
    and not only for what was typed after the upgrade. **It moves events
    between positions** — the ``mc.pa`` lines join ``MC.PA`` — and that move is
    the fix: they were always the same company.

    The rule is read live rather than written out here, unlike the literal in
    :func:`_refetch_prices_bucketed_in_utc`: a store that has not run this step
    must end on the rule the writer applies today, and a later change to the
    rule is a later step for the stores that already ran this one.

    Per spelling that folds to something else, in this order:

    - **the events** move to the canonical symbol, declared if it was not;
    - **the market data** moves with them only where the canonical symbol has
      none of its own — a quote, a series or a split history is one symbol's
      whole answer, and two half-answers merged is neither. Where it has one,
      the variant's is dropped, and the backfill already covers what is kept;
    - **the positions** go: two lines merging into one is a replay's sum, not
      a rename, and the boot's replay writes it a breath later. The two
      derived series go too, as they do in :func:`_buy_the_series_again`,
      because they were computed off two positions where there is one.

    Under :func:`rebuilding`, because DuckDB refuses to delete a ``symbol`` row
    another row referenced earlier in the same transaction — and the variant's
    row has to go, or the orphan list would offer to purge a ticker the owner
    never typed. A lookalike letter folds to itself and stays: no
    normalisation knows a Cyrillic ``С`` from a Latin one, and the writer now
    refuses it on the way in.

    A no-op on a store whose symbols are already canonical, which is every
    file created today: it reads the ``symbol`` table and touches nothing.
    """
    moves = []
    for (symbol,) in connection.execute(
            'SELECT symbol FROM symbol ORDER BY symbol').fetchall():
        target = canonical_symbol(symbol)
        if target is not None and target != symbol:
            moves.append((symbol, target))
    if not moves:
        return

    with rebuilding(connection, 'symbol'):
        for variant, target in moves:
            connection.execute(
                'INSERT INTO symbol (symbol) VALUES (?) ON CONFLICT DO NOTHING',
                [target])
            connection.execute(
                'UPDATE _step_event SET symbol = ? WHERE symbol = ?',
                [target, variant])
            connection.execute(
                'DELETE FROM _step_position WHERE symbol = ?', [variant])
            for table in ('_step_symbol_quote', 'price_point', 'symbol_split'):
                held = connection.execute(
                    f'SELECT 1 FROM {table} WHERE symbol = ? LIMIT 1',
                    [target]).fetchall()
                if held:
                    connection.execute(
                        f'DELETE FROM {table} WHERE symbol = ?', [variant])
                else:
                    connection.execute(
                        f'UPDATE {table} SET symbol = ? WHERE symbol = ?',
                        [target, variant])
            connection.execute('DELETE FROM symbol WHERE symbol = ?', [variant])
        connection.execute('DELETE FROM account_metrics')
        connection.execute('DELETE FROM portfolio_totals')
    folded = ', '.join(f'{variant} → {target}' for variant, target in moves)
    logger.info(f'Folded the symbols stored under another spelling: {folded}')


def _buy_the_series_again(connection) -> None:
    """Forget every stored close and the two series computed from them.

    Shared by the two steps above because they are the same act: a price series
    stored in a unit the ledger does not hold, which nothing in the rows lets
    you correct in place. ``symbol_quote`` keeps the four ``last_price_*``
    columns, deliberately and for a reason worth writing down because it reads
    like an omission: the adjustment factor is **anchored on the newest bar**,
    so the close ``latest_quote`` reads is served identically adjusted or not
    and the live price was never in the wrong unit. Blanking it would buy
    nothing and cost every symbol its price until the next quote cycle lands.

    The two derived series go with it. They are rewritten whole on the first
    perf cycle and pruned to what that cycle could compute, so keeping them
    would buy nothing but a window of wrong figures — one that lasts until the
    boot's rebuild lands, and for as long as this store stands if it fails.
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
#:
#: These are **the store's own** steps, and this tuple is closed: the list a
#: store walks is :data:`application.schema_steps.STEPS`, which the app hands
#: to :func:`open_store` (#1198), and **every new step is appended there** —
#: one written here would run before ``cap_dividend_fee_at_amount`` on a new
#: file and after it on every store that already ran it.
STEPS = (
    ('drop_account_type', _drop_account_type),
    ('add_newest_window_tried', _add_newest_window_tried),
    ('add_symbol_classification', _add_symbol_classification),
    ('drop_split_adjusted_prices', _drop_split_adjusted_prices),
    ('add_splits_read_at', _add_splits_read_at),
    ('drop_dividend_adjusted_prices', _drop_dividend_adjusted_prices),
    ('refetch_prices_bucketed_in_utc', _refetch_prices_bucketed_in_utc),
    ('fold_symbol_case', _fold_symbol_case),
)


def apply_steps(connection, steps) -> List[str]:
    """Run the ``steps`` this store has not run, and name the ones that ran.

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
    for name, step in steps:
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
