"""The ingestion: the replay at boot, after a write, and at the turn of the day.

Issues #850, #1253. It has no ``/health`` line: its row on the System page is
read off its own history.
"""
import logging
from datetime import datetime, timezone
from typing import Tuple

from application import carrying
from application import installation_facts
from application import job_history
from application import runtime_state
from application import runtime_view
from application import scheduling
from application.jobs import base

app_logger = logging.getLogger("suivi_bourse")


class IngestionJob(base.Job):
    """One replay, whole: the snapshot, the currency, the jobs and the facts."""

    id = job_history.INGESTION
    label_key = 'settings.jobs.ingestion'
    triggers = (base.OnWrite(kwargs={'force': True}),
                # The replay stops at today (#1459), so an event dated ahead
                # starts counting at the turn of the day, with no write to
                # replay it: the ingestion replays then, and re-arms the scrape
                # entries the new day holds.
                base.Daily(scheduler_id=scheduling.DAY_TURN_JOB_ID,
                           name='Day turn replay', hour=0, minute=0))

    def __init__(self, ctx, jobs):
        super().__init__(ctx, jobs)

    def run(self, force: bool = False) -> None:
        self.ingest(force)

    def outcome(self, started) -> base.Outcome:
        return runtime_view.ingest_outcome(self.ctx.recorder.ingest())

    def ingest(self, force: bool = False):
        """Replay the ledger and reconcile the scrape jobs."""
        now = datetime.now(timezone.utc)
        manager = self.ctx.config_manager
        try:
            before = manager.current().shares
            snapshot = manager.replay() if force else manager.reload()
            self.adopt_declared_currency()
            after = snapshot.shares
            if after != before:
                app_logger.info("Shares configuration updated from events")
            else:
                app_logger.debug("No changes in shares configuration")
            self.ctx.recorder.record_ingest(runtime_state.IngestRecord(
                at=now,
                outcome=(runtime_state.INGEST_UPDATED if after != before
                         else runtime_state.INGEST_UNCHANGED),
                shares=len(after),
                events=len(snapshot.events) if snapshot.events is not None else None,
            ))
            self.ctx.recorder.retain({share['symbol'] for share in after
                                      if share.get('symbol')})
        except Exception as e:
            app_logger.error(f"Error during ingestion (keeping previous config): {e}")
            self.ctx.recorder.record_ingest(runtime_state.IngestRecord(
                at=now, outcome=runtime_state.INGEST_FAILED, error=str(e)))

        self.jobs['scrape'].reconcile_jobs()

        self.review_installation_facts()

    def reconstruction_state(self) -> Tuple[int, int]:
        """``(series complete, series in the reconstruction)`` — process memory."""
        windows = self.ctx.config_manager.current().backfill_windows()
        now = datetime.now(timezone.utc)
        targets = {
            symbol: carrying.holding_bounds(window[0], window[1], now)[0]
            for symbol, window in windows.items()}
        # Unreachable (#1288) is settled too: the pass keeps retrying, but the
        # reconstruction no longer waits on it.
        settled = (self.jobs['backfill'].complete,
                   self.jobs['backfill'].unreachable)
        complete = sum(1 for symbol, target in targets.items()
                       if any(done.get(symbol) == target for done in settled))
        return complete, len(windows)

    def review_installation_facts(self) -> None:
        """Re-observe every installation fact, and record the one that is an event."""
        try:
            context = installation_facts.observe(self)
            with self.ctx.config_manager.writing() as opened:
                if context.reconstruction_concluded:
                    installation_facts.record(
                        opened,
                        installation_facts.ASSUMED_BASE_CURRENCY, context)
                installation_facts.refresh(opened, context)
        except Exception as e:
            app_logger.error(f"Failed to review the installation facts: {e}")

    def adopt_declared_currency(self) -> None:
        """Take up a reporting currency an import has just declared (issue #710)."""
        stored = self.ctx.config_manager.store.setting('base_currency')
        if stored and stored != self.ctx.base_currency:
            app_logger.info(
                f"Reporting currency taken from an imported file: {stored}")
            self.ctx.base_currency = stored
            self.repair_conversions_now()

    def repair_conversions_now(self) -> bool:
        """Put the lateral pass in front of the queue (issue #704). Did it move?"""
        self.jobs['backfill'].lateral_retry_at.clear()
        scheduler = self.ctx.scheduler
        if scheduler is None:
            return False
        try:
            scheduler.modify_job(scheduling.BACKFILL_JOB_ID,
                                 next_run_time=datetime.now(timezone.utc))
        except Exception as e:
            app_logger.error(
                f"Failed to bring the conversion repair forward: {e}")
            return False
        app_logger.info(
            "Reporting currency answered: repairing the conversions of every "
            "price already stored")
        return True
