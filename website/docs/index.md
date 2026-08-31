---
title: Home
id: home
description: What SuiviBourse is, and what it is not
slug: /
---

# SuiviBourse

A personal stock-portfolio tracker. You record what you bought, sold, received
and paid in; it fetches the prices, values your positions and computes your
returns — in one container, with nothing else to install.

## What it does

- **It keeps your ledger.** Six kinds of event — `BUY`, `SELL`, `GRANT`,
  `DIVIDEND`, `DEPOSIT`, `WITHDRAWAL` — recorded in the app or imported from
  the files your broker exports. Your events are the only thing it treats as
  yours; everything else it shows is derived from them and can be recomputed.
- **It fetches prices, and it fetches the past.** A symbol whose market is open
  is polled often, a symbol whose market is closed sleeps until it reopens, and
  the history behind your first purchase is rebuilt in the background until it
  reaches it.
- **It reports in one currency.** Everything you own is converted into a single
  base currency, so a portfolio spread over several markets still adds up to one
  figure.
- **It shows you five pages** — a dashboard, your shares, your accounts, the
  ledger you gave it and what this installation is — and each figure explains, on
  the figure itself, the convention it rests on.
- **It has one interface, and it is that one.** Everything the app knows about
  itself it says on those pages; there is no second surface to scrape and no
  second port to publish.

## What it is not

- **Not a broker, and not an adviser.** It executes nothing, recommends nothing
  and knows nothing your events do not tell it.
- **Not a stack.** There is no database to run beside it, no dashboard tool to
  provision and nothing to compose: one image, one store, one process.
- **Not a market terminal.** Prices come from Yahoo! Finance on a polite
  cadence; the further back a point is, the coarser it is kept.
- **Not an upgrade from version 4.** A version 5 install is a new install whose
  import folder happens to be full — see [Coming from v4](./coming-from-v4.mdx).

## Start here

[Get started](./get-started.mdx) is one command and one screen.

## Support, licence, credits

To report a problem or request a feature,
[open a ticket](https://github.com/pbrissaud/suivi-bourse/issues/new/choose).
Pull requests are welcome — please read
[the contributing guide](https://github.com/pbrissaud/suivi-bourse/blob/master/CONTRIBUTING.md)
first. The project is under the
[MIT licence](https://github.com/pbrissaud/suivi-bourse/blob/master/LICENSE),
and owes a great deal to the maintainers of the projects it relies on.
