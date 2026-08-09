/**
 * The content header bar — an **object of the product**, not a mount for a
 * trigger (ADR-0022). It is on all four pages and carries exactly four things:
 * the collapse trigger on the left; the status dot, the language and the theme
 * on the right.
 *
 * It exists because it is the one surface that survives the **three** sidebar
 * states: shadcn hides `SidebarMenuBadge` in icon mode, and the drawer takes the
 * whole navigation with it — so anything mounted in the column disappears twice.
 */
import { Languages, MonitorCog, Moon, Sun } from 'lucide-react'

import { PreferenceMenu } from '@/components/PreferenceMenu'
import { StatusDot } from '@/components/StatusDot'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { useI18n, type LanguageChoice } from '@/lib/i18n'
import { useTheme, type ThemeChoice } from '@/lib/theme'

export function ContentHeader() {
  const { t, choice: language, setChoice: setLanguage } = useI18n()
  const { choice: theme, ground, setChoice: setTheme } = useTheme()

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      {/* No `aria-label` here: the trigger names itself from `header.toggleSidebar`
          — the vendored English was fixed in the component rather than covered
          over at this one call site, which left the rail and the drawer speaking
          English (#713). */}
      <SidebarTrigger />
      <div className="ml-auto flex items-center gap-1">
        <StatusDot />
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
