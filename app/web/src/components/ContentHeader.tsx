/**
 * The content header bar — an **object of the product**, not a mount for a
 * trigger (ADR-0022). It is on all four pages and carries the page's own name
 * on the left, beside the collapse trigger; the status dot and the reader's
 * three preferences on the right.
 *
 * It exists because it is the one surface that survives the **three** sidebar
 * states: shadcn hides `SidebarMenuBadge` in icon mode, and the drawer takes the
 * whole navigation with it — so anything mounted in the column disappears twice.
 * That is also why the page's `<h1>` came up here (#789): a bar that carried
 * four controls and no name left the reader deducing which page they were on
 * from the navigation, which is exactly what the drawer takes away.
 */
import { Languages, MonitorCog, Moon, Rows3, Sun } from 'lucide-react'

import { PreferenceMenu } from '@/components/PreferenceMenu'
import { StatusDot } from '@/components/StatusDot'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { useDensityControl, type DensityChoice } from '@/lib/density'
import { useI18n, type LanguageChoice } from '@/lib/i18n'
import { usePageHeadingValue } from '@/lib/pageHeading'
import { useTheme, type ThemeChoice } from '@/lib/theme'

export function ContentHeader() {
  const { t, choice: language, setChoice: setLanguage } = useI18n()
  const { choice: theme, ground, setChoice: setTheme } = useTheme()
  const { choice: density, setChoice: setDensity } = useDensityControl()
  const { title, subtitle } = usePageHeadingValue()

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      {/* No `aria-label` here: the trigger names itself from `header.toggleSidebar`
          — the vendored English was fixed in the component rather than covered
          over at this one call site, which left the rail and the drawer speaking
          English (#713). */}
      <SidebarTrigger />
      {/* An empty `<h1>` is worse than none, so the pair is drawn only once the
          page has declared it — one render, and never a blank heading.

          **Neither half is dropped by a breakpoint.** The subtitle is the
          instant the page's figures are of, and that mention exists to stop a
          reader reading them as *now* — a phone is where a stale figure is most
          likely to be read, not where the safeguard can be spared. So both
          truncate and neither hides: narrow degrades the sentence, it does not
          remove it.

          **But the title does not pay for it** (#787). Sharing the space evenly,
          390 px gave `Compt…` beside `Chiffres arrêtés au 2…` — two truncations
          where one was owed, and the one that broke is the page's own name,
          which is the whole reason ADR-0022 moved it into this bar. The name is
          short and fixed, so it takes the room it needs and the sentence takes
          what is left. */}
      <div className="flex min-w-0 items-baseline gap-3">
        {title === '' ? null : (
          <h1 className="shrink-0 text-sm font-semibold tracking-tight">{title}</h1>
        )}
        {subtitle === null ? null : (
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <StatusDot />
        <PreferenceMenu<DensityChoice>
          label={t('header.density')}
          value={density}
          onChange={setDensity}
          icon={<Rows3 />}
          // Two options and no third: nothing anywhere answers *how tight do
          // you like a table*, so an `auto` would consult nothing.
          options={[
            { value: 'comfortable', label: t('density.comfortable') },
            { value: 'compact', label: t('density.compact') },
          ]}
        />
        <PreferenceMenu<LanguageChoice>
          label={t('header.language')}
          value={language}
          onChange={setLanguage}
          icon={<Languages />}
          options={[
            { value: 'auto', label: t('lang.auto') },
            { value: 'fr', label: t('lang.fr') },
            { value: 'en', label: t('lang.en') },
          ]}
        />
        <PreferenceMenu<ThemeChoice>
          label={t('header.theme')}
          value={theme}
          onChange={setTheme}
          // The icon shows the ground in force, not the choice: `auto` has no
          // look of its own, and a reader on `auto` at dusk wants to see it turn.
          icon={theme === 'auto' ? <MonitorCog /> : ground === 'dark' ? <Moon /> : <Sun />}
          options={[
            { value: 'auto', label: t('theme.auto') },
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
          ]}
        />
      </div>
    </header>
  )
}
