/**
 * The Thème form as data (#1314): which stored key each field writes, which
 * hidden keys follow it, and the theme those edits make.
 *
 * The form edits **a few primary keys**; the theme it applies is
 * `candidate(baseline, edits)`, derived — so an untouched value is never
 * rewritten, and "N modifications" counts what the reader changed, not the
 * keys that came along.
 */
import type { ThemeVars } from '@/features/settings/lib/api'
import type { MessageKey } from '@/lib/i18n'
import type { Ground } from '@/lib/theme'
import atelierJson from '@/theme/atelier.json'

const atelier = atelierJson as ThemeVars

export type Scope = Ground | 'theme'

/** What the reader changed, per scope, by primary key. `theme` is both grounds at once. */
export type Edits = Record<Scope, Record<string, string>>

export const NO_EDITS: Edits = { light: {}, dark: {}, theme: {} }

export const COLOUR_GROUPS = [
  {
    title: 'settings.theme.group.surfaces',
    fields: [
      { key: 'background', label: 'settings.theme.field.background' },
      { key: 'muted', label: 'settings.theme.field.muted' },
      { key: 'card', label: 'settings.theme.field.card' },
      { key: 'foreground', label: 'settings.theme.field.foreground' },
      { key: 'muted-foreground', label: 'settings.theme.field.muted-foreground' },
      { key: 'border', label: 'settings.theme.field.border' },
      { key: 'input', label: 'settings.theme.field.input' },
    ],
  },
  {
    title: 'settings.theme.group.accent',
    fields: [
      { key: 'primary', label: 'settings.theme.field.primary' },
      { key: 'primary-foreground', label: 'settings.theme.field.primary-foreground' },
      { key: 'accent', label: 'settings.theme.field.accent' },
      { key: 'chart-2', label: 'settings.theme.field.chart-2' },
      { key: 'destructive', label: 'settings.theme.field.destructive' },
    ],
  },
  {
    title: 'settings.theme.group.charts',
    fields: [
      { key: 'chart-1', label: 'settings.theme.field.chart-1' },
      { key: 'chart-3', label: 'settings.theme.field.chart-3' },
      { key: 'chart-4', label: 'settings.theme.field.chart-4' },
      { key: 'chart-5', label: 'settings.theme.field.chart-5' },
    ],
  },
] as const satisfies readonly {
  title: MessageKey
  fields: readonly { key: string; label: MessageKey }[]
}[]

/**
 * The keys a theme leaves out of the form but that were, in the bundled
 * Atelier, the same colour as a source (the sidebar is the background, a
 * popover is a card…). They follow their source **only when they equal it**
 * in the theme being edited: an imported theme's own sidebar stays its own.
 */
const FOLLOWERS: Record<string, readonly string[]> = {
  background: ['sidebar'],
  foreground: [
    'card-foreground',
    'popover-foreground',
    'secondary-foreground',
    'accent-foreground',
    'sidebar-foreground',
    'sidebar-accent-foreground',
  ],
  card: ['popover'],
  muted: ['secondary'],
  primary: ['ring', 'sidebar-primary', 'sidebar-ring'],
  'primary-foreground': ['sidebar-primary-foreground', 'destructive-foreground'],
  accent: ['sidebar-accent'],
  border: ['sidebar-border'],
}

/** Tailwind's `shadow-*` read these strings, not `shadow-opacity`; the alpha each carries. */
const SHADOW_ALPHA: Record<string, number> = {
  'shadow-2xs': 0.5,
  'shadow-xs': 0.5,
  'shadow-sm': 1,
  shadow: 1,
  'shadow-md': 1,
  'shadow-lg': 1,
  'shadow-xl': 1,
  'shadow-2xl': 2.5,
}

/** The unit each slider's key is written in. */
export const UNIT: Record<string, string> = {
  radius: 'rem',
  'shadow-opacity': '',
  'tracking-normal': 'em',
}

/** A font choice: the stack written to the key. The bundled faces need no download. */
export const FONTS = {
  'font-sans': [
    { label: 'settings.theme.font.geist', value: atelier.theme['font-sans'] },
    { label: 'settings.theme.font.system', value: 'ui-sans-serif, system-ui, sans-serif' },
    { label: 'settings.theme.font.serif', value: 'ui-serif, Georgia, serif' },
  ],
  'font-mono': [
    { label: 'settings.theme.font.geist-mono', value: atelier.theme['font-mono'] },
    {
      label: 'settings.theme.font.system-mono',
      value: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    },
  ],
} as const satisfies Record<string, readonly { label: MessageKey; value: string }[]>

/**
 * What a key says on a ground: the theme's own, else Atelier's — the same
 * fallback the server paints with.
 */
export function read(vars: ThemeVars, ground: Ground, key: string): string {
  return vars[ground][key] ?? vars.theme[key] ?? atelier[ground][key] ?? atelier.theme[key]
}

/** The value a field shows: the reader's edit, else the baseline's. */
export function valueOf(baseline: ThemeVars, edits: Edits, scope: Scope, key: string): string {
  return edits[scope][key] ?? read(baseline, scope === 'theme' ? 'light' : scope, key)
}

/** An edit back to the baseline's own value is no edit. */
export function setEdit(
  baseline: ThemeVars,
  edits: Edits,
  scope: Scope,
  key: string,
  value: string | null,
): Edits {
  const { [key]: _gone, ...rest } = edits[scope]
  const same = value === read(baseline, scope === 'theme' ? 'light' : scope, key)
  return { ...edits, [scope]: value === null || same ? rest : { ...rest, [key]: value } }
}

/** Edited fields — not the keys that follow them. */
export const count = (edits: Edits) =>
  Object.values(edits).reduce((n, e) => n + Object.keys(e).length, 0)

/** A number in the unit its key is written in; `px` radii are read as `rem`. */
export function toNumber(key: string, value: string): number {
  const n = Number.parseFloat(value)
  return key === 'radius' && value.trim().endsWith('px') ? n / 16 : n
}

export const fromNumber = (key: string, n: number) => `${+n.toFixed(3)}${UNIT[key]}`

/** The shadow strings with their alpha rewritten; offsets, blur and colour are the theme's. */
const withAlpha = (shadow: string, alpha: number) =>
  shadow.replace(/\/\s*[\d.]+(?=\))/g, `/ ${+Math.min(1, alpha).toFixed(3)}`)

/**
 * The theme the edits make. Each edit lands on its ground; a key the other
 * ground lacks is filled from Atelier (the server drops a key one ground only
 * says). A theme-wide edit is written once, in `theme`, and wins over any
 * per-ground override of the same key.
 */
export function candidate(baseline: ThemeVars, edits: Edits): ThemeVars {
  const next: ThemeVars = {
    theme: { ...baseline.theme },
    light: { ...baseline.light },
    dark: { ...baseline.dark },
  }
  for (const ground of ['light', 'dark'] as const) {
    const other = ground === 'light' ? 'dark' : 'light'
    for (const [key, value] of Object.entries(edits[ground])) {
      const followers = (FOLLOWERS[key] ?? []).filter(
        (follower) => read(baseline, ground, follower) === read(baseline, ground, key),
      )
      for (const k of [key, ...followers]) {
        next[ground][k] = value
        if (next[other][k] === undefined && next.theme[k] === undefined) {
          next[other][k] = atelier[other][k]
        }
      }
    }
  }
  const everywhere = (key: string, value: string) => {
    next.theme[key] = value
    delete next.light[key]
    delete next.dark[key]
  }
  for (const [key, value] of Object.entries(edits.theme)) everywhere(key, value)
  if (edits.theme['tracking-normal'] !== undefined) {
    everywhere('letter-spacing', edits.theme['tracking-normal'])
  }
  if (edits.theme['shadow-opacity'] !== undefined) {
    const opacity = Number.parseFloat(edits.theme['shadow-opacity'])
    // ponytail: geometry comes from the light ground's strings; a theme whose
    // grounds draw different shadows gets the light ones on both.
    for (const [name, factor] of Object.entries(SHADOW_ALPHA)) {
      everywhere(name, withAlpha(read(baseline, 'light', name), opacity * factor))
    }
  }
  return next
}
