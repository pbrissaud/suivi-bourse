"""The installation under ``/api``: runtime, store, facts, advisories, config."""
import threading
from datetime import datetime, timezone

from flask import Blueprint, Response, current_app, jsonify, request
from logfmt_logger import getLogger

from application import advisories
from application import build_info
from application import installation_facts
from application import instants
from application import job_history
from application import journal
from application import ledger
from application import notifications
from application import runtime_view
from application import settings as settings_module
from application import store as store_module
from api.problem import (
    bad_request,
    not_found,
    unprocessable_request,
)
from api.common import (
    _snapshot,
    _store,
    current_runtime,
    _rebuilding,
    _json_object,
    ingestion,
    reconstruction_state,
)

bp = Blueprint('system', __name__)
logger = getLogger("api.system")


@bp.get('/runtime')
def get_runtime():
    """What the scheduler is doing — the one thing Grafana cannot do at all."""
    from api import current_runtime

    runtime = current_runtime()
    recorder = runtime.recorder
    snapshot = runtime.config_manager.current()

    scrape, backfill = recorder.records_for(snapshot.shares)
    last = recorder.history.last_pass(job_history.SCRAPE)

    return jsonify(runtime_view.build_runtime(
        shares=snapshot.shares,
        scrape=scrape,
        backfill=backfill,
        next_runs=_next_runs(runtime.scheduler),
        ingest=recorder.ingest(),
        perf=recorder.perf(),
        now=datetime.now(timezone.utc),
        scheduler_running=runtime.scheduler is not None,
        reconstruction=reconstruction_state(runtime),
        build=runtime.build,
        documentation_url=runtime.documentation_url,
        store_path=(str(runtime.store_path)
                    if runtime.store_path is not None else None),
        database_bytes=(store_module.file_size(runtime.store_path)
                        if runtime.store_path is not None else None),
        quote_response=(last.duration if last is not None else None),
    ))


def _next_runs(scheduler) -> dict:
    """``symbol -> next_run_time`` for the live per-symbol scrape jobs."""
    from application.jobs.scrape import scrape_next_runs

    return scrape_next_runs(scheduler)


@bp.get('/system/release')
def get_release():
    """A newer release than this one, or ``null`` (#1237)."""
    build = current_runtime().build
    if build.source != build_info.RELEASE:
        return jsonify({'latest': None})
    if not settings_module.read_all(_store())['update_check']:
        return jsonify({'latest': None})
    checker = current_app.config['RELEASE_CHECKER']
    latest = checker.latest(build.version, datetime.now(timezone.utc))
    if latest is not None:
        _push_release(latest)
    return jsonify({'latest': latest})


def _push_release(latest) -> None:
    """Hand a newly learnt release to the outbound channels, off the request."""
    runtime = current_runtime()
    threading.Thread(
        target=_sweep_quietly, args=(runtime, latest), daemon=True,
        name='notifications').start()


def _sweep_quietly(runtime, latest) -> None:
    try:
        notifications.sweep(runtime.config_manager, runtime.recorder, release=latest)
    except Exception as exc:
        logger.debug(f"release notification skipped: {type(exc).__name__}: {exc}")


@bp.get('/store')
def get_store():
    """What the installation's store *is*: its size, its last write, its orphans."""
    opened = _store()
    return jsonify({
        'size_bytes': store_module.file_size(opened.path),
        'ledger_last_write': instants.iso(ledger.last_write(opened)),
        'orphans': [
            {'symbol': orphan.symbol, 'points': orphan.points}
            for orphan in ledger.orphan_symbols(opened)
        ],
    })


@bp.delete('/store/orphans')
def purge_store_orphans():
    """Purge every orphan symbol: its price series, its quote row, itself."""
    runtime = current_runtime()
    with runtime.config_manager.writing() as opened:
        symbols, points = ledger.purge_orphan_symbols(opened)
    return jsonify({'symbols': symbols, 'points_removed': points})


@bp.get('/installation-facts')
def list_installation_facts():
    """What this installation has been told, and has not yet acknowledged."""
    runtime = current_runtime()
    return jsonify([
        fact.to_dict() for fact in installation_facts.listing(
            _store(),
            installation_facts.observe(ingestion(runtime)))
    ])


@bp.post('/installation-facts/<key>/acknowledgement')
def acknowledge_installation_fact(key: str):
    """Acknowledge one installation fact — the table's only gesture, and the reason it exists."""
    runtime = current_runtime()
    context = installation_facts.observe(ingestion(runtime))
    try:
        with runtime.config_manager.writing() as opened:
            fact = installation_facts.acknowledge(opened, key, context)
    except installation_facts.UnknownFact:
        return not_found(f"No installation fact is named {key!r}")
    except installation_facts.FactNotStanding:
        return not_found(
            f"Nothing is standing under the installation fact {key!r}")

    return jsonify(fact.to_dict())


@bp.get('/advisories')
def list_advisories():
    """What this portfolio says about itself — the inventory, or the reading.

    ``?register=user`` is the bell's (a late price, an update); ``system`` is
    the System page's; without it, both.
    """
    register = request.args.get('register')
    if register not in (None, advisories.REGISTER_USER, advisories.REGISTER_SYSTEM):
        return unprocessable_request(
            "The register is 'user' or 'system'", key='register')
    read = (advisories.standing
            if request.args.get('asleep') == 'include'
            else advisories.listing)
    return jsonify([one.to_dict()
                    for one in read(_store(), rebuilding=_rebuilding(),
                                    register=register,
                                    recorder=current_runtime().recorder,
                                    release=_known_release())])


def _known_release():
    """The newer release the check has **already** learnt, or ``None``; asks no one."""
    build = current_runtime().build
    if build.source != build_info.RELEASE:
        return None
    if not settings_module.read_all(_store())['update_check']:
        return None
    return current_app.config['RELEASE_CHECKER'].known(build.version)


@bp.post('/advisories/<key>/acknowledgement')
def acknowledge_advisory(key: str):
    """Put one advisory to sleep for thirty days — and never for good."""
    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            advisory, acknowledged = advisories.acknowledge(
                opened, key, rebuilding=_rebuilding(),
                recorder=runtime.recorder, release=_known_release())
    except advisories.UnknownAdvisory:
        return not_found(f"No advisory is standing under {key!r}")

    return jsonify({
        **advisory.to_dict(),
        'acknowledged_until': acknowledged.to_dict()['expires_at'],
    })


@bp.get('/config')
def get_config():
    """What this installation is configured with."""
    from application import main

    return jsonify({
        'log_level': main.current_log_level(),
        'settings': settings_module.describe(_store()),
        'unread_environment': installation_facts.unread_environment(),
        'shares': _snapshot().shares,
    })


@bp.put('/config/log-level')
def put_log_level():
    """Change the log level for the life of this process."""
    from application import main

    values = _json_object()
    if values is None or 'level' not in values:
        return bad_request("Expected a JSON object with a 'level' field.")

    try:
        level = main.set_log_level(values['level'])
    except ValueError as exc:
        return bad_request(str(exc))
    return jsonify({'log_level': level})


def _log_directory():
    path = current_runtime().store_path
    return path.parent / 'logs' if path is not None else None


@bp.get('/logs')
def get_logs():
    """The journal, newest first; poll with ``cursor`` for what came after."""
    args = request.args
    try:
        cursor = int(args.get('cursor') or 0)
        since = (datetime.fromisoformat(args['since'])
                 if args.get('since') else None)
    except ValueError:
        return bad_request("'cursor' is an integer and 'since' an ISO 8601 instant.")
    if since is not None and since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    rows, last = journal.RING.select(
        level=args.get('level'), job=args.get('job'), since=since,
        q=args.get('q'), cursor=cursor)
    return jsonify({'rows': rows, 'cursor': last})


@bp.get('/logs/download')
def download_logs():
    """The file log, the last seven days of it, as one text."""
    directory = _log_directory()
    if directory is None or not journal.files(directory):
        return not_found("No log file is kept for this installation.")
    return Response(journal.stream(directory), mimetype='text/plain',
                    headers={'Content-Disposition':
                             'attachment; filename="suivi-bourse.log"'})
