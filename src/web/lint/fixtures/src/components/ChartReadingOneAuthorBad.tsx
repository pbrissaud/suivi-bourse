import { useT } from '@/lib/i18n'

export function Bad() {
  const t = useT()
  return <p>{t('chart.reading.rising')}</p> // expect: chart-reading-one-author
}

export const fine = 'the chart.reading. prefix, quoted mid-sentence'
