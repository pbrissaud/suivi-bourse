/**
 * What to do with edits that were not applied when the reader leaves (#1314).
 * Escape and the backdrop are **Rester**: leaving is never the default.
 */
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useI18n } from '@/lib/i18n'

export function ThemeLeaveDialog({
  open,
  count,
  busy,
  onStay,
  onDiscard,
  onApply,
}: {
  open: boolean
  count: number
  busy: boolean
  onStay: () => void
  onDiscard: () => void
  onApply: () => void
}) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onStay()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('settings.theme.leave.title', { count })}</DialogTitle>
          <DialogDescription>{t('settings.theme.leave.body')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onStay}>
            {t('settings.theme.leave.stay')}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={onDiscard}>
            {t('settings.theme.leave.discard')}
          </Button>
          <Button type="button" disabled={busy} onClick={onApply}>
            {t('settings.theme.apply')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
