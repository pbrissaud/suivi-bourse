/**
 * The side panel of a Settings procedure (token, provider, channel, tax model):
 * 460 px, a header (20/28/600), a body with a 24 px gap that scrolls, and a
 * footer with the destructive text link on the left, then Annuler and the one
 * filled button — the frame `TokenSheet-Refonte`, `ProviderSheet-Refonte` and
 * `TaxSheet-Refonte` share.
 */
import type { FormEvent, ReactNode } from 'react'

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'

export function SettingsSheet({
  open,
  onClose,
  title,
  subtitle,
  footer,
  onSubmit,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: ReactNode
  footer: ReactNode
  /** The body and footer are a form when the sheet submits. */
  onSubmit?: () => void
  children: ReactNode
}) {
  const body = (
    <>
      <div className="flex flex-1 flex-col gap-6 overflow-x-hidden overflow-y-auto px-6 pt-5 pb-6">
        {children}
      </div>
      <footer className="flex items-center gap-2 border-t px-6 py-4">{footer}</footer>
    </>
  )
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent className="w-full gap-0 sm:max-w-[460px]">
        <div className="px-6 pt-5">
          <SheetTitle className="text-2xl">{title}</SheetTitle>
          <SheetDescription className={subtitle ? 'mt-0.5' : 'sr-only'}>
            {subtitle ?? title}
          </SheetDescription>
        </div>
        {onSubmit ? (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              onSubmit()
            }}
          >
            {body}
          </form>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">{body}</div>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** A label over a field, the sheet's own grammar (`.lbl`). */
export function SheetField({
  id,
  label,
  optional,
  children,
}: {
  id?: string
  label: ReactNode
  /** The suffix after « · » in weight 400 (« facultatif »). */
  optional?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="label">
        {label}
        {optional ? <span className="font-normal"> · {optional}</span> : null}
      </label>
      {children}
    </div>
  )
}
