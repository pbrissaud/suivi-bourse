# Notifications have a space, and the banner has none

[ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md) separated
three words that had been sharing one — **health**, **installation facts**, **advisories**
— and gave each its own surface. The separation stands and is not reopened here. What is
reopened is the arrangement of the surfaces: the three registers now share **one
destination**, a panel behind the header's bell, and that bell is also the status dot.

This record therefore amends 0036 three months after it was written, and it does so on
two points 0036 argued by name. Both objections are quoted, because a record that steps
over its predecessor's reasoning invites the next reader to re-litigate it.

## The two objections, and what answers them

**"An advisory is never acknowledged."** 0036's reason is exact and it is not a
preference: *"an acknowledgement that outlived its condition would silence the app the
second time the cash piled up, which is the failure a stored one guarantees."* A key in
`installation_fact` — `key VARCHAR PRIMARY KEY, first_seen_at, acknowledged_at` — is
permanent, and acknowledging `cash_cto` once would silence it for the life of the store.

The answer is that **the acknowledgement is bounded in time**. An advisory is
acknowledged *for a window*, not for good, so it cannot outlive its condition by more
than that window. Nothing has to observe the condition going false — which nothing does,
an advisory being derived on every read and stored nowhere — because the expiry needs no
observer. The failure 0036 named is impossible by construction rather than by care.

**"A counter stuck at one is the noise the badge rule was written against"**
([ADR-0021](./0021-the-app-asks-one-question.md)). The badge here counts every open
entry, and three of the four sources never decrement on their own: health, a running
reconstruction, a missing base currency. So the objection lands: this count can sit at
two for a week.

It is accepted with the objection in view rather than around it, for one reason: the
alternative is a badge that counts *some* of what the panel holds, and a reader who opens
a panel expecting three things and finds five has been lied to by a number. What the
decision owes in exchange is that **the control which clears says what it clears** — see
below.

## Consequences

- **One indicator, and the bell is the dot.** The bell's **icon carries the health
  colour** — green, amber, red — and its **badge carries the count**. Two channels, one
  control, one destination, which is what ADR-0022 asked for when it refused a second
  global badge and what 0036 restated as *one indicator, not two*. The badge is
  deliberately neutral in colour so the two channels do not compete for the same signal.
- **The sidebar's status card goes, and *one indicator* becomes literal.** ADR-0022 kept
  it as the dot's *development where there was room*, back when the dot was a colour and
  nothing else. The bell is no longer only a colour: it carries the count, it names its
  own state in its accessible name, and it opens onto a health card that says the state
  in prose. That is three renderings of one fact, and the sidebar card was a fourth —
  the one that vanishes in the rail and in the drawer, which is to say on the widths
  where a reader has least to look at. What it alone used to say, the scrape cadence, was
  never health: it is a setting, and it is already on the settings page as a field.
- **Every entry has two axes, and only one of them is a word on screen.** The
  **register** — `health`, `installation fact`, `advisory` — is never named to the
  reader; it decides what the card offers. The **subject** — Health, Installation,
  Portfolio, Accounts — is the group heading and the destination of the card's link. So
  0036's separation is preserved in the model and hidden from the reader, who sees
  subjects and infers the rest from what each card lets them do.
- **What each register offers.** Health offers a link and no acknowledgement, because it
  is repaired rather than dismissed. An installation fact offers *Acknowledge*, stored
  and permanent, which is the mechanism `installation_fact` already holds. An advisory
  offers *Acknowledge 30 days*, and says so on the card — it is put to sleep, never
  ended, and the condition itself ends when the owner invests the cash or the price
  starts moving again.
- **The advisory acknowledgement is a new table, not a new column.** The DDL is applied
  with `IF NOT EXISTS` and there is no migration machinery, so a column added to
  `installation_fact` would exist on no store created before it. `advisory_ack` is
  created on an existing store like any other table, and it carries the expiry that
  `installation_fact` deliberately does not. The count of tables the product declares
  goes from eleven to twelve, and the comment in `store.py` that calls the count
  meaningful moves with it.
- **An advisory is still read beside the figure it comments on.** The chip on the account
  and the chip on the security stay: they are the *reading*, the panel is the *inventory*.
  What the chip never offers is the acknowledgement — one fact cannot propose two
  different gestures depending on where it is met, so the gesture belongs to the panel
  and to the panel alone. And the distinction has to be **observable** or it is not one:
  *acknowledge for thirty days* is *not now*, said to the inventory, so the card goes and
  the chip stays — the cash is still sitting in that account while the window is open.
  The route serves both from one derivation: bare it answers `listing`, and
  `?asleep=include` answers `standing`, which is the chip's read.
- **A card's link lands on the figure, never on the page.** *See the account* opens
  Accounts **with that account selected**; *See the security* opens its sheet; *See the
  events concerned* opens the ledger **reduced to them**, the reduction naming itself and
  offering the way out, as every reduction must.
- **"Acknowledge all" is renamed rather than kept honest by hope.** It cannot reach zero
  any more, so it states its own scope — *Acknowledge the 3 acknowledgeable* — and when
  there are none it is disabled **with its reason in prose**, in the form the account
  refusals already use. This is the exchange the badge's stuck counter is accepted for.
- **The panel says nothing to report only when there is nothing.** A pinned red health
  card and an empty-state sentence cannot be on screen together; the sentence is true of
  the panel or it is not said.
- **The banner goes, and it is not replaced.** ADR-0021 gave the app one interruption and
  three surfaces — receipt, banner, installation panel. The banner's three conditions
  (a missing base currency, a running reconstruction, a stopped scheduler) are entries
  here now, so the slot has nothing left that is its alone. **Three surfaces become two.**
- **Its sentence descends to the emptiness it explained.** A missing base currency renders
  nothing on the dashboard, the securities and the accounts — and each of those empty
  states *says why*, in place of the tirets it would otherwise show. The ledger stays
  readable throughout: the events are declared, it is their valuation that waits. The
  banner's job was never the strip at the top; it was the sentence, and the sentence is
  closer to its subject one floor down.
- **The rule 0021 wrote to separate banner from badge is spent, and its replacement is
  written here**: *the empty state says why what you are looking at is empty; the panel
  says what you might do about something that is nonetheless right.* The old rule —
  conditions the owner can end against facts they can only acknowledge — no longer cuts
  anything, since advisories are conditions and they are counted.
- **The word `notification` is rehabilitated in the glossary.** `CONTEXT.md` put it under
  `_Avoid_` for both *installation fact* and *advisory*, and rightly: it was a lazy
  synonym flattening two things the product had just told apart. It now names a
  **container** and not a content, which is a different job, so it stops being ambiguous
  the moment the surface exists.

[The separation it keeps and the surfaces it rearranges: ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md) ·
[the banner it retires and the badge rule it spends: ADR-0021](./0021-the-app-asks-one-question.md) ·
[the single indicator it honours: ADR-0022](./0022-the-navigation-is-a-sidebar.md) ·
[the page the panel's destination becomes: ADR-0038](./0038-settings-leaves-the-data-page.md) ·
[the spec that carries it: #787](https://github.com/pbrissaud/suivi-bourse/issues/787) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
