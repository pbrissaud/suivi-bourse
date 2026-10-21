/**
 * The investor's profile on the agent's page (#1116): the proposal cards in a
 * thread, and the chips of what is confirmed in its header.
 *
 * **The agent proposes, only this page decides.** A `propose_profile_fact`
 * call is drawn as a card reading its stored state (5A): *Confirmer* and
 * *Ignorer* while it is ready, one status line once decided or expired. The
 * chips are the confirmed facts, each opening its value, its date, *Modifier*
 * and *Oublier* (13A).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UIMessage } from 'ai'
import {
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getToolName, isToolUIPart } from '@/features/agent/lib/agentChat'
import {
  FACTS,
  factLabel,
  LABEL_MAX,
  MARGINAL_RATE_MAX_PERCENT,
  type Profile,
  profileApi,
  type ProjectValue,
  type Proposal,
  proposalId,
  RISK_TOLERANCES,
} from '@/features/agent/lib/profile'
import { type EventsProposal, eventProposalsApi } from '@/features/agent/lib/eventProposals'
import { settingsApi } from '@/features/settings/lib/api'
import { ApiProblem } from '@/lib/api'
import { baseCurrency } from '@/lib/firstRun'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

/** Beyond this many chips, a *+N* chip opens the whole profile. */
const CHIPS = 4

/** The `<select>` skin of the other forms (`AgentBlock`, `EventForm`), copied as they copy it. */
const SELECT =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

// ------------------------------------------------------------ proposals --

/** A proposal the thread made: a profile fact's, or ledger events' (#1119). */
export type ThreadProposal = Proposal | EventsProposal

/** The proposal a tool part came back with, or `null` for any other part. */
export function proposalOf(
  part: UIMessage['parts'][number],
): { id: string; kind: 'fact' | 'events' } | null {
  if (!isToolUIPart(part) || part.state !== 'output-available') return null
  const name = getToolName(part)
  const kind =
    name === 'propose_profile_fact' ? 'fact' : name === 'propose_events' ? 'events' : null
  const id = kind === null ? null : proposalId(part.output)
  return kind === null || id === null ? null : { id, kind }
}

/**
 * The stored state of every proposal the thread made, read once its turn has
 * ended: a reloaded thread, or one returned to, shows what was decided.
 * `undefined` while the read has not answered (#795); a read that failed is an
 * empty answer, so each card falls back to its plain tool line.
 */
export function useProposals(
  threadId: string,
  messages: UIMessage[],
  busy: boolean,
): Map<string, ThreadProposal> | undefined {
  const refs = messages.flatMap((m) => m.parts.map(proposalOf)).filter((ref) => ref !== null)
  const idsOf = (kind: 'fact' | 'events') =>
    [...new Set(refs.filter((ref) => ref.kind === kind).map((ref) => ref.id))].sort()
  const factIds = idsOf('fact')
  const eventIds = idsOf('events')
  // A proposal made mid-stream changes the key: the cards already read keep
  // their state, and the new one is its tool line until the turn ends.
  const facts = useQuery({
    queryKey: ['proposals', threadId, factIds],
    queryFn: () => profileApi.proposals(factIds),
    enabled: !busy && factIds.length > 0,
    placeholderData: keepPreviousData,
  })
  const events = useQuery({
    queryKey: ['proposals', threadId, 'events', eventIds],
    queryFn: () => eventProposalsApi.proposals(eventIds),
    enabled: !busy && eventIds.length > 0,
    placeholderData: keepPreviousData,
  })
  const factsFailed = facts.error !== null
  const eventsFailed = events.error !== null
  return useMemo(() => {
    // A read that failed is an empty answer for its own kind only (the other
    // kind's cards still show), and `undefined` stays *nobody has answered*.
    const answered = (failed: boolean, data: { proposals: ThreadProposal[] } | undefined) =>
      failed ? [] : data?.proposals
    const read = [answered(factsFailed, facts.data), answered(eventsFailed, events.data)]
    if (read.every((one) => one === undefined)) return undefined
    return new Map(read.flatMap((one) => one ?? []).map((p) => [p.id, p]))
  }, [factsFailed, eventsFailed, facts.data, events.data])
}

/** A proposal (5A): the question and its two answers, or the one line it came to. */
export function FactCard({ proposal }: { proposal: Proposal }) {
  const { t, locale } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const decide = useMutation({
    mutationFn: (confirm: boolean) =>
      confirm ? profileApi.confirm(proposal.id) : profileApi.ignore(proposal.id),
    // Written at once: while a later turn streams, the read is disabled and an
    // invalidation alone would leave the buttons standing.
    onSuccess: ({ proposal: decided }) =>
      client.setQueriesData<{ proposals: Proposal[] }>(
        { queryKey: ['proposals'] },
        (read) =>
          read && {
            proposals: read.proposals.map((p) => (p.id === decided.id ? decided : p)),
          },
      ),
    // A 409 too: the card then reads what the server holds.
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['proposals'] }),
        client.invalidateQueries({ queryKey: ['profile'] }),
      ]),
  })
  const label = factLabel(proposal.key, proposal.value, locale)
  // The owner's own screen: an income is confirmed on its amount, which only
  // the model is never sent back.
  const income = proposal.key === 'income' ? (proposal.value as IncomeValue) : null
  const named = income
    ? t('agent.fact.income', { amount: f.currency(income.amount, income.currency) })
    : t(label.key, label.values)
  // A refusal the card cannot outlive (a project forgotten since, no reporting
  // currency) is said in the server's words; anything else in ours.
  const refused =
    decide.error instanceof ApiProblem && decide.error.detail
      ? decide.error.detail
      : t('agent.fact.failed')

  return (
    // Polite: the decision replaces the buttons, and is said once it has. The
    // frame is the question's: a decided proposal is a line, not a card (#1271).
    <div
      aria-live="polite"
      className={
        proposal.status === 'ready' ? 'flex flex-col gap-3 rounded-card border bg-card p-3.5' : ''
      }
    >
      {proposal.status === 'ready' ? (
        <>
          <p className="text-prose">
            {t(proposal.key === 'project' ? 'agent.fact.ask.project' : 'agent.fact.ask', {
              label: named,
            })}
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
          <span className="text-muted-foreground">{t(`agent.fact.${proposal.status}`)}</span>
        </p>
      )}
    </div>
  )
}

interface IncomeValue {
  amount: number
  currency: string
}

// ---------------------------------------------------------------- chips --

interface Entry {
  /** The fact's key, a project's being `project:<id>`. */
  key: string
  value: unknown
  confirmed_at: string
}

/** The facts in their order, then the projects in the server's. */
function entries(profile: Profile): Entry[] {
  return [
    ...FACTS.flatMap((key) => {
      const fact = profile.facts[key]
      return fact ? [{ key, ...fact }] : []
    }),
    ...profile.projects.map(({ id, confirmed_at, ...value }) => ({
      key: `project:${id}`,
      value,
      confirmed_at,
    })),
  ]
}

/** The confirmed profile as chips (13A). Nothing while it is read, nor when empty. */
export function ProfileChips() {
  const { t } = useI18n()
  const list = useRef<HTMLUListElement>(null)
  // A forgotten chip takes its popover and the focus with it: the list keeps it.
  const forgotten = () => list.current?.focus()
  const profile = useQuery({ queryKey: ['profile'], queryFn: profileApi.profile })
  if (profile.data === undefined) return null
  const all = entries(profile.data)
  if (all.length === 0) return null
  const shown = all.length > CHIPS ? all.slice(0, CHIPS) : all

  return (
    <ul
      ref={list}
      tabIndex={-1}
      aria-label={t('agent.profile')}
      className="flex flex-wrap gap-1.5 pt-1.5 focus:outline-none"
    >
      {shown.map((entry) => (
        <li key={entry.key}>
          <Chip label={<EntryLabel entry={entry} />}>
            <FactDetail entry={entry} onForgotten={forgotten} />
          </Chip>
        </li>
      ))}
      {all.length > shown.length ? (
        <li>
          <Chip
            label={t('agent.profile.more', { count: all.length - shown.length })}
            name={`${t('agent.profile.all')} (${t('agent.profile.more', { count: all.length - shown.length })})`}
          >
            <div className="flex flex-col divide-y">
              {all.map((entry) => (
                <div key={entry.key} className="py-2 first:pt-0 last:pb-0">
                  <FactDetail entry={entry} onForgotten={forgotten} />
                </div>
              ))}
            </div>
          </Chip>
        </li>
      ) : null}
    </ul>
  )
}

function EntryLabel({ entry }: { entry: Entry }) {
  const { t, locale } = useI18n()
  const label = factLabel(entry.key, entry.value, locale)
  return <>{t(label.key, label.values)}</>
}

function Chip({ label, name, children }: { label: ReactNode; name?: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={name}
          className="label min-h-8 rounded-full border px-2.5 text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:outline-none pointer-coarse:min-h-11"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** One fact: its value, when it was confirmed, *Modifier* and *Oublier*. */
function FactDetail({ entry, onForgotten }: { entry: Entry; onForgotten: () => void }) {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  // Back from the editor, the focus returns to *Modifier*, not to the page.
  const [edited, setEdited] = useState(false)
  const forget = useMutation({
    mutationFn: () => profileApi.forgetFact(entry.key),
    onSuccess: onForgotten,
    onSettled: () => client.invalidateQueries({ queryKey: ['profile'] }),
  })

  if (editing) {
    const done = () => {
      setEditing(false)
      setEdited(true)
    }
    return <FactEditor entry={entry} onDone={done} />
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">
        <FactValue entry={entry} />
      </p>
      <p className="text-xs text-muted-foreground">
        {t('agent.profile.confirmedOn', { date: f.date(entry.confirmed_at) })}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          autoFocus={edited}
          onClick={() => setEditing(true)}
        >
          {t('agent.profile.edit')}
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={forget.isPending}
          onClick={() => forget.mutate()}
        >
          {t('agent.profile.forget')}
        </Button>
      </div>
      {forget.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t('agent.profile.failed')}
        </p>
      ) : null}
    </div>
  )
}

/** The value in full: on the owner's own screen the income shows its amount. */
function FactValue({ entry }: { entry: Entry }) {
  const f = useFormatters()
  if (entry.key === 'income') {
    const income = entry.value as IncomeValue
    return <>{f.currency(income.amount, income.currency)}</>
  }
  if (!entry.key.startsWith('project:')) return <EntryLabel entry={entry} />
  return <ProjectAmount entry={entry} />
}

/** A project, its amount in the reporting currency (a plain number while unanswered). */
function ProjectAmount({ entry }: { entry: Entry }) {
  const f = useFormatters()
  // The currency cannot move once answered, so no refetch on every mount.
  const config = useQuery({
    queryKey: ['config'],
    queryFn: settingsApi.config,
    refetchOnMount: false,
  })
  const currency = baseCurrency(config.data?.settings)
  const project = entry.value as ProjectValue
  const amount =
    project.amount == null
      ? null
      : currency
        ? f.currency(project.amount, currency, 0)
        : f.number(project.amount, 0)
  return (
    <>
      <EntryLabel entry={entry} />
      {amount === null ? null : ` · ${amount}`}
    </>
  )
}

/** *Modifier*: the field the fact's kind takes, then `PUT`. */
function FactEditor({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const id = useId()
  const [draft, setDraft] = useState<Record<string, string>>(() => initialDraft(entry))
  const save = useMutation({
    mutationFn: (value: unknown) => profileApi.putFact(entry.key, value),
    onSuccess: (profile) => {
      client.setQueryData(['profile'], profile)
      onDone()
    },
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    save.mutate(valueOf(entry.key, draft))
  }
  const field = (name: string, label: string, props: ComponentProps<typeof Input>) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-${name}`} className="block text-sm">
        {label}
      </label>
      <Input
        id={`${id}-${name}`}
        value={draft[name]}
        onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
        {...props}
      />
    </div>
  )

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {entry.key === 'income'
        ? field('amount', t('agent.profile.field.amount'), {
            type: 'number',
            min: 0,
            required: true,
          })
        : null}
      {entry.key === 'marginal_rate'
        ? field('rate', t('agent.profile.field.rate'), {
            type: 'number',
            min: 0,
            max: MARGINAL_RATE_MAX_PERCENT,
            step: 0.1,
            required: true,
          })
        : null}
      {entry.key === 'risk_tolerance' ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-risk`} className="block text-sm">
            {t('agent.profile.field.risk')}
          </label>
          <select
            id={`${id}-risk`}
            className={SELECT}
            value={draft.risk}
            onChange={(event) => setDraft({ ...draft, risk: event.target.value })}
          >
            {RISK_TOLERANCES.map((risk) => (
              <option key={risk} value={risk}>
                {t(`agent.profile.risk.${risk}`)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {entry.key.startsWith('project:') ? (
        <>
          {field('label', t('agent.profile.field.label'), { maxLength: LABEL_MAX, required: true })}
          {field('year', t('agent.profile.field.year'), { type: 'number', required: true })}
          {field('amount', t('agent.profile.field.projectAmount'), { type: 'number', min: 0 })}
        </>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" className="min-h-11" disabled={save.isPending}>
          {t('agent.profile.save')}
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={onDone}>
          {t('agent.profile.cancel')}
        </Button>
      </div>
      {save.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t('agent.profile.failed')}
        </p>
      ) : null}
    </form>
  )
}

function initialDraft(entry: Entry): Record<string, string> {
  const value = entry.value as Record<string, unknown> | number | string
  if (entry.key === 'income') return { amount: String((value as { amount: number }).amount) }
  if (entry.key === 'marginal_rate')
    return { rate: String(Math.round((value as number) * 1000) / 10) }
  if (entry.key === 'risk_tolerance') return { risk: value as string }
  const project = value as unknown as ProjectValue
  return {
    label: project.label,
    year: String(project.target_year),
    amount: project.amount == null ? '' : String(project.amount),
  }
}

/** The draft as the value `PUT` takes; the server holds the rules. */
function valueOf(key: string, draft: Record<string, string>): unknown {
  if (key === 'income') return { amount: Number(draft.amount) }
  if (key === 'marginal_rate') return Number(draft.rate) / 100
  if (key === 'risk_tolerance') return draft.risk
  return {
    label: draft.label,
    target_year: Number(draft.year),
    ...(draft.amount === '' ? {} : { amount: Number(draft.amount) }),
  }
}
