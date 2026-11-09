import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { Segmented } from '@/components/Segmented'
import { Button } from '@/components/ui/button'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection } from '@/features/settings/components/SettingsSection'
import { settingsApi } from '@/features/settings/lib/api'
import { useDensityControl } from '@/lib/density'
import { type LanguageChoice, useI18n } from '@/lib/i18n'
import { useTheme } from '@/lib/theme'

/**
 * *Affichage*: the reader's preferences — appearance, language, table density —
 * and the way into the Thème page.
 *
 * The first three are the browser's, not the installation's: they read
 * `localStorage` and nothing else, which is why the page draws the section
 * outside every read — it renders when every Settings read fails. The theme is
 * the installation's, so its row names it once it has been read.
 */
export function DeviceSection() {
  const { t, language, setChoice: setLanguage } = useI18n()
  const { choice: appearance, setChoice: setAppearance } = useTheme()
  const { choice: density, setChoice: setDensity } = useDensityControl()
  const theme = useQuery({ queryKey: ['theme'], queryFn: settingsApi.theme })

  return (
    <SettingsSection id="display" title={t('settings.device.title')}>
      <SettingRow label={t('settings.device.theme')}>
        <Segmented
          mode="radio"
          bordered
          size="compact"
          label={t('settings.device.theme')}
          value={appearance}
          onChange={setAppearance}
          options={[
            { value: 'auto', label: t('theme.auto') },
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
          ]}
        />
      </SettingRow>
      <SettingRow label={t('settings.device.language')}>
        <Segmented
          mode="radio"
          bordered
          size="compact"
          label={t('settings.device.language')}
          // The language in force: an automatic choice shows what it resolved to.
          value={language}
          onChange={(next) => setLanguage(next as LanguageChoice)}
          options={[
            { value: 'fr', label: t('lang.fr') },
            { value: 'en', label: t('lang.en') },
          ]}
        />
      </SettingRow>
      <SettingRow label={t('settings.device.density')}>
        <Segmented
          mode="radio"
          bordered
          size="compact"
          label={t('settings.device.density')}
          value={density}
          onChange={setDensity}
          // Two options and no third: nothing anywhere answers *how tight do
          // you like a table*, so an `auto` would consult nothing.
          options={[
            { value: 'comfortable', label: t('density.comfortable') },
            { value: 'compact', label: t('density.compact') },
          ]}
        />
      </SettingRow>
      <SettingRow
        label={t('settings.theme.title')}
        description={
          theme.isSuccess
            ? t(theme.data ? 'settings.theme.custom' : 'settings.theme.bundled')
            : undefined
        }
      >
        <Button asChild>
          <Link to="/settings/theme">{t('settings.theme.customise')}</Link>
        </Button>
      </SettingRow>
    </SettingsSection>
  )
}
