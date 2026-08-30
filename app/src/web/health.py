"""The health route for SuiviBourse (issue #651, deepened by #696 and #818).

**Health is said in two registers, and they never mix** (ADR-0036).

The **status code** is for the orchestrator, and its only question is *should
this container be restarted*. Its predicate is the one #696 settled and nothing
here widens it: the worker serves, and the store answers. The rule the route
used to follow — *never touch the database, a healthcheck that depends on it
would restart the app for someone else's outage* — had **lost its subject**
(ADR-0015): there is no longer someone else, the store is a file this process
opens, so an unreachable store is not a remote outage to ride out but this
process being unable to do its job.

The **body** is for a person, and it carries each job — scrape, backfill,
performance — with its last pass and its verdict, plus one word for the whole.
A scrape that has gone silent is **amber with a `200`**: restarting repairs
nothing that yfinance or the market broke, and a probe that reds on a stuck job
turns it into a restart loop that fixes nothing and hides everything. So a job
that is late, wedged or mute is read in the body and **never** in the code.

That body is why the gauges could leave (ADR-0033): with them gone, it *is* the
observability of an install nobody is watching from a dashboard.
"""
from datetime import datetime, timezone

from flask import Blueprint

import main
import runtime_view
from web import problem

health_bp = Blueprint('health', __name__)


@health_bp.get('/health')
def health():
    """Answer 200 when the worker is serving *and* the store answers.

    The route keeps its name. `/healthz` is a Kubernetes idiom and this product
    ships as one self-hosted container whose probe is written into its own image
    (`HEALTHCHECK` in the Dockerfile), so the convention addresses a reader the
    app does not have — examined and declined in ADR-0036, where *affordable* is
    explicitly not accepted as a reason.
    """
    from web import current_runtime

    runtime = current_runtime()
    open_store = runtime.store
    if open_store is None:
        # Before the boot opened the store, or after the teardown closed it. The
        # socket is not bound at either moment (``boot.sequence`` serves between
        # the two), so this is reachable only in a test or an embedding — and
        # "the store is not open" is exactly what it says.
        return problem.storage_unavailable('The store is not open')

    try:
        open_store.ping()
    except Exception as exc:
        # Broad on purpose: the point of the probe is that *whatever* stops the
        # store from answering shows up here rather than as a green light.
        return problem.storage_unavailable(f"The store did not answer: {exc}")

    return _jobs(runtime)


def _jobs(runtime) -> dict:
    """The body — what each job last did, out of process memory (issue #818).

    **It issues no query.** The material exists already: the recorder holds one
    last-pass record per job and :mod:`runtime_view` already knows how to read
    them, so this composes rather than produces. That is not an optimisation
    either — it is what keeps the two registers apart, since a body built from
    the store would fail for reasons the status code has just finished saying it
    does not have.

    **Nothing raised here may reach the status code.** The code answers one
    question and this object is not part of it: a defect in the shaping is not a
    reason to restart the container, and :func:`instants.utc` records what
    that looks like when it happens — a ``TypeError`` deep in the arithmetic,
    surfacing one storey up as a wholly untrue verdict on the store. So the fold
    is guarded, and what it fails to say it says it could not say.
    """
    now = datetime.now(timezone.utc)
    scheduler_running = runtime.scheduler is not None
    try:
        snapshot = runtime.config_manager.current()
        scrape, backfill = runtime.recorder.records_for(snapshot.shares)
        symbols = runtime_view.build_symbols(
            shares=snapshot.shares,
            scrape=scrape,
            backfill=backfill,
            # The jobstore, read through the one function that reads it (#656
            # déc. 4). The body publishes no countdown, but the fold is the same
            # one ``/api/runtime`` performs and a second way of building it is a
            # second way of disagreeing with it.
            next_runs=main.scrape_next_runs(runtime.scheduler),
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
