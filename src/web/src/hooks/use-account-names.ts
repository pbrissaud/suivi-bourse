/**
 * An account as the reader knows it: its libellé, the identifier only where it
 * is edited. One rule for the ledger's rows and filters, the effect line and
 * anywhere else an account is named — the declared label, else the id, and the
 * product's own word for the seeded row.
 *
 * The function is stable between renders of the same answer, so a memoised
 * column that closes over it is not rebuilt at every tick of a checkbox.
 */
import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  declaredLabel,
  DEFAULT_ACCOUNT_LABEL,
  isDefaultAccount,
} from '@/features/accounts/lib/accounts'
import { accountsApi } from '@/features/accounts/lib/api'
import { useI18n } from '@/lib/i18n'

export function useAccountNames(): (id: string) => string {
  const { t } = useI18n()
  const declared = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts }).data
    ?.accounts
  return useCallback(
    (id: string) => {
      // A read that has not landed says nothing, rather than the identifier.
      if (declared === undefined) return ''
      const known = declared?.find((account) => account.id === id)
      if (known) return declaredLabel(known) ?? t(DEFAULT_ACCOUNT_LABEL)
      return isDefaultAccount(id) || id === '' ? t(DEFAULT_ACCOUNT_LABEL) : id
    },
    [declared, t],
  )
}
