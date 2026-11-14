/**
 * **« Calcul en cours — chiffres provisoires. »** — the one marker a page
 * wears while the history is being rebuilt (#845).
 *
 * Every figure that rests on the rebuilt series (a total, a gain, a rate, a
 * comparison) is provisional for as long as it lasts, and the pages said so
 * nowhere: a first deposit dated 2024 for a ledger that starts in 2022 read as
 * a fact. One component and one sentence, mounted by each page the series
 * feeds, reading the same `runtime` query the bell does (one request, however
 * many pages mount it), and silent the rest of the time.
 */
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

export function ProvisionalNote() {
  const { t } = useI18n()
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })

  if (!runtime.data?.rebuilding) return null
  return <p className="max-w-prose text-sm text-muted-foreground">{t('figures.provisional')}</p>
}
