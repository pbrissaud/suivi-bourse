import { Button } from '@/components/ui/button'
import { useDocs } from '@/lib/docs'
import { useI18n } from '@/lib/i18n'

/** The format's page, as a secondary action (outline, body size) beside the door. */
export function FormatDocsButton() {
  const { t, language } = useI18n()
  const { docsPageHref } = useDocs()
  return (
    <Button asChild>
      <a
        href={docsPageHref(language, 'import-your-events', 'format')}
        target="_blank"
        rel="noreferrer"
      >
        {t('data.empty.file.docs')}
      </a>
    </Button>
  )
}
