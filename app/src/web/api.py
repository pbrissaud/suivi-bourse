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

    No id and no etag: both were properties of an address, and there is no
    address any more. ``account`` is reported as the aggregator resolves it —
    blank means ``default``, which is the rule for an install that declared no
    account.
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
    }


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
