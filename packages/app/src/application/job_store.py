"""The scheduler's memory, written in batches and read back at boot (#1254).

``JobHistory`` buffers what changed since the last flush: the hourly slots a
pass touched, the passes themselves, each scrape member's last arming, and the
members that left. :func:`flush` writes that in **one** transaction under the
writers' mutex, every :data:`FLUSH_SECONDS` and at shutdown, and is the only
writer of ``job_slot``, ``job_pass`` and ``job_schedule``: no pass writes on its
own path (#972). A crash loses at most one interval.

:func:`restore` reloads the history at boot and hands the scrape its stored
arming, so a symbol backing off resumes its back-off rather than starting over.
"""
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from application import job_history
from application.job_history import Key, Pass, Schedule, Slot

logger = logging.getLogger("suivi_bourse")

FLUSH_SECONDS = 30
FLUSH_JOB_ID = 'job-history-flush'

_SLOT_COLUMNS = ('job', 'member', 'hour', 'passes', 'attentions', 'errors',
                 'idles', 'duration', 'last_error', 'last_error_at')
_PASS_COLUMNS = ('job', 'member', 'ran_at', 'duration', 'outcome', 'error',
                 'lines', 'overflow')
_SCHEDULE_COLUMNS = ('job', 'member', 'next_run', 'failure_count')


def _member(key: Key) -> str:
    return key[1] or ''


def _key(job: str, member: str) -> Key:
    return job, (member or None)


def _upsert(store, table: str, columns, keys, rows) -> None:
    updated = ', '.join(f'{name} = excluded.{name}'
                        for name in columns if name not in keys)
    store.write_arrow(
        f'INSERT INTO {table} ({", ".join(columns)}) '
        f'SELECT {", ".join(columns)} FROM incoming '
        f'ON CONFLICT ({", ".join(keys)}) DO UPDATE SET {updated}',
        columns, rows)


def flush(config_manager, history: job_history.JobHistory,
          now: Optional[datetime] = None) -> None:
    """Write what the history buffered, in one transaction. Never raises."""
    now = now or datetime.now(timezone.utc)
    drained = history.drain()
    oldest = now.replace(minute=0, second=0, microsecond=0) - timedelta(
        hours=job_history.SLOTS - 1)
    try:
        with config_manager.writing() as store, store.transaction():
            for symbol in drained.gone:
                for table in ('job_slot', 'job_pass', 'job_schedule'):
                    store.execute(
                        f'DELETE FROM {table} WHERE job = ? AND member = ?',
                        [job_history.SCRAPE, symbol])
            _upsert(store, 'job_slot', _SLOT_COLUMNS, ('job', 'member', 'hour'), [
                (key[0], _member(key), hour, slot.passes, slot.attentions,
                 slot.errors, slot.idles, slot.duration, slot.last_error,
                 slot.last_error_at)
                for (key, hour), slot in drained.slots.items()])
            # Two passes of one key at one instant is one pass: the last wins.
            passes = {(key[0], _member(key), one.at): one
                      for key, one in drained.passes}
            _upsert(store, 'job_pass', _PASS_COLUMNS, ('job', 'member', 'ran_at'), [
                (job, member, at, one.duration, one.outcome, one.error,
                 json.dumps(list(one.lines)), one.overflow)
                for (job, member, at), one in passes.items()])
            _upsert(store, 'job_schedule', _SCHEDULE_COLUMNS, ('job', 'member'), [
                (key[0], _member(key), schedule.next_run, schedule.failure_count)
                for key, schedule in drained.schedule.items()])
            store.execute('DELETE FROM job_slot WHERE hour < ?', [oldest])
            store.execute(
                'DELETE FROM job_pass WHERE (job, member, ran_at) IN ('
                ' SELECT job, member, ran_at FROM job_pass QUALIFY row_number()'
                ' OVER (PARTITION BY job, member ORDER BY ran_at DESC) > ?)',
                [job_history.RECENT])
    except Exception as e:
        logger.error(f"Failed to write the job history, kept for the next "
                     f"flush: {e}")
        history.undrain(drained)


def restore(store, history: job_history.JobHistory,
            now: Optional[datetime] = None) -> Dict[str, Schedule]:
    """Reload the history the store kept; the scrape's arming, by symbol."""
    now = now or datetime.now(timezone.utc)
    oldest = now.replace(minute=0, second=0, microsecond=0) - timedelta(
        hours=job_history.SLOTS - 1)
    slots = [
        (_key(job, member), hour,
         Slot(passes, errors, attentions, idles, duration, last_error,
              last_error_at))
        for (job, member, hour, passes, attentions, errors, idles, duration,
             last_error, last_error_at) in store.query(
            f'SELECT {", ".join(_SLOT_COLUMNS)} FROM job_slot WHERE hour >= ?',
            [oldest])]
    passes = [
        (_key(job, member),
         Pass(at=at, duration=duration, outcome=outcome, error=error,
              lines=tuple(json.loads(lines)), overflow=overflow))
        for job, member, at, duration, outcome, error, lines, overflow
        in store.query(f'SELECT {", ".join(_PASS_COLUMNS)} FROM job_pass')]
    history.load(slots, passes)
    return {
        member: Schedule(next_run, failure_count, paused)
        for member, next_run, failure_count, paused in store.query(
            'SELECT member, next_run, failure_count, paused FROM job_schedule '
            'WHERE job = ?', [job_history.SCRAPE])}


__all__ = ['FLUSH_SECONDS', 'FLUSH_JOB_ID', 'flush', 'restore']
