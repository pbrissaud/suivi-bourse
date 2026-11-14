/**
 * The import page, `/ledger/import` (« Relevé »): a statement is read, shown
 * line by line, and written only when the owner says so. The title is fixed and
 * the page carries no subtitle; `?account=` names the account the file goes
 * into.
 */
import { useSearch } from '@tanstack/react-router'

import { ImportPreview } from '@/features/data/components/ImportPreview'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'

export default function ImportPage() {
  const { t } = useI18n()
  usePageHeading(t('page.import'))
  const { account } = useSearch({ from: '/ledger/import' })
  return <ImportPreview account={account} />
}
