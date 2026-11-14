/**
 * The ledger events the agent proposed, drawn under its answer as ruled rows
 * (« Relevé », `Agent-Refonte.dc.html` mode *events*): date, kind, the security
 * with its account, the amount, and — for a line the ledger already holds,
 * found by the import's own dry run — « déjà dans le grand livre », unchecked.
 * One filled button, « Ajouter N événements », writes the others.
 *
 * **The agent proposes, only the merge writes.** Like `FactCard` it reads a
 * stored state and has five: *ready*, *merged*, *ignored*, *expired*, and
 * *stale* — the ledger changed since, so the events were judged against another
 * one — whose *Relancer* judges the same events again, with no model, as a new
 * proposal. A proposal the dry run cannot settle alone (a statement, or an
 * answer the import still asks for) is reviewed in the ledger's window instead:
 * « Revoir dans le grand livre ». There is no *Garder en branche*.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  type EventsProposal,
  eventProposalsApi,
  holdsAlready,
  LINES_SHOWN,
} from '@/features/agent/lib/eventProposals'
import { ACT } from '@/features/agent/lib/styles'
import { EventFigure, TYPE_LABEL } from '@/features/data/components/LedgerTable'
import type { LedgerEvent, LedgerEventType } from '@/features/data/lib/api'
import { settingsApi } from '@/features/settings/lib/api'
import { ApiProblem } from '@/lib/api'
import { baseCurrency } from '@/lib/firstRun'
import { useFormatters } from '@/lib/format'
import { type MessageKey, useI18n } from '@/lib/i18n'

type Line = EventsProposal['events'][number]

export function EventsCard({
  proposal,
  primary = false,
}: {
  proposal: EventsProposal
  /** Only the thread's last card is the screen's one filled button; the others are outlines. */
  primary?: boolean
}) {
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
  const open = shown.status === 'ready' || shown.status === 'stale'

  // The dry run, once per proposal on screen: it is what tells a line the
  // ledger holds from one it does not. Under a different key than the
  // proposals' own, which decisions rewrite in place.
  const dry = useQuery({
    queryKey: ['proposal-preview', shown.id],
    queryFn: () => eventProposalsApi.preview(shown.id),
    enabled: shown.status === 'ready',
    retry: false,
  })
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config, enabled: open })
  const currency = baseCurrency(config.data?.settings)

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
  const add = useMutation({
    mutationFn: () => eventProposalsApi.merge(shown.id),
    onSuccess: (receipt) => {
      toast.success(t('agent.events.added', { count: receipt.written }))
      // Every figure is downstream of the ledger.
      void client.invalidateQueries()
    },
    onError: () => void client.invalidateQueries({ queryKey: ['proposals'] }),
  })
  // A batch that no longer passes is said in the server's words, as a fact's is.
  const refused = (error: Error | null) =>
    error instanceof ApiProblem && error.detail ? error.detail : t('agent.events.failed')

  const lines = shown.events.slice(0, LINES_SHOWN)
  const rest = shown.count - lines.length
  const held = holdsAlready(shown.events, dry.data?.duplicate_rows ?? [])
  // « Ajouter N » only where the dry run settled it without a question: a
  // statement, or a refusal of the dry run, is reviewed in the ledger.
  const direct = shown.status === 'ready' && !shown.statement && dry.isSuccess
  const toAdd = dry.data?.written ?? 0
  // The ledger's window is the way when the dry run cannot settle it alone.
  const review = shown.status === 'ready' && !direct
  const busy = decide.isPending || add.isPending

  return (
    <div aria-live="polite" className="flex flex-col gap-3">
      <p className="text-prose">
        {shown.title}
        {open ? null : (
          <>
            {' · '}
            <span className="text-muted-foreground">{decided(t, f, shown)}</span>
          </>
        )}
      </p>
      {open ? (
        <>
          <Table aria-label={t('agent.events.table')}>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="sr-only">{t('agent.events.included')}</span>
                </TableHead>
                <TableHead>{t('agent.events.col.date')}</TableHead>
                <TableHead>{t('agent.events.col.type')}</TableHead>
                <TableHead>{t('agent.events.col.event')}</TableHead>
                <TableHead numeric>{t('agent.events.col.amount')}</TableHead>
                <TableHead numeric>{t('agent.events.col.present')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line, index) => (
                // A read-out of a stored batch: the position is the identity, within a proposal.
                <TableRow
                  key={`${shown.id}-${index}`}
                  tall
                  className={held[index] ? 'text-muted-foreground' : undefined}
                >
                  <TableCell>
                    <Checkbox
                      checked={!held[index]}
                      disabled
                      aria-label={t('agent.events.included')}
                    />
                  </TableCell>
                  <TableCell className="fig">{line.date ? f.date(line.date) : ''}</TableCell>
                  <TableCell>{t(TYPE_LABEL[line.event_type as LedgerEventType])}</TableCell>
                  <TableCell>
                    <LineName line={line} />
                  </TableCell>
                  <TableCell numeric>
                    <EventFigure event={asEvent(line)} currency={currency} />
                  </TableCell>
                  <TableCell numeric className="font-sans text-xs text-muted-foreground">
                    {held[index] ? t('agent.events.present') : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {rest > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('agent.events.more', { count: rest })}
            </p>
          ) : null}
          {shown.status === 'stale' ? (
            <p className="text-sm text-attention">{t('agent.events.stale')}</p>
          ) : null}
          {shown.statement && shown.statement.dropped > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('agent.events.dropped', { count: shown.statement.dropped })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-4">
            {/* One filled button: what settles the proposal in this state. */}
            <Button
              variant={primary ? 'primary' : 'outline'}
              asChild={review}
              disabled={busy || (direct && toAdd === 0)}
              onClick={
                shown.status === 'stale'
                  ? () => decide.mutate('repropose')
                  : direct
                    ? () => add.mutate()
                    : undefined
              }
            >
              {review ? (
                <Link to="/ledger" search={{ proposal: shown.id }}>
                  {t('agent.events.review')}
                </Link>
              ) : shown.status === 'stale' ? (
                t('agent.events.repropose')
              ) : (
                t('agent.events.add', { count: toAdd })
              )}
            </Button>
            {direct ? (
              <Link to="/ledger" search={{ proposal: shown.id }} className={ACT}>
                {t('agent.events.review')}
              </Link>
            ) : null}
            <button
              type="button"
              className={ACT}
              disabled={busy}
              onClick={() => decide.mutate('ignore')}
            >
              {t('agent.events.ignore')}
            </button>
            {rekinds(shown, busy, () => decide.mutate('rekind'), t)}
          </div>
          {decide.error || add.error ? (
            <p role="alert" className="text-sm text-destructive">
              {refused(decide.error ?? add.error)}
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

/** A proposed line as the ledger's own figure component reads an event. */
function asEvent(line: Line): LedgerEvent {
  return {
    date: line.date,
    event_type: line.event_type as LedgerEventType,
    symbol: line.symbol,
    name: line.name ?? null,
    quantity: line.quantity,
    unit_price: line.unit_price,
    fee: line.fee,
    amount: line.amount,
    notes: line.notes,
    account: line.account ?? '',
  }
}

/** The security (or the cash movement's note) over its ticker, account and marks. */
function LineName({ line }: { line: Line }) {
  const { t } = useI18n()
  const title = line.name ?? line.symbol ?? line.notes ?? ''
  const sub = [
    line.symbol ?? (line.name ? t('agent.events.pickTitle') : null),
    line.account,
    line.symbol === null ? null : line.notes,
    ...(line.marks ?? []).map((mark) => t(`agent.events.mark.${mark}`)),
  ].filter((part): part is string => part !== null && part !== '')
  return (
    <span className="flex flex-col">
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{sub.join(' · ')}</span>
    </span>
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
    <button type="button" className={ACT} disabled={pending} onClick={onClick}>
      {t(
        proposal.statement.kind === 'positions'
          ? 'agent.events.rekind.operations'
          : 'agent.events.rekind.positions',
      )}
    </button>
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

/** *3 mars 2026 · Achat · CW8.PA · 10 × 512 · cto*, and a word where a mark is set. */
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
        <span key={mark} className="ml-2 text-muted-foreground">
          {t(`agent.events.mark.${mark}`)}
        </span>
      ))}
    </>
  )
}
