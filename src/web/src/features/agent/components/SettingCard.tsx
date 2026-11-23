/**
 * A setting the agent proposed to change (#1628, #1629), drawn as `FactCard`
 * draws a fact: *Confirmer* and *Ignorer* while it is ready, one status line
 * once decided or expired. `log_level` lasts until the next restart: a process
 * setting. Every other one is stored, and says what it does in the registry's
 * own line (`doc`).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { type SettingProposal, settingProposalsApi } from '@/features/agent/lib/settingProposals'
import { ApiProblem } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

/** A stored value as the card says it: a list by its members, an unset one as a word. */
function said(value: unknown, none: string): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : none
  return value === null || value === '' ? none : String(value)
}

/** A setting proposal: the change and its two answers, or the one line it came to. */
export function SettingCard({ proposal }: { proposal: SettingProposal }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const decide = useMutation({
    mutationFn: (confirm: boolean) =>
      confirm ? settingProposalsApi.confirm(proposal.id) : settingProposalsApi.ignore(proposal.id),
    // Written at once: while a later turn streams, the read is disabled and an
    // invalidation alone would leave the buttons standing.
    onSuccess: ({ proposal: decided }) =>
      client.setQueriesData<{ proposals: SettingProposal[] }>(
        { queryKey: ['proposals'] },
        (read) =>
          read && {
            proposals: read.proposals.map((p) => (p.id === decided.id ? decided : p)),
          },
      ),
    // A 409 too: the card then reads what the server holds. The settings and
    // the log level are read from the configuration, the followed funds by the
    // comparison page.
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['proposals'] }),
        client.invalidateQueries({ queryKey: ['config'] }),
        client.invalidateQueries({ queryKey: ['benchmark'] }),
      ]),
  })
  // The levels are stored upper-case (`INFO`); the card says them as a reader
  // would. A ticker keeps its case.
  const say = (value: unknown) =>
    proposal.key === 'log_level'
      ? String(value).toLowerCase()
      : said(value, t('agent.setting.none'))
  const named = `${proposal.key}: ${say(proposal.previous)} → ${say(proposal.value)}`
  const refused =
    decide.error instanceof ApiProblem && decide.error.detail
      ? decide.error.detail
      : t('agent.setting.failed')

  return (
    // Polite: the decision replaces the buttons, and is said once it has.
    <div
      aria-live="polite"
      className={
        proposal.status === 'ready' ? 'flex flex-col gap-3 rounded-card border bg-card p-3.5' : ''
      }
    >
      {proposal.status === 'ready' ? (
        <>
          <p className="text-prose">{t('agent.setting.ask', { change: named })}</p>
          <p className="text-sm text-muted-foreground">
            {proposal.doc ?? t('agent.setting.untilRestart')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              disabled={decide.isPending}
              onClick={() => decide.mutate(true)}
            >
              {t('agent.fact.confirm')}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={decide.isPending}
              onClick={() => decide.mutate(false)}
            >
              {t('agent.fact.ignore')}
            </Button>
          </div>
          {decide.error ? (
            <p role="alert" className="text-sm text-destructive">
              {refused}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-prose">
          {named} ·{' '}
          <span className="text-muted-foreground">{t(`agent.setting.${proposal.status}`)}</span>
        </p>
      )}
    </div>
  )
}
