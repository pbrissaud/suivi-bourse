/**
 * **The one confirmation** (« Relevé », mockup `Confirm-Refonte.dc.html`): a
 * centred 440 px dialog, radius 14, `border`, no shadow, that names what is
 * about to go instead of asking *are you sure*.
 *
 *  - a **question** as the title (« Purger 2 historiques ? »);
 *  - a **ruled list of what goes**, the key in Geist and the value in `.fig`
 *    `muted-foreground` — absent when there is nothing to enumerate;
 *  - **one line**, « Irréversible. … » or « Immédiat. … » — DESIGN.md's one
 *    sentence a screen is allowed to say about what will happen;
 *  - **Annuler** (outline) and a filled `destructive` button carrying the verb.
 *
 * It is an `alertdialog`, and it opens on its safe answer. It is the only
 * confirmation of the product: purging histories, deleting a thread, an event,
 * an account, revoking a token. A refused write is shown inside it (`error`),
 * since everything behind the overlay is `aria-hidden` while it is up; fields
 * the confirmation needs (the access code to switch the code off) go in
 * `children`, and Enter in one of them confirms.
 */
import { type FormEvent, type ReactNode, useRef } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { useT } from '@/lib/i18n'

export interface ConfirmItem {
  /** What goes, in Geist (« CSPX.AS », « 57 événements »). */
  key: ReactNode
  /** Its measure, in `.fig` `muted-foreground` (« 4 120 cours »). */
  value?: ReactNode
}

interface ConfirmDestructiveProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The question: « Supprimer cet événement ? ». */
  title: string
  /** What goes. Omit when there is nothing to enumerate. */
  items?: readonly ConfirmItem[]
  /** « Irréversible. … » or « Immédiat. … », one line. */
  line: string
  /** The verb on the destructive button: « Supprimer », « Révoquer ». */
  confirmLabel: string
  onConfirm: () => void
  /** A write is in flight: the destructive button is held. */
  pending?: boolean
  /** Hold the destructive button for another reason (nothing left to act on). */
  disabled?: boolean
  /** A refusal (`<Refusal>`), drawn inside the dialog. */
  error?: ReactNode
  /** Fields the confirmation needs, between the list and the line. */
  children?: ReactNode
  /** Where the focus goes when it closes; by default back to what opened it. */
  onCloseAutoFocus?: (event: Event) => void
}

export function ConfirmDestructive({
  open,
  onOpenChange,
  title,
  items = [],
  line,
  confirmLabel,
  onConfirm,
  pending = false,
  disabled = false,
  error,
  children,
  onCloseAutoFocus,
}: ConfirmDestructiveProps) {
  const t = useT()
  const cancel = useRef<HTMLButtonElement>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!pending && !disabled) onConfirm()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        role="alertdialog"
        showCloseButton={false}
        className="gap-0 p-0"
        onCloseAutoFocus={onCloseAutoFocus}
        // It opens on its safe answer.
        onOpenAutoFocus={(event) => {
          if (children) return
          event.preventDefault()
          cancel.current?.focus()
        }}
      >
        <form onSubmit={submit} className="contents">
          <div className="flex flex-col gap-3 px-6 pt-6 pb-5">
            <DialogTitle className="text-2xl leading-7 font-semibold tracking-normal">
              {title}
            </DialogTitle>
            {items.length > 0 ? (
              <ul className="flex flex-col">
                {items.map((item, at) => (
                  <li
                    key={at}
                    className="flex min-h-9 items-center justify-between gap-4 border-b text-sm"
                  >
                    <span className="min-w-0 truncate">{item.key}</span>
                    {item.value === undefined ? null : (
                      <span className="fig text-muted-foreground">{item.value}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {children}
            <DialogDescription className="text-md">{line}</DialogDescription>
            {error}
          </div>
          <DialogFooter className="flex-row items-center justify-end gap-2 border-t px-6 py-4">
            <Button
              ref={cancel}
              type="button"
              size="sheet"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {t('confirm.cancel')}
            </Button>
            <Button type="submit" size="sheet" variant="destructive" disabled={pending || disabled}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
