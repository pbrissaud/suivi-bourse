import { declaredLabel, DEFAULT_ACCOUNT_LABEL } from '@/features/accounts/lib/accounts'
import type { AccountsResponse } from '@/features/accounts/lib/api'
import type { RuntimeState } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { rebuildProgress } from '@/lib/status'

interface RebuildBlockProps {
  runtime: RuntimeState | null
  /** The oldest event date: the progress figure's starting point. */
  firstEvent: string | null
  /** Only used to name the lagging account. */
  accounts: AccountsResponse | null
}

/**
 * Shown only while the history is being rebuilt: one slim band — what is
 * rebuilding, the account furthest behind, and the share of the period covered
 * when it can be measured (no figure, and no bar, when it cannot).
 */
export function RebuildBlock({ runtime, firstEvent, accounts }: RebuildBlockProps) {
  const { t } = useI18n()

  if (runtime === null || runtime.rebuilding !== true) return null

  const { account, ratio } = rebuildProgress(runtime.accounts ?? [], firstEvent, new Date())
  const declared =
    account === null ? null : (accounts?.accounts ?? []).find((one) => one.id === account)
  const name =
    account === null
      ? null
      : ((declared ? declaredLabel(declared) : null) ?? t(DEFAULT_ACCOUNT_LABEL))

  return (
    <div
      role="status"
      className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-section bg-muted px-6 py-3 text-sm"
    >
      <span className="font-semibold">{t('installation.rebuild.title')}</span>
      {name === null ? null : (
        <span className="text-muted-foreground">
          {t('installation.rebuild.body.account', { account: name })}
        </span>
      )}
      {ratio === null ? null : (
        <span className="fig ml-auto text-muted-foreground">
          {t('installation.rebuild.progress', { percent: Math.round(ratio * 100) / 100 })}
        </span>
      )}
    </div>
  )
}
