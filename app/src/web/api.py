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
from typing import Any, Callable, Optional, Tuple

from flask import Blueprint, jsonify, request
from logfmt_logger import getLogger

import portfolio_view
import runtime_state
import runtime_view
from config_writer import (
    Clobber,
    ConfigWriteError,
    InvalidCandidate,
    ReadOnlySource,
    SourceUnwritable,
    StaleFingerprint,
    UnknownRow,
    WrongMode,
)
from events.editor import EventEditorReader
from influx_reads import (
    MEASUREMENT,
    TOTALS_MEASUREMENT,
    PortfolioReader,
    bucket_for_window,
)
from web.problem import (
    bad_request,
    conflict,
    invalid_configuration,
    not_found,
    precondition_required,
    read_only_source,
    source_unwritable,
    stale_fingerprint,
    storage_unavailable,
    wrong_mode,
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
    from web import current_runtime
    runtime = current_runtime()
    if runtime.metrics is None:
        raise RuntimeError(
            "the scheduler runtime has not started; no InfluxDB client yet")
    return PortfolioReader.from_writer(runtime.metrics.influxdb)


def _snapshot():
    """The published configuration snapshot — the lock-free read (issue #658)."""
    from web import current_runtime
    return current_runtime().config_manager.current()


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
# Accounts — read-only in this slice
# --------------------------------------------------------------------- #

@api_bp.get('/accounts')
def list_accounts():
    """The **declared** accounts, each with its newest perf figures.

    #652 déc. 4 corrects trap 12 here, and it matters for the shares page's
    global filter. The obvious source would be a ``DISTINCT`` on the ``account``
    tag, but ``validator.py:128-138`` makes every event carry a *declared*
    account once any account is declared — so an account that holds shares
    without being declared cannot exist, and the two lists differ only on
    historical residue (an account since removed, the pre-v4.1 ``default``
    bucket). Reading the declaration also hands over ``label``, ``type`` and
    ``currency``: three fields the app writes and **zero** Grafana panel reads
    (it hardcodes ``currencyEUR``).

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


# --------------------------------------------------------------------- #
# Events — read-only in this slice; the write half belongs to the Data page
# --------------------------------------------------------------------- #

@api_bp.get('/events')
def list_events():
    """The event ledger, addressable row by row.

    Two consumers already, which is why it is a resource and not a page
    endpoint: the data page's ledger (#652 déc. 14) and *this* slice's chart
    markers (déc. 11) — the single thing Grafana structurally cannot draw, since
    it reads one datasource and the events are files.

    ``?symbol=`` narrows to one share's events. Cash events (DEPOSIT /
    WITHDRAWAL) carry no symbol and are therefore excluded by that filter, which
    is what the chart wants.

    Manual mode has no events at all: ``200`` + ``[]``, the empty-collection
    state, not an error.
    """
    from web import current_runtime
    manager = current_runtime().config_manager
    if manager.get_mode() != manager.MODE_EVENTS:
        return jsonify([])

    source = manager.get_events_source()
    if not source:
        return jsonify([])

    records = EventEditorReader(source).list_records()

    symbol = request.args.get('symbol')
    if symbol:
        records = [
            r for r in records
            if r.event is not None and r.event.symbol == symbol
        ]

    return jsonify([record.to_dict() for record in records])


@api_bp.post('/events')
def create_event():
    """Append one event to the ledger.

    The body is the *event*, never a file and a row (#653) — the server decides
    where it lands and the response says where that was, so the front can name
    the file without the contract ever mentioning one.
    """
    values = _json_object()
    if values is None:
        return bad_request("Expected a JSON object describing one event.")
    return _write(lambda: _writer().add_event(values), status=201)


@api_bp.patch('/events/<token>')
def update_event(token: str):
    """Edit one row, under ``If-Match``.

    Partial: only the fields the body names move. The guard is required, not
    optional — an unguarded write is exactly the silent edit of the wrong row
    the fingerprint exists to prevent.
    """
    values = _json_object()
    if values is None:
        return bad_request("Expected a JSON object of fields to change.")

    if_match = _if_match()
    if if_match is None:
        return precondition_required(
            "An If-Match header carrying the row's etag is required to edit it.")

    return _write(lambda: _writer().update_event(token, if_match, values))


@api_bp.delete('/events/<token>')
def delete_event(token: str):
    """Remove one row, under ``If-Match``."""
    if_match = _if_match()
    if if_match is None:
        return precondition_required(
            "An If-Match header carrying the row's etag is required to delete it.")
    return _write(lambda: _writer().delete_event(token, if_match))


@api_bp.get('/events/files')
def list_event_files():
    """The event files behind the ledger — the lock badge's source.

    File-shaped on purpose, and it is the *only* file-shaped resource here.
    #653 keeps the **event** contract free of files so the store stays
    replaceable; a workbook that cannot be written and the conversion that fixes
    it are properties of a file and of nothing else, so pretending otherwise
    would have bought nothing.
    """
    try:
        return jsonify(_writer().list_files())
    except WrongMode:
        return jsonify([])


@api_bp.post('/events/files')
def import_event_file():
    """Upload a whole event file.

    Refused as a whole if it introduces an error the directory did not already
    have — which is not the rule an in-place edit follows, and the asymmetry is
    the point: the user still holds the file they uploaded and can correct it,
    where a refused edit would leave them unable to repair the ledger at all.
    """
    upload = request.files.get('file')
    if upload is None or not upload.filename:
        return bad_request(
            "Expected a multipart upload with a 'file' part.")
    return _write(
        lambda: _writer().import_file(upload.filename, upload.read()),
        status=201)


@api_bp.post('/events/files/<name>/convert')
def convert_event_file(name: str):
    """Convert a workbook to the CSV that replaces it.

    The workbook is kept, renamed out of the loader's view rather than deleted:
    it is read-only here *because* its owner may still compute in it, so
    destroying it would contradict the reason the restriction exists.
    """
    return _write(lambda: _writer().convert_file(name))


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
    manager = runtime.config_manager
    recorder = runtime.recorder
    snapshot = manager.current()

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
        mode=manager.get_mode(),
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
    """What kind of installation this is, and whether it can be edited.

    Asked once by the data page, which has two entirely different screens to
    choose between. ``mode`` decides which; ``editable`` decides whether the
    events one offers buttons at all, and stating it up front is what keeps an
    unwritable mount — the map's open PaaS fog, where a platform that never ran
    ``make init`` runs as ``1000:1000`` — a sentence instead of a mystery on
    first save.

    ``shares`` is the published snapshot's aggregate, and it is the manual-mode
    screen's whole content: an install with no events still has a portfolio, and
    it is `config.yaml`'s. Reading it from the snapshot rather than from
    InfluxDB is deliberate — the question here is *what is declared*, not what
    has been observed.

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
    manager = runtime.config_manager
    editable, reason = runtime.config_writer.can_write()

    return jsonify({
        'mode': manager.get_mode(),
        'editable': editable,
        'read_only_reason': reason,
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


@api_bp.put('/accounts')
def put_accounts():
    """Rewrite the ``accounts:`` block of ``settings.yaml``.

    Hot since #658 — the file joined the mtime cache key — so this takes effect
    on the next reload rather than the next restart, which is what makes it an
    editor rather than a form that lies.

    The rejection worth knowing about is not the malformed block: it is dropping
    an account that events still reference. ``validator.py:128-138`` makes every
    event carry a *declared* id once any account is declared, so removing one
    invalidates every event that names it — and since #658 an invalid
    configuration is fatal at boot. The candidate is therefore validated against
    the events on disk, and a removal that would strand them comes back as a
    ``422`` with the events named.
    """
    values = _json_object()
    if values is None or 'accounts' not in values:
        return bad_request(
            "Expected a JSON object with an 'accounts' list "
            "(send an empty list to remove the declaration).")
    return _write(lambda: _writer().set_accounts(values['accounts'] or None))


# --------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------- #

def _writer():
    """The process's single :class:`config_writer.ConfigWriter`.

    One instance, because the mutex *is* the instance: two writers would each
    validate a candidate against a directory the other is about to change.
    """
    from web import current_runtime
    return current_runtime().config_writer


def _json_object() -> Optional[dict]:
    """The request body as a JSON object, or ``None`` if it is not one.

    ``silent=True`` matters: Flask's default raises ``BadRequest``, which the
    blueprint's catch-all would render as a ``503`` — telling a client that sent
    a malformed body that the database is down.
    """
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else None


def _if_match() -> Optional[str]:
    """The ``If-Match`` etag, unwrapped, or ``None`` when absent.

    A conforming client quotes it and may mark it weak; the front sends it bare.
    Both are accepted and normalised here rather than in the writer, which
    compares fingerprints and should not also know HTTP's syntax.
    """
    raw = (request.headers.get('If-Match') or '').strip()
    if not raw:
        return None
    if raw.startswith('W/'):
        raw = raw[2:].strip()
    return raw.strip('"')


def _write(action: Callable[[], Any], status: int = 200):
    """Run a write and translate its refusals into problem+json.

    One place for the mapping, because the statuses are a contract the front
    branches on and scattering them across six routes is how two of them end up
    disagreeing. The order of the clauses is load-bearing: every one of these is
    a :class:`ConfigWriteError`, so the general case must come last.
    """
    try:
        result = action()
    except InvalidCandidate as exc:
        return invalid_configuration(exc.errors)
    except StaleFingerprint as exc:
        return stale_fingerprint(str(exc))
    except (ReadOnlySource,) as exc:
        return read_only_source(str(exc))
    except SourceUnwritable as exc:
        return source_unwritable(str(exc))
    except WrongMode as exc:
        return wrong_mode(str(exc))
    except Clobber as exc:
        return conflict(str(exc))
    except UnknownRow as exc:
        return not_found(str(exc))
    except ValueError as exc:
        # The `accounts:` block's own validation, which raises rather than
        # collecting — a malformed declaration is still an invalid
        # configuration, and the front reads it in the same place as the rest.
        return invalid_configuration([str(exc)])
    except ConfigWriteError as exc:
        return bad_request(str(exc))
    except OSError as exc:
        # The write itself failed on the filesystem. Not a storage outage and
        # not the client's fault: the mount is the thing to look at.
        logger.error(f"Configuration write failed: {exc}", exc_info=True)
        return source_unwritable(str(exc))

    response = jsonify(result.to_dict())
    response.status_code = status
    return response


def _portfolio_mode() -> Tuple[str, Optional[Any]]:
    """Which dashboard head this install gets, plus the declaration behind it.

    A read of the published snapshot (#658) and of the configuration mode —
    no InfluxDB. That is deliberate: deciding the mode from the *data* would
    make an install whose first perf cycle has not run yet indistinguishable
    from one that never declared accounts, which is exactly the collapse #655
    déc. 8's discriminator exists to prevent.
    """
    from web import current_runtime
    manager = current_runtime().config_manager
    accounts = manager.current().accounts
    currencies = [a.currency for a in accounts.accounts] if accounts else None
    mode = portfolio_view.portfolio_mode(
        currencies, manager.get_mode() == manager.MODE_EVENTS)
    return mode, accounts


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
