import { Segmented } from '@/components/Segmented'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection } from '@/features/settings/components/SettingsSection'
import { settingFieldId } from '@/features/settings/lib/installation'
import { useDensityControl } from '@/lib/density'
import { type LanguageChoice, useI18n } from '@/lib/i18n'
import { useTheme } from '@/lib/theme'

/**
 * The reader's three preferences: appearance, language and table density.
 *
 * They are the browser's, not the installation's: the section reads
 * `localStorage` and nothing else, which is why the page draws it outside every
 * read — it renders when every Settings read fails.
 */
export function DeviceSection() {
  const { t, choice: language, setChoice: setLanguage } = useI18n()
  const { choice: theme, setChoice: setTheme } = useTheme()
  const { choice: density, setChoice: setDensity } = useDensityControl()
  const languageId = settingFieldId('language')

  return (
    <SettingsSection
      id="device"
      title={t('settings.device.title')}
      summary={t('settings.device.summary')}
    >
      <SettingRow label={t('settings.device.theme')}>
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
        />
      </SettingRow>
      <SettingRow id={languageId} label={t('settings.device.language')}>
        <Select value={language} onValueChange={(next) => setLanguage(next as LanguageChoice)}>
          <SelectTrigger id={languageId} className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t('lang.auto')}</SelectItem>
            <SelectItem value="fr">{t('lang.fr')}</SelectItem>
            <SelectItem value="en">{t('lang.en')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t('settings.device.density')}>
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
        />
      </SettingRow>
    </SettingsSection>
  )
}
