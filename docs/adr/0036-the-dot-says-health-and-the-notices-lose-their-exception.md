# The dot says health, and the notices lose their exception

> **The surfaces are rearranged by
> [ADR-0037](./0037-notifications-have-a-space-and-the-banner-has-none.md)**: the three
> registers share one destination, a panel behind the header's bell, and that bell is the
> dot. Two things below no longer describe the product — *an advisory is never
> acknowledged* (it is, but only for a window, which is what answers the objection stated
> here) and *advisories need no global indicator* (the badge counts them). **The
> separation of the three words stands**, and so does *one indicator, not two*: there is
> still exactly one, and it is the bell. The dot's destination is renamed by
> [ADR-0038](./0038-settings-leaves-the-data-page.md) — the installation tab is a page.

Three things were sharing one word. They are separated here, and each gets its surface.

**Health** is whether the app is doing its work — it serves, its store answers, its jobs ran
when they were due. **Installation facts** are what is true of this install and cannot be
computed by its owner: a retired variable still set, a currency adopted from a file, a
reconstruction under way. **Advisories** are what the owner's *data* says about itself — a
quarter of an account sitting in cash — and they did not exist before this record.

## Health is said in two registers, and they never mix

`/health` today is a liveness probe and nothing more: the worker serves, the store answers a
`ping`. What *"is it still scraping"* needs already exists elsewhere — `runtime_state.py`
keeps every job's last pass and `GET /api/runtime` serves it without touching the store. The
decision is the junction, and its rule is:

- **the HTTP status code is for the orchestrator**, and its only question is *should this
  container be restarted*. That is exactly the probe of today: the process serves and the
  store answers;
- **the body is for a person**, and carries each job — scrape, backfill, performance — with
  its last pass and its verdict. The front paints it green, amber or red.

A silent scrape is **amber with a `200`**. Restarting repairs nothing that yfinance or the
market broke, and a probe that reds on it turns a stuck job into a restart loop that fixes
nothing and hides everything. This is the register that
[ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) makes necessary:
with the gauges gone, this body *is* the observability.

## Consequences

- **The dot leads to the installation tab**, where the jobs and the store are — the place
  where one repairs, which is what ADR-0022 asked of it when it made the dot *lead* somewhere
  rather than indicate without pointing.
- **The dot reads the health route, and that is a trade rather than a detail.** It reads the
  runtime resource today, which **touches no store** — a property #659 argued for by name, so
  that a diagnostic would not die with the thing it diagnoses. Health is now said in one
  place, and the dot reads that place; the cost is that the body goes when the store goes.
  What survives the loss is the part that matters most then: the route answers `503`, the
  read fails, and the dot is **red** — the one colour that needs no body to be true. The
  runtime resource stays, and stays store-free, as the installation tab's detail.
- **ADR-0030's exception is withdrawn, and the principle it broke is whole again.** The
  notices tab was kept permanently mounted for one reason, stated there: *"a tab that answers
  'nothing to report' answers exactly the question the dot asks; a destination that exists
  only when the dot is amber gives one control two addresses."* The dot no longer asks that
  question. So the installation facts render as an ordinary block that **does not exist when
  it is empty**, and *a block with nothing in it does not exist* has no exception anywhere.
- **One indicator, not two.** A second badge for advisories beside a dot for health would be
  the very thing ADR-0022 refused, doubled: two controls the reader must learn to tell apart.
  Advisories need no global indicator — they are read beside the figures they comment on.
- **The three surviving advisory keys are renamed, not moved.** `unread_environment`,
  `reconstruction_running` and `assumed_base_currency` become **installation facts** in the
  table, the route and the front; they are already rendered where they belong.
  `reconstruction_running` was already a banner condition rather than an acknowledgeable
  fact, by ADR-0021's own rule — *the banner shows conditions the owner can end; the badge
  counts facts they can only acknowledge*. The rename lands with this lot, ahead of the
  advisories themselves, so the word is never carrying two meanings at once.
- **An advisory is never acknowledged.** By that same rule it is a condition the owner can
  end: they invest the cash and it stops. Nothing is stored, so nothing has to expire — and
  an acknowledgement that outlived its condition would silence the app the second time the
  cash piled up, which is the failure a stored one guarantees.
- **Advisories are built after this lot.** They are a new feature and not a consequence of
  removing the import; their thresholds start as constants, and become dials the day a second
  value is actually wanted. A setting nobody has ever turned is a setting that should not
  have been written.
- **The route keeps the name `/health`.** `/healthz` is a Kubernetes idiom, and this product
  ships as one self-hosted container whose probe is written into its own image — so the
  convention is addressed to a reader the app does not have. The rename would be affordable,
  v5 having not shipped; it is declined because *affordable* is not a reason, and because the
  name is spelt in the blueprint, the module, the `HEALTHCHECK` and the suite. What changes
  here is what the route **answers**, not what it is called.

[The dot's placement: ADR-0022](./0022-the-navigation-is-a-sidebar.md) ·
[the exception it withdraws: ADR-0030](./0030-the-data-page-has-three-tabs.md) ·
[the banner-versus-badge rule: ADR-0021](./0021-the-app-asks-one-question.md) ·
[the observability it inherits: ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
