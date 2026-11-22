/**
 * The settings the agent proposed to change (#1628). **The agent never writes a
 * setting**: `propose_setting` records a proposal, and only these calls decide
 * it; confirming applies it on the server.
 */
import type {
  SettingProposal,
  SettingProposalDecided,
  SettingProposalsPayload,
} from '@/lib/api.gen'
import { get, ROUTES, send } from '@/lib/api'

export type { SettingProposal }

function proposalPath(route: string, id: string): string {
  return route.replace(':id', encodeURIComponent(id))
}

/** The most ids one read takes: the server's `PROPOSAL_IDS_MAX`. */
export const IDS_PER_READ = 50

export const settingProposalsApi = {
  /** Read in batches the server accepts, so a long thread keeps every card. */
  proposals: async (ids: string[]): Promise<SettingProposalsPayload> => {
    const batches = []
    for (let i = 0; i < ids.length; i += IDS_PER_READ) {
      batches.push(ids.slice(i, i + IDS_PER_READ))
    }
    const answers = await Promise.all(
      batches.map((batch) =>
        get<SettingProposalsPayload>(`${ROUTES.configProposals}?ids=${batch.join(',')}`),
      ),
    )
    return { proposals: answers.flatMap((answer) => answer.proposals) }
  },
  confirm: (id: string) =>
    send<SettingProposalDecided>(proposalPath(ROUTES.configProposalConfirm, id), 'POST', {}),
  ignore: (id: string) =>
    send<SettingProposalDecided>(proposalPath(ROUTES.configProposalIgnore, id), 'POST', {}),
}
