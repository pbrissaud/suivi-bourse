# The navigation is a sidebar, and width was never the question

The shell was the one front-end surface the redesign had given to nobody: four pages each had a
ticket, their shared vocabulary had a fifth, and the navigation was inherited from the prototype
untouched. The question put to it was what a 256 px column costs the two decisions that were
settled at full width — the twelve-slice allocation ([ADR-0018](./0018-the-gain-has-four-terms.md))
and the eight-column accounts table ([ADR-0019](./0019-a-comparison-stops-where-it-exists.md)).

Mounted on the real portfolio with shadcn's own `Sidebar`, it costs them **nothing visible**:

```
window   top bar    sidebar    cost
1920 px  1232 px    1232 px      0
1536 px  1232 px    1232 px      0     ← above this, the cap is reached either way
1440 px  1232 px    1136 px    −7,8 %
1280 px  1232 px     976 px   −20,8 %  ← worst realistic case; both payers still hold
 390 px   342 px     342 px      0     ← sidebar becomes a drawer
```

At 976 px the twelve slices still sit in two columns of six with no name wrapping, and the eight
columns neither truncate nor scroll. The half-width failure that founded the concern measured
~608 px; a sidebar never approaches it. **The cost follows the window, not the form** — it is nil
above 1536 px, where the column eats a gutter rather than content.

So the two forms are separated somewhere else, and mechanically: **at 390 px with four entries the
top bar loses a route.** *Données* overflows its row with no scroll and no drawer, taking the
status dot with it. The sidebar answers with the component's drawer. A lost function outweighs the
chrome — a column that is empty across roughly two thirds of its height at four entries, more at
three.

The cap stays. Uncapping gives the content 1616 px at 1920 (+31,2 %), a width neither paying page
was ever judged at, and the dashboard head visibly loosens there. `max-w-7xl` stops being an
inheritance and becomes a measured decision.

## Consequences

- **The collapse is kept, and the dot moves instead.** shadcn hides `SidebarMenuBadge` in icon
  mode and the drawer takes the whole navigation with it, so the status dot survives neither.
  Forbidding a form to work around that would let the tool decide the product.
- **The status dot sits at the right of the content header and is a link** — the only place that
  survives all three sidebar states. Moving it strips its anchor, so it regains one by *leading*
  to the installation tab rather than indicating without pointing. This **amends
  [ADR-0021](./0021-the-app-asks-one-question.md)** on the dot's location only, never on its
  nature: it stays a state, not a count.
- **The banner lives in the content column.** Mounted full width under a sidebar its left edge
  runs behind the column — it has no honest left edge there. "Visible from any page" loses
  nothing, the content column being present on all four. One band, never two, is untouched.
- **The content header becomes an object of the product**, not a mount for a trigger: collapse on
  the left, status on the right, on every page.
- **Translation is not pre-empted, it is exercised.** The language control was mounted in both
  forms rather than reserved a slot, so the chosen form survives either answer and *where the
  language lives* stays whole. The precedent is on file: a reserved `status` slot had to be
  retired unused — a reservation that is not mounted is a debt.
- **The narrow case stops being a form to decide.** The rail, the drawer, the keyboard shortcut
  and the persisted state come with the component, which is what removed the ticket's last open
  question rather than answering it.
- **N ≥ 3 stays unobserved.** The column was judged at four entries and at three; the navigation
  does not vary beyond that, but chrome is judged on a product that does not grow.

[Full argument: #691](https://github.com/pbrissaud/suivi-bourse/issues/691) ·
[the widths it re-measured: #683](https://github.com/pbrissaud/suivi-bourse/issues/683),
[#685](https://github.com/pbrissaud/suivi-bourse/issues/685) ·
[the dot it relocates: ADR-0021](./0021-the-app-asks-one-question.md)
