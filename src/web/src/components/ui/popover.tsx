"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  container,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  /**
   * Where the content is drawn, `document.body` by default (#1036).
   *
   * It is passed through because a popover inside a modal dialog has to be
   * drawn **inside that dialog's content** to scroll at all: `react-remove-scroll`
   * cancels wheel and touch outside the shards it was given, and radix's dialog
   * declares exactly one — its own content node. The positioner runs `fixed`, so
   * being inside an `overflow-y-auto` ancestor costs no clipping.
   */
  container?: React.ComponentProps<typeof PopoverPrimitive.Portal>["container"]
}) {
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 origin-(--radix-popover-content-transform-origin) animate-in rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
