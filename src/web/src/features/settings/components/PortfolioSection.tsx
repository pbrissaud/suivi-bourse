import { CurrencyField } from '@/components/CurrencyField'
import { FundsList } from '@/features/settings/components/FundsList'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { TaxList } from '@/features/settings/components/TaxList'
import { settingFieldId } from '@/features/settings/lib/installation'
import { useDial } from '@/features/settings/lib/useDial'
import { currencyFixed, CURRENCY_KEY } from '@/lib/firstRun'
import { useI18n } from '@/lib/i18n'

/**
 * *Portefeuille*: the reporting currency, the funds the Comparaison page offers
 * and the tax models. The currency is chosen once, at the first run, and then
 * fixed: the row states the answer; the field is drawn only while nobody has
 * answered.
 */
export function PortfolioSection({ read }: { read: SectionRead }) {
  const { t } = useI18n()
  const dial = useDial(CURRENCY_KEY)
  const fixed = dial.setting ? currencyFixed([dial.setting]) : undefined
  const id = settingFieldId(CURRENCY_KEY)

  return (
    <SettingsSection id="portfolio" title={t('settings.portfolio.title')} read={read}>
      <SettingRow
        // Once fixed the value is a sentence, not a field: nothing to point a label at.
        id={fixed ? undefined : id}
        label={t('settings.base_currency')}
        state={dial.state}
      >
        {fixed ? (
          <p className="text-sm text-muted-foreground">
            <span className="fig text-foreground">{dial.draft}</span> ·{' '}
            {t('settings.base_currency.fixed')}
          </p>
        ) : (
          <div className="max-w-72">
            <CurrencyField
              id={id}
              value={dial.draft}
              fixed={fixed}
              finality={false}
              // Fixed for good once answered: a second choice made while the first
              // is on its way would be refused, and shown as the fixed one.
              onChange={(code) => {
                if (dial.state.kind !== 'saving') dial.set(code)
              }}
            />
          </div>
        )}
      </SettingRow>
      <FundsList />
      <TaxList />
    </SettingsSection>
  )
}
