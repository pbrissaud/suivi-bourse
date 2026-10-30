/**
 * The ledger events the agent proposed, drawn as a card in the thread (#1119).
 *
 * **The agent proposes, only the import preview merges.** Like `FactCard` it
 * reads a stored state and has five: *ready* (the title, the lines, *Revoir et
 * fusionner* and *Ignorer*), *merged*, *ignored*, *expired*, and *stale* — the
 * ledger changed since, so the events were judged against another one — whose
 * *Relancer* judges the same events again, with no model, as a new proposal.
 * There is no *Garder en branche*.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { TYPE_LABEL } from '@/features/data/components/LedgerTable'
import { Button } from '@/components/ui/button'
import {
  type EventsProposal,
  eventProposalsApi,
  LINES_SHOWN,
} from '@/features/agent/lib/eventProposals'
import type { LedgerEventType } from '@/features/data/lib/api'
import { ApiProblem } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { type MessageKey, useI18n } from '@/lib/i18n'

type Line = EventsProposal['events'][number]

export function EventsCard({ proposal }: { proposal: EventsProposal }) {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  // *Relancer* makes a new proposal; the card then shows that one, read like
  // the first (`['proposals']` is invalidated by every decision and merge).
  // Held in the query cache and not in state, so a card that remounts (the
  // thread is left and returned to) still shows the new proposal.
  const successor = useQuery<string | null>({
    queryKey: ['proposal-successor', proposal.id],
    queryFn: () => null,
    enabled: false,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const next = useQuery({
    queryKey: ['proposals', 'successor', successor.data],
    queryFn: () => eventProposalsApi.proposals([successor.data as string]),
    enabled: successor.data !== null,
  })
  const shown = (successor.data !== null ? next.data?.proposals[0] : undefined) ?? proposal
  // The new proposal could not be read: say so, rather than let the old card
  // (stale, with its buttons) stand as if nothing had happened.
  const successorFailed = successor.data !== null && next.isError

  const decide = useMutation({
    mutationFn: (how: 'ignore' | 'repropose' | 'rekind') =>
      how === 'rekind'
        ? eventProposalsApi.rekind(shown.id)
        : how === 'repropose'
          ? eventProposalsApi.repropose(shown.id)
          : eventProposalsApi.ignore(shown.id),
    onSuccess: ({ proposal: decided }, how) => {
      const again = how !== 'ignore'
      // Written at once: while a later turn streams, the read is disabled and an
      // invalidation alone would leave the buttons standing. A new proposal
      // replaces nothing: the one it came from reads `ignored`.
      if (again) client.setQueryData(['proposal-successor', proposal.id], decided.id)
      const settled = again ? { ...shown, status: 'ignored' as const } : decided
      client.setQueriesData<{ proposals: { id: string }[] }>(
        { queryKey: ['proposals'] },
        (read) =>
          read && { proposals: read.proposals.map((p) => (p.id === settled.id ? settled : p)) },
      )
    },
    // A 409 too: the card then reads what the server holds.
    onSettled: () => client.invalidateQueries({ queryKey: ['proposals'] }),
  })
  // A batch that no longer passes is said in the server's words, as a fact's is.
  const refused =
    decide.error instanceof ApiProblem && decide.error.detail
      ? decide.error.detail
      : t('agent.events.failed')

  const lines = shown.events.slice(0, LINES_SHOWN)
  const rest = shown.count - lines.length
  const framed = shown.status === 'ready' || shown.status === 'stale'

  return (
    <div
      aria-live="polite"
      className={framed ? 'flex flex-col gap-3 rounded-card border bg-card p-3.5' : ''}
    >
      <p className="text-prose">
        {shown.title}
        {framed ? null : (
          <>
            {' · '}
            <span className="text-muted-foreground">{decided(t, f, shown)}</span>
          </>
        )}
      </p>
      {framed ? (
        <>
          <ul className="flex flex-col gap-1 text-sm">
            {lines.map((line, index) => (
              // A read-out of a stored batch: the position is the identity, within a proposal.
              <li key={`${shown.id}-${index}`}>
                <LineText line={line} />
              </li>
            ))}
            {rest > 0 ? (
              <li className="text-muted-foreground">{t('agent.events.more', { count: rest })}</li>
            ) : null}
          </ul>
          {shown.status === 'stale' ? (
            <p className="text-sm text-attention">{t('agent.events.stale')}</p>
          ) : null}
          {shown.statement && shown.statement.dropped > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('agent.events.dropped', { count: shown.statement.dropped })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {shown.status === 'ready' ? (
              <>
                <Button asChild className="min-h-11">
                  <Link to="/ledger" search={{ proposal: shown.id }}>
                    {t('agent.events.review')}
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate('ignore')}
                >
                  {t('agent.events.ignore')}
                </Button>
                {rekinds(shown, decide.isPending, () => decide.mutate('rekind'), t)}
              </>
            ) : (
              <>
                <Button
                  className="min-h-11"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate('repropose')}
                >
                  {t('agent.events.repropose')}
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate('ignore')}
                >
                  {t('agent.events.ignore')}
                </Button>
                {rekinds(shown, decide.isPending, () => decide.mutate('rekind'), t)}
              </>
            )}
          </div>
          {decide.error ? (
            <p role="alert" className="text-sm text-destructive">
              {refused}
            </p>
          ) : null}
        </>
      ) : null}
      {successorFailed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('agent.events.failed')}
        </p>
      ) : null}
    </div>
  )
}

/** *Lire comme relevé d'opérations / de positions*: only a statement can be read the other way (#1120). */
function rekinds(
  proposal: EventsProposal,
  pending: boolean,
  onClick: () => void,
  t: (key: MessageKey) => string,
) {
  if (!proposal.statement) return null
  return (
    <Button variant="outline" className="min-h-11" disabled={pending} onClick={onClick}>
      {t(
        proposal.statement.kind === 'positions'
          ? 'agent.events.rekind.operations'
          : 'agent.events.rekind.positions',
      )}
    </Button>
  )
}

/** The one word a decided or expired proposal comes to. */
function decided(
  t: (key: MessageKey, values?: Record<string, string>) => string,
  f: ReturnType<typeof useFormatters>,
  proposal: EventsProposal,
): string {
  if (proposal.status === 'merged')
    return t('agent.events.merged', { date: f.date(proposal.decided_at) })
  return t(proposal.status === 'ignored' ? 'agent.events.ignored' : 'agent.events.expired')
}

/** *3 mars 2026 · Achat · CW8.PA · 10 × 512 · cto*, and a badge where a mark is set. */
export function LineText({ line, detailed = false }: { line: Line; detailed?: boolean }) {
  const { t } = useI18n()
  const f = useFormatters()
  const what =
    line.quantity !== null && line.unit_price !== null
      ? `${f.quantity(line.quantity)} × ${f.number(line.unit_price, 2)}`
      : line.amount !== null
        ? f.number(line.amount, 2)
        : null
  const parts = [
    line.date ? f.date(line.date) : null,
    t(TYPE_LABEL[line.event_type as LedgerEventType]),
    line.symbol ?? (line.name ? `${line.name} · ${t('agent.events.pickTitle')}` : null),
    what,
    detailed && line.fee ? `${t('data.import.proposal.fee')} ${f.number(line.fee, 2)}` : null,
    line.account,
    detailed ? line.notes : null,
  ].filter((part): part is string => part !== null && part !== '')
  return (
    <>
      {parts.join(' · ')}
      {(line.marks ?? []).map((mark) => (
        <span key={mark} className="ml-2 rounded-md bg-muted px-2 py-0.5 text-2xs font-medium">
          {t(`agent.events.mark.${mark}`)}
        </span>
      ))}
    </>
  )
}
