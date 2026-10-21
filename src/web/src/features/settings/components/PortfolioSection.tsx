import { CurrencyField } from '@/components/CurrencyField'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { settingFieldId } from '@/features/settings/lib/installation'
import { useDial } from '@/features/settings/lib/useDial'
import { currencyFixed, CURRENCY_KEY } from '@/lib/firstRun'
import { useI18n } from '@/lib/i18n'

/**
 * The reporting currency. Chosen once and then fixed: the row shows the answer
 * and « Figée », and the field is drawn only while nobody has answered. The
 * comparison references join this section with #1312.
 */
export function PortfolioSection({ read }: { read: SectionRead }) {
  const { t } = useI18n()
  const dial = useDial(CURRENCY_KEY)
  const fixed = dial.setting ? currencyFixed([dial.setting]) : undefined
  const id = settingFieldId(CURRENCY_KEY)

  return (
    <SettingsSection
      id="portfolio"
      title={t('settings.portfolio.title')}
      summary={t('settings.portfolio.summary')}
      read={read}
    >
      <SettingRow
        // Once fixed the value is a sentence, not a field: nothing to point a label at.
        id={fixed ? undefined : id}
        label={t('settings.base_currency')}
        description={t('settings.base_currency.hint')}
        state={dial.state}
      >
        <div className="max-w-72">
          <CurrencyField
            id={id}
            value={dial.draft}
            fixed={fixed}
            // Fixed for good once answered: a second choice made while the first
            // is on its way would be refused, and shown as the fixed one.
            onChange={(code) => {
              if (dial.state.kind !== 'saving') dial.set(code)
            }}
          />
        </div>
      </SettingRow>
    </SettingsSection>
  )
}
