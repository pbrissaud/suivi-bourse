# Architecture Decision Records

One file per decision that is hard to reverse, surprising without context, and the
result of a real trade-off. Each record states *what* and *why* in a few lines and
links to the issue holding the full argument, the measurements and the rejected
alternatives.

The v5 records below come from the wayfinding effort tracked in
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669). Domain vocabulary
lives in [`CONTEXT.md`](../../CONTEXT.md) at the repo root.

| # | Decision |
|---|---|
| [0001](./0001-one-embedded-store-duckdb.md) | One embedded store, and it is DuckDB |
| [0002](./0002-one-base-currency.md) | One base currency, set once and never changed |
| [0003](./0003-weighted-average-cost-no-closed-flag.md) | Weighted-average cost, and a closed position is not a flagged position |
| [0004](./0004-carrying-price.md) | A position with no price is carried at its cost |
| [0005](./0005-every-position-is-historied.md) | Every position is historied: manual mode is removed |
| [0006](./0006-declaration-and-derived-state-never-share-a-row.md) | Declaration and derived state never share a row |
| [0007](./0007-constraints-where-the-error-enters.md) | Constraints go where the error enters, not where the rows pile up |
| [0008](./0008-no-upgrade-from-v4.md) | There is no upgrade from v4 |
| [0009](./0009-backfill-replays-holding-windows.md) | Backfill replays holding windows, and performance writes on a sliding horizon |
| [0010](./0010-resolution-is-a-function-of-age.md) | A stored point's resolution is a function of its age |
| [0011](./0011-performance-series-is-a-cache.md) | The performance series is a cache, not a record |
| [0012](./0012-first-party-ui-replaces-grafana-prometheus-stays.md) | The first-party UI replaces Grafana, and Prometheus stays |
| [0013](./0013-accounts-are-data-with-provenance.md) | Accounts are user data with provenance, not a setting |
| [0014](./0014-settings-live-only-in-the-store.md) | Settings live only in the store, and the environment stops speaking |
| [0015](./0015-one-container-two-mounts-persistence-is-observed.md) | One container, two mounts, and persistence that is observed rather than demanded |
| [0016](./0016-conventions-are-explained-on-the-figure.md) | Conventions are explained on the figure, not written on the page |
| [0017](./0017-a-closed-position-leaves-the-table-never-the-total.md) | A closed position leaves the table, never the total |
| [0018](./0018-the-gain-has-four-terms.md) | The gain has four terms, and their sum is its definition |
| [0019](./0019-a-comparison-stops-where-it-exists.md) | A comparison never outruns the period where it exists |
| [0020](./0020-the-line-is-no-longer-the-unit.md) | The line is no longer the unit: the data page revokes rather than repairs |
| [0021](./0021-the-app-asks-one-question.md) | The app asks one question, and not at boot |
| [0022](./0022-the-navigation-is-a-sidebar.md) | The navigation is a sidebar, and width was never the question |
| [0023](./0023-the-preset-owns-the-chrome-the-product-owns-the-meaning.md) | The preset owns the chrome, the product owns the meaning |
| [0024](./0024-the-english-catalogue-is-not-a-translation.md) | The English catalogue is not a translation of the French one |
| [0025](./0025-every-version-has-an-address.md) | Every version has an address, and the newest is not an exception |
| [0026](./0026-a-read-in-flight-is-not-an-absence.md) | A read in flight is not an absence |
| [0027](./0027-a-key-names-a-row-for-as-long-as-the-row-lives.md) | A key names a row for as long as the row lives, and no longer |
| [0028](./0028-the-accounts-page-shows-one-account.md) | The accounts page shows one account, and the comparison moves with its range control |
| [0029](./0029-the-preset-becomes-ours.md) | The preset becomes ours, and it is still installed from a URL |
| [0030](./0030-the-data-page-has-three-tabs.md) | The data page has three tabs |
| [0031](./0031-the-ledger-loads-in-pages.md) | The ledger loads in pages, and only the first one is silent |
| [0032](./0032-the-import-is-a-gesture-not-a-mount.md) | The import is a gesture, not a mount |
| [0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) | Prometheus leaves, and the API stops being a contract |
| [0034](./0034-accounts-are-born-in-the-app.md) | Accounts are born in the app, and nowhere else |
| [0035](./0035-the-first-run-has-three-passages.md) | The first run has three passages, and its memory is the browser's |
| [0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md) | The dot says health, and the notices lose their exception |
| [0037](./0037-notifications-have-a-space-and-the-banner-has-none.md) | Notifications have a space, and the banner has none |
| [0038](./0038-settings-leaves-the-data-page.md) | Settings leaves the data page, and the tabs leave with it |
| [0039](./0039-the-app-stops-forking.md) | The app stops forking, and two guards go with it |
| [0040](./0040-the-app-gets-a-second-reader-and-it-is-an-agent.md) | The app gets a second reader, and it is an agent |
| [0041](./0041-the-rhythm-is-measured-on-the-buys.md) | The rhythm is measured on the buys, and it describes without judging |

> These records describe **v5**, and v5 has landed: `master` carries it, so a record that
> contradicts the code is no longer a plan — it is a **documentation defect**, and it is
> the ADR that must be amended, never the code that must be bent back to it. Amend it by
> writing why the decision changed, not only what it changed to: a record whose reason is
> missing is a record the next reader will re-litigate.
>
> **`preview/v5` is kept for its history alone** — the ticket-by-ticket commits that
> reached `master` folded together. Nothing is written there any more, and it trails
> `master`; this note used to say the opposite, back when it did not.
