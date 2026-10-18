import type { ReactNode } from 'react'

import { Segmented } from '@/components/Segmented'
import { Section } from '@/components/ui/section'
import { useDensityControl } from '@/lib/density'
import { useI18n } from '@/lib/i18n'
import { useTheme } from '@/lib/theme'

/**
 * The reader's three preferences (#1276): density, language and theme.
 *
 * They are set once, so they left the header bar for the page whose subject is
 * what the owner sets. They are the browser's, not the installation's: the block
 * reads `localStorage` and nothing else, which is why the page draws it outside
 * every `Unreadable` branch — it renders when every Settings read fails.
 */
export function DeviceBlock() {
  const { t, choice: language, setChoice: setLanguage } = useI18n()
  const { choice: theme, setChoice: setTheme } = useTheme()
  const { choice: density, setChoice: setDensity } = useDensityControl()

  const row = (label: string, control: ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0">
      <span className="text-sm">{label}</span>
      {control}
    </div>
  )

  return (
    <Section title={t('settings.device.title')}>
      {row(
        t('settings.device.density'),
        <Segmented
          mode="radio"
          bordered
          label={t('settings.device.density')}
          value={density}
          onChange={setDensity}
          // Two options and no third: nothing anywhere answers *how tight do
          // you like a table*, so an `auto` would consult nothing.
          options={[
            { value: 'comfortable', label: t('density.comfortable') },
            { value: 'compact', label: t('density.compact') },
          ]}
        />,
      )}
      {row(
        t('settings.device.language'),
        <Segmented
          mode="radio"
          bordered
          label={t('settings.device.language')}
          value={language}
          onChange={setLanguage}
          options={[
            { value: 'auto', label: t('lang.auto') },
            { value: 'fr', label: t('lang.fr') },
            { value: 'en', label: t('lang.en') },
          ]}
        />,
      )}
      {row(
        t('settings.device.theme'),
        <Segmented
          mode="radio"
          bordered
          label={t('settings.device.theme')}
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'auto', label: t('theme.auto') },
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
          ]}
        />,
      )}
    </Section>
  )
}
