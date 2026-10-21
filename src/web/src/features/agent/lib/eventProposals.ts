/**
 * The ledger events the agent proposed (#1119). **The agent never writes an
 * event**: `propose_events` records a proposal, and only the import preview's
 * merge writes it (`features/data/lib/proposalImport.ts`). What lives here is
 * what the chat card needs: its stored state, *Ignorer* and *Relancer*.
 */
import type { EventsProposal, EventsProposalsPayload } from '@/lib/api.gen'
import { get, ROUTES, send } from '@/lib/api'

export type { EventsProposal }

/** A card lists this many lines and says *et N autres* for the rest. */
export const LINES_SHOWN = 8

export function proposalPath(route: string, id: string): string {
  return route.replace(':id', encodeURIComponent(id))
}

export const eventProposalsApi = {
  proposals: (ids: string[]) =>
    get<EventsProposalsPayload>(`${ROUTES.agentProposals}?ids=${ids.join(',')}`),
  ignore: (id: string) =>
    send<{ proposal: EventsProposal }>(proposalPath(ROUTES.agentProposalIgnore, id), 'POST', {}),
  /** The same events against the ledger as it is: a **new** proposal, no model asked. */
  repropose: (id: string) =>
    send<{ proposal: EventsProposal }>(proposalPath(ROUTES.agentProposalRepropose, id), 'POST', {}),
}
