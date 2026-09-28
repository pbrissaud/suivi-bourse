/**
 * A field that suggests, and never stops being a field (#1036).
 *
 * The control is an `<input>` with a list underneath, and the distinction that
 * governs every decision below is that **the input is the value**. A reader who
 * types a ticker nobody has ever held is doing the normal thing, so nothing here
 * may refuse, rewrite, or require a gesture on what was typed.
 *
 * ```
 *   ┌─────────────────────────────┐
 *   │ MC.P|                       │  ← PopoverAnchor wraps the input itself,
 *   └─────────────────────────────┘    so the list is the width of the field
 *   ┌─────────────────────────────┐
 *   │ MC.PA                  LVMH │  ← bg-accent when active, never --primary
 *   │ MC.AS              Movado…  │
 *   └─────────────────────────────┘
 * ```
 *
 * Five things are decisions rather than defaults:
 *
 *  - **No line is active until an arrow key says so.** `Entrée` on a field
 *    nobody has arrowed into still submits the form it sits in, which is the
 *    gesture this product already had: type a ticker, press enter, the event is
 *    recorded. A pre-highlighted line would turn that reflex into *record the
 *    line I happened to be hovering*, in a form that writes a portfolio.
 *  - **The list is drawn in the container it is given.** Inside a modal dialog,
 *    `react-remove-scroll` cancels wheel and touch everywhere but the shards it
 *    was handed, and radix's dialog hands it one: its own content. A list
 *    portalled to `document.body` therefore has a scrollbar that answers no
 *    mouse. The caller passes the dialog's node and the problem evaporates.
 *  - **The layer is real, and that is what makes `Escape` behave.** Radix
 *    registers its escape handler for the highest layer only, so the open list
 *    takes the key and the sheet underneath keeps it. There is nothing to stop
 *    and nothing to propagate.
 *  - **An option takes the pointer without taking the focus.** `preventDefault`
 *    on `pointerdown` is what keeps the caret in the field while a line is
 *    clicked; without it the field blurs at the exact moment of choosing.
 *  - **One highlight, not two.** The hover moves the active index rather than
 *    painting a second surface, so what the eye follows and what
 *    `aria-activedescendant` names are the same line.
 *
 * **Two deliberate divergences from `Palette.tsx`**, which renders the same
 * object and is the precedent this row was drawn from:
 *
 *  - **No badge.** The palette's four-letter mono chip says which *kind* of line
 *    you are looking at among five sections — a title, an account, an event. A
 *    list where every line is a title has no kind to announce, and the chip
 *    would print the ticker a second time beside itself.
 *  - **The code leads, the name follows.** The palette puts the company name in
 *    the label because a reader searching *what do I own* recognises a name. The
 *    field this list serves is labelled `Ticker`, and the value it writes is a
 *    ticker — so the ticker is the label and the name is the hint. It also
 *    degrades correctly: every event this product's own create form writes
 *    carries `name: null` (`lib/api.ts`, `EventDraft`), so on a typed portfolio
 *    the palette's order would have printed the ticker twice and nothing else.
 *
 *  - **A taller row, and a different highlight.** `py-3` against the palette's
 *    `py-2` makes the line exactly 44px, the touch target a list you pick from
 *    with a thumb owes; and the highlight is `--accent`, not the palette's
 *    `--muted`. `index.css:35-39` names `--accent` as the surface of a hovered
 *    or selected row and warns that the mint dropped there takes text to 2,4:1
 *    — which makes the palette the one standing off-system, not this row.
 *
 * The active surface is therefore `--accent` and never `--primary`.
 *
 * It holds no vocabulary of its own: the items, their labels and the sentence a
 * screen reader hears are the caller's, which is what keeps this file a
 * primitive rather than a second place the domain is spelled.
 */
import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent } from 'react'

import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * One line of the list. `value` is what the field receives when it is chosen,
 * and it is **the line's identity**: it keys the row and it is what the active
 * line is remembered by, so two items may not share one. The caller owns that
 * uniqueness — here, one entry per symbol.
 */
export interface ComboboxItem {
  value: string
  label: string
  /** What the line says on its right — a name, a unit. `null` for nothing. */
  hint: string | null
  /**
   * Whether the label is a **code** rather than a sentence. A ticker is read
   * column by column down a list, which is what the fixed pitch is for; a line
   * that offers to record what was typed is a sentence and reads as one.
   */
  mono?: boolean
}

// `onKeyDown` is refused rather than merged: the keyboard contract above is
// the whole of this control, and a caller's handler spread over it would
// silently replace it.
type InputProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'onKeyDown'>

export interface ComboboxProps extends InputProps {
  value: string
  onValueChange: (value: string) => void
  /**
   * What the list offers, already filtered and ordered by the caller. Empty is
   * *nothing to show* and the list never opens — which is also how a read that
   * has not landed is rendered, since an empty list says nothing at all.
   */
  items: readonly ComboboxItem[]
  /** The node the list is drawn in. `null` — `document.body`, the default. */
  container?: HTMLElement | null
  /** What a screen reader calls the list. */
  listLabel: string
}

export function Combobox({
  value,
  onValueChange,
  items,
  container,
  listLabel,
  className,
  ...props
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  /**
   * The active line is held **by its value and not by its index** (#1036).
   *
   * `items` is rebuilt whenever the collection behind it is refetched, and the
   * panel stays open across at least one refetch by design — a save that failed
   * because the row went elsewhere re-reads the ledger with the sheet still up.
   * An index kept across that refetch points at whatever moved into its slot,
   * and `Entrée` would then record a ticker the reader never chose. A value that
   * is no longer in the list resolves to *nothing active*, which is the state
   * that hands the key back to the form.
   */
  const [activeValue, setActiveValue] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const options = useRef<(HTMLLIElement | null)[]>([])
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`
  /** Where the active value sits **today**. `-1` — nothing is active. */
  const active = activeValue === null ? -1 : items.findIndex((item) => item.value === activeValue)

  // Nothing to show is nothing to open: the two states that produce an empty
  // list — no match, and a read that has not answered — render identically.
  const shown = open && items.length > 0

  function close() {
    setOpen(false)
    setActiveValue(null)
  }

  function choose(index: number) {
    const item = items[index]
    if (item === undefined) return
    onValueChange(item.value)
    close()
    field.current?.focus()
  }

  /**
   * The active line is scrolled to rather than searched for: an id carrying a
   * ticker (`MC.PA`) is not a valid CSS selector, and a ref never was one.
   *
   * **Only for the keyboard.** A pointer that moves the active line must not
   * make the list move under it: `block: 'nearest'` on a half-visible row
   * scrolls it into full view, which slides another row under the cursor, which
   * moves the active line again. The arrow keys are the only caller that needs
   * the list to follow, because they are the only one that can leave the view.
   */
  const arrowed = useRef(false)
  useEffect(() => {
    if (active < 0 || !arrowed.current) return
    options.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function move(step: number) {
    if (items.length === 0) return
    arrowed.current = true
    setOpen(true)
    const next = active < 0 ? (step > 0 ? 0 : items.length - 1) : (active + step + items.length) % items.length
    setActiveValue(items[next]?.value ?? null)
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        return
      case 'Home':
        if (!shown) return
        event.preventDefault()
        arrowed.current = true
        setActiveValue(items[0]?.value ?? null)
        return
      case 'End':
        if (!shown) return
        event.preventDefault()
        arrowed.current = true
        setActiveValue(items[items.length - 1]?.value ?? null)
        return
      case 'Enter':
        // **Only over a line the reader arrowed onto.** Otherwise the key
        // belongs to the form, and the form records an event with it.
        if (!shown || active < 0) return
        event.preventDefault()
        choose(active)
        return
      case 'Tab':
        close()
        return
      default:
    }
  }

  return (
    <Popover open={shown} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverAnchor asChild>
        <Input
          // The caller's props come **first**: everything below is this
          // control's own contract, and a `ref` or an `aria-*` landing after it
          // would silently disconnect the field from its own keyboard.
          {...props}
          ref={field}
          role="combobox"
          aria-expanded={shown}
          // (4) The list only exists while it is shown, so the reference only
          // exists then too — a dangling IDREF is worse than none.
          aria-controls={shown ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active < 0 ? undefined : optionId(active)}
          autoComplete="off"
          value={value}
          className={className}
          onChange={(changed) => {
            onValueChange(changed.target.value)
            setOpen(true)
            // What was typed is not what was chosen: the active line goes back
            // to nothing, so `Entrée` keeps belonging to the form.
            setActiveValue(null)
          }}
          onKeyDown={keyDown}
        />
      </PopoverAnchor>
      <PopoverContent
        // The wrapper's own `role="dialog"` would announce a dialog with no
        // name around a listbox. The list is what carries the role here.
        role="presentation"
        container={container}
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-(--radix-popover-trigger-width) max-h-(--radix-popover-content-available-height) overflow-y-auto p-1"
        // The field keeps the caret: without this the layer takes the focus on
        // open and the next keystroke lands nowhere.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Radix exempts its own trigger from the outside-pointer dismissal, and
        // there is no trigger here — the anchor is the field. Without this,
        // putting the caret back in the field closes the list.
        onPointerDownOutside={(event) => {
          if (field.current?.contains(event.target as Node)) event.preventDefault()
        }}
      >
        <ul id={listId} role="listbox" aria-label={listLabel}>
          {items.map((item, index) => (
            <li
              key={item.value}
              ref={(node) => {
                options.current[index] = node
              }}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              // The pointer chooses; the caret stays where it was. Only for a
              // mouse: cancelling `pointerdown` on a touch screen is what stops
              // a finger from scrolling the very list it is scrolling.
              onPointerDown={(event) => {
                if (event.pointerType === 'mouse') event.preventDefault()
              }}
              onClick={() => choose(index)}
              onMouseMove={() => {
                arrowed.current = false
                setActiveValue(item.value)
              }}
              className={cn(
                'flex cursor-default items-center gap-3 rounded-md px-3 py-3 text-sm',
                index === active && 'bg-accent text-accent-foreground',
              )}
            >
              {/* **C'est l'indice qui cède, jamais le libellé.** La palette fait
                  l'inverse, et elle a raison chez elle : son libellé est un nom
                  de société et son indice un ticker. Ici les deux ont échangé
                  leurs places, donc la priorité de rétrécissement échange aussi
                  — sans quoi `MC.PA` s'abrège en `M…` pour laisser tout leur
                  aise à « Taiwan Semiconductor Manufacturing Company Limited ». */}
              <span
                className={cn(
                  'truncate',
                  // Un code est court et ne cède pas — mais `max-w-full` le
                  // borne quand même, faute de quoi un ticker absurde importé
                  // d'un fichier ferait défiler la liste à l'horizontale.
                  item.mono ? 'max-w-full shrink-0 font-mono' : 'min-w-0 grow',
                )}
              >
                {item.label}
              </span>
              {item.hint === null ? null : (
                // Un nom de société vient du grand livre et n'a ni longueur ni
                // direction connues : `<bdi>` l'isole du sens de lecture de la
                // ligne, qu'un caractère de bascule renverserait autrement.
                <bdi className="min-w-0 grow truncate text-right text-xs text-muted-foreground">
                  {item.hint}
                </bdi>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
