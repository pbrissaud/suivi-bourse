"use client"

import * as React from "react"

import { useDensity } from "@/lib/density"
import { cn } from "@/lib/utils"

// The wide-content rule of the shell applies here and nowhere else in the
// product yet: a table scrolls **inside its own container**, so the nine columns
// of the shares page (#791) never make the page itself scroll sideways.
//
// The reader's third preference reaches every table through the one attribute
// below (#789, ADR-0024): the cells key their padding on an ancestor carrying
// it, so a table written on these primitives obeys the density by being written
// on them — no prop to thread, and no second place to forget.
// A **bounded** table scrolls in that same container and not in one of its own
// (#795, ADR-0031): `position: sticky` on a header cell resolves against the
// nearest scrolling ancestor, and `overflow-x-auto` already makes this div one —
// so a `max-height` wrapped around the whole thing would scroll the outer box
// while the header stayed stuck to an inner one that never moves. The ceiling
// has to land here, which is what `containerClassName` is for.
function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<"table"> & { containerClassName?: string }) {
  const density = useDensity()
  return (
    <div
      data-slot="table-container"
      className={cn("relative w-full overflow-x-auto", containerClassName)}
    >
      <table
        data-slot="table"
        data-density={density}
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        // The drawing's own header: 42 px tall, the label set as the eyebrow
        // every card heading is set in, and the strip a shade under the card it
        // sits on. The density does not touch it — it is the **rows** a reader
        // tightens, and a header that moved with them would take the column
        // names off the same line as the figures they name.
        // `[&_button]:uppercase` is not belt and braces: the reset the framework
        // ships puts `text-transform: none` on every `button`, so a sortable
        // column — where the control *is* the label (#791) — came out in
        // sentence case beside its unsortable neighbours in small caps.
        "h-10.5 bg-background px-1.5 text-left align-middle text-2xs font-semibold tracking-wide text-muted-foreground uppercase whitespace-nowrap xl:px-4 xl:tracking-widest [&_button]:uppercase",
        className,
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-1.5 py-3 align-middle whitespace-nowrap xl:px-4",
        "[[data-density=compact]_&]:py-1.5",
        className,
      )}
      {...props}
    />
  )
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow }
