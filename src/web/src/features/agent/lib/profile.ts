/**
 * The investor's profile (#1116): what the owner declared about themself, and
 * the agent's proposals they confirm or ignore. **The agent never writes a
 * fact**: `propose_profile_fact` records a proposal, and only these calls
 * decide it.
 */
import type { Confirmed, Ignored, Profile, Proposal, ProposalsPayload } from '@/lib/api.gen'
import { forget, get, ROUTES, send } from '@/lib/api'
import type { MessageKey, MessageValues } from '@/lib/i18n'

export type { Profile, Proposal }

/** The facts that are one value each, in the order their chips read. */
export const FACTS = ['income', 'marginal_rate', 'risk_tolerance'] as const
export const RISK_TOLERANCES = ['prudent', 'balanced', 'dynamic'] as const
/** The server's bounds (`application/profile.py`), so a field says them first. */
export const LABEL_MAX = 80
export const MARGINAL_RATE_MAX_PERCENT = 60

export interface ProjectValue {
  label: string
  target_year: number
  amount?: number | null
}

function factPath(key: string): string {
  return ROUTES.profileFact.replace(':key', encodeURIComponent(key))
}

function proposalPath(route: string, id: string): string {
  return route.replace(':id', encodeURIComponent(id))
}

export const profileApi = {
  profile: () => get<Profile>(ROUTES.profile),
  putFact: (key: string, value: unknown) => send<Profile>(factPath(key), 'PUT', { value }),
  forgetFact: (key: string) => forget(factPath(key)),
  proposals: (ids: string[]) =>
    get<ProposalsPayload>(`${ROUTES.profileProposals}?ids=${ids.join(',')}`),
  confirm: (id: string) =>
    send<Confirmed>(proposalPath(ROUTES.profileProposalConfirm, id), 'POST', {}),
  ignore: (id: string) => send<Ignored>(proposalPath(ROUTES.profileProposalIgnore, id), 'POST', {}),
}

/**
 * How a fact reads on a chip and in a proposal: *TMI 30 %*, *Équilibré*,
 * *Maison · 2028*. **The income never shows its amount here**: the label says
 * it is not sent to the model.
 */
export function factLabel(
  key: string,
  value: unknown,
  locale: string,
): { key: MessageKey; values?: MessageValues } {
  if (key === 'income') return { key: 'agent.profile.income' }
  if (key === 'marginal_rate') {
    const rate = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
    return { key: 'agent.profile.marginal_rate', values: { rate: rate.format(value as number) } }
  }
  if (key === 'risk_tolerance')
    return { key: `agent.profile.risk.${value as string}` as MessageKey }
  const project = value as ProjectValue
  return {
    key: 'agent.profile.project',
    values: { label: project.label, year: String(project.target_year) },
  }
}

/** The proposal id a `propose_profile_fact` call came back with, if any. */
export function proposalId(output: unknown): string | null {
  const id = (output as { proposal_id?: unknown } | null | undefined)?.proposal_id
  return typeof id === 'string' ? id : null
}
