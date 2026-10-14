"""The ingestion workload: the replay that follows a write (issue #850)."""
import logging
from datetime import datetime, timezone
from typing import Tuple

from application import carrying
from application import installation_facts
from application import runtime_state
from application import scheduling

app_logger = logging.getLogger("suivi_bourse")


class IngestionWorkload:
    """One replay, whole: the snapshot, the currency, the jobs and the facts."""

    def __init__(self, facade):
        self.facade = facade

    def ingest(self, force: bool = False):
        """Replay the ledger and reconcile the scrape jobs."""
        now = datetime.now(timezone.utc)
        manager = self.facade.config_manager
        try:
            before = manager.current().shares
            snapshot = manager.replay() if force else manager.reload()
            self.facade._adopt_declared_currency()
            after = snapshot.shares
            if after != before:
                app_logger.info("Shares configuration updated from events")
            else:
                app_logger.debug("No changes in shares configuration")
            self.facade.recorder.record_ingest(runtime_state.IngestRecord(
                at=now,
                outcome=(runtime_state.INGEST_UPDATED if after != before
                         else runtime_state.INGEST_UNCHANGED),
                shares=len(after),
                events=len(snapshot.events) if snapshot.events is not None else None,
            ))
            self.facade.recorder.retain({share['symbol'] for share in after
                                         if share.get('symbol')})
        except Exception as e:
            app_logger.error(f"Error during ingestion (keeping previous config): {e}")
            self.facade.recorder.record_ingest(runtime_state.IngestRecord(
                at=now, outcome=runtime_state.INGEST_FAILED, error=str(e)))

        self.facade._reconcile_jobs()

        self.facade.review_installation_facts()

    def reconstruction_state(self) -> Tuple[int, int]:
        """``(series complete, series in the reconstruction)`` — process memory."""
        windows = self.facade.config_manager.current().backfill_windows()
        now = datetime.now(timezone.utc)
        targets = {
            symbol: carrying.holding_bounds(window[0], window[1], now)[0]
            for symbol, window in windows.items()}
        complete = sum(1 for symbol, target in targets.items()
                       if self.facade._backfill_complete.get(symbol) == target)
        return complete, len(windows)

    def review_installation_facts(self) -> None:
        """Re-observe every installation fact, and record the one that is an event."""
        try:
            context = installation_facts.observe(self.facade)
            with self.facade.config_manager.writing() as opened:
                if context.reconstruction_concluded:
                    installation_facts.record(
                        opened,
                        installation_facts.ASSUMED_BASE_CURRENCY, context)
                installation_facts.refresh(opened, context)
        except Exception as e:
            app_logger.error(f"Failed to review the installation facts: {e}")

    def adopt_declared_currency(self) -> None:
        """Take up a reporting currency an import has just declared (issue #710)."""
        stored = self.facade.config_manager.store.setting('base_currency')
        if stored and stored != self.facade.base_currency:
            app_logger.info(
                f"Reporting currency taken from an imported file: {stored}")
            self.facade.base_currency = stored
            self.facade.repair_conversions_now()

    def repair_conversions_now(self) -> bool:
        """Put the lateral pass in front of the queue (issue #704). Did it move?"""
        self.facade._lateral_retry_at.clear()
        scheduler = self.facade.scheduler
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
