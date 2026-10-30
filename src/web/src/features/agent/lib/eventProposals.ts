/**
 * The ledger events the agent proposed (#1119). **The agent never writes an
 * event**: `propose_events` records a proposal, and only the import preview's
 * merge writes it (`features/data/lib/proposalImport.ts`). What lives here is
 * what the chat card needs: its stored state, *Ignorer* and *Relancer*.
 */
import type {
  EventsProposal,
  EventsProposalsPayload,
  ProposedLine,
  StatementFacts,
} from '@/lib/api.gen'
import { get, ROUTES, send } from '@/lib/api'

export type { EventsProposal }

/** What a statement proposal's preview adds to the receipt: its facts and its lines now (#1120). */
export type StatementPreview = StatementFacts & { lines: ProposedLine[] }

/**
 * The owner's answers on a statement proposal: a ticker for a line that has
 * none (by the line's number), a price for a gap (by symbol). The server keeps
 * none of them; they ride the body of every `/preview` and of `/merge`.
 */
export interface StatementEdits {
  symbols: Record<string, string>
  prices: Record<string, number>
}

export const NO_EDITS: StatementEdits = { symbols: {}, prices: {} }

/** The gestures the preview offers on a statement's lines. */
export interface StatementEdit {
  edits: StatementEdits
  /** Choose the ticker of line `n`; an empty one takes the choice back. */
  pick: (n: number, symbol: string) => void
  /** Price the gap on `symbol`; `null` takes the price back. */
  price: (symbol: string, value: number | null) => void
}

/** The body of `/preview` and `/merge`: nothing when nothing was edited. */
export function editsBody(edits: StatementEdits): Record<string, unknown> {
  return {
    ...(Object.keys(edits.symbols).length > 0 ? { symbols: edits.symbols } : {}),
    ...(Object.keys(edits.prices).length > 0 ? { prices: edits.prices } : {}),
  }
}

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
  /** A statement's extraction read as the other kind: a **new** proposal, no model asked (#1120). */
  rekind: (id: string) =>
    send<{ proposal: EventsProposal }>(proposalPath(ROUTES.agentProposalRekind, id), 'POST', {}),
}
