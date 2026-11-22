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

export const settingProposalsApi = {
  proposals: (ids: string[]) =>
    get<SettingProposalsPayload>(`${ROUTES.configProposals}?ids=${ids.join(',')}`),
  confirm: (id: string) =>
    send<SettingProposalDecided>(proposalPath(ROUTES.configProposalConfirm, id), 'POST', {}),
  ignore: (id: string) =>
    send<SettingProposalDecided>(proposalPath(ROUTES.configProposalIgnore, id), 'POST', {}),
}
