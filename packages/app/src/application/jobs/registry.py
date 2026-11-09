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
from typing import (Any, Dict, Iterator, List, Mapping, Optional, Sequence,
                    Tuple, Type)

from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.schedulers.background import BackgroundScheduler

from application import instants, job_history
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


_STATES = {job_history.OK: 'À jour', job_history.ATTENTION: 'À surveiller',
           job_history.ERROR: 'En erreur', job_history.IDLE: 'En veille'}


def _every(seconds: float) -> str:
    seconds = int(seconds)
    if seconds % 3600 == 0:
        return f'toutes les {seconds // 3600} h'
    if seconds % 60 == 0:
        return f'toutes les {seconds // 60} min'
    return f'toutes les {seconds} s'


def _scheduled(scheduler, cls) -> Tuple[Optional[Any], Optional[datetime]]:
    """The interval entry of ``cls`` (or ``None``), and the soonest next run."""
    entries = [scheduler.get_job(t.scheduler_id) for t in cls.triggers
               if isinstance(t, (base.Interval, base.Daily))] \
        if scheduler is not None else []
    entries = [entry for entry in entries if entry is not None]
    runs = [e.next_run_time for e in entries if e.next_run_time is not None]
    return (entries[0] if entries else None), (min(runs) if runs else None)


def _cadence(cls, jobs: 'Jobs', entry) -> Optional[str]:
    if cls is ScrapeJob:
        return _every(jobs.ctx.regular_interval)
    interval = getattr(getattr(entry, 'trigger', None), 'interval', None)
    if interval is not None:
        return _every(interval.total_seconds())
    if any(isinstance(t, base.OnWrite) for t in cls.triggers):
        return 'à chaque écriture'
    return None


def describe(jobs: Optional['Jobs'] = None, history=None,
             scheduler=None) -> List[Dict[str, Any]]:
    """``GET /api/jobs``: every job, as the System page lists it.

    Given the running ``jobs``, each also says its ``state`` (its last pass,
    in short French), ``last_run_at``, ``next_run_at`` and ``cadence``.
    """
    rows = []
    for cls in JOBS:
        row = {'id': cls.id, 'label_key': cls.label_key, 'kind': cls.kind,
               'in_health': cls.in_health}
        if jobs is not None:
            last = history.last_pass(cls.id) if history is not None else None
            entry, next_run = _scheduled(scheduler, cls)
            if cls is ScrapeJob:
                from application.jobs.scrape import scrape_next_runs
                soon = [r for r in scrape_next_runs(scheduler).values() if r]
                next_run = min(soon) if soon else None
            row.update({
                'state': _STATES.get(last.outcome, 'À jour') if last
                else 'Jamais lancé',
                'last_run_at': instants.iso(last.at) if last else None,
                'next_run_at': instants.iso(next_run),
                'cadence': _cadence(cls, jobs, entry),
            })
        rows.append(row)
    return rows


__all__ = ['JOBS', 'Jobs', 'build', 'build_scheduler', 'register',
           'HealthView', 'health', 'history_jobs', 'describe']
