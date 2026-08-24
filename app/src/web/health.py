"""Liveness route for SuiviBourse (issue #651, deepened by #696).

It answers for *this* process — and, since #696, for the store, which is the
same thing. The container healthcheck used to probe the exporter's endpoint,
which turned trivially green whenever that endpoint was switched off; this route
closed that blind spot, and it now closes the second one.

The rule it used to follow — *never touch the database, a healthcheck that
depends on it would restart the app for someone else's outage* — has **lost its
subject** (ADR-0015). There is no longer someone else: the store is a file this
process opens, so an unreachable store is not a remote outage to ride out, it is
this process being unable to do its job. A probe that stays green through it is
reporting on nothing.
"""
from flask import Blueprint

from web import problem

health_bp = Blueprint('health', __name__)


@health_bp.get('/health')
def health():
    """Answer 200 when the worker is serving *and* the store answers."""
    from web import current_runtime

    open_store = current_runtime().store
    if open_store is None:
        # Before ``post_fork``, or after ``worker_exit``. Under gunicorn the
        # socket is not being served then, so this is reachable only in a test
        # or an embedding — and "the store is not open" is exactly what it says.
        return problem.storage_unavailable('The store is not open')

    try:
        open_store.ping()
    except Exception as exc:
        # Broad on purpose: the point of the probe is that *whatever* stops the
        # store from answering shows up here rather than as a green light.
        return problem.storage_unavailable(f"The store did not answer: {exc}")

    return {'status': 'ok'}
