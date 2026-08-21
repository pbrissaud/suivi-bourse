"""The ``/api`` blueprint — the disposable half (issue #659, design #655).

#655 decision 1 is what shapes this file: **the for-keeps boundary is Python,
not HTTP**. What must last is :mod:`store_reads` and :mod:`portfolio_view` —
the join, the arithmetic, the three states of absence. A route that
calls a primitive and ``jsonify``s is five lines, and is as throwaway as the
React on the other side of it.

So the rules here are thin on purpose. What the routes *do* own:

* **Shape.** RESTful, resource by resource, because resources deduplicate
  across pages: #652 déc. 8 serves the shares table *and* the dashboard's
  allocation + movers from one query, and a page-shaped endpoint would have
  re-split what that decision unified. ``/api/positions`` with two consumers
  and one client cache is the HTTP expression of it.
* **Windows on series sub-resources only.** #652 déc. 1 made stats absolute;
  the window drives charts alone, so it appears on ``/prices`` and nowhere else.
* **Symbols as identity.** Trap 9 / déc. 3 — a share's name is display only,
  and since #700 it lives on the position rather than on the price series, so
  renaming one cannot cut its history in two.
"""
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional, Tuple

import duckdb
from flask import Blueprint, Response, jsonify, request
from logfmt_logger import getLogger

import accounts as accounts_module
import advisories
import entries
import ledger
import main
import portfolio_view
import quotes
import reassignment
import runtime_state
import runtime_view
import settings as settings_module
import settings_registry
import store as store_module
from events import EventAggregator, Event, EventType
from events import export as events_export
from events.aggregator import AggregationError
from store_reads import PortfolioReader, chart_window
from web.problem import (
    bad_request,
    conflict,
    internal_error,
    not_found,
    storage_unavailable,
    unprocessable,
    unprocessable_entry,
    unprocessable_parameter,
)

logger = getLogger("web.api")

api_bp = Blueprint('api', __name__, url_prefix='/api')

#: Default chart window when the client asks for none. Short on purpose: the
#: ``REGULAR`` cadence is one point every 120 s, so a month is already a few
#: thousand points and a year is fifty thousand.
DEFAULT_WINDOW = timedelta(days=30)

#: The dashboard's default, and it is an order of magnitude wider for a reason
#: that is not taste: the global series is written **one point per calendar
#: day**, so a month of it is thirty points and a day of it is one. #660's
#: trap — the short presets that are natural on the shares page are degenerate
#: here, and the window this endpoint defaults to has to reflect that.
DEFAULT_HISTORY_WINDOW = timedelta(days=365)

#: The one spelling of a calendar day this API takes on the way in (issue #764).
#: ``date.fromisoformat`` accepts several others since Python 3.11 — a bare
#: ``20260210``, a whole instant — and the store's rule is that a day is a day
#: and never a midnight: a bound that arrived as an instant is what silently
#: drops the first day of every window.
_ISO_DAY = re.compile(r'\d{4}-\d{2}-\d{2}')


def _reader() -> PortfolioReader:
    """A reader over the worker's open store.

    Built per request, which is free — it holds a reference and no state. It
    goes through :func:`_store`, so an absent store is a **failed request** and
    never an empty portfolio.
    """
    return PortfolioReader(_store())


def _snapshot():
    """The published configuration snapshot — the lock-free read (issue #658)."""
    return current_runtime().config_manager.current()


def _carried():
    """The symbols a position may be carried at cost on (issue #706, ADR-0004).

    The convention's **second** term, and it is asked here rather than inside
    :mod:`portfolio_view` because that module is pure and this is the one place
    that has both halves: the store, which knows how far the reconstruction has
    got, and the published snapshot, which knows each symbol's holding window.

    Two queries for the whole portfolio — see :func:`quotes.terminal_symbols` —
    so the shares page pays one batched read and not one per row. An empty set is
    the honest answer on an install whose backfill is still running, and it is
    what leaves the priceless rows at an em dash until the rebuild concludes.
    """
    return quotes.terminal_symbols(
        _store(), _snapshot().backfill_windows(), datetime.now(timezone.utc))


def _store():
    """The worker's open store (issue #697).

    Raises when there is none, and the raise is the contract: an absent store is
    a **failed request**, which the blueprint's error handler turns into a
    ``503``. It must never be read as "you own nothing yet", which is the
    ``200`` + ``[]`` a genuinely empty ledger earns.
    """
    runtime = current_runtime()
    if runtime.store is None:
        raise RuntimeError("the store is not open in this process")
    return runtime.store


def current_runtime():
    """The process's runtime, imported late to avoid a cycle at import time."""
    from web import current_runtime as _current
    return _current()


@api_bp.errorhandler(Exception)
def _on_error(exc: Exception):
    """Turn anything a route raises into problem+json.

    This is the point of the separate read module: the scheduler's own reads
    swallow and return ``None``, this blueprint lets the exception travel and
    answers ``503``. The two policies coexist in one process because they live
    in two modules (#655 decision 5).

    The three states of absence are **structural** here since #700 and no longer
    rescued by inspecting an exception: a table the store declares but nothing
    has written answers ``200`` + ``[]``, an unwritten column reads as ``NULL``,
    and only a genuine fault reaches this handler.

    **A fault of the store, and a fault of ours, are two answers.** This handler
    used to give every exception ``503`` and the type
    ``/problems/storage-unavailable``, so a ``TypeError`` in ``portfolio_view``
    told the client the database was unreachable — and the front branches on
    ``problem.type`` and nothing else (#745), so it drew the *store unreachable*
    screen for a bug of ours. The distinction is the whole reason ``503`` is
    ``503``: the condition is transient by nature and the retry policy should
    treat it as such, where a ``500`` invites a bug report. ``internal_error``
    existed, was exported, and had no caller: dead code that documented a
    distinction the code did not make.
    """
    logger.error(f"API error on {request.path}: {exc}", exc_info=True)
    if isinstance(exc, (store_module.StoreUnavailable, duckdb.Error)):
        return storage_unavailable(str(exc))
    return internal_error(str(exc))


# --------------------------------------------------------------------- #
# Portfolio — what moved since the last session close (issue #660)
#
# What is left of #660's section. ``/api/shares``, ``/api/shares/<symbol>``,
# ``/api/shares/<symbol>/prices``, ``/api/portfolio`` and
# ``/api/portfolio/history`` were kept "until the pages that consume them are
# rewritten"; the pages are rewritten, and the v5 pair below is what they read.
# Two of the five were the same arithmetic as a v5 route reached by another
# path — ``/api/portfolio/history?mode=titres`` was ``/api/positions/history``
# argument for argument — which is one figure with two chances of drifting.
# --------------------------------------------------------------------- #

@api_bp.get('/portfolio/movers')
def get_portfolio_movers():
    """What moved since the last session close (#652 déc. 8).

    Two queries, and the second is the point: the current side is P1 — the very
    query ``/api/positions`` runs, so the front holds it in one cache — and the
    baseline is one ``values_at`` giving every symbol's last price at or before
    the previous close. Running P1 again here rather than bolting a
    ``previous_price`` onto ``/api/positions`` keeps the extra read off the
    shares page, which does not want it, and keeps the "since the last close"
    rule and its arithmetic in one tested place instead of half in TypeScript.

    No ``currency`` on a row since #702: every amount here is in the reporting
    currency, so it is one fact about the block and the head is where it is
    published — the same rule every series resource follows.
    """
    reader = _reader()
    rows = reader.positions()

    times = [row['price_time'] for row in rows
             if isinstance(row.get('price_time'), datetime)]
    if not times:
        return jsonify({'since': None, 'reference': None, 'movers': []})

    since = portfolio_view.session_baseline_instant(max(times))
    baseline = reader.prices_at(since)
    # The carrying set rides along for the ``market_value`` on the row; it
    # cannot put a *mover* on the block, because a carried position's ``price``
    # is still ``None`` and :func:`portfolio_view.build_movers` drops a share it
    # cannot compare. That is right — a position nothing priced has not moved.
    movers = portfolio_view.build_movers(
        portfolio_view.build_shares(rows, _carried()), baseline)

    # Two instants, and they are not interchangeable. `since` is the **cut** the
    # rule defines; `reference` is the newest price actually found at or before
    # it. Naming the block after the cut is what made it claim a close that had
    # not happened yet, so the front labels with `reference` and keeps the cut
    # as the rule it is.
    return jsonify({
        'since': since.isoformat(),
        'reference': _iso(portfolio_view.baseline_reference(baseline)),
        'movers': [mover.to_dict() for mover in movers],
    })


# --------------------------------------------------------------------- #
# The v5 pair the front reads: the positions and the global perf cache
# (contract #745, issue #763)
#
# **A resource carries the name of the store's table, never the page's.**
# ``positions`` and not ``shares`` — *Titres* is the page, ``position`` is the
# table (#699) — and ``portfolio-totals`` after ``portfolio_totals`` (#700,
# #707). Reusing a v4 name for a different payload would make a new resource
# pass for the old one, which is what ADR-0008 avoids everywhere else: renaming
# costs nothing when nothing migrates.
#
# --------------------------------------------------------------------- #

@api_bp.get('/positions')
def list_positions():
    """The hot read of the portfolio — one query for the whole of it.

    P1, unfolded: one row per ``(account, symbol)``, a **sold** position among
    them (``quantity`` 0, which stays in the table — ADR-0017), and a position
    whose symbol has never been fetched as a row whose market objects are
    ``null`` rather than as a missing line. That last one is the LEFT join's
    doing (:meth:`store_reads.PortfolioReader.positions`): an inner one would
    answer *"you own nothing"* to somebody who has just declared everything they
    own.

    ``base_currency`` is the head of the payload rather than a field of each row
    (ADR-0002): there is **one** reporting currency, and ``null`` is how the API
    states that nobody has answered the question yet — no route and no fourth
    kind of absence is added for it (ADR-0021).

    Empty portfolio is ``200`` + ``[]`` inside a payload that still names the
    currency; a query that fails **propagates** and this blueprint answers
    ``503`` + ``application/problem+json``. The two must stay two screens.
    """
    # Read before the rows, and through the store like every other dial: an
    # unreadable store owes a 503 rather than a payload whose figures have no
    # unit and whose envelope says everything is fine.
    currency = _base_currency()
    return jsonify({
        'base_currency': currency,
        'positions': portfolio_view.build_positions(
            _reader().positions(), currency),
    })


@api_bp.get('/portfolio-totals')
def get_portfolio_totals():
    """The newest day of the global perf series, plus three derived members.

    Eight of the eleven members are columns (`store.py`); the other three are
    **derivations**, and each is derived here rather than written by the perf job
    for a reason recorded where it is taken:
    :meth:`store_reads.PortfolioReader.twr_origin` for ``twr_since``,
    :meth:`store_reads.PortfolioReader.transfer_fees` for the fourth term of
    ADR-0018, and :func:`portfolio_view.ytd_base_day` for the bound the
    year-to-date rests on.

    ``totals: null`` is the resource's own absence and has **two** causes with
    one shape — no ledger, or no reporting currency answered, the perf job
    writing nothing at all until it is. ``200`` + ``null``, never a ``404`` and
    never ``[]``: the head keeps its subject either way, since three of the four
    terms of the gain are read off ``/api/positions``, which is under no such
    constraint (ADR-0018).
    """
    reader = _reader()
    latest = reader.latest_totals()

    totals = None
    if latest is not None:
        # The three reads are asked only once there is a row to hang them on:
        # on an install whose perf cache is empty they would each answer
        # nothing, and asking is how a resource acquires queries it does not
        # need. ``day`` is the table's primary key, so it is always there.
        day = latest['day']
        totals = portfolio_view.build_portfolio_totals(
            latest,
            reader.totals_on_or_before(portfolio_view.ytd_base_day(day)),
            reader.twr_origin(),
            reader.transfer_fees(day))

    return jsonify({'base_currency': _base_currency(), 'totals': totals})


@api_bp.get('/portfolio-totals/history')
def get_portfolio_totals_history():
    """The global perf series — ``/api/accounts/<id>/history`` one level up (#721).

    It exists because the accounts page owes its ``Portefeuille`` row a ``perf``
    cell, and ``perf`` is **the series rebased to 100 at the start of the visible
    window** (ADR-0019) rather than the stored index: at ``MAX`` that row read
    ``+102,72 %`` above two accounts measured over two other periods, which is
    exactly the comparison the rebasing exists to make possible. A rebasing needs
    the series, and the newest row of ``/api/portfolio-totals`` is one day.

    It is a **resource of its own** rather than a member of the row above, and
    named after the store's table rather than after the page (#745). The obvious
    alternative was ``/api/portfolio/history``, which served this table already
    — but it was a v4 route discriminated by a ``?mode=``, publishing
    ``value``/``contributed`` for a chart rather than the perf members. It went
    on serving until the page reading it was rewritten, and it left with the
    other four when that finished.

    **The five members are the account resource's, field for field**, so one
    client shape reads both and the rebasing is written once. No ``currency``
    here either: the head owns it, and since #702 there is exactly one to own.
    """
    try:
        start, stop = _parse_window(DEFAULT_HISTORY_WINDOW)
    except ValueError as exc:
        return bad_request(str(exc))

    return jsonify({
        'from': start.isoformat(),
        'to': stop.isoformat(),
        'points': [
            {
                't': _iso(row.get('day')),
                'cash_balance': row.get('cash_balance'),
                'holdings_value': row.get('holdings_value'),
                'total_value': row.get('total_value'),
                'net_contributed': row.get('net_contributed'),
                'twr_index': row.get('twr_index'),
            }
            for row in _reader().totals_series(start, stop)
        ],
    })


@api_bp.get('/positions/history')
def get_positions_history():
    """What the holdings were worth day by day, against what they cost (#727).

    The dashboard draws **one** chart slot with two readings, and this serves the
    fallback of the first one. *Value against net contributed* has nothing to
    draw on an install with no cash event: since #708's per-field rule
    ``total_value`` and ``net_contributed`` are ``NULL`` there, which is every v4
    arrival (v4 had no cash events at all) and every owner who only ever recorded
    purchases. The area between the two curves is then the **latent** gain rather
    than the gain, and the page renames it — the two are not the same figure, so
    they are not the same words.

    **A resource of its own, named after the store's table** (#745): it is the
    series ``/api/positions`` is one instant of, and ``portfolio-totals/history``
    could not have carried it. That one publishes *the account resource's five
    members, field for field*, so one client shape reads both and the rebasing is
    written once (#721); a sixth member here would be a member the account level
    has no equivalent of.

    Each of the reads is a decision recorded where it was taken: the closes are
    bounded by the window while the holdings come from the replay, which knows
    nothing of it, so each symbol's last close **before** the window rides in
    (``carried_in``) or a position quoted before ``from`` counts its whole cost
    and none of its value; and ADR-0004's two terms — ``carried`` and
    ``first_quoted`` — are what keep a day with no observed price flat at its
    cost rather than at zero, which is the crater #706 filled.
    """
    try:
        start, stop = _parse_window(DEFAULT_HISTORY_WINDOW)
    except ValueError as exc:
        return bad_request(str(exc))

    reader = _reader()
    timeline = EventAggregator().replay(_snapshot().events)
    return jsonify({
        'from': start.isoformat(),
        'to': stop.isoformat(),
        'points': portfolio_view.valuation_series(
            reader.daily_closes(start, stop), timeline.at,
            carried_in={row['symbol']: row['price']
                        for row in reader.prices_at(start)},
            carried=_carried(),
            first_quoted=quotes.first_quoted_days(_store())),
    })


@api_bp.get('/prices/<symbol>')
def get_prices(symbol: str):
    """One symbol's series over a **rung of the retention ladder** (#719, #763).

    A **new** resource and not a rename of ``/api/shares/<symbol>/prices``: that
    one took ``?from=``/``?to=`` and announced a ``bucket``, this one takes a
    window from a closed set and announces a ``resolution``. The two cohabited
    until the page consuming the older one was rewritten, and it left with the
    other four v4 routes then.

    Three properties, and each is a criterion rather than a convenience:

    * **The window is a rung, never a round number** (ADR-0010): ``1M`` / ``1Y``
      / ``2Y`` / ``MAX``, so changing the range changes the resolution
      *visibly*. An unknown one — or none at all — is a ``422`` and never a
      fallback: a default would serve a curve nobody asked for under a caption
      that describes it correctly.
    * **The resolution is what was actually served**, decided by
      :func:`store_reads.chart_window` and stated once, so the chart's
      *aggregated by X* caption reads a field instead of computing a second
      bucketing of its own.
    * **A point whose conversion is missing is ``price: null``**, never a point
      that is absent — that is what
      :meth:`store_reads.PortfolioReader.chart_series` exists for.

    A symbol nobody has ever stored a price for is ``200`` + ``[]``, not a
    ``404``: the resource is the *series* of a symbol, and an empty series is a
    legitimate state of a fresh install (#655 decision 8). A query that fails
    propagates into ``503`` like every other read here.
    """
    try:
        span_days, bucket, resolution = chart_window(request.args.get('window'))
    except ValueError as exc:
        return unprocessable_parameter(str(exc), key='window')

    # ``MAX`` has no lower bound — the whole series — which is a ``None`` start
    # rather than a very old instant: a bound computed from a guessed depth
    # would silently cut an install older than the guess.
    start = (None if span_days is None
             else datetime.now(timezone.utc) - timedelta(days=span_days))

    return jsonify(portfolio_view.build_price_series(
        symbol,
        _reader().chart_series(symbol, bucket, start),
        resolution,
        _base_currency()))


# --------------------------------------------------------------------- #
# Accounts — declared by a file or here (issue #698)
# --------------------------------------------------------------------- #

@api_bp.get('/accounts')
def list_accounts():
    """The **declared** accounts, each with its newest perf figures.

    #652 déc. 4 corrects trap 12 here, and it matters for the shares page's
    global filter. The obvious source would be a ``DISTINCT`` on the ``account``
    tag, but the validator makes every event name an account that exists — so an
    account that holds shares without being declared cannot exist, and the two
    lists differ only on historical residue (an account since removed, the
    pre-v4.1 ``default`` bucket). Reading the declaration also hands over
    ``label`` and ``type``, which the tags on the series only record as they
    *were*, plus ``source_id``/``editable``: where the row came from, which is
    what tells the page whether it may offer an edit at all (issue #698).

    The figures ride the *same* resource rather than a second one, which is
    #655's REST rule doing what it was adopted for: there is one accounts
    resource with two consumers — the shares filter reads ``id``/``label``, the
    accounts table reads the rest — and one cache entry between them, exactly as
    ``/api/positions`` serves the shares table and the dashboard's allocation.
    Splitting
    the declaration from its figures would be the page-shaped endpoint that
    decision rejected, under another name.

    ``declared: false`` is a *designed* state, not an empty one — the opt-out
    setup every default install runs. Stating it explicitly rather than letting
    the front infer it from ``[]`` is #655 decision 8's discriminator rule, and
    it is the member that carries the whole distinction now that the list is
    never empty.

    **The list always holds at least one row** (issue #729, ADR-0013). While
    nothing else is declared that row is the seeded ``default`` one, and it is
    *served* rather than left to a client to synthesise, for one reason: its
    ``label`` is the one thing no client can know. Renaming that account is a
    ``PATCH`` on this very resource — it is the only account a fresh install has,
    so it is the only one there is to rename — and a payload that never carried
    the row made the rename **invisible**: the store held ``Mon PEA`` while every
    page went on drawing a row it had rebuilt from nothing. ``declared`` keeps
    its meaning exactly (*is there a declaration beyond the one every install is
    given*), so nothing reading the discriminator changes; what changes is that a
    reader asking *which accounts are there* is no longer answered *none*, which
    ADR-0013 says is impossible.

    The cost accepted is one query on an install that declared nothing, where
    this route used to read no database at all. The property that argument was
    written for — the shares page's account filter surviving a store outage —
    left with the page itself: since #719 that filter reads ``/api/positions``,
    which opens the store on every install.

    **And one member is not a column of that row**: ``transfer_fees``, ADR-0018's
    fourth term per account (issue #722). The account's own panel shows the gain
    dominating its four terms and three of them come off ``/api/positions``; the
    fourth belongs to no position at all. It is derived at read time exactly as
    ``/api/portfolio-totals`` derives the global one, and it rides here rather
    than on a resource of its own for the reason the figures beside it do — one
    accounts resource, two consumers. The cost is the same one written down
    there: a resource that names accounts reads the ``event`` table, once.
    """
    accounts = _snapshot().accounts
    declaration = accounts.accounts if accounts is not None else _seeded_only()
    # **What nobody declared goes out as `null`**, and it is done here rather
    # than in the store: `read_accounts` keeps serving the row as it is written,
    # which is what the export and the replay want, while the *wire* carries the
    # declaration alone. `accounts.as_declared` holds the comparison, beside the
    # constant it compares against — the front then folds `null` into its own
    # catalogue with no copy of a server-owned string.
    declaration = [accounts_module.as_declared(row) for row in declaration]
    reader = _reader()
    rows = reader.latest_account_metrics() if declaration else []
    # Bounded per account by the day its own row describes: the days differ the
    # moment one account's series is capped in the past (#765), and ADR-0018's
    # identity only holds between terms measured at the same instant. An account
    # with no day is out of the mapping and therefore out of the answer.
    through = {
        row['account']: row['day'] for row in rows
        if row.get('account') is not None and row.get('day') is not None
    }
    return jsonify({
        'declared': accounts is not None,
        'accounts': [
            summary.to_dict()
            for summary in portfolio_view.build_accounts(
                declaration, rows, reader.transfer_fees_by_account(through))
        ],
    })


def _seeded_only():
    """The ``default`` row as the store holds it — the whole declaration.

    Read from the table and never rebuilt from :data:`store.DEFAULT_ACCOUNT_ROW`:
    the point is to publish what the row says *now*, seed included until somebody
    relabels it. ``declared_portfolio`` answering ``None`` means the table holds
    this row and nothing else, so the filter is a guard rather than a search.
    """
    return [row for row in accounts_module.read_accounts(_store())
            if row.id == accounts_module.DEFAULT_ACCOUNT]


@api_bp.get('/accounts/<account_id>/history')
def get_account_history(account_id: str):
    """One account's perf series — the TWR chart and the detail sheet's curve.

    Two consumers again, and this time they read different fields of it: the
    comparison chart takes ``twr_index`` from N of these in parallel (#652
    déc. 13 — the baseline's only multi-series query, and the one place
    comparing accounts of different sizes means anything, since a base-100 index
    carries neither size nor currency), while the sheet takes cash / holdings /
    contributed from the single account it opened.

    An unknown ``account_id`` is a **404**, and it is decided against the
    declaration rather than against the data: an account with no series yet is
    declared and empty (``200`` + ``[]``), while an id nobody declared does not
    exist. Collapsing the two would answer a typo with an empty chart.

    No ``currency`` in the payload — the head owns it, per the rule every
    series resource here follows. Since #702 the collection owns none either: an
    account has no currency, there is one reporting currency for the whole
    install, and ``/api/portfolio-totals`` is where it is said.
    """
    accounts = _snapshot().accounts
    if accounts is not None:
        known = accounts.get(account_id) is not None
    else:
        # Nothing declared: the declaration is the seeded ``default`` row, which
        # is exactly what ``list_accounts`` answers with in the same state. The
        # two decided against different things and disagreed on the one install
        # that has never been configured — the commonest one there is. The page
        # asks for the history of every row the collection gave it, so a 404
        # here put a failure band on the accounts page of a fresh install.
        known = any(row.id == account_id for row in _seeded_only())
    if not known:
        return not_found(f"No declared account {account_id!r}")

    try:
        start, stop = _parse_window(DEFAULT_HISTORY_WINDOW)
    except ValueError as exc:
        return bad_request(str(exc))

    return jsonify({
        'account': account_id,
        'from': start.isoformat(),
        'to': stop.isoformat(),
        'points': [
            {
                't': _iso(row.get('day')),
                'cash_balance': row.get('cash_balance'),
                'holdings_value': row.get('holdings_value'),
                'total_value': row.get('total_value'),
                'net_contributed': row.get('net_contributed'),
                'twr_index': row.get('twr_index'),
            }
            for row in _reader().account_series(account_id, start, stop)
        ],
    })


@api_bp.post('/accounts')
def create_account():
    """Declare an account from the app — the other half of the file (issue #698).

    The file exists so that a **headless** install can declare accounts at all;
    this exists so that an install with a page does not have to write a file to
    do it. Neither is the primary one, and the row they produce differs in
    exactly one column: ``source_id``, ``NULL`` here, which is what makes this
    row editable and a file's row read-only.

    The replay follows the write, in this process: declaring an account changes
    what an event file is allowed to say, so the caller must see the effect of
    their own gesture without waiting for anything.

    **And the reassignment rides in the same gesture** (issue #725). ``reassign``
    asks, in the same request, for every event still naming the seeded row to be
    moved onto the account being declared — which is the exact instant a blank
    ``account`` column stops meaning ``default`` and starts meaning an error, and
    the only one at which those rows may be rewritten (:mod:`reassignment`).
    Two properties are the ticket's:

    * **the declaration is never refused because events are unassigned.** The
      refusal is the trap dismantled elsewhere under another name — it locks the
      owner out of the one action that repairs their state — so the flag is
      *offered*, never *required*, and its absence declares the account all the
      same;
    * **the two writes are one transaction.** A declaration committed without
      the reassignment asked for in the same click is a half gesture, and the
      owner would then be looking at a declared account beside a ledger that
      still ignores it — which is the very screen the flag exists to prevent.
    """
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    runtime = current_runtime()
    try:
        # Under the writers' mutex, and the replay strictly after it: the lock
        # is what keeps this row out of an ingestion transaction that could roll
        # it back (:meth:`main.ConfigurationManager.writing`), and it is not
        # reentrant, so the replay cannot happen inside the block.
        with runtime.config_manager.writing() as opened:
            with opened.transaction():
                account = accounts_module.create_account(
                    opened, body.get('id'), body.get('type'), body.get('label'))
                if _flag(body.get('reassign')):
                    reassignment.reassign_unassigned(opened, account.id)
    except accounts_module.DuplicateAccount as exc:
        return conflict(str(exc))
    except accounts_module.AccountSourceError as exc:
        return bad_request(str(exc))
    except AggregationError as exc:
        return conflict(str(exc))

    main.replay_after_write(runtime)
    return jsonify(_account_to_dict(account)), 201


@api_bp.post('/accounts/<account_id>/reassignment')
def reassign_unassigned_events(account_id: str):
    """Move every event naming the seeded row onto a declared account (#725).

    The **standing** half of the gesture ``POST /api/accounts`` carries inline,
    and it exists because the instant it serves is reachable without any gesture
    in the app at all: an accounts *file* dropped into the folder declares just
    as much (issue #698), and the event file beside it is then refused for the
    blank column it was right to carry — leaving its rows under ``default`` with
    nothing on any page able to move them. One resource, two roads to it.

    It is a **collection gesture and not a row one**, and that is what keeps it
    inside the read-only rule rather than beside it: no event id crosses the
    wire, the population is the column's own value, and :mod:`reassignment`'s
    single ``UPDATE`` cannot reach a row naming a declared account. The mapping
    table a client might send instead is refused by ADR-0006 — it would be a
    second truth about the account an event names.

    ``404`` on an id nothing declares, ``409`` on the seeded row (it is the row
    every install is given, not a declaration) and on a ledger that would not
    replay. ``200`` with the count on everything else, **zero included**: a
    gesture that has nothing left to move is not an error, it is the window
    already spent.
    """
    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            with opened.transaction():
                moved = reassignment.reassign_unassigned(opened, account_id)
    except accounts_module.UnknownAccount as exc:
        return not_found(str(exc))
    except reassignment.NotReassignable as exc:
        return conflict(str(exc))
    except AggregationError as exc:
        return conflict(str(exc))

    main.replay_after_write(runtime)
    return jsonify({'account': account_id, 'reassigned': moved})


@api_bp.patch('/accounts/<account_id>')
def update_account(account_id: str):
    """Relabel or retype an account created in the app.

    The id is **not** among what can change: it is the value events name, so
    renaming it would be an edit of every imported row that names it — and
    imported rows are read-only. Rename by declaring the new id and forgetting
    the import that carried the old one.
    """
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            account = accounts_module.update_account(
                opened, account_id,
                account_type=body.get('type'), label=body.get('label'))
    except accounts_module.UnknownAccount as exc:
        return not_found(str(exc))
    except accounts_module.ReadOnlyAccount as exc:
        return conflict(str(exc))

    main.replay_after_write(runtime)
    return jsonify(_account_to_dict(account))


@api_bp.delete('/accounts/<account_id>')
def delete_account(account_id: str):
    """Remove an account created in the app.

    ``409`` on the three refusals, and they are the ticket's spine: an account
    **an event names** cannot go (ADR-0013 — no orphan historical residue), an
    account a **file** declared is revoked by forgetting that import, and the
    ``default`` account is the one row every install has.
    """
    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            accounts_module.delete_account(opened, account_id)
    except accounts_module.UnknownAccount as exc:
        return not_found(str(exc))
    except (accounts_module.AccountInUse,
            accounts_module.ReadOnlyAccount) as exc:
        return conflict(str(exc))

    main.replay_after_write(runtime)
    return jsonify({'id': account_id, 'removed': True})


def _account_to_dict(account) -> dict:
    """One :class:`events.schemas.Account`, on the wire.

    ``editable`` is published rather than left to the client to derive from
    ``source_id``: it is the rule, and a rule the front re-implements is a rule
    that can disagree with the API that enforces it.
    """
    return {
        'id': account.id,
        'type': account.type,
        'label': account.label,
        'source_id': account.source_id,
        'editable': account.editable,
    }


# --------------------------------------------------------------------- #
# Events — read, and written one typed row at a time (issue #764)
#
# The **population** is what splits this section in two, and it is the whole of
# what #764 settles. A row that came from a file is read-only and revoked with
# its import (#697): the file and the store would otherwise be two truths about
# the same purchase. A row somebody typed here came from no file, no revocation
# can reach it, and ADR-0005 makes that form the *onboarding* — so a typo in the
# first five minutes of using this app would be permanent. The three write
# routes below serve the second population and refuse the first by name.
# --------------------------------------------------------------------- #

@api_bp.get('/events')
def list_events():
    """The event ledger, as the published snapshot holds it.

    Two consumers, which is why it is a resource and not a page endpoint: the
    data page's ledger (#652 déc. 14) and the chart markers (déc. 11) — the
    single thing Grafana structurally cannot draw, since it reads one datasource
    and the events are files.

    Served from :meth:`ConfigurationManager.current` rather than from a second
    read of the files. #662's editor was that second read, and it existed for
    one reason: **the file was the address**, so a row needed an opaque token
    over ``(file, sheet, row)`` and a fingerprint to guard it. #711 removes the
    apparatus without a row-by-row successor — the rows here are the ones the
    aggregator actually ran on, in the order it sorted them.

    **And the key rides in the snapshot rather than turning this into a store
    read** (issue #764). Both were open: ``event.id`` is a column, so the
    resource could have queried it directly. The two differ by their **error
    contract**, and that is what settles it:

    * *the field descends into the snapshot* — this resource goes on answering
      from process memory, so its three states stay ``200`` + rows and ``200`` +
      ``[]`` and it **has no** ``503``. The rows served are, by construction, the
      ones the aggregator ran on, so the ledger a reader sees is the ledger the
      figures on every other page were computed from. The snapshot is immutable
      and republished by a single rebind (#658), so the key enters it like any
      other field; and it cannot go stale against the store, because **every
      writer of the** ``event`` **table replays synchronously in this process**
      (:func:`main.replay_after_write`, and ``ingest()`` on a file landing).
    * *the resource reads the store* — it would gain a ``503`` the way
      ``/api/positions`` has one, and that ``503`` would take the shares page's
      chart markers down with it for a fault they read no ledger about. It would
      also serve rows the aggregator has not run on whenever a build raised,
      i.e. show a ledger the app is not computing anything from.

    The cost accepted, and it is the one the export pays in the other direction:
    :func:`export_events` reads the **store** on purpose, because a snapshot the
    validator refused leaves the previous one standing and a backup must be of
    what is stored. Two resources over one table with two contracts, each named
    where it is chosen.

    ``?symbol=`` narrows to one share's events. Cash events (DEPOSIT /
    WITHDRAWAL) carry no symbol and are therefore excluded by that filter, which
    is what the chart wants.

    An install whose events directory is still empty is ``200`` + ``[]``, the
    empty-collection state, not an error.
    """
    events = _snapshot().events

    symbol = request.args.get('symbol')
    if symbol:
        events = [event for event in events if event.symbol == symbol]

    return jsonify([_event_to_dict(event) for event in events])


def _event_to_dict(event) -> dict:
    """One :class:`events.schemas.Event`, on the wire.

    No etag: it was a property of an address, and there is no address any more.
    ``account`` is reported as the aggregator resolves it — blank means
    ``default``, which is the rule for an install that declared no account.

    ``provenance`` is what survives of #662, and it is a **display** (issue
    #697). The triplet behind it — ``(source_id, source_sheet, source_row)`` —
    is reported alongside the rendered label so a client can group by source
    without re-parsing a sentence, and neither is an address: the row has a
    primary key now, and a key does not go stale. The label is ``null`` for a
    row with no source, which is what a line created in the UI is.

    ``source_filename`` is the file's **name**, and it is served beside the
    rendered ``provenance`` rather than instead of it (issue #764). The store's
    label is one English sentence — ``2024.csv, row 14`` — and a rendering
    follows the **reader's** language (ADR-0024), so a front that has only the
    sentence can translate nothing. What it needs is the name; what it composes
    from the name and the row number is its own. The field was already on the
    event, joined at read time by :func:`ledger.read_events` precisely so that
    whoever holds one can render its provenance, and it simply was not put on
    the wire.

    ``id`` is a **string**, and that is a decision. The column is a ``BIGINT``,
    and a JSON number above 2^53 is not the integer that was sent; more to the
    point, a client has no arithmetic to do with a key — it addresses a row with
    it and uses it as a render key — so publishing it as text is publishing what
    it is. ``null`` on an event that has no row of its own, which nothing
    produces today and which the type has to allow all the same.
    """
    return {
        'id': str(event.id) if event.id is not None else None,
        'date': event.date.isoformat() if event.date else None,
        'event_type': event.event_type.value,
        'symbol': event.symbol,
        'name': event.name,
        'quantity': event.quantity,
        'unit_price': event.unit_price,
        'fee': event.fee,
        'amount': event.amount,
        'notes': event.notes,
        'account': event.account,
        'source_id': event.source_id,
        'source_sheet': event.source_sheet,
        'source_row': event.source_row,
        'source_filename': event.source_filename,
        'provenance': ledger.provenance_label(event),
    }


@api_bp.post('/events')
def create_event():
    """Record one event typed in the app (issue #764, ADR-0005).

    The onboarding, not a convenience: manual mode is gone, so *typing a
    position* **means** creating dated events, and this is where they land. The
    row carries ``source_id NULL`` — created here, therefore editable — which is
    the same column, and the same sentence, as ``POST /api/accounts``' (#698).

    ``422`` for a body the ledger refuses, and it refuses **before writing
    anything**: the parse below runs over the whole body, and
    :func:`entries.create` holds its single-row check, its write and its replay
    inside one transaction. That is ``PUT /api/settings``' rule for the same
    reason — a half-applied body is a state nobody asked for — and it is what
    makes *"a date that does not exist"* a refusal rather than a row.

    ``409`` when the ledger it would make does not replay: overselling is a
    property of the *ledger*, not of a row, so a `SELL` that is legal alone can
    be illegal in company. Well formed, and the store's state refuses it — which
    is what that status is for.

    The replay follows the write, synchronously and in this process, exactly as
    on ``DELETE /imports/<id>``: whoever just recorded an event must not wait
    for a timer to see their own gesture.
    """
    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    try:
        draft = _event_from_body(body)
    except _InvalidBody as exc:
        return unprocessable_entry(str(exc), key=exc.field)

    runtime = current_runtime()
    try:
        # The writers' mutex, like every other write here: a Flask handler and
        # the ingestion share one DuckDB connection, and a row written between
        # another thread's BEGIN and its ROLLBACK disappears with it after this
        # handler has answered 201.
        with runtime.config_manager.writing() as opened:
            created = entries.create(opened, draft)
    except entries.InvalidEntry as exc:
        return unprocessable_entry(str(exc), key=exc.field)
    except AggregationError as exc:
        return conflict(str(exc))

    main.replay_after_write(runtime)
    return jsonify(_event_to_dict(created)), 201


@api_bp.patch('/events/<event_id>')
def update_event(event_id: str):
    """Rewrite one event typed in the app — and refuse an imported one.

    **This is the route** ``forget_import``'s docstring used to say did not
    exist, and the two now say the same thing about two different populations:
    a line provisioned by ``broker.csv`` is still uneditable here (``409``,
    naming the import to forget), because the file and the store must not become
    two truths about one purchase. A line somebody typed a minute ago is
    reachable by no revocation at all, so refusing it too would make a typo in
    the onboarding form permanent — which is the trap ADR-0005 walked into by
    making that form the first gesture of a new arrival.

    The **whole** row is rewritten, never the members the body happened to
    carry: an event's fields are not independent — a type change turns a
    purchase into a transfer — so a partial patch would leave a row nobody
    typed.
    """
    key = _entry_key(event_id)
    if key is None:
        return not_found(f"No event with id {event_id!r}")

    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")
    try:
        draft = _event_from_body(body)
    except _InvalidBody as exc:
        return unprocessable_entry(str(exc), key=exc.field)

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            updated = entries.update(opened, key, draft)
    except entries.UnknownEntry as exc:
        return not_found(str(exc))
    except entries.ImportedEntry as exc:
        return conflict(str(exc))
    except entries.InvalidEntry as exc:
        return unprocessable_entry(str(exc), key=exc.field)
    except AggregationError as exc:
        return conflict(str(exc))

    main.replay_after_write(runtime)
    return jsonify(_event_to_dict(updated))


@api_bp.delete('/events/<event_id>')
def delete_event(event_id: str):
    """Remove one event typed in the app — and refuse an imported one.

    The pair of the route above and refused on the same predicate. It exists
    because *edit* alone does not cover the mistake it is there for: an event
    recorded on the wrong account, or recorded twice, is removed rather than
    corrected — and the bulk gesture that would otherwise reach it, forgetting
    an import, has nothing to forget on a row that came from no file.

    The ``409`` on a ledger that would not replay is not symmetry either: taking
    a purchase away can leave a later sale overselling, which is the same fact
    ``POST`` meets from the other side.
    """
    key = _entry_key(event_id)
    if key is None:
        return not_found(f"No event with id {event_id!r}")

    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            entries.remove(opened, key)
    except entries.UnknownEntry as exc:
        return not_found(str(exc))
    except entries.ImportedEntry as exc:
        return conflict(str(exc))
    except AggregationError as exc:
        return conflict(str(exc))

    main.replay_after_write(runtime)
    return jsonify({'id': event_id, 'removed': True})


def _entry_key(event_id: str) -> Optional[int]:
    """The path segment as the ``event`` table's key, or ``None``.

    The route takes a **string** rather than Flask's ``<int:…>`` converter, so
    that ``/api/events/nope`` is answered by this blueprint — problem+json, with
    the id in it — instead of by the router's own bare ``404``. The client is
    handed a key as text (:func:`_event_to_dict`) and hands it back as text; what
    it means is this table's business, not the URL's.
    """
    try:
        return int(event_id)
    except (TypeError, ValueError):
        return None


class _InvalidBody(Exception):
    """A member of the body is not a value an event can carry.

    The HTTP boundary's own refusal, and it is deliberately **not** a second
    validator. :class:`events.loader.EventLoader` turns a CSV cell into a typed
    value and raises when it cannot; this is that function for a JSON member,
    and :mod:`events.validator` judges what comes out of either. So
    *"2026-02-31 is not a day"* is refused here and *"a BUY needs a quantity"*
    there — two questions, two owners, and the split is the one the file path
    has always had rather than a new one invented for this road.
    """

    def __init__(self, message: str, field: str):
        super().__init__(message)
        self.field = field


#: The members a client may send. ``id``, the provenance triplet and
#: ``source_filename`` are **not** among them: they are the store's to write, and
#: a client that could name one would be a client that could forge one.
_EVENT_TEXT_FIELDS = ('symbol', 'name', 'notes', 'account')
_EVENT_NUMBER_FIELDS = ('quantity', 'unit_price', 'fee', 'amount')


def _event_from_body(body: Optional[dict]) -> Any:
    """One JSON object as an :class:`events.schemas.Event`, or a named refusal.

    Every member is read here and none is inferred, which is what makes
    ``PATCH`` a rewrite rather than a merge.

    The date is checked **twice on purpose**: for its shape, because a calendar
    day is not an instant (the store's own rule, and ``date.fromisoformat``
    accepts more spellings than the format this app writes), and then for its
    existence, because ``2026-02-31`` has the shape of a day and is not one.
    That second check is the one no browser can make for the app:
    ``<input type="date">`` empties its own value before any script sees it, so
    the front measured the trap and cannot prove the rule — it is observable
    from here alone.
    """
    if not isinstance(body, dict):
        raise _InvalidBody("a JSON object is required", 'date')

    raw_type = body.get('event_type')
    try:
        event_type = EventType(str(raw_type).upper())
    except (ValueError, AttributeError):
        allowed = ", ".join(kind.value for kind in EventType)
        raise _InvalidBody(
            f"event_type {raw_type!r} is not one of {allowed}", 'event_type')

    fields = {name: _text_member(body, name) for name in _EVENT_TEXT_FIELDS}
    fields.update({name: _number_member(body, name)
                   for name in _EVENT_NUMBER_FIELDS})

    return Event(date=_day_member(body), event_type=event_type, **fields)


def _day_member(body: dict) -> date:
    raw = body.get('date')
    if not isinstance(raw, str) or not _ISO_DAY.fullmatch(raw.strip()):
        raise _InvalidBody(
            f"date {raw!r} is not a calendar day (YYYY-MM-DD)", 'date')
    try:
        return date.fromisoformat(raw.strip())
    except ValueError:
        raise _InvalidBody(f"date {raw!r} is not a day that exists", 'date')


def _text_member(body: dict, name: str) -> Optional[str]:
    """A string member, blank read as absent — the empty cell of a CSV."""
    raw = body.get(name)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise _InvalidBody(f"{name} must be text", name)
    return raw.strip() or None


def _number_member(body: dict, name: str) -> Optional[float]:
    """A numeric member, or ``None``.

    A **bool is refused** rather than read as ``1``: Python says ``True`` is an
    integer and a quantity of ``true`` is not a quantity. Text is refused too —
    the decimal comma a French reader types is parsed by the form that shows it
    (``lib/ledger.ts``), and a second parser here would be a second convention
    for the same character.
    """
    raw = body.get(name)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise _InvalidBody(f"{name} must be a number", name)
    return float(raw)


# --------------------------------------------------------------------- #
# Export — the ledger back out, in the format it comes in (issue #710)
# --------------------------------------------------------------------- #

#: What the two exported files are called when a browser saves them. Plain
#: names, because a re-import identifies a source by its **file name** (spec
#: #695 § 6): a name carrying a date would make every export a new source, and
#: restoring twice would double the ledger instead of replacing it.
#:
#: **Issue #728 asks for the date and does not get it**, and the arbitration is
#: written here rather than left for the next reader to redo. The two exports of
#: one install describe one ledger, the later a superset of the earlier; under
#: dated names both are droppable side by side and every event they share is
#: recorded twice, in silence. Under one name the second simply replaces the
#: first on the reader's own disk, which is the protection. Giving the date back
#: would need a rule on the *import* side that no criterion asks for, so the
#: criterion is refused rather than half-met — and the file's own date is on the
#: import list, in `Importé le`, which is where a reader looks for it.
EXPORT_FILENAMES = {
    'events': 'suivi-bourse-events.csv',
    'accounts': 'suivi-bourse-accounts.csv',
}


@api_bp.get('/export/events.csv')
def export_events():
    """Every event, as a file this app imports.

    The gesture that makes *"can I go back?"* answerable in one sentence, and
    the reason a backup is not only a binary DuckDB file. It is on the API and
    not only on a page, for the reason ``PUT /api/settings`` is: *headless means
    without an interface, not without HTTP* — one ``curl`` is a complete backup,
    and the page is one client of it.

    Read from the **store**, not from the published snapshot. The two hold the
    same rows on the common path, and they part exactly where it matters: a
    snapshot the validator refused leaves the previous one standing (#658), so
    an export taken from it would quietly hand back a ledger from before the
    last import. What is exported is what is stored.

    ``base_currency`` rides on every row, and is blank when the install has never
    answered the question — see :mod:`events.export` for why a column rather
    than a preamble, and why it is not called ``currency``.
    """
    opened = _store()
    return _csv_response(
        events_export.render_events(ledger.read_events(opened),
                                    opened.setting('base_currency')),
        EXPORT_FILENAMES['events'])


@api_bp.get('/export/accounts.csv')
def export_accounts():
    """Every **declared** account, as a file this app imports (issue #698).

    The other half of a round trip that is actually round: an event file naming
    ``pea`` is refused whole where nothing declares ``pea``, so exporting the
    events alone would restore a multi-account install into a refusal. Two files
    and not one because that is the format — a file is an accounts source or an
    event source according to its header, never both.

    The seeded ``default`` row is **not** in it unless something changed it: it
    is on every install and nobody declared it, so writing it out would turn "I
    declared nothing" into a declaration — and re-importing that would hand the
    one row every install owns a ``source_id``, making it read-only and
    forgettable, which is exactly what ADR-0013 keeps it from being.
    """
    return _csv_response(
        events_export.render_accounts(events_export.declared_accounts(
            accounts_module.read_accounts(_store()),
            store_module.DEFAULT_ACCOUNT_ROW)),
        EXPORT_FILENAMES['accounts'])


def _csv_response(body: str, filename: str) -> Response:
    """One exported file on the wire.

    ``attachment`` rather than an inline body: the browser's own *Save as* is
    the whole of the interface this gesture needs, and a CSV rendered in a tab
    is a backup nobody took. The charset is stated because the ledger carries
    the user's own text — a share called *Société Générale* read as latin-1 is a
    file that re-imports with a mangled name.
    """
    return Response(body, mimetype='text/csv', headers={
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': f'attachment; filename="{filename}"',
    })


# --------------------------------------------------------------------- #
# Imports: the unit of revocation (issue #697)
# --------------------------------------------------------------------- #

@api_bp.get('/imports')
def list_imports():
    """The imports the store holds, each with the number of events it carried.

    The count is not decoration: forgetting an import is destructive in bulk, so
    how many rows the gesture takes with it belongs next to the gesture that
    offers it.

    ``200`` + ``[]`` on an install that has imported nothing — the empty
    collection, never an error.
    """
    records = ledger.list_imports(_store())
    return jsonify([
        {
            'id': record.id,
            'filename': record.filename,
            'kind': record.kind,
            'imported_at': _iso(record.imported_at),
            'fingerprint': record.fingerprint,
            'events': record.events,
        }
        for record in records
    ])


@api_bp.delete('/imports/<int:source_id>')
def forget_import(source_id: int):
    """Forget an import: every row it laid down, in one gesture.

    **The only gesture that reaches an imported row, and the only one there will
    be.** Read-only forbids editing line 42 of ``broker.csv``; it does not
    forbid revoking the file. Without this, a line provisioned by a file would
    be at once unalterable and indestructible — which is the trap #697 exists to
    avoid.

    That sentence used to end *"...and why the absence of a*
    ``PATCH /api/events/<id>`` *is a decision rather than an omission"*, and
    issue #764 makes it **imprecise rather than false**: the route exists now,
    and what it will not touch is exactly this population. The argument was
    always about a row *a file provisioned* — the file and the store must not
    become two truths about one purchase, and revoking the file is what is
    offered instead. It never covered a row somebody typed here a minute ago,
    which comes from no file and which no revocation can reach; refusing to edit
    that one made a typo in the onboarding form (ADR-0005) permanent. So the
    population is named, the sibling routes refuse an imported row by name
    (``409``, quoting the import to forget), and the two texts say one thing.

    The replay follows the write, synchronously and in this process (issue
    #697): the caller has just changed the ledger, and must not have to wait for
    a timer to see the effect of their own gesture.

    Removing the *file* from disk is not this gesture and never will be — the
    store is the truth, so a deleted file changes nothing at all.

    **An accounts import is refused while an event names one of its accounts**
    (``409``, issue #698). Cascading — taking the events with it — is what the
    refusal exists instead of: the gesture is meant to be reversible by
    re-dropping the file, and one that deleted a year of events on the way out
    would not be. The answer names the account, so the order to follow is
    readable from the error: forget the event imports first.
    """
    runtime = current_runtime()
    try:
        # The same mutex the account writes take: a revocation is two
        # statements, and an ingestion transaction running between them in
        # another thread would take them into its own rollback.
        with runtime.config_manager.writing() as opened:
            removed = ledger.forget_import(opened, source_id)
    except ledger.UnknownImport as exc:
        return not_found(str(exc))
    except accounts_module.AccountInUse as exc:
        return conflict(str(exc))

    main.replay_after_write(runtime)
    return jsonify({'id': source_id, 'events_removed': removed})


# --------------------------------------------------------------------- #
# The app's own runtime state (issue #668, design #656)
# --------------------------------------------------------------------- #

@api_bp.get('/runtime')
def get_runtime():
    """What the scheduler is doing — the one thing Grafana cannot do at all.

    Every other item of #652's "what does first-party buy" list, Grafana does
    badly; this one it cannot reach at any price, because none of this is in a
    database. It is scheduler memory, and the web process living *inside* the
    scraper process (#651) is what makes it readable.

    **This route touches no store**, and that is decision 6 rather than an
    optimisation. #659 reserved a ``status`` slot on the shares resource for the
    pills; that resource is a query, and this blueprint answers ``503`` when a
    query fails — so a pill riding there would **disappear exactly when it is the
    only thing able to explain the empty table**. #655's error contract turned
    against itself one storey up, and worse than the original, because the
    diagnostic would die with what it diagnoses. So the slot is retired rather
    than filled, and the pills live here: process memory, the configuration
    snapshot, the APScheduler jobstore. Two resources on one page means two cache
    cadences and two independent failure states — the table can be empty while
    the banner is talkative.

    Decision 4 makes that free: the backfill job already *reads* the oldest
    stored point, so it *remembers* it, and the progress bar survives an
    unreachable database.

    The row set comes from the configuration snapshot and the records are fetched
    one ``get`` per key — never an iteration of a dict the scrape threads are
    writing, which raises ``RuntimeError: dictionary changed size during
    iteration`` and only ever does so in production with forty symbols.
    """
    from web import current_runtime

    runtime = current_runtime()
    recorder = runtime.recorder
    snapshot = runtime.config_manager.current()

    scrape = {}
    backfill = {}
    for share in snapshot.shares:
        symbol = share.get('symbol')
        if not symbol:
            continue
        scrape.setdefault(symbol, recorder.scrape_of(symbol))
        # Every direction the recorder knows, from its own list (issue #704):
        # the pair spelled out here is what left the lateral pass out of this
        # payload on the day it landed.
        for direction in runtime_state.DIRECTIONS:
            backfill[(symbol, direction)] = recorder.backfill_of(
                symbol, direction)

    return jsonify(runtime_view.build_runtime(
        shares=snapshot.shares,
        scrape=scrape,
        backfill=backfill,
        next_runs=_next_runs(runtime.scheduler),
        ingest=recorder.ingest(),
        perf=recorder.perf(),
        now=datetime.now(timezone.utc),
        scheduler_running=runtime.scheduler is not None,
        # ``rebuilding`` (#745, #763), and it keeps this route's one rule: it
        # comes from :meth:`SuiviBourseMetrics.reconstruction_state`, which is
        # the scheduler's own memory — the published windows and
        # ``_backfill_complete`` — and issues no query. A runtime with no metrics
        # cannot see the scheduler at all, and ``None`` is what says so.
        reconstruction=(runtime.metrics.reconstruction_state()
                        if runtime.metrics is not None else None),
        # The mount observation (#741, ADR-0015), made once in the master and
        # carried on the runtime — process memory again, and therefore this
        # route's rule kept: no query, and readable on a store nobody can open,
        # which is exactly when *"where did my data go"* is asked.
        persistence=runtime.store_persistence,
        # Beside it, and read as one line with it (#724): *the path, and whether
        # it survives*. Boot knowledge, so this route's rule holds.
        store_path=(str(runtime.store_path)
                    if runtime.store_path is not None else None),
    ))


def _next_runs(scheduler) -> dict:
    """``symbol -> next_run_time`` for the live per-symbol scrape jobs.

    The one pull kept from the scheduler's internals (#656 déc. 4): it is the
    truth of scheduling, the jobstore is natively locked, and a copied
    ``next_delay`` would be exactly the duplicate decision 2 forbids. It lives
    in :func:`main.scrape_next_runs` because the settings write path reads the
    same times to decide which symbols a new cadence reaches (#701) — two loops
    over the jobstore would eventually classify a symbol two ways in one
    request.

    A symbol **absent** from the result is trap 1 and not an error: a ``date``
    job is removed from the jobstore *while it runs* and re-added at the end of
    ``_scrape_symbol``, so absence means "being scraped right now" **or** "symbol
    departed" — and a cycle can be seconds long, since a rate-limit retry sleeps
    up to 8 s. The pure module renders that as one ambiguous value carrying both
    readings, never as either alone.
    """
    import main

    return main.scrape_next_runs(scheduler)


# --------------------------------------------------------------------- #
# The store itself (issue #724, spec #695 § 10, ADR-0015)
# --------------------------------------------------------------------- #

@api_bp.get('/store')
def get_store():
    """What the installation's store *is*: its size, its last write, its orphans.

    The fourth block of the data page's *installation* tab, and it is split from
    ``/api/runtime`` along the line #668 drew rather than by subject: the path
    and its persistence are **process memory** and ride on the runtime, where
    they stay readable on a store nobody can open — which is exactly when *"where
    did my data go?"* is asked. Everything here needs the file, so it fails with
    it, and the ``503`` is the honest answer.

    Three figures, and each is a different fact:

    * ``size_bytes`` — the file and its write-ahead log (:func:`store.file_size`).
      It is published **because hiding it removes only its explanation**: the
      number is still there for anyone who runs ``du``. What must travel with it
      is what a purge does *not* do — measured, 79 % of a real store's rows
      purged for zero bytes returned.
    * ``ledger_last_write`` — the newest import, and **never the newest observed
      price**. The second is liveness, it belongs to the banner, and shown here
      it would make a store whose last import was a year ago read as freshly
      written.
    * ``orphans`` — the symbols no event names any more, with the size of the
      series each one holds. Kept deliberately (#695 § 10): forgetting an import
      is reversible and a reconstructed series is not. A **sold position is not
      one of them** — its events are still recorded.
    """
    runtime = current_runtime()
    opened = _store()
    return jsonify({
        'size_bytes': store_module.file_size(opened.path),
        'ledger_last_write': _iso(ledger.last_write(opened)),
        'orphans': [
            {'symbol': orphan.symbol, 'points': orphan.points}
            for orphan in ledger.orphan_symbols(opened)
        ],
        # Repeated from ``/api/runtime`` on purpose, and it is the one member
        # here that is not a query: a client rendering this block reads one
        # resource for the three figures and the other for the two facts about
        # the file, and a reader who lands on the block while the store is
        # unreadable still gets the sentence that explains the emptiness.
        'persistence': runtime.store_persistence,
    })


@api_bp.delete('/store/orphans')
def purge_store_orphans():
    """Purge every orphan symbol: its price series, its quote row, itself.

    The gesture #695 § 10 owes in exchange for keeping them. It answers with
    **rows**, never bytes, and the interface says the rest out loud: a purge
    returns rows and not bytes, because the store reuses its blocks.

    ``DELETE`` on the collection rather than a ``POST`` to a verb: the resource
    is *the orphans of this store*, and what the gesture does to it is remove it
    whole. There is no per-symbol form and there will not be one — an orphan is
    a consequence of a forget the owner has just made, not a maintenance list to
    work through row by row.
    """
    runtime = current_runtime()
    # The writers' mutex, like every other write in this blueprint: a Flask
    # handler and the scheduled jobs share one DuckDB connection.
    with runtime.config_manager.writing() as opened:
        symbols, points = ledger.purge_orphan_symbols(opened)
    return jsonify({'symbols': symbols, 'points_removed': points})


# --------------------------------------------------------------------- #
# The advisories (issue #709, spec #695 § 14)
# --------------------------------------------------------------------- #

@api_bp.get('/advisories')
def list_advisories():
    """What this installation has been told, and has not yet acknowledged.

    A **read**, and only a read: the advisories are armed by the jobs that
    observe their sources (``ingest`` for the installation's, the backfill cycle
    for the reconstruction's and the one it produces), never by somebody opening
    a page. A ``GET`` that armed them would date every advisory with the moment a
    browser arrived and log it there too, which is neither where nor when it
    happened.

    Each row's **detail is re-derived here** — the path, the variables, the
    events — because the table has three columns and stores nothing else. An
    advisory whose source this process cannot see keeps its row and reports
    ``detail: null``, which is the honest answer and not an error.

    ``200`` + ``[]`` on an install with nothing to say, which is the ordinary
    case and emphatically not a ``404``.
    """
    runtime = current_runtime()
    return jsonify([
        advisory.to_dict() for advisory in advisories.listing(
            _store(),
            main.advisory_context(runtime.config_manager, runtime.metrics))
    ])


@api_bp.post('/advisories/<key>/acknowledgement')
def acknowledge_advisory(key: str):
    """Acknowledge one advisory. The table's only gesture, and the reason it exists.

    A log cannot be acknowledged, which is the whole argument for a table
    (spec #695 § 14): someone may want to keep their v4 ``config.yaml`` beside
    their events for ever, and an app that reproaches them at every boot becomes
    noise one learns to ignore — taking the advisory that matters down with it.

    The acknowledgement **persists**, which a *toast* does not, and that is not a
    refinement either: the assumed-currency advisory arrives at the end of the
    first reconstruction, half an hour after the boot, and an acknowledgement
    living in a browser tab would be gone by the next restart.

    ``404`` covers both refusals — an unknown key, and a key of the five that
    nothing stands under — because they are the same answer to the client:
    *there is nothing here to acknowledge*. Acknowledging twice is not an error
    and does not move the date.
    """
    runtime = current_runtime()
    context = main.advisory_context(runtime.config_manager, runtime.metrics)
    try:
        # The writers' mutex, like every other write in this blueprint: a Flask
        # handler and the scheduled jobs share one DuckDB connection.
        with runtime.config_manager.writing() as opened:
            advisory = advisories.acknowledge(opened, key, context)
    except advisories.UnknownAdvisory:
        return not_found(f"No advisory is named {key!r}")
    except advisories.AdvisoryNotStanding:
        return not_found(f"Nothing is standing under the advisory {key!r}")

    return jsonify(advisory.to_dict())


# --------------------------------------------------------------------- #
# The configuration itself (issue #662)
# --------------------------------------------------------------------- #

@api_bp.get('/config')
def get_config():
    """What this installation is configured with.

    ``shares`` is the published snapshot's aggregate — what the event ledger
    *declares*, as opposed to ``/api/positions``, which is what has been
    *observed* of it. Two different questions, and this is the one that can be
    answered with no database at all.

    ``mode``, ``editable`` and ``read_only_reason`` left with #711: there is one
    loading path, so there is no mode to report, and the config directory has no
    write path left to be refused by.

    The payload lands here rather than on ``/api/runtime`` on #661's argument:
    one noun, two consumers. "What is this install running?" is a question about
    the configuration, and putting it on the runtime resource would start that
    resource down the road to a junk drawer.

    Two lists since #701, and the split is ADR-0014's line rather than a
    grouping of convenience:

    * ``settings`` — the dials, read **through the registry** and therefore not
      a second enumeration of them. Each carries its bounds and its effect, so
      the form that renders it validates on the same rule the write path
      enforces, instead of on a copy of that rule.
    * ``environment`` — what the process had to know before it could open the
      store: the two directories, the sockets, the log level. **Six names and
      no seventh** (#740), none of them writable from in here and none of them
      pretending to be. There is no redaction and no flag for one:
      ``INFLUXDB_TOKEN`` was the environment's only secret and it left with the
      database (#700), so the rule died with its subject. Alongside it,
      ``unread_environment`` names what is set in that same environment and no
      longer obeyed — computed, so it cannot drift.

    Reading the dials makes the whole resource depend on the store, and the
    ``503`` that follows an unreadable one is deliberate rather than overlooked:
    since #696 the store is not optional anywhere — the app does not boot
    without it and ``/health`` fails with it — so a ``/api/config`` that
    answered ``200`` while the file was gone would be claiming to describe an
    installation it can no longer read. The resource written to survive a broken
    app is ``/api/runtime`` (#668), which touches nothing at all; the store's
    own location is in the boot log either way.
    """
    import main

    return jsonify({
        'log_level': main.current_log_level(),
        'settings': settings_module.describe(_store()),
        'environment': main.effective_environment(),
        'unread_environment': main.unread_environment(),
        'shares': _snapshot().shares,
    })


@api_bp.put('/settings')
def put_settings():
    """Change one or more dials. The **only** writer of a setting (issue #701).

    That it is an HTTP route is what keeps a headless install whole: *headless
    means without an interface, not without HTTP*, so this is reachable with one
    ``curl`` and the page is only ever one client of it. There is still exactly
    one writer.

    ``422`` for a value the registry refuses — an unknown key, a wrong type, a
    number outside the dial's bounds — because the request is well formed and
    the *content* is what cannot be processed; ``400`` is for a body that is not
    a JSON object at all. Nothing is written on a refusal, not even the keys of
    the same body that were valid.

    The answer **quantifies the effect**, and that is a requirement rather than
    a courtesy. ``regular_interval`` reaches only the symbols whose market is
    open right now, so a portfolio of eleven can see three re-armed and eight
    left to read the new value when they wake — and an interface that answered a
    bare ``200`` would let the reader conclude the other eight are misconfigured.

    What no interface can hide, and what the settings page must therefore say
    out loud: ``regular_interval`` is **also the base of the dead-ticker
    back-off** (#617), whose wait is ``regular_interval × 2^(n−3)`` and not an
    absolute delay stored anywhere. Lowering it shortens, retroactively, the
    wait of a symbol that has been failing since this morning; raising it
    lengthens it. The number in the form is the number in the formula.
    """
    import main

    body = _json_object()
    if body is None:
        return bad_request("a JSON object is required")

    runtime = current_runtime()
    try:
        # The writers' mutex, like every other write in this blueprint: a Flask
        # handler and the ingestion share one DuckDB connection, and a row
        # written between another thread's BEGIN and its ROLLBACK disappears
        # with that transaction after this handler has answered 200.
        with runtime.config_manager.writing() as opened:
            changes = settings_module.save(opened, body)
    except settings_registry.InvalidSetting as exc:
        return unprocessable(str(exc), key=exc.key or None)

    # Strictly after the block — the mutex is not reentrant, and re-arming a job
    # takes no store lock anyway.
    effect = main.apply_settings(runtime, changes)

    return jsonify({
        'settings': settings_module.describe(_store()),
        'changed': [change.key for change in changes],
        'effect': effect,
    })


@api_bp.put('/config/log-level')
def put_log_level():
    """Change the log level for the life of this process.

    #654 found that **0 of 17** settings can be persisted from here — ``.env``
    is a host file the container never sees — so this one is offered as what it
    is and nothing more: a debug toggle that lasts until the next restart. A
    field that silently reverted would be worse than no field.
    """
    import main

    values = _json_object()
    if values is None or 'level' not in values:
        return bad_request("Expected a JSON object with a 'level' field.")

    try:
        level = main.set_log_level(values['level'])
    except ValueError as exc:
        return bad_request(str(exc))
    return jsonify({'log_level': level})


# --------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------- #

def _json_object() -> Optional[dict]:
    """The request body as a JSON object, or ``None`` if it is not one.

    ``silent=True`` matters: Flask's default raises ``BadRequest``, which the
    blueprint's catch-all would render as a ``503`` — telling a client that sent
    a malformed body that the database is down.
    """
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else None


def _flag(value) -> bool:
    """One optional boolean out of a JSON body, and never a truthiness test.

    ``true`` is the only thing that asks — a string, a number or an object does
    not, and reading them as one would make a client's typo perform a write it
    never requested. The absent member is what a client that has never heard of
    the flag sends, and it must mean *no* rather than *whatever the default is*.
    """
    return value is True


def _base_currency() -> Optional[str]:
    """The reporting currency, or ``None`` while the question is unanswered.

    Read through the registry like every other dial (ADR-0014), so *"never
    answered"* and *"answered"* stay the two states the absence of a default
    exists to keep apart. A store error propagates, as everywhere else in this
    blueprint: a head that answered ``200`` with a silent ``null`` currency would
    label every figure on the page with nothing and say the database was fine.
    """
    return _store().setting('base_currency')


def _parse_window(default: timedelta = DEFAULT_WINDOW) -> Tuple[datetime, datetime]:
    """Resolve ``?from=``/``?to=`` into a UTC window, defaulting to ``default``."""
    stop = _parse_instant(request.args.get('to')) or datetime.now(timezone.utc)
    start = _parse_instant(request.args.get('from')) or (stop - default)
    if start >= stop:
        raise ValueError("'from' must be earlier than 'to'")
    return start, stop


def _parse_instant(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO-8601 date or datetime, always returning UTC-aware.

    Accepts a bare date (``2024-01-15``) as midnight UTC, and tolerates the
    ``Z`` suffix ``fromisoformat`` rejected before Python 3.11 — the app targets
    3.10+, so the replacement stays.
    """
    if not value:
        return None
    text = value.strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(f"Not an ISO-8601 instant: {value!r}")
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _iso(value) -> Optional[str]:
    """ISO-8601 for an instant **or** a calendar day.

    Both shapes reach the wire since #700: an observed price carries a
    ``TIMESTAMPTZ`` and a perf point carries a ``DATE``, which is the store's
    two kinds of time arriving unchanged rather than one of them being stamped
    into the other on the way out.
    """
    return value.isoformat() if isinstance(value, (datetime, date)) else None


__all__ = ['api_bp']
