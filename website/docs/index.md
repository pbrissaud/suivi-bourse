---
title: Home
id: home
description: SuiviBourse documentation home
slug: /
sidebar_position: 1
---

# Documentation Home

Welcome to the **SuiviBourse** documentation.

SuiviBourse monitors your stock portfolio: it fetches live prices from
Yahoo! Finance, stores them (together with historical data) in
**InfluxDB 3 Core**, and lets you visualize everything in **Grafana**.

:::info Version 4
This documentation covers version **>= 4.0**, which stores data in
**InfluxDB 3 Core** and adds **historical backfill** and the **events**
configuration mode.

Looking for the previous release? Switch to **v3** with the version selector in
the top-right navbar — v3 stores data in Prometheus and only supports the manual
configuration mode.
:::

## What's new in v4

- **InfluxDB 3 Core** replaces Prometheus as the primary datastore, unlocking
  long-term historical storage.
- **Historical backfill**: SuiviBourse progressively fills past price data back
  to your first purchase, so you can see the full evolution of your portfolio.
- **Events mode**: describe your portfolio as a list of transactions
  (`BUY`, `SELL`, `GRANT`, `DIVIDEND`) in CSV/XLSX files and let SuiviBourse
  aggregate positions automatically.
- The **legacy Prometheus endpoint** is still exposed for backward compatibility.

Start with the [Getting Started](/docs/intro/getting-started) guide.

## Support

To report a problem or request a feature, please
[open a ticket on the GitHub page](https://github.com/pbrissaud/suivi-bourse/issues/new/choose).

## Contributing

Pull requests welcome, as long as they're not overly specific to a niche
use-case. Please read and follow the
[contributing documentation](https://github.com/pbrissaud/suivi-bourse/blob/master/CONTRIBUTING.md).

## Licence

This project is under the
[MIT license](https://github.com/pbrissaud/suivi-bourse/blob/master/LICENSE).

## Credits

A big thank you to the contributors and maintainers of the projects SuiviBourse
relies on.
