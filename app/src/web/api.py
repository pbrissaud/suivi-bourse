"""The ``/api`` blueprint — the disposable half (issue #659, design #655).

#655 decision 1 is what shapes this file: **the for-keeps boundary is Python,
not HTTP**. What must last is :mod:`influx_reads` and :mod:`portfolio_view` —
the SQL window, the weighted mean, the three states of absence. A route that
calls a primitive and ``jsonify``s is five lines, and is as throwaway as the
React on the other side of it.

So the rules here are thin on purpose. What the routes *do* own:

* **Shape.** RESTful, resource by resource, because resources deduplicate
  across pages: #652 déc. 8 serves the shares table *and* the dashboard's
  allocation + movers from one query, and a page-shaped endpoint would have
  re-split what that decision unified. ``/api/shares`` with two consumers and
  one client cache is the HTTP expression of it.
* **Windows on series sub-resources only.** #652 déc. 1 made stats absolute;
  the window drives charts alone, so it appears on ``/prices`` and nowhere else.
* **Symbols as identity.** Trap 9 / déc. 3 — ``share_name`` is display only.
"""
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Tuple

from flask import Blueprint, jsonify, request
from logfmt_logger import getLogger

import accounts as accounts_module
import ledger
import main
import portfolio_view
import runtime_state
import runtime_view
from influx_reads import (
    MEASUREMENT,
    TOTALS_MEASUREMENT,
    PortfolioReader,
    bucket_for_window,
)
from web.problem import (
    bad_request,
    conflict,
    not_found,
    storage_unavailable,
)

logger = getLogger("web.api")

api_bp = Blueprint('api', __name__, url_prefix='/api')

#: Default chart window when the client asks for none. Short on purpose: the
#: ``REGULAR`` cadence is one point every 120 s, so a month is already a few
#: thousand points and a year is fifty thousand.
DEFAULT_WINDOW = timedelta(days=30)

#: The dashboard's default, and it is an order of magnitude wider for a reason
#: that is not taste: the global series is written **one point per calendar day**
#: at midnight, so a month of it is thirty points and a day of it is one. #660's
#: trap — the short presets that are natural on the shares page are degenerate
#: here, and the window this endpoint defaults to has to reflect that.
DEFAULT_HISTORY_WINDOW = timedelta(days=365)


def _reader() -> PortfolioReader:
    """A reader over the worker's InfluxDB client.

    Built per request, which is free — it holds nothing but the bound ``query``
    of the pool created in ``post_fork``. Raises when the runtime has not
    started, which under gunicorn cannot happen (the socket is not served until
    the worker is up) but does in tests.
    """
    runtime = current_runtime()
    if runtime.metrics is None:
        raise RuntimeError(
            "the scheduler runtime has not started; no InfluxDB client yet")
    return PortfolioReader.from_writer(runtime.metrics.influxdb)


def _snapshot():
    """The published configuration snapshot — the lock-free read (issue #658)."""
    return current_runtime().config_manager.current()


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

    This is the point of the sibling read module: the writer swallows and
    returns ``None``, this blueprint lets the exception travel and answers
    ``503``. The two policies coexist in one process because they live in two
    modules (#655 decision 5).
    """
    logger.error(f"API error on {request.path}: {exc}", exc_info=True)
    return storage_unavailable(str(exc))


# --------------------------------------------------------------------- #
# Shares
# --------------------------------------------------------------------- #

@api_bp.get('/shares')
def list_shares():
    """The shares table — one row per share, aggregated across accounts.

    P1 generalised: **one** query for the whole portfolio (#652 déc. 8), folded
    by the pure module. Empty portfolio is ``200`` + ``[]``, never a 404.
    """
    rows = _reader().latest_per_account()
    shares = portfolio_view.build_shares(rows)
    return jsonify([share.to_dict() for share in shares])


@api_bp.get('/shares/<symbol>')
def get_share(symbol: str):
    """One share's detail sheet: the aggregate plus its per-account breakdown."""
    rows = _reader().latest_per_account(share_symbol=symbol)
    share = portfolio_view.build_share(rows, symbol)
    if share is None:
        return not_found(f"No stored data for symbol {symbol!r}")
    return jsonify(share.to_dict())


@api_bp.get('/shares/<symbol>/prices')
def get_share_prices(symbol: str):
    """The price series behind the chart, over ``?from=``/``?to=``.

    The one place a window exists. Wide windows are served downsampled — see
    :func:`influx_reads.bucket_for_window`; the response says which bucket it
    used so the chart is never silently lying about its resolution.

    Gaps are returned as gaps (#606): a weekend is missing rows, not zeros, and
    whether to bridge them is the chart's call — ``connectNulls`` is a
    per-series prop, and #650's trap 5 records that the two Grafana dashboards
    deliberately disagree about it.
    """
    try:
        start, stop = _parse_window()
    except ValueError as exc:
        return bad_request(str(exc))

    reader = _reader()
    bucket = bucket_for_window((stop - start).total_seconds() / 86400)
    if bucket is None:
        rows = reader.raw_series(symbol, start, stop)
    else:
        rows = reader.bucketed_series(symbol, bucket, start, stop)

    return jsonify({
        'symbol': symbol,
        'from': start.isoformat(),
        'to': stop.isoformat(),
        'bucket': bucket,
        'points': [
            {'t': _iso(row.get('time')), 'price': row.get('share_price')}
            for row in rows
        ],
    })


# --------------------------------------------------------------------- #
# Portfolio — the consolidated dashboard (issue #660)
# --------------------------------------------------------------------- #

@api_bp.get('/portfolio')
def get_portfolio():
    """The dashboard head, as a **discriminated union** (#655 déc. 8).

    ``mode`` is decided from the configuration — declared accounts, their
    currencies, whether events are in play — never from whether the series has
    rows, so "you have not declared accounts" and "the perf job has not run yet"
    stay two different screens. Each mode carries its own fields; #652 déc. 6's
    **Gain** and **plus-value latente** therefore never share a key.

    ``?since=`` is the relative delta of #652 déc. 2 — a UI preference applied to
    the head, explicitly *decoupled* from the chart's zoom, which is why it is a
    baseline **instant** here rather than a window. Windows still live on series
    sub-resources only (déc. 1).
    """
    # Parsed before the mode is even looked at, and deliberately so: doing it
    # inside the `accounts` branch made a malformed instant a 400 there and a
    # silent no-op in the other two, so the same request answered differently
    # depending on a configuration the caller cannot see. A request is malformed
    # or it is not.
    try:
        since = _parse_instant(request.args.get('since'))
    except ValueError as exc:
        return bad_request(str(exc))

    mode, accounts = _portfolio_mode()

    if mode == portfolio_view.MODE_MULTI_CURRENCY:
        return jsonify(portfolio_view.build_multi_currency_head(accounts.accounts))

    reader = _reader()
    if mode == portfolio_view.MODE_TITRES:
        shares = portfolio_view.build_shares(reader.latest_per_account())
        return jsonify(portfolio_view.build_titres_head(shares))

    baseline_value = None
    if since is not None:
        baseline_value = reader.value_at(TOTALS_MEASUREMENT, 'total_value', since)

    # In this mode every declared account shares one currency — that is what
    # made it this mode — so the first declaration answers for all of them.
    currency = accounts.accounts[0].currency if accounts.accounts else None
    return jsonify(portfolio_view.build_totals_head(
        reader.latest_totals(), currency, since, baseline_value))


@api_bp.get('/portfolio/history')
def get_portfolio_history():
    """The main chart: total value vs net contributed (#652 déc. 7).

    The area between the two curves *is* the Gain — the headline figure made
    visible over time, answering "did I gain because it went up or because I put
    more in", which a value curve alone cannot. It has no equivalent at global
    level in the Grafana baseline, which shows this shape per account only.

    Discriminated like the head, and the field names carry the distinction:
    ``contributed`` in ``accounts`` mode is money the investor put in, while
    ``invested`` in ``titres`` mode is the cost of the positions. Two different
    curves telling two different stories; giving them one name is how they would
    end up conflated.

    No ``currency`` in the payload — the head owns it. In ``titres`` mode it can
    only be learned by reading the shares, and an endpoint whose payload changes
    shape by mode for an incidental reason is worse than one rule: the page
    fetches both, and the head is where the currency question is already asked.
    """
    mode, _ = _portfolio_mode()
    try:
        start, stop = _parse_window(DEFAULT_HISTORY_WINDOW)
    except ValueError as exc:
        return bad_request(str(exc))

    payload = {'mode': mode, 'from': start.isoformat(), 'to': stop.isoformat()}

    if mode == portfolio_view.MODE_MULTI_CURRENCY:
        # Nothing to draw and nothing to invent: `portfolio_totals` is not
        # written for a mixed-currency portfolio, and summing the per-account
        # series would be adding euros to dollars.
        return jsonify({**payload, 'points': []})

    reader = _reader()
    if mode == portfolio_view.MODE_TITRES:
        rows = reader.daily_position_series(start, stop)
        return jsonify({**payload, 'points': portfolio_view.valuation_series(rows)})

    return jsonify({**payload, 'points': [
        {
            't': _iso(row.get('time')),
            'value': row.get('total_value'),
            'contributed': row.get('net_contributed'),
        }
        for row in reader.totals_series(start, stop)
    ]})


@api_bp.get('/portfolio/movers')
def get_portfolio_movers():
    """What moved since the last session close (#652 déc. 8).

    Two queries, and the second is the point: the current side is P1 — the very
    query ``/api/shares`` runs, so the front holds it in one cache — and the
    baseline is one ``values_at`` giving every symbol's last price at or before
    the previous close. Running P1 again here rather than bolting a
    ``previous_price`` onto ``/api/shares`` keeps the extra read off the shares
    page, which does not want it, and keeps the "since the last close" rule and
    its arithmetic in one tested place instead of half in TypeScript.

    Works in every mode, including the multi-currency one the head refuses:
    a percentage move carries no currency, and every row states its own for the
    amounts that do.
    """
    reader = _reader()
    rows = reader.latest_per_account()

    times = [row['time'] for row in rows if isinstance(row.get('time'), datetime)]
    if not times:
        return jsonify({'since': None, 'reference': None, 'movers': []})

    since = portfolio_view.session_baseline_instant(max(times))
    baseline = reader.values_at(
        MEASUREMENT, 'share_price', since, partition_by='share_symbol')
    movers = portfolio_view.build_movers(portfolio_view.build_shares(rows), baseline)

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
    ``/api/shares`` serves the table and the dashboard's allocation. Splitting
    the declaration from its figures would be the page-shaped endpoint that
    decision rejected, under another name.

    ``declared: false`` is a *designed* state, not an empty one — the opt-out
    setup every default install runs. Stating it explicitly rather than letting
    the front infer it from ``[]`` is #655 decision 8's discriminator rule. It is
    also what keeps the enrichment free for that install: with no declaration
    there is no query, so the default setup's shares filter still cannot fail on
    a database it never reads.
    """
    accounts = _snapshot().accounts
    if accounts is None:
        return jsonify({'declared': False, 'accounts': []})

    rows = _reader().latest_account_metrics() if accounts.accounts else []
    return jsonify({
        'declared': True,
        'accounts': [
            summary.to_dict()
            for summary in portfolio_view.build_accounts(accounts.accounts, rows)
        ],
    })


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

    No ``currency`` in the payload — the collection owns it, per the same rule
    ``/api/portfolio/history`` follows.
    """
    accounts = _snapshot().accounts
    declared = accounts.get(account_id) if accounts is not None else None
    if declared is None:
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
                't': _iso(row.get('time')),
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
            account = accounts_module.create_account(
                opened, body.get('id'), body.get('type'), body.get('label'))
    except accounts_module.DuplicateAccount as exc:
        return conflict(str(exc))
    except accounts_module.AccountSourceError as exc:
        return bad_request(str(exc))

    main.replay_after_write(runtime)
    return jsonify(_account_to_dict(account)), 201


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
# Events — read-only, and read-only is now the whole of it (issue #711)
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
    aggregator actually ran on, in the order it sorted them, and nothing
    addresses them.

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
    """
    return {
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
        'provenance': ledger.provenance_label(event),
    }


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

    **The only destructive gesture in the API, and there is deliberately no
    sibling that edits one event.** Read-only forbids editing line 42 of
    ``broker.csv``; it does not forbid revoking the file. Without this, a line
    provisioned by a file would be at once unalterable and indestructible —
    which is the trap #697 exists to avoid, and why the absence of a
    ``PATCH /api/events/<id>`` is a decision rather than an omission.

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
    badly; this one it cannot reach at any price, because none of this is in
    InfluxDB. It is scheduler memory, and the web process living *inside* the
    scraper process (#651) is what makes it readable.

    **This route touches no InfluxDB**, and that is decision 6 rather than an
    optimisation. #659 reserved a ``status`` slot on ``/api/shares`` for the
    pills; ``/api/shares`` is a query, and this blueprint answers ``503`` when a
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
        account = str(share.get('account') or runtime_view.DEFAULT_ACCOUNT)
        scrape.setdefault(symbol, recorder.scrape_of(symbol))
        for direction in (runtime_state.BACKWARD, runtime_state.FORWARD):
            backfill[(symbol, account, direction)] = recorder.backfill_of(
                symbol, account, direction)

    return jsonify(runtime_view.build_runtime(
        shares=snapshot.shares,
        scrape=scrape,
        backfill=backfill,
        next_runs=_next_runs(runtime.scheduler),
        ingest=recorder.ingest(),
        perf=recorder.perf(),
        now=datetime.now(timezone.utc),
        scheduler_running=runtime.scheduler is not None,
    ))


def _next_runs(scheduler) -> dict:
    """``symbol -> next_run_time`` for the live per-symbol scrape jobs.

    The one pull kept from the scheduler's internals (#656 déc. 4): it is the
    truth of scheduling, the jobstore is natively locked, and a copied
    ``next_delay`` would be exactly the duplicate decision 2 forbids.

    A symbol **absent** from the result is trap 1 and not an error: a ``date``
    job is removed from the jobstore *while it runs* and re-added at the end of
    ``_scrape_symbol``, so absence means "being scraped right now" **or** "symbol
    departed" — and a cycle can be seconds long, since a rate-limit retry sleeps
    up to 8 s. The pure module renders that as one ambiguous value carrying both
    readings, never as either alone.
    """
    if scheduler is None:
        return {}
    import main

    runs = {}
    for job in (scheduler.get_jobs() or []):
        job_id = getattr(job, 'id', '') or ''
        if job_id.startswith(main.SCRAPE_JOB_PREFIX):
            symbol = job_id[len(main.SCRAPE_JOB_PREFIX):]
            runs[symbol] = getattr(job, 'next_run_time', None)
    return runs


# --------------------------------------------------------------------- #
# The configuration itself (issue #662)
# --------------------------------------------------------------------- #

@api_bp.get('/config')
def get_config():
    """What this installation is configured with.

    ``shares`` is the published snapshot's aggregate — what the event ledger
    *declares*, as opposed to ``/api/shares``, which is what has been *observed*
    of it. Two different questions, and this is the one that can be answered
    with no database at all.

    ``mode``, ``editable`` and ``read_only_reason`` left with #711: there is one
    loading path, so there is no mode to report, and the config directory has no
    write path left to be refused by.

    ``settings`` is #654's read-only **effective configuration**, and it lands
    here rather than on ``/api/runtime`` on #661's argument: one noun, two
    consumers. "What is this container running?" is a question about the
    configuration, the data page is already the screen that asks it, and putting
    it on the runtime resource would start that resource down the road to a junk
    drawer. The list is the one the *app reads* — see
    :data:`main.SETTINGS_INVENTORY` for why that has to be said out loud — and
    ``INFLUXDB_TOKEN`` is redacted by name, since the prototype has no
    authentication.
    """
    from web import current_runtime
    import main

    runtime = current_runtime()

    return jsonify({
        'log_level': main.current_log_level(),
        'settings': main.effective_settings(runtime.metrics),
        'shares': _snapshot().shares,
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


def _portfolio_mode() -> Tuple[str, Optional[Any]]:
    """Which dashboard head this install gets, plus the declaration behind it.

    A read of the published snapshot (#658) — no InfluxDB. That is deliberate:
    deciding the mode from the *data* would make an install whose first perf
    cycle has not run yet indistinguishable from one that never declared
    accounts, which is exactly the collapse #655 déc. 8's discriminator exists
    to prevent.
    """
    accounts = _snapshot().accounts
    currencies = [a.currency for a in accounts.accounts] if accounts else None
    return portfolio_view.portfolio_mode(currencies), accounts


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
    return value.isoformat() if isinstance(value, datetime) else None


__all__ = ['api_bp']
