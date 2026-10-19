import { Link } from '@tanstack/react-router'

import { Section } from '@/components/ui/section'
import { declaredLabel, DEFAULT_ACCOUNT_LABEL } from '@/features/accounts/lib/accounts'
import type { AccountsResponse } from '@/features/accounts/lib/api'
import type { RuntimeState } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { rebuildProgress } from '@/lib/status'

interface RebuildBlockProps {
  runtime: RuntimeState | null
  /** The oldest event date: the progress bar's starting point. */
  firstEvent: string | null
  /** Only used to name the lagging account. */
  accounts: AccountsResponse | null
}

/** Shown only while the history is being rebuilt. */
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
  const percent = ratio === null ? null : Math.round(ratio * 100)

  return (
    <Section title={t('installation.rebuild.title')}>
      <p className="text-sm text-muted-foreground">
        {name === null
          ? t('installation.rebuild.body')
          : t('installation.rebuild.body.account', { account: name })}
      </p>
      {percent === null ? null : (
        <progress
          className="mt-3 h-1.5 w-full"
          value={percent}
          max={100}
          aria-label={t('installation.rebuild.progress', { percent: percent / 100 })}
        />
      )}
      <Link to="/" className="mt-3 inline-block text-sm font-medium underline underline-offset-4">
        {t('installation.rebuild.link')}
      </Link>
    </Section>
  )
}
