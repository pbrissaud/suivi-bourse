/**
 * *Analyste* in the content header bar (#1117): it opens and closes the
 * panel, as ⌘/Ctrl + J does, and it stays there when the analyst is off —
 * the panel then says what to connect (4A). Focus comes back here on close.
 */
import { Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAnalystPanel } from '@/lib/analystPanel'
import { useI18n } from '@/lib/i18n'

export function AnalystButton() {
  const { t } = useI18n()
  const { open, toggle, trigger } = useAnalystPanel()
  return (
    <Button
      ref={trigger}
      type="button"
      variant={open ? 'secondary' : 'ghost'}
      aria-label={t('analyst.open')}
      aria-expanded={open}
      aria-keyshortcuts="Meta+J Control+J"
      className="h-8 gap-1.5 rounded-lg px-2 text-muted-foreground"
      onClick={toggle}
    >
      <Sparkles className="size-3.75" />
      <span aria-hidden className="hidden text-sm md:inline">
        {t('analyst.open')}
      </span>
    </Button>
  )
}
