# The import is a gesture, not a mount

The drop folder goes, and with it the whole apparatus that existed because a file was
**read again**. `SB_IMPORT_DIR`, the watchdog observer, `import_source`, `event.source_id`
and `account.source_id`, `ledger.forget_import`, `accounts.forget_source`, and the `409`
that made `PUT`/`DELETE /api/events/<id>` refuse a row a file had provisioned — all of it
answers one question, and the question stops being asked. A file now arrives through
`POST /api/events/import`, is parsed once, and is never seen again.

**What justified the second population was liveness, not provenance.** `ledger.py` refused
a row-level write on an imported row so that *the file and the store would not become two
truths about the same purchase* — and that is exactly right about a file that is mounted,
watched and re-read. An uploaded file is not a truth: it is a payload, dead the instant it
is parsed. The argument therefore does not survive the mount, and neither does the split it
produced. `entries.py` absorbs the import; **one population, one writer, one set of
gestures**, and the rule the split was protecting — *the import path has no row-level
write* — has nothing left to protect.

The chain runs further back than it looks. ADR-0012 wrote it down as a principle:
*"**Because a headless install has no UI in which to declare accounts**, accounts must be
provisionable from files, with provenance, and revocable file-by-file."* The provenance
apparatus is the child of the guarantee that every gesture has a non-interactive path.
[ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) retires that
guarantee; this record spends the inheritance.

## Consequences

- **The removal is the gesture.** An imported row is deleted like any other, one at a time
  or in bulk over the ledger's current reduction — a **general** gesture that also repairs
  the twelve events somebody mistyped, and one that does not resurrect a batch identity to
  delete by. The bulk delete is not a convenience here; it is what makes losing
  `forget_import` survivable, and it must land in the same lot.
- **Duplicates are caught by content, and never by a constraint.** The key is
  `(date, event_type, account, symbol, quantity, unit_price, fee, amount)` — `name` and
  `notes` are excluded, or annotating a row would make it re-importable. It is compared at
  import and **never declared in the DDL**: two `BUY` of ten shares at the same price on the
  same day are one order filled twice, and a constraint would make that impossible to
  record *by hand as well*. The comparison reports, skips by default, and offers to import
  the duplicates anyway — the owner is the only one who knows.
- **This frees a refusal.** `docs/v5-decisions.md` refused the export's dated filename
  *because* a re-import identified a source by its name, so two dated exports would record
  what they share twice. Content-level dedup removes that argument; the dated name may come
  back on its own merits.
- **The preview holds no server state.** `?dry_run=1` returns the receipt and writes
  nothing; the front re-uploads the file to commit. Any pending-import identifier would be
  `import_source` under another name, with a lifetime and a sweeper to go with it. The
  double upload is the price of *the server remembers no import, ever*, and it is a few
  hundred kilobytes on a local hop.
- **The route is `/api/events/import`, not `/api/imports`.** An import is no longer a
  resource — nothing persists to name — so it is a gesture on the collection it writes.
- **The replay follows the write, and now so does the performance.** A write already
  triggers `main.replay_after_write`; it did not recompute the series, which waited up to
  `PERF_TICK`. It does now, **in full and unconditionally**: ADR-0011 measured the whole
  recompute at 460 ms over five years and retired incremental windows on purpose. A window
  from the event's date to today would buy 400 ms and cost a boundary to reason about
  forever.
- **`reassignment.py` survives, against expectation.** Its trap — a year of events under the
  seeded `default` row, then two accounts declared — is reached from the keyboard exactly as
  it was from a file. It was never about the import.
- **`/import` leaves the image and `SB_IMPORT_DIR` leaves the environment**, taking one of
  ADR-0015's two mounts and one assertion of the container contract with it. Together with
  ADR-0033 the boot variables go from six to **three**.
- **Two advisories lose their subject** — `legacy_config_file` and `legacy_settings_file`
  were predicates on files *found in the folder*. The sentence moves to where it can be said
  in time: an upload that is handed a v4 `config.yaml` **refuses it by name** and points at
  the migration page. A refusal at the moment of the gesture beats a notice discovered later.
- **There is no last v4 release, and no export bridge.** v4's `Event` is field-for-field v5's
  and its loader requires only `date` and `event_type`, so a v4 owner in event mode already
  holds a v5 import file. The other population has nothing to export: v4's `schema.yaml`
  declares `purchase{quantity, fee, cost_price}` and `estate{…}` with **no date anywhere**,
  so a converted ledger would be dated by invention — which is what ADR-0008 refuses.

[The guarantee it spends: ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) ·
[the provenance it retires: ADR-0013](./0013-accounts-are-data-with-provenance.md) ·
[the cache it recomputes: ADR-0011](./0011-performance-series-is-a-cache.md) ·
[the mount it removes: ADR-0015](./0015-one-container-two-mounts-persistence-is-observed.md) ·
[what does not migrate: ADR-0008](./0008-no-upgrade-from-v4.md) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
