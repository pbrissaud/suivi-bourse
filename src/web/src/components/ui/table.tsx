'use client'

import * as React from 'react'

import { useDensity } from '@/lib/density'
import { cn } from '@/lib/utils'

// **A table sits on the ground** (« Relevé »): no plane, no frame, a header row
// in Label, a 1 px `border` rule under every row — the last one included, and
// the totals row. Rows are 40 px tall for one line and 48 px (`tall`) for a name
// with a sub-line or a total; figures are right-aligned in `.fig` (`numeric`).
// A sortable column carries `aria-sort`, and that alone makes its header
// `foreground` 500: no glyph, no arrow. A clickable row underlines its name on
// hover, which is the page's to draw; the row itself takes no background.
//
// The wide-content rule of the shell applies here and nowhere else in the
// product yet: a table scrolls **inside its own container**, so the nine columns
// of the shares page (#791) never make the page itself scroll sideways.
//
// The reader's third preference reaches every table through the one attribute
// below (#789): the cells key their padding on an ancestor carrying
// it, so a table written on these primitives obeys the density by being written
// on them — no prop to thread, and no second place to forget.
// A **bounded** table scrolls in that same container and not in one of its own
// (#795): `position: sticky` on a header cell resolves against the
// nearest scrolling ancestor, and `overflow-x-auto` already makes this div one —
// so a `max-height` wrapped around the whole thing would scroll the outer box
// while the header stayed stuck to an inner one that never moves. The ceiling
// has to land here, which is what `containerClassName` is for.
function Table({
  className,
  containerClassName,
  containerStyle,
  ...props
}: React.ComponentProps<'table'> & {
  containerClassName?: string
  containerStyle?: React.CSSProperties
}) {
  const density = useDensity()
  return (
    <div
      data-slot="table-container"
      className={cn('relative w-full overflow-x-auto', containerClassName)}
      style={containerStyle}
    >
      <table
        data-slot="table"
        data-density={density}
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />
}

// Every row, the last one included, ends on its rule.
function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={className} {...props} />
}

// The totals: the last rows of the table, on the same rules, 48 px tall.
function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('font-medium [&_tr]:h-12', className)}
      {...props}
    />
  )
}

function TableRow({
  className,
  tall = false,
  ...props
}: React.ComponentProps<'tr'> & {
  /** 48 px for a name with a sub-line, instead of 40 px for one line. */
  tall?: boolean
}) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b transition-colors data-[state=selected]:bg-muted',
        tall ? 'h-12' : 'h-10',
        className,
      )}
      {...props}
    />
  )
}

function TableHead({
  className,
  numeric = false,
  ...props
}: React.ComponentProps<'th'> & {
  /** A figure column: its name sits on the right with the figures. */
  numeric?: boolean
}) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        // The column names in DESIGN.md's Label (never uppercase, never
        // letter-spaced), on the ground. A sortable column says `aria-sort`
        // and is then `foreground` 500; the others stay muted.
        'label px-3 pb-2 align-bottom whitespace-nowrap first:pl-0 aria-[sort]:font-medium aria-[sort]:text-foreground',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    />
  )
}

function TableCell({
  className,
  numeric = false,
  ...props
}: React.ComponentProps<'td'> & {
  /** A figure column: right-aligned, in `.fig`. */
  numeric?: boolean
}) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'px-3 py-2 align-middle whitespace-nowrap first:pl-0',
        '[[data-density=compact]_&]:py-1',
        numeric && 'fig text-right',
        className,
      )}
      {...props}
    />
  )
}

export { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow }
