"""The health route for SuiviBourse (issue #651, deepened by #696 and #818)."""
from datetime import datetime, timezone

from flask import Blueprint

from application import runtime_view
from application.scrape import scrape_next_runs
from api import problem

health_bp = Blueprint('health', __name__)


@health_bp.get('/health')
def health():
    """Answer 200 when the worker is serving *and* the store answers."""
    from api import current_runtime

    runtime = current_runtime()
    open_store = runtime.store
    if open_store is None:
        return problem.storage_unavailable('The store is not open')

    try:
        open_store.ping()
    except Exception as exc:
        return problem.storage_unavailable(f"The store did not answer: {exc}")

    return _jobs(runtime)


def _jobs(runtime) -> dict:
    """The body — what each job last did, out of process memory (issue #818)."""
    now = datetime.now(timezone.utc)
    scheduler_running = runtime.scheduler is not None
    try:
        snapshot = runtime.config_manager.current()
        scrape, backfill = runtime.recorder.records_for(snapshot.shares)
        symbols = runtime_view.build_symbols(
            shares=snapshot.shares,
            scrape=scrape,
            backfill=backfill,
            next_runs=scrape_next_runs(runtime.scheduler),
            now=now,
            scheduler_running=scheduler_running)
        return runtime_view.build_health(
            symbols=symbols,
            perf=runtime.recorder.perf(),
            now=now,
            scheduler_running=scheduler_running)
    except Exception as exc:
        return {
            'status': runtime_view.HEALTH_UNKNOWN,
            'now': now.isoformat(),
            'scheduler_running': scheduler_running,
            'jobs': None,
            'error': f"The jobs could not be read: {exc}",
        }
