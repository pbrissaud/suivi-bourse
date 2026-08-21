"use client"

import * as React from "react"

import { useDensity } from "@/lib/density"
import { cn } from "@/lib/utils"

// The wide-content rule of the shell applies here and nowhere else in the
// product yet: a table scrolls **inside its own container**, so nine money
// columns never make the page itself scroll sideways.
//
// The reader's third preference reaches every table through the one attribute
// below (#789, ADR-0024): the cells key their padding on an ancestor carrying
// it, so a table written on these primitives obeys the density by being written
// on them — no prop to thread, and no second place to forget.
function Table({ className, ...props }: React.ComponentProps<"table">) {
  const density = useDensity()
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
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
        "h-10 px-3 text-left align-bottom text-xs font-medium text-muted-foreground whitespace-nowrap",
        "[[data-density=compact]_&]:h-8 [[data-density=compact]_&]:px-2",
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
        "p-3 align-middle whitespace-nowrap",
        "[[data-density=compact]_&]:px-2 [[data-density=compact]_&]:py-1.5",
        className,
      )}
      {...props}
    />
  )
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow }
