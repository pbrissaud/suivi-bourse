/**
 * The convention bubble (ADR-0016) — the first of the three shared primitives,
 * and the one that did not exist at all.
 *
 * Until now the product's only mechanism for explaining a figure was two
 * `title=` attributes sat on the XIRR and the TWR: a second of delay, unstyled,
 * and **non-existent on touch**. Those two sentences are not discarded — they
 * become the *first* sentence of their bubble.
 *
 * Five decisions are encoded here rather than described:
 *
 *  - **One bubble, one text.** What the figure means, the rule it rests on,
 *    then the link. No second level: a bubble that opens onto another bubble is
 *    a page that explains itself, which is what the icon exists to replace.
 *  - **Click, never hover.** Hover does not exist on touch, and a convention
 *    readable on half the devices is a convention not stated. It is also what
 *    lets the reader *walk to the link inside*: a hover bubble closes the moment
 *    the pointer leaves the figure for it.
 *  - **It closes on scroll**, because a bubble must not outlive the figure it
 *    explains. The board that mounted it `position: fixed` left it pinned above
 *    unrelated content, which is worse than no bubble.
 *  - **It opens beside its figure, never over it.** Two boards out of two showed
 *    it covering the very numbers it was explaining. jsdom has no layout, so
 *    this half is an acceptance criterion checked by eye; what is written here
 *    is the side and the collision padding that make it true.
 *  - **The link carries version and locale** (`lib/docs.ts`). It is the first
 *    `href` to the outside in the whole front.
 *
 * The trigger names itself after **its figure** — `Ce que veut dire Gain total`
 * — so four bubbles on one head are four distinct handles rather than four
 * identical *More information* buttons.
 */
import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { docsHref, type DocsAnchor } from '@/lib/docs'
import { useI18n, type MessageKey } from '@/lib/i18n'

export interface ExplainProps {
  /** The figure's own name, as it is written beside it. */
  figure: string
  /** The one text: what it means, then the rule. */
  body: MessageKey
  /** Where the whole rule lives, on the versioned documentation page. */
  anchor: DocsAnchor
}

export function Explain({ figure, body, anchor }: ExplainProps) {
  const { t, language } = useI18n()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      // Scrolling *inside* the bubble is not leaving it. Matched on the slot
      // rather than on a ref so the portal's own node needs no plumbing.
      const target = event.target
      if (target instanceof Element && target.closest('[data-slot="popover-content"]')) return
      setOpen(false)
    }
    // Capture: a `scroll` event does not bubble, so a listener on `window`
    // only ever sees the page's own — which is the half that matters least.
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [open])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-label={t('explain.open', { figure })}
      >
        <Info className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        // Beside, not over — and let it flip rather than run off the viewport.
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        className="space-y-3 text-sm leading-relaxed"
      >
        <p>{t(body)}</p>
        <a
          href={docsHref(language, anchor)}
          target="_blank"
          rel="noreferrer"
          className="inline-block font-medium underline underline-offset-4"
        >
          {t('explain.link')}
        </a>
      </PopoverContent>
    </Popover>
  )
}
