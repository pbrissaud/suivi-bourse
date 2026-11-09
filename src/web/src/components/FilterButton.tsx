/**
 * **A filter is a text button** (« Relevé », DESIGN.md › Components): 13 px
 * `muted-foreground`, the chosen value only (« Tous les comptes », « 7 derniers
 * jours ») and a ChevronDown 14 px. A value that narrows the list — anything but
 * the neutral one — is `foreground`. It opens a listbox popover (`background`,
 * `border`, radius 14, no shadow of its own) with a search field when the list
 * is long (more than eight entries).
 *
 * The visible text is the value, so the name of the filter rides in a
 * screen-reader-only prefix (« Compte : Tous les comptes »).
 */
import { ChevronDown, Search } from 'lucide-react'
import { type KeyboardEvent, useId, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** Past this many entries the listbox carries a search field. */
const SEARCHABLE_FROM = 8

interface FilterOption<T extends string> {
  value: T
  label: string
}

interface FilterButtonProps<T extends string> {
  /** What is filtered — « Compte », « Période ». Read by assistive technology. */
  label: string
  options: readonly FilterOption<T>[]
  value: T
  onChange: (value: T) => void
  /** The value that filters nothing; defaults to the first option. */
  neutral?: T
  className?: string
}

export function FilterButton<T extends string>({
  label,
  options,
  value,
  onChange,
  neutral,
  className,
}: FilterButtonProps<T>) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()

  const chosen = options.find((option) => option.value === value)
  const narrowing = value !== (neutral ?? options[0]?.value)
  const searchable = options.length > SEARCHABLE_FROM
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options

  function choose(next: T) {
    onChange(next)
    setOpen(false)
  }

  /** The arrows walk the entries; the search field is the one before the first. */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const stops = [
      ...(event.currentTarget.querySelectorAll<HTMLElement>('input, [role="option"]') ?? []),
    ]
    const at = stops.indexOf(document.activeElement as HTMLElement)
    stops[Math.min(stops.length - 1, Math.max(0, at + step))]?.focus()
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className={cn(
            'inline-flex items-center gap-1 text-sm whitespace-nowrap outline-none hover:text-foreground focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50',
            narrowing ? 'text-foreground' : 'text-muted-foreground',
            className,
          )}
        >
          <span className="sr-only">{`${label} :`}</span>
          {` ${chosen?.label ?? ''}`.trimEnd()}
          <ChevronDown aria-hidden className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-60 p-1"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => {
          // The search field when there is one; otherwise the entry in force.
          if (searchable) return
          event.preventDefault()
          const entries = list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
          const current = [...entries].find(
            (entry) => entry.getAttribute('aria-selected') === 'true',
          )
          ;(current ?? entries[0])?.focus()
        }}
      >
        {searchable ? (
          <div className="relative p-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('filter.search')}
              placeholder={t('filter.search')}
              className="h-8 pl-8 text-sm"
            />
          </div>
        ) : null}
        <div ref={list} id={listId} role="listbox" aria-label={label} className="flex flex-col">
          {shown.map((option) => {
            const on = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => choose(option.value)}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent',
                  on && 'font-medium',
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
