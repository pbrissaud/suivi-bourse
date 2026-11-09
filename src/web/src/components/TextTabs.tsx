/**
 * **Text tabs** — how a screen chooses a view or a type (« Relevé », DESIGN.md ›
 * Components). They replace the segmented controls, which now only draw the
 * chart's period and a setting's values.
 *
 * On a page: 15/22/500, gap 24, a 2 px `foreground` underline on the active tab
 * that sits on the container's 1 px `border` line. In a sheet (`size="sheet"`):
 * 14/20, gap 18, the active tab 500 and the others 400.
 *
 * A tab *chooses what the slot below draws*, so this is a real `tablist`:
 * one tab stop, the arrows (and Home / End) move the choice and the focus with
 * it, wrapping. `panelId`, when the caller has one panel for the whole list,
 * is what the active tab controls.
 */
import type { KeyboardEvent, ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface TextTab<T extends string> {
  value: T
  label: ReactNode
}

interface TextTabsProps<T extends string> {
  /** The accessible name of the list — what the tabs are tabs of. */
  label: string
  tabs: readonly TextTab<T>[]
  value: T
  onChange: (value: T) => void
  /** `sheet` is the 14/20, gap 18 variant for a side panel. */
  size?: 'page' | 'sheet'
  /** The one panel the active tab controls, when there is one. */
  panelId?: string
  className?: string
}

export function TextTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  size = 'page',
  panelId,
  className,
}: TextTabsProps<T>) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.value === value)
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    onChange(tabs[next].value)
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('flex border-b', size === 'sheet' ? 'gap-4.5' : 'gap-6', className)}
    >
      {tabs.map((tab) => {
        const on = tab.value === value
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={on ? panelId : undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              '-mb-px border-b-2 pb-3 whitespace-nowrap transition-colors outline-none focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50',
              size === 'sheet' ? 'text-md' : 'text-prose font-medium',
              size === 'sheet' && on && 'font-medium',
              on
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
