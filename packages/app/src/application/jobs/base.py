"""What a job is: an id, a label, its triggers, one pass, and how it reads (#1253).

A job is a class. It declares:

- ``id``, the key its passes are recorded under in the history, and
  ``label_key``, the i18n key the System page names it with;
- ``triggers``, *when* it runs, as plain data the registry translates into the
  scheduler's terms (this module never imports the scheduler);
- ``run``, one pass, and ``outcome``, how that pass reads in the history;
- ``health``, its line in ``GET /health``, or ``None`` to stay out of it.

Calling the job runs one pass, timed and recorded in the history, which is
what every trigger fires.

:class:`JobFamily` is the job that runs once per member (the scrape, once per
held symbol): each member is its own scheduled entry, arms itself again after
its pass, and the family keeps the set of entries in step with the members.
"""
import logging
import threading
from contextlib import nullcontext
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, ClassVar, Dict, Mapping, Optional, Set, Tuple

from application import job_history
from application import notifications
from application import runtime_view

job_logger = logging.getLogger("suivi_bourse")

Outcome = runtime_view.Outcome


@dataclass(frozen=True)
class Interval:
    """Every ``seconds``, or every value of the dial ``dial`` (a re-arm on change)."""

    scheduler_id: str
    name: str
    seconds: Optional[int] = None
    dial: Optional[str] = None
    first_run_now: bool = False


@dataclass(frozen=True)
class Daily:
    """Once a day at ``hour:minute`` UTC."""

    scheduler_id: str
    name: str
    hour: int = 0
    minute: int = 0
    kwargs: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class OnWrite:
    """Right after a write changed the ledger, in registry order, with ``kwargs``."""

    kwargs: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SelfArmed:
    """Each member arms itself after its pass; ``dial`` changes its cadence."""

    dial: Optional[str] = None


@dataclass
class Rearmed:
    """What a dial's re-arm reached — ``apply_settings``'s report, per job."""

    symbols: int = 0
    at_market_open: int = 0
    jobs: Tuple[str, ...] = ()


def _announce(ctx, job: str, member: Optional[str], run) -> None:
    """Let the outbound channels know of this pass, **off the job's thread**.

    A failed pass, and (after a scrape) any ``user`` advisory that just started
    standing, may be pushed to a channel; a sender can take seconds, so it never
    holds the job. The thread swallows its own errors (``notifications``).
    """
    threading.Thread(target=notifications.after_pass,
                     args=(ctx, job, member, run), daemon=True,
                     name='notifications').start()


class Job:
    """A singleton job: one pass at a time, recorded under ``id``."""

    id: ClassVar[str]
    label_key: ClassVar[str]
    triggers: ClassVar[Tuple[Any, ...]] = ()
    #: In ``GET /health``? The ``health`` fold is only read when it is.
    in_health: ClassVar[bool] = False
    kind: ClassVar[str] = 'job'

    def __init__(self, ctx, jobs):
        self.ctx = ctx
        self.jobs = jobs

    def run(self, *args, **kwargs) -> None:
        raise NotImplementedError

    def outcome(self, started: datetime) -> Outcome:
        """The pass that just ran, as the history colours it."""
        return job_history.OK, None

    def guard(self):
        """Held around the pass and its outcome — a lock, for a job that needs one."""
        return nullcontext()

    def __call__(self, *args, **kwargs) -> None:
        started = datetime.now(timezone.utc)
        run = None
        try:
            with job_history.timed(self.ctx.recorder.history, self.id) as run:
                with self.guard():
                    self.run(*args, **kwargs)
                    run.settle(*self.outcome(started))
        finally:
            _announce(self.ctx, self.id, None, run)

    @classmethod
    def health(cls, view) -> Optional[Dict[str, Any]]:
        """This job's line in ``GET /health``, read off ``view``."""
        return None

    @classmethod
    def dials(cls) -> Set[str]:
        """The dials whose change re-arms this job."""
        return {trigger.dial for trigger in cls.triggers
                if getattr(trigger, 'dial', None)}

    def rearm(self, dial: str, value) -> Rearmed:
        """Re-cadence the interval this dial sets (issue #701)."""
        reached = []
        scheduler = self.ctx.scheduler
        for trigger in self.triggers:
            if isinstance(trigger, Interval) and trigger.dial == dial \
                    and scheduler is not None:
                try:
                    scheduler.reschedule_job(trigger.scheduler_id,
                                             trigger='interval', seconds=value)
                    reached.append(trigger.scheduler_id)
                except Exception as e:
                    job_logger.error(
                        f"Failed to reschedule the {trigger.scheduler_id} job: {e}")
        return Rearmed(jobs=tuple(reached))


class JobFamily(Job):
    """A job run once per member, each member its own self-arming entry."""

    kind: ClassVar[str] = 'family'

    def members(self) -> Set[str]:
        raise NotImplementedError

    def run(self, member: str, **kwargs) -> None:
        raise NotImplementedError

    def outcome(self, member: str) -> Outcome:
        return job_history.OK, None

    def __call__(self, member: str, **kwargs) -> None:
        history = self.ctx.recorder.history
        run = None
        try:
            with job_history.timed(history, self.id, member) as run:
                self.run(member, **kwargs)
                run.settle(*self.outcome(member))
        finally:
            _announce(self.ctx, self.id, member, run)
        # A pass still running when its member left records after the
        # reconciliation forgot it; forget it again.
        try:
            if member not in self.members():
                history.forget(member)
        except Exception:
            pass


__all__ = ['Outcome', 'Interval', 'Daily', 'OnWrite', 'SelfArmed', 'Rearmed',
           'Job', 'JobFamily']
