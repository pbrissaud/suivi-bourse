/**
 * **Giving the agent a broker statement** (#1120): the one box where the raw
 * text is shown, edited and confirmed before it leaves.
 *
 * It holds the account (one statement is one declared account), the text
 * (pasted, or a dropped `.txt` / `.csv` read in the browser) with its counter,
 * and the sentence that says where it goes. *Envoyer* posts to
 * `/api/agent/statements`, which hands the text to a model with no tool and
 * writes a proposal; the thread is then read again so its messages and the
 * card appear. The text is never kept here once the box closes.
 */
import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { accountsApi } from '@/features/accounts/lib/api'
import { agentApi, PROVIDER_NAME, STATEMENT_MAX } from '@/features/agent/lib/api'
import { useI18n } from '@/lib/i18n'

/** The `<select>` skin the forms share (`EventForm`, `AgentBlock`). */
const SELECT =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

export interface StatementDraftIn {
  /** The file's name, or empty for a text that was pasted. */
  name: string
  text: string
}

export function StatementDialog({
  draft,
  threadId,
  onClose,
  onSent,
}: {
  /** The box is open while there is a draft. */
  draft: StatementDraftIn | null
  threadId: string
  onClose: () => void
  /** The proposal exists and the thread holds its messages on the server. */
  onSent: () => void
}) {
  const { t } = useI18n()
  const client = useQueryClient()
  const accountId = useId()
  const textId = useId()
  const [account, setAccount] = useState('')
  const [text, setText] = useState('')
  const open = draft !== null

  const config = useQuery({
    queryKey: ['agent-config'],
    queryFn: agentApi.agentConfig,
    enabled: open,
  })
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.accounts,
    enabled: open,
  })
  const declared = accounts.data?.accounts ?? []

  // Each time the box opens it starts from what it was handed.
  useEffect(() => {
    if (draft) setText(draft.text)
  }, [draft])
  useEffect(() => {
    if (declared.length === 1) setAccount(declared[0].id)
  }, [declared])

  const write = useMutation({
    mutationFn: () => {
      const provider = config.data?.provider
      if (!provider) throw new Error('no provider')
      return agentApi.sendStatement({
        thread_id: threadId,
        account,
        provider,
        name: draft?.name || t('agent.statement.pasted'),
        text: text.trim(),
      })
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['proposals'] })
      write.reset()
      // The text is not kept once it has gone.
      setText('')
      onSent()
      onClose()
    },
  })

  const close = () => {
    if (write.isPending) return
    write.reset()
    setText('')
    onClose()
  }

  const count = text.trim().length
  const tooLong = count > STATEMENT_MAX
  const provider = config.data?.provider
  const ready = provider != null && account !== '' && count > 0 && !tooLong

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('agent.statement.title')}</DialogTitle>
          <DialogDescription>{t('agent.statement.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label htmlFor={accountId} className="text-sm font-medium">
            {t('agent.statement.account')}
          </label>
          {declared.length === 0 && accounts.isSuccess ? (
            <p className="text-sm text-muted-foreground">{t('agent.statement.account.none')}</p>
          ) : (
            <select
              id={accountId}
              className={SELECT}
              value={account}
              onChange={(event) => setAccount(event.target.value)}
            >
              <option value="">{t('agent.statement.account.placeholder')}</option>
              {declared.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.label ?? one.id}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor={textId} className="text-sm font-medium">
            {t('agent.statement.text')}
          </label>
          <Textarea
            id={textId}
            value={text}
            rows={8}
            className="max-h-64 font-mono text-xs"
            aria-invalid={tooLong}
            onChange={(event) => setText(event.target.value)}
          />
          <p
            className={tooLong ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            aria-live="polite"
          >
            {tooLong
              ? t('agent.statement.tooLong', { max: STATEMENT_MAX })
              : t('agent.statement.count', { count, max: STATEMENT_MAX })}
          </p>
        </div>

        {provider ? (
          <p className="text-sm">
            {t('agent.statement.provider', {
              provider: t(PROVIDER_NAME[provider]),
              model: config.data?.model_name ?? config.data?.model ?? '',
            })}
          </p>
        ) : null}

        {/* In the box and not on the page: the overlay hides everything behind it. */}
        {write.error ? <Refusal>{write.error.message}</Refusal> : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={write.isPending} onClick={close}>
            {t('agent.statement.cancel')}
          </Button>
          <Button type="button" disabled={!ready || write.isPending} onClick={() => write.mutate()}>
            {write.isPending ? t('agent.statement.sending') : t('agent.statement.send')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
