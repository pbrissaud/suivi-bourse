/**
 * One control for the reader's three preferences (ADR-0024: *reader
 * preferences, one mechanism* — it decided the first two, the density joined
 * them at #789 and `app/web/CLAUDE.md` carries the count). Three
 * states for the theme and the language, **two** for the density, and the
 * current one marked — so a reader can tell *I chose light* from *it is light
 * because my system is*.
 *
 * It lives in the content header bar and nowhere else. The sidebar foot, where
 * the language selector was first mounted to prove the form, is exactly the
 * surface that does not survive the drawer (ADR-0022).
 */
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface PreferenceOption<T extends string> {
  value: T
  label: string
}

export function PreferenceMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  icon,
}: {
  label: string
  value: T
  options: readonly PreferenceOption<T>[]
  onChange: (value: T) => void
  icon: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 rounded-lg" aria-label={label}>
          {icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
