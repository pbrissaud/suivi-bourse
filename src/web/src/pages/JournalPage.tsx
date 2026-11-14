import { Journal } from '@/features/system/components/Journal'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'

/** What the process logged, reached from Système › Installation. */
export default function JournalPage() {
  const { t } = useI18n()
  usePageHeading(t('journal.title'))
  return <Journal />
}
