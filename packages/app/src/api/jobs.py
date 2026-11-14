"""The jobs, and their recent passes, under ``/api/jobs`` (issues #1236, #1253).

A read of its own, and not a field of ``/health``: the bell polls that one and
it must stay small, and ``/api/runtime`` is read by the sidebar on every page.
"""
import threading
from datetime import datetime, timezone

from flask import Blueprint, jsonify

from api.common import current_runtime
from api.problem import not_found
from application.jobs import registry
from application.jobs.base import JobFamily

bp = Blueprint('jobs', __name__)


@bp.get('/jobs/history')
def get_history():
    """Each job's last 24 hours, out of process memory."""
    history = current_runtime().recorder.history
    return jsonify(history.read(datetime.now(timezone.utc),
                                registry.history_jobs()))


@bp.get('/jobs')
def list_jobs():
    """Every job the process runs, in registry order, as the System page lists it."""
    runtime = current_runtime()
    return jsonify(registry.describe(
        runtime.jobs, runtime.recorder.history, runtime.scheduler))


@bp.post('/jobs/<job_id>/run')
def run_job(job_id: str):
    """« Lancer »: one pass now, off the request; the history records it."""
    jobs = current_runtime().jobs
    job = jobs.get(job_id) if jobs is not None else None
    if job is None:
        return not_found(f"No job is named {job_id!r}")
    passes = ([lambda member=member: job(member) for member in job.members()]
              if isinstance(job, JobFamily) else [job])

    def run_all():
        for one in passes:
            one()

    threading.Thread(target=run_all, name=f'run-{job_id}', daemon=True).start()
    return jsonify({'id': job_id, 'started': True}), 202
