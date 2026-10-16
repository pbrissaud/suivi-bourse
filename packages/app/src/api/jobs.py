"""The jobs' recent passes under ``/api/jobs`` (issue #1236).

A read of its own, and not a field of ``/health``: the bell polls that one and
it must stay small, and ``/api/runtime`` is read by the sidebar on every page.
"""
from datetime import datetime, timezone

from flask import Blueprint, jsonify

from api.common import current_runtime

bp = Blueprint('jobs', __name__)


@bp.get('/jobs/history')
def get_history():
    """Each job's last 24 hours, out of process memory."""
    history = current_runtime().recorder.history
    return jsonify(history.read(datetime.now(timezone.utc)))
