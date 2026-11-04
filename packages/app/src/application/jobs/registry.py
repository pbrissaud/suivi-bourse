"""The jobs this process runs, and the one module that knows the scheduler (#1253).

``JOBS`` lists the job classes. Everything that is said of *every* job reads it:
the scheduler's entries (:func:`register`), the replay after a write
(:meth:`Jobs.after_write`), a dial's re-arm (:meth:`Jobs.rearm`), ``GET /health``
(:func:`health`), ``GET /api/jobs/history`` (:func:`history_jobs`) and
``GET /api/jobs`` (:func:`describe`). Adding a job is its class, its line here
and its i18n key.

The order is meaningful once: it is the order the *on write* triggers fire in,
so the ingestion publishes the ledger before the performance pass reads it.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence, Type

from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.schedulers.background import BackgroundScheduler

from application.jobs import base
from application.jobs.backfill import BackfillJob
from application.jobs.context import JobContext, MarketClient
from application.jobs.ingestion import IngestionJob
from application.jobs.performance import PerformanceJob
from application.jobs.scrape import ScrapeJob

JOBS: Sequence[Type[base.Job]] = (ScrapeJob, BackfillJob, IngestionJob,
                                  PerformanceJob)


class Jobs:
    """One instance of every job in ``JOBS``, over one shared context."""

    def __init__(self, ctx: JobContext,
                 classes: Optional[Sequence[Type[base.Job]]] = None):
        self.ctx = ctx
        self._jobs: Dict[str, base.Job] = {}
        for cls in (JOBS if classes is None else classes):
            self._jobs[cls.id] = cls(ctx, self)

    def __getitem__(self, job_id: str) -> base.Job:
        return self._jobs[job_id]

    def __contains__(self, job_id: str) -> bool:
        return job_id in self._jobs

    def __iter__(self) -> Iterator[base.Job]:
        return iter(self._jobs.values())

    def get(self, job_id: str) -> Optional[base.Job]:
        return self._jobs.get(job_id)

    def after_write(self) -> None:
        """Every *on write* trigger, in registry order (issue #697)."""
        for job in self:
            for trigger in job.triggers:
                if isinstance(trigger, base.OnWrite):
                    job(**trigger.kwargs)

    def rearm(self, dial: str, value) -> base.Rearmed:
        """Re-arm every job the dial sets the cadence of (issue #701)."""
        total = base.Rearmed()
        for job in self:
            if dial in job.dials():
                reached = job.rearm(dial, value)
                total.symbols += reached.symbols
                total.at_market_open += reached.at_market_open
                total.jobs += reached.jobs
        return total


def build(config_manager, recorder=None,
          market_client: Optional[MarketClient] = None,
          classes: Optional[Sequence[Type[base.Job]]] = None) -> Jobs:
    """Every job, over a fresh context for ``config_manager``."""
    kwargs: Dict[str, Any] = {}
    if recorder is not None:
        kwargs['recorder'] = recorder
    if market_client is not None:
        kwargs['market'] = market_client
    return Jobs(JobContext(config_manager, **kwargs), classes)


def build_scheduler(pool_size: int) -> BackgroundScheduler:
    """The process's scheduler, its pool sized for the held symbols (#851)."""
    return BackgroundScheduler(
        executors={'default': ThreadPoolExecutor(pool_size)})


def register(scheduler, jobs: Jobs, dials: Mapping[str, Any]) -> None:
    """Give the scheduler one entry per timed trigger of every job."""
    for job in jobs:
        for trigger in job.triggers:
            if isinstance(trigger, base.Interval):
                seconds = (dials[trigger.dial] if trigger.dial is not None
                           else trigger.seconds)
                extra = ({'next_run_time': datetime.now(timezone.utc)}
                         if trigger.first_run_now else {})
                scheduler.add_job(job, 'interval', seconds=seconds,
                                  id=trigger.scheduler_id, name=trigger.name,
                                  **extra)
            elif isinstance(trigger, base.Daily):
                scheduler.add_job(job, 'cron', hour=trigger.hour,
                                  minute=trigger.minute, timezone=timezone.utc,
                                  kwargs=dict(trigger.kwargs),
                                  id=trigger.scheduler_id, name=trigger.name)


@dataclass(frozen=True)
class HealthView:
    """What the ``/health`` folds read: every symbol's runtime, the perf record."""

    symbols: Sequence[Any]
    perf: Any


def health(view: HealthView) -> Dict[str, Dict[str, Any]]:
    """``GET /health``'s ``jobs``: the line of every job that has one, in order."""
    return {cls.id: cls.health(view) for cls in JOBS if cls.in_health}


def history_jobs() -> List[str]:
    """The singleton jobs ``GET /api/jobs/history`` gives a track of its own."""
    return [cls.id for cls in JOBS if cls.kind == 'job']


def describe() -> List[Dict[str, Any]]:
    """``GET /api/jobs``: every job, as the System page lists it."""
    return [{'id': cls.id, 'label_key': cls.label_key, 'kind': cls.kind,
             'in_health': cls.in_health} for cls in JOBS]


__all__ = ['JOBS', 'Jobs', 'build', 'build_scheduler', 'register',
           'HealthView', 'health', 'history_jobs', 'describe']
