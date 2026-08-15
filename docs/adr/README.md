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

> These records describe **v5**, which is being designed on `preview/v5`. Where they
> contradict the code on `master`, the code is v4 and the record is the destination.
