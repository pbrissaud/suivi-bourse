"""Liveness route for SuiviBourse (issue #651).

Deliberately shallow: it answers for *this* process and nothing else. The
container healthcheck used to probe ``/metrics``, which turned trivially green
whenever ``SB_PROMETHEUS_ENABLED=false`` — a blind spot this route closes. It
stops short of touching InfluxDB on purpose: a healthcheck that depended on the
database would restart the app for someone else's outage, and the scheduler is
built to keep polling through one.
"""
from flask import Blueprint

health_bp = Blueprint('health', __name__)


@health_bp.get('/health')
def health():
    """Answer 200 as long as the WSGI worker is serving."""
    return {'status': 'ok'}
