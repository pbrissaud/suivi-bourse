"""The ingestion workload: the replay that follows a write (issue #850).

The fourth of the four workloads the root ``CLAUDE.md`` names, and the one that
is **not a job**: it runs at the boot and after a write, never on a timer
(issue #697, ADR-0032). What it does is republish the configuration off the
ledger, arm or retire the per-symbol scrape jobs the new held set asks for, take
up a reporting currency an imported file has just declared (#710), and re-observe
the installation facts — the four gestures a ledger change can require, in the
one order that keeps them consistent.

*What* it writes is nobody's business here: :mod:`entries` is the ledger's one
writer (ADR-0032) and this workload never touches it — by the time a pass starts,
the write has already committed and what is left is to make the running process
agree with the store.

**The workload calls its collaborators through the façade that carries it**, for
the reason :mod:`scrape`, :mod:`backfill` and :mod:`perf_job` give: the suite
replaces methods *on the instance*, and a pass holding references captured at
construction would step over the replacement. That includes the three of them
that are *this class's own*: the backfill reaches
:meth:`review_installation_facts` through the façade and the settings write path
reaches :meth:`repair_conversions_now` through it, so a pass reaching either on
``self`` would give one name two behaviours — replaced for one caller and not
for the other, invisibly at both call sites.

It owns **no state at all**, and that is worth stating rather than noticing: the
reconstruction's progress it reports is the backfill's memory, the reporting
currency it adopts is the façade's dial, and the installation facts it reviews
are rows. There is nothing here to keep between two passes.
"""
import logging
from datetime import datetime, timezone
from typing import Tuple

import carrying
import installation_facts
import runtime_state
import scheduling

app_logger = logging.getLogger("suivi_bourse")


class IngestionWorkload:
    """One replay, whole: the snapshot, the currency, the jobs and the facts.

    ``facade`` is the object that carries the workloads — the store manager, the
    dials, the recorder, the scheduler — and every collaborator is reached
    through it. It is :class:`workloads.Workloads`.
    """

    def __init__(self, facade):
        self.facade = facade

    def ingest(self, force: bool = False):
        """Replay the ledger and reconcile the scrape jobs.

        **Not a job** (issue #697). In v4 this ran every 300 s because the files
        were the truth and nothing else could notice they had changed. The
        ledger now changes only when a write changes it, so this is the *replay
        that follows the write* — a quiet, synchronous, in-process gesture with
        exactly two callers:

        * the boot, in :func:`main.start_runtime`, where it is also what arms
          the per-symbol scrape jobs for the first time. It publishes nothing
          new: the snapshot was built before the scheduler existed, so this is a
          cache hit on :func:`ledger.stamp` that only arms the jobs;
        * a write through the API, via :func:`main.replay_after_write`, which
          passes ``force=True``.

        **``force`` is not the flag that left** (ADR-0032). ``import_files``
        said *scan the drop folder or do not*, and it went with the folder;
        what is left is whether the fingerprint may be honoured, and the write
        path says it need not be — it has just moved the ledger and has no
        reason to ask.

        ``SB_INGESTION_INTERVAL`` is gone with the polling it paced, and there
        is no timer anywhere that re-reads a file on its own.

        Errors are logged but not raised to avoid blocking the scraping job.
        The previous valid configuration is kept until the error is fixed —
        which since #658 is true by construction rather than by this method's
        care: the manager publishes a snapshot only once it is complete *and*
        valid, so a failure anywhere above leaves the previous one standing for
        every reader, not just for this one.
        """
        now = datetime.now(timezone.utc)
        manager = self.facade.config_manager
        try:
            before = manager.current().shares
            snapshot = manager.replay() if force else manager.reload()
            # **On every ingest, and that was a defect once** (issue #812). The
            # condition here used to be ``if import_files``, which was right
            # while the only file that could carry a reporting currency arrived
            # through the drop folder. ``POST /api/events/import`` writes that
            # setting too (:func:`entries.create_many`) and comes through the
            # replay that follows the write — so the row landed in the store and
            # the running process went on holding ``None``. Since the perf gate
            # reads the *attribute*, every later tick was blind as well: an
            # install whose first gesture is an import had no performance series
            # at all until a restart.
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
            # The last-pass records of a symbol the ledger no longer names at
            # all — a forgotten import (issue #703). The parallel of
            # ``retain_positions`` just above, and the *only* thing that drops a
            # backfill record: leaving the held set is not leaving the ledger,
            # and a sold position's backward pass is still running.
            self.facade.recorder.retain({share['symbol'] for share in after
                                         if share.get('symbol')})
        except Exception as e:
            app_logger.error(f"Error during ingestion (keeping previous config): {e}")
            # The record #656 called out as the one gap worth closing on its
            # own: since #658 a rejected configuration is never published, so
            # the app goes on running — correctly — on its previous snapshot,
            # and the only trace of that anywhere is the line just above.
            self.facade.recorder.record_ingest(runtime_state.IngestRecord(
                at=now, outcome=runtime_state.INGEST_FAILED, error=str(e)))

        # Reconcile the per-symbol scrape jobs against the (possibly unchanged)
        # held-symbol set. Idempotent and always run — on the first ingest it
        # arms every symbol, later it only touches the diff. No-op until the
        # scheduler is wired in ``start_runtime``.
        self.facade._reconcile_jobs()

        # Re-observe the installation facts (issue #709). Here because this is
        # the gesture that runs at the boot, on a file landing and after a
        # write — the three moments an *installation fact* can change — and
        # because it is the only one that runs on an install holding nothing at
        # all, where the backfill returns before doing anything.
        self.facade.review_installation_facts()

    # ------------------------------------------------------------------ #
    # The installation facts (issue #709)
    # ------------------------------------------------------------------ #

    def reconstruction_state(self) -> Tuple[int, int]:
        """``(series complete, series in the reconstruction)`` — process memory.

        The source of the one installation fact that is neither a file nor an
        environment variable, and it is memory rather than a query for the same
        reason ``/api/runtime`` reads none: ``_backfill_complete`` is where
        "this pass has reached its first acquisition" lives, and no row
        anywhere says it — a symbol Yahoo answers nothing about has a completed
        pass and an empty series.

        **This method never answers ``None``**, and that is the whole of it:
        across the seam ``None`` means :data:`installation_facts.UNOBSERVED` —
        *this process cannot see the scheduler* — and it is
        :func:`installation_facts.observe` alone that says it, for a caller
        holding no workloads at all. Nothing ever held is ``(0, 0)``: an
        observation, made from here, saying there is no reconstruction to run.
        A fresh install still announces no reprise d'historique —
        ``_observe_reconstruction`` stands the installation fact down on
        ``total <= 0`` exactly as it does on a finished one — but it *stands it
        down* instead of leaving it untouched, which is what the criterion
        demands: forgetting every import while the reconstruction was armed
        used to leave its row standing for ever, on a portfolio that no longer
        names a single symbol.
        """
        windows = self.facade.config_manager.current().backfill_windows()
        now = datetime.now(timezone.utc)
        targets = {
            symbol: carrying.holding_bounds(window[0], window[1], now)[0]
            for symbol, window in windows.items()}
        complete = sum(1 for symbol, target in targets.items()
                       if self.facade._backfill_complete.get(symbol) == target)
        return complete, len(windows)

    def review_installation_facts(self) -> None:
        """Re-observe every installation fact, and record the one that is an
        event.

        The whole call-site pattern of the feature: the observation is made
        where the sources are — the ingest and the backfill cycle — and **never
        on a ``GET``**, an installation fact dated by the moment somebody
        happened to open a page saying nothing about when the thing it names
        started.

        Both callers see all four sources, the façade being where the
        reconstruction's memory lives, so neither of them can drop a row the
        other armed. What cannot see it is a runtime with no scheduler — a boot
        that has not reached :func:`main.start_runtime`, a web request on one
        that never did — and :func:`installation_facts.observe` answers
        *unobservable* for those rather than *finished*.

        Guarded: a store that refuses this must not take a scheduled job with it.
        A missed review costs one cycle, and the next one re-observes everything
        from scratch, there being no state to catch up on.
        """
        try:
            context = installation_facts.observe(self.facade)
            with self.facade.config_manager.writing() as opened:
                # Order matters, and only in one direction: the reconstruction
                # concluding is what *produces* the assumed-currency
                # installation fact, so it is recorded before the refresh that
                # stands its sibling down.
                if context.reconstruction_concluded:
                    installation_facts.record(
                        opened,
                        installation_facts.ASSUMED_BASE_CURRENCY, context)
                installation_facts.refresh(opened, context)
        except Exception as e:
            app_logger.error(f"Failed to review the installation facts: {e}")

    # ------------------------------------------------------------------ #
    # The reporting currency an import declares (issue #710)
    # ------------------------------------------------------------------ #

    def adopt_declared_currency(self) -> None:
        """Take up a reporting currency an import has just declared (issue #710).

        A dial reaches this process from exactly two places: the boot reads them
        all once into the attributes every cycle re-reads
        (:func:`main.start_runtime`), and ``PUT /api/settings`` assigns the same
        attributes after writing the row. That pair is the whole of *"no dial
        requires a restart"*.

        An **import** is the third writer of one of them, and of one only: an
        exported file states its reporting currency, and a store that has none
        takes it (``ledger.currency_to_adopt``, ADR-0021). Without this line the
        row would be in the store and the running process would go on converting
        nothing until the next restart — and that is the one dial where the
        symptom is invisible, since a missing currency writes ``NULL``
        conversions rather than failing anything.

        Read after the replay and not before it: the value this looks for is
        written *by* the import that replay follows. And it is read on **every**
        ingest since #812 — a file uploaded to ``POST /api/events/import``
        declares a currency exactly as one dropped in the folder did, and that
        road comes through ``replay_after_write``, which scans no folder.
        Idempotent by the condition below, so the boot's own ingest and every
        write that changes nothing here cost one ``setting`` read.

        And it triggers the lateral pass for the same reason ``PUT
        /api/settings`` does (issue #704): this **is** the pose of the reporting
        currency, on the road a headless install actually takes, and every point
        already scraped is carrying a ``NULL`` conversion waiting for it.
        """
        stored = self.facade.config_manager.store.setting('base_currency')
        if stored and stored != self.facade.base_currency:
            app_logger.info(
                f"Reporting currency taken from an imported file: {stored}")
            self.facade.base_currency = stored
            self.facade.repair_conversions_now()

    def repair_conversions_now(self) -> bool:
        """Put the lateral pass in front of the queue (issue #704). Did it move?

        The effect of answering the reporting currency, and it is the *only*
        dial with one of this shape, because it is the only one whose value is
        **retroactive**: while it was unanswered every scrape and every rebuilt
        chunk wrote its point with ``price_converted NULL``, and those rows are
        not lost — the lateral pass gives them the column they are short of. The
        whole stock is therefore repairable the instant the question is answered,
        and what this does is make it start now rather than up to one
        ``backfill_interval`` later, on the single gesture that unblocks every
        money figure in the product.

        Two things happen, and the first is what makes the second honest. The
        back-off memory is **cleared**: a symbol backing off after a failed rate
        fetch was failing at a question that has just changed, and making it wait
        out a delay computed against the old world would be the interface
        punishing the repair. Then the backfill job's next run is advanced —
        the pass rides on it, so there is nothing else to start.

        Returns whether the job was actually moved. ``False`` on a runtime with
        no scheduler (the boot before it, a test) is not a failure: the dial is
        in the store, the attribute is set, and the next cycle reads both.
        """
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
