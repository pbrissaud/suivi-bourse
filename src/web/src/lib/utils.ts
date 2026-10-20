/**
 * `cn` — the class merger every component composes with, **taught the scale
 * this product actually uses** (#838).
 *
 * `twMerge` resolves conflicts by *group*, and it knows the framework's default
 * groups by name: `text-sm` is a font size, `text-gain` is a colour, and the
 * later of two members of one group wins. The redesign redeclares the `--text-*`
 * ladder and adds four rungs the framework has no name for — `text-2xs`,
 * `text-md`, `text-prose` and `text-hero`. An unknown
 * `text-…` is read as a **colour**, so `cn('text-hero', 'text-gain')` silently dropped the size: the
 * dashboard's 52 px figure came out at the body's 15 px, with nothing failing
 * anywhere.
 *
 * `text-prose` was missed, and the agent's questions came out at 13 px: the
 * bubble's `text-sm` sat beside it and won on source order.
 *
 * So the four names are declared here, once, beside the tokens that create
 * them. A rung added to `index.css` and not named here is a rung that works
 * until the day it meets a colour on the same element — which is exactly the
 * kind of silence this file exists to remove.
 */
import { clsx, type ClassValue } from 'cn'
import { extendTailwindMerge } from 'cn/config'

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // The four rungs the framework has no name for. The rest of the ladder —
      // `xs` through `7xl` — it already knows by name, redeclared value and all.
      'font-size': ['text-2xs', 'text-md', 'text-prose', 'text-hero'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
