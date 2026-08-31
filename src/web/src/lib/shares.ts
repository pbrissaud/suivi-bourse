/**
 * The shares page's arithmetic, pure (#719, ADR-0017, ADR-0003, ADR-0004).
 *
 * Four things live here rather than in a component, and each of them is a rule
 * the page would otherwise re-decide per cell:
 *
 *  - **A row is a *symbol*, not a holding.** `/api/positions` is keyed by
 *    `(account, symbol)` — the same ETF on a PEA and on a CTO is two rows there
 *    and one line here. That grouping is the model staying multi-account while
 *    the *rendering* bends: measured, none of the nineteen symbols of the real
 *    portfolio is held on two accounts, and the fact is **contingent** rather
 *    than structural, so the column keeps a list and renders one account as
 *    plain text (#684 D11).
 *  - **The unit cost is derived, and it is undefined on a closed position.**
 *    `Σ cost_basis / Σ quantity` *is* the weighted mean and falls out of one
 *    division because the basis is stored as an amount (ADR-0003); a plain mean
 *    of per-account unit prices produces a plausible-looking wrong price. At
 *    quantity zero the basis is zero too, so the division is `0 / 0` and the
 *    honest answer is *there is nothing to compute* — the row has a realised
 *    gain instead.
 *  - **The counter is a rendering concern and never an arithmetic one.** A
 *    symbol the app has asked for N times and got nothing from renders *N
 *    consecutive readings, no price* in its price cell (`lib/absence.ts`), and
 *    is still **carried at its cost** in every sum (ADR-0004) — as long as its
 *    backfill is terminal, which is the term #845 brought over the wire.
 *    Written the other way round, a failing ticker would subtract its whole
 *    basis from the portfolio's value the day its quote went missing; written
 *    with the counter standing in for terminality, a line still being rebuilt
 *    was valued at its cost while the dashboard's curve left it hollow.
 *  - **The header's total is the same function the dashboard's is**
 *    (`lib/gain.ts`), minus its fourth term. The fees a broker takes out of a
 *    transfer belong to no security, so a table whose header sums its rows can
 *    never show them — which is the one line ADR-0017's identity had to be
 *    corrected on (ADR-0018) and the one thing this page's bubble has to say.
 *
 * **The sheet's two rules grow this module rather than a second one beside it**
 * (#720, the way `lib/accounts.ts` took the declaration at #729): the
 * per-account breakdown, which **does not exist at one account** because it
 * would then repeat the sheet's own header line for line, and the chart's event
 * markers, where *a day carrying three events is one marker announcing three*
 * and never three points merged in silence.
 */
import {
  absenceCase,
  isQuoted,
  positionRenderings,
  DASH,
  FIGURE,
  type AbsenceCase,
  type PositionAbsenceInput,
  type Rendering,
} from '@/lib/absence'
import { ALLOCATION_SLICES } from '@/lib/alloc'
import type { Converted, Fundamentals, LedgerEvent, Position, Quote, SeriesPoint } from '@/lib/api'
import { type Sum } from '@/lib/gain'
import { byDateDescending } from '@/lib/ledger'

/** One line of the page — one symbol, whatever the number of accounts on it. */
export interface ShareRow extends PositionAbsenceInput {
  symbol: string
  /** Display only. A rename must not split anything (`lib/api.ts`). */
  name: string | null
  quantity: number
  cost_basis: number
  realised: number
  dividends: number
  price: Quote | null
  converted: Converted | null
  /**
   * Who holds it — and, once nobody does, who held it. The folded section keeps
   * a `Compte` column, so a closed row that named no account would carry an
   * empty cell where the reader is looking for *which account did this happen
   * on*.
   */
  accounts: string[]
  /** The day the last account sold out. `null` while it is held. */
  closedAt: string | null
  /**
   * The symbol's, off `/api/positions` and folded like `price` (#845): the fact
   * describes the security, so the first row of the group that carries it is
   * the group's — the rows of one symbol cannot disagree about how far its own
   * backward pass has got.
   */
  terminal: boolean
  consecutiveFailures: number
  /**
   * The instrument's own attributes — read off the first row of the group that
   * carries them, never summed (#720). `null` is *nothing has ever been observed
   * about this symbol*, and the sheet then renders no block at all.
   */
  fundamentals: Fundamentals | null
}

/** Closed is a derivation over `quantity` — there is no stored flag (ADR-0003). */
export function isClosed(row: ShareRow): boolean {
  return row.quantity === 0
}

/**
 * The **arithmetic** classification: the same one every cell reads, with the
 * failure counter deliberately dropped. See the header comment — *asked and got
 * nothing* and *not asked yet* are two renderings and one sum, and the sum is
 * the cost. Folding `noQuote` here rather than leaving it in every switch
 * downstream is what keeps the counter out of the arithmetic in **one** place,
 * and out of the return type: a caller cannot branch on a case it cannot get.
 *
 * `rebuilding` is **not** folded, and that is the whole of #845: it is a third
 * priceless state and the only one whose sum is not the cost.
 */
function arithmeticCase(row: ShareRow): Exclude<AbsenceCase, 'noQuote'> {
  const decided = absenceCase(row)
  return decided === 'noQuote' ? 'carriedAtCost' : decided
}

/**
 * What the position is worth, in the reporting currency.
 *
 * `null` has **two** causes and they are the two transitory absences: the rate
 * has not resolved, or the symbol's history is still being rebuilt (#845). A
 * position with no quote and nothing left to fetch is **carried at its cost**
 * (ADR-0004) rather than valued at zero, and a sold one is worth exactly zero,
 * which is a figure.
 *
 * The second cause is what this function used to answer *the cost* for, on the
 * strength of a failure counter standing in for terminality — so a fresh
 * install, where no symbol is terminal, showed every line valued at its PMP in
 * a table whose own dashboard curve was still hollow.
 */
export function marketValue(row: ShareRow): number | null {
  switch (arithmeticCase(row)) {
    case 'nothingToCompute':
      return 0
    case 'carriedAtCost':
      return row.cost_basis
    case 'awaitingRate':
    case 'rebuilding':
      return null
    case 'quoted':
      return (row.converted?.value ?? 0) * row.quantity
  }
}

/**
 * The latent gain — `market value − cost basis`, and neither dividends nor
 * fees, which are the two other named figures (ADR-0018).
 *
 * `null` on a closed position, where there is nothing to compute, and on one
 * waiting for its rate. Carried at its cost it is exactly **zero**, not a loss:
 * that is what makes the day of a purchase come out neutral.
 */
export function unrealised(row: ShareRow): number | null {
  if (isClosed(row)) return null
  const value = marketValue(row)
  return value === null ? null : value - row.cost_basis
}

/** The second line under the latent gain. Undefined on a nil basis (a grant). */
export function unrealisedRatio(row: ShareRow): number | null {
  const gain = unrealised(row)
  if (gain === null || row.cost_basis === 0) return null
  return gain / row.cost_basis
}

/** The PRU — the word the owner reads at their broker; PMP names the rule. */
export function unitCost(row: ShareRow): number | null {
  if (row.quantity === 0) return null
  return row.cost_basis / row.quantity
}

/**
 * A share the app cannot price and **the app is the answer**, never the market
 * (#684 D6). It is the one exception ADR-0016 allows to *icons never go on a
 * cell*: the text is a repair, not a convention.
 *
 * It is `noQuote` and therefore **terminal** since #845, which narrows the lens
 * rather than widening it: a symbol whose backward pass is still running has
 * been asked for nothing that has not still got time to arrive, and marking it
 * *to repair* is exactly the *not yet* rendered *never* the whole ticket is
 * about. The line is still named on screen — it carries its count in three
 * cells — it is simply not offered as something the reader should act on.
 */
export function isAnomalous(row: ShareRow): boolean {
  return absenceCase(row) === 'noQuote'
}

/**
 * Every account's positions on one symbol, folded into one line.
 *
 * The price rides on the symbol and not on the holding (#700), so the first
 * non-null quote of the group is the group's; the amounts add. `closedAt` takes
 * the **latest** of them: the line is closed when the last account is, and it
 * is that day the section sorts on.
 */
export function buildShareRows(
  positions: readonly Position[],
  failures: ReadonlyMap<string, number>,
): ShareRow[] {
  const rows = new Map<string, ShareRow>()

  for (const position of positions) {
    const existing = rows.get(position.symbol)
    const row: ShareRow = existing ?? {
      symbol: position.symbol,
      name: null,
      quantity: 0,
      cost_basis: 0,
      realised: 0,
      dividends: 0,
      price: null,
      converted: null,
      accounts: [],
      closedAt: null,
      terminal: position.terminal,
      consecutiveFailures: failures.get(position.symbol) ?? 0,
      fundamentals: null,
    }

    row.name = row.name ?? position.name
    row.quantity += position.quantity
    row.cost_basis += position.cost_basis
    row.realised += position.realised
    row.dividends += position.dividends
    row.price = row.price ?? position.price
    row.converted = row.converted ?? position.converted
    // Read, never added: the attributes describe the security, and holding it
    // on two accounts does not double its market capitalisation.
    row.fundamentals = row.fundamentals ?? position.fundamentals
    if (position.closed_at !== null && (row.closedAt === null || position.closed_at > row.closedAt)) {
      row.closedAt = position.closed_at
    }
    rows.set(position.symbol, row)
  }

  // Who holds it, in a second pass: the holders when there are any, everyone
  // who ever named it once there are none.
  for (const row of rows.values()) {
    const named = positions.filter((position) => position.symbol === row.symbol)
    const holders = named.filter((position) => position.quantity !== 0)
    row.accounts = Array.from(new Set((holders.length > 0 ? holders : named).map((p) => p.account)))
  }

  return Array.from(rows.values())
}

// ------------------------------------------------------------------------- //
// The order (#791)
// ------------------------------------------------------------------------- //

/**
 * What the reader may order the live table by — **one name per column**, the
 * nine of them.
 *
 * `weight` is not among them, and it has left twice now: with the `Poids`
 * column after #791, back with it at #832, and out again with #831 when the
 * maquette was read rendered rather than in its source — the weight is
 * answered on that page by the `Répartition` above the table, which is a
 * figure of the whole and orders nothing. A sort key for a column nobody
 * renders is a control the reader cannot reach; the list and the header row
 * are read together or they drift.
 */
export type SortColumn =
  | 'symbol'
  | 'price'
  | 'quantity'
  | 'avgCost'
  | 'value'
  | 'unrealised'
  | 'realised'
  | 'dividends'
  | 'account'

export interface ShareSort {
  column: SortColumn
  direction: 'asc' | 'desc'
}

/**
 * Heaviest first, which is what the page opened on before it could be ordered
 * at all: value is the only ordering a portfolio reads naturally, so it stays
 * what the reader is handed before making a gesture.
 */
export const DEFAULT_SORT: ShareSort = { column: 'value', direction: 'desc' }

/**
 * The direction a column takes when it is **first** pressed.
 *
 * Money descends and a name ascends, because that is the reading each of them
 * is asked for: *which line is the biggest* and *where is the line called Z*.
 * A single rule for both would make one of the two gestures cost two clicks
 * every time.
 */
export function firstDirection(column: SortColumn): ShareSort['direction'] {
  return column === 'symbol' || column === 'account' ? 'asc' : 'desc'
}

/** Pressing the column in force turns it round; pressing another starts it. */
export function nextSort(current: ShareSort, column: SortColumn): ShareSort {
  if (current.column !== column) return { column, direction: firstDirection(column) }
  return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
}

/** The text a column orders on, or the number — whichever the column is. */
function sortKey(row: ShareRow, column: SortColumn): string | number | null {
  switch (column) {
    case 'symbol':
      // What is **written** in the cell, not the ticker under it: a reader
      // ordering by `Titre` is ordering the names they can see.
      return row.name ?? row.symbol
    case 'price':
      // The native quote, and only where there is one to compare: a number in
      // no nameable unit is not a price (#774), so it sorts as an absence.
      return isQuoted(row.price) ? (row.price?.value ?? null) : null
    case 'quantity':
      return row.quantity
    case 'avgCost':
      return unitCost(row)
    case 'value':
      return marketValue(row)
    case 'unrealised':
      return unrealised(row)
    case 'realised':
      return row.realised
    case 'dividends':
      return row.dividends
    case 'account':
      return row.accounts.join(', ')
  }
}

/**
 * The live table in the reader's own order — **and an absence never rises**.
 *
 * A row with nothing to compare goes last in *both* directions, which is the
 * rule the default order already carried for the rate that has not resolved: a
 * line with no value has no rank, and letting the direction float it to the top
 * would put the lines the reader knows least about above the ones they came
 * for. Ties fall back on the symbol, so the order is total and a re-sort never
 * shuffles equal rows.
 */
export function sortRows(rows: readonly ShareRow[], sort: ShareSort): ShareRow[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const left = sortKey(a, sort.column)
    const right = sortKey(b, sort.column)
    if (left === null && right === null) return a.symbol.localeCompare(b.symbol)
    if (left === null) return 1
    if (right === null) return -1
    // One column answers one type — `sortKey` is a closed switch — so the two
    // keys can never be a string and a number.
    const order =
      typeof left === 'string' && typeof right === 'string'
        ? left.localeCompare(right)
        : Number(left) - Number(right)
    return order === 0 ? a.symbol.localeCompare(b.symbol) : order * sign
  })
}

/**
 * The live table, in the order asked for — heaviest first until one is.
 */
export function heldRows(rows: readonly ShareRow[], sort: ShareSort = DEFAULT_SORT): ShareRow[] {
  return sortRows(rows.filter((row) => !isClosed(row)), sort)
}

/**
 * The folded section, **closing date descending**. Market value is zero across
 * the whole section, so a column of zeros orders nothing; this is the one
 * column that discriminates its rows, and the live table does not have it.
 */
export function closedRows(rows: readonly ShareRow[]): ShareRow[] {
  return rows
    .filter(isClosed)
    .sort((a, b) => {
      if (a.closedAt === b.closedAt) return a.symbol.localeCompare(b.symbol)
      if (a.closedAt === null) return 1
      if (b.closedAt === null) return -1
      return a.closedAt < b.closedAt ? 1 : -1
    })
}

// ------------------------------------------------------------------------- //
// The grouping by account (#791)
// ------------------------------------------------------------------------- //

/**
 * One block of the live table: its rows, and the positions its header sums.
 *
 * `account` is `null` when nothing is grouped — the table is then **one** group
 * with no header of its own, which is what keeps the ungrouped and the grouped
 * table one component rather than two renderings of nine columns each.
 */
export interface ShareGroup {
  account: string | null
  /** The rows under the header, already ordered. */
  rows: ShareRow[]
  /**
   * The positions those rows fold, which is what the group header's subtotal is
   * computed from — the page header's own argument, one level down: a header
   * states the sum of the lines it sits above, so it is handed exactly them.
   */
  positions: readonly Position[]
}

/**
 * The live table split by account — **a partition, and never a filter**.
 *
 * That is the whole difficulty and it is the page's own rule met one axis over.
 * A row of this table is a *symbol* across its accounts, so splitting it by
 * account has to put every part of every line somewhere: a symbol still held on
 * one account and sold out on another carries that second account's **realised
 * gain and dividends**, and a group built out of *the accounts that still hold
 * something* would drop that slice — leaving the page header summing a figure
 * no row on screen accounts for, which is the second correct figure ADR-0017
 * exists to prevent, one level down.
 *
 * So the split is over the symbols the table is showing, and an account named
 * by one of them gets a row for it whatever its own quantity is. Summed over
 * the groups, the figures are the ungrouped line's, exactly.
 *
 * The accounts come out in **their id's order**, which is what the `Compte`
 * column already renders: there is no fifth read here to fetch a label with,
 * and an order taken from the weights would be a second ranking on a table the
 * reader has just been given nine of their own.
 */
export function accountGroups(
  positions: readonly Position[],
  failures: ReadonlyMap<string, number>,
  sort: ShareSort = DEFAULT_SORT,
): ShareGroup[] {
  const accounts = Array.from(new Set(positions.map((position) => position.account))).sort((a, b) =>
    a.localeCompare(b),
  )
  return accounts
    .map((account) => {
      const own = positions.filter((position) => position.account === account)
      return {
        account,
        rows: sortRows(buildShareRows(own, failures), sort),
        positions: own,
      }
    })
    .filter((group) => group.rows.length > 0)
}

// ------------------------------------------------------------------------- //
// The allocation (#727, moved here from the dashboard by #831)
// ------------------------------------------------------------------------- //

export interface AllocationSlice {
  /** The security, or `null` on the tail — which names no single line. */
  symbol: string | null
  /** What to write. `null` on the tail: the catalogue names it with its count. */
  label: string | null
  value: number
  /** Of the placed total, `0`…`1`. The legend renders it beside the name. */
  share: number
  /** How many lines this slice folds. `1` everywhere but on the tail. */
  count: number
}

export interface Allocation {
  /** Descending by value, **at most eight**, the tail last if there is one. */
  slices: AllocationSlice[]
  total: number
  /**
   * The held lines that could **not** be placed — quoted, and the rate has not
   * resolved. Named on screen, never summed: summing them would make every other
   * percentage silently wrong, and dropping them in silence is what happened.
   */
  unplaced: string[]
}

/**
 * The whole portfolio in one figure, **seven slices, the fold, and the full
 * width**.
 *
 * It divided the dashboard until #831 and it divides the shares page now: the
 * maquette draws the ring over the table it is the division of, and the block
 * is handed exactly the rows the page header sums, so the figure in the ring's
 * hole and the header's `Valorisation` are one number read twice.
 *
 * **The cap is the drawing's, and it reverses a measurement** (#838). It was
 * twelve, and the reason is on the record: at eight, the tail *Autres (4)* was
 * worth **10,1 %** on the real portfolio, more than four of the named slices
 * put together — a fold that outweighs what it hides. The drawing caps at seven
 * arcs all the same, and it answers that objection rather than ignoring it: the
 * fold **names its own count** (*Autres · 13 lignes*), it carries the ramp's
 * last stop so it reads as a remainder and not as a holding, and every line it
 * hides is in the table directly under it. What twelve bought in fidelity it
 * paid for in the reading — a ring of twelve arcs is not a ranking anybody can
 * see, and its legend is two columns six rows deep beside a 240 px circle.
 *
 * It folds only **past** eight lines: at exactly eight there is nothing to gain
 * by hiding one of them behind a word.
 *
 * A **closed** line is not a slice: it is worth exactly zero and a legend of
 * zeros is noise, so the folded section of the shares page is where it lives. A
 * held line worth zero stays — that is a figure about a line the owner holds.
 * The predicate is `isClosed`, above, and `moversList` calls the same one one
 * module over: the two blocks describe one portfolio, so what is *in* it cannot
 * be two questions — which is why the predicate did not travel with the block.
 */
export function allocation(rows: readonly ShareRow[]): Allocation {
  const placed: AllocationSlice[] = []
  const unplaced: string[] = []

  for (const row of rows) {
    if (isClosed(row)) continue
    const value = marketValue(row)
    if (value === null) {
      unplaced.push(row.symbol)
      continue
    }
    placed.push({
      symbol: row.symbol,
      label: row.name ?? row.symbol,
      value,
      share: 0,
      count: 1,
    })
  }

  placed.sort((left, right) =>
    left.value === right.value
      ? (left.symbol ?? '').localeCompare(right.symbol ?? '')
      : right.value - left.value,
  )

  // **Seven ranked lines and the fold** (#838, the drawing's own cap). The tail
  // is one slice like any other, so it takes the ramp's last stop — the least
  // contrasted rank, which is what a fold of the smallest lines should be. It
  // folds only past `ALLOCATION_SLICES` lines: at exactly eight there is
  // nothing to gain by hiding one of them behind a word.
  let slices = placed
  if (placed.length > ALLOCATION_SLICES) {
    const named = placed.slice(0, ALLOCATION_SLICES - 1)
    const rest = placed.slice(ALLOCATION_SLICES - 1)
    slices = [
      ...named,
      {
        symbol: null,
        label: null,
        value: rest.reduce((sum, slice) => sum + slice.value, 0),
        share: 0,
        count: rest.length,
      },
    ]
  }

  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  return {
    slices: slices.map((slice) => ({
      ...slice,
      share: total === 0 ? 0 : slice.value / total,
    })),
    total,
    unplaced,
  }
}

// ------------------------------------------------------------------------- //
// The weight (#791, #832, and the account's lines since #833)
// ------------------------------------------------------------------------- //

/**
 * The whole a weight divides — **the value of the lines that can be placed**,
 * which is `allocation`'s own rule just above and not a second answer to the
 * same question.
 *
 * These three functions have outlived two renderings of the shares table's
 * `Poids` column — #791 wrote it, took it out, #832 brought it back as a bar,
 * #831 took it out for good on the maquette's rendered evidence — and they are
 * kept because the figure never depended on that column: `AccountDetail`'s held
 * lines state each line's share of the account, and the surface decides its own
 * divisor.
 *
 * A held line whose valuation has no figure — its rate has not resolved, or its
 * history is still being rebuilt (#845) — has no value in the reporting
 * currency. Counting it as nothing would make every other percentage silently
 * wrong; refusing the whole figure for it would put one line's absence on every
 * row, which is the noise ADR-0016 deletes markers for. So it is left out of
 * the whole and **named on its own row**, by the rendering below. The omission
 * covers **any** nullity, which is why the second cause changes nothing here
 * while it changes the two totals: those state a sum of the lines, and this
 * states a divisor.
 */
export function placedValue(rows: readonly ShareRow[]): number {
  let total = 0
  for (const row of rows) {
    const value = marketValue(row)
    if (value !== null) total += value
  }
  return total
}

/** A line's share of that whole, `0`…`1`, or `null` where there is none. */
export function weightShare(row: ShareRow, whole: number): number | null {
  const value = marketValue(row)
  if (value === null || whole <= 0) return null
  return value / whole
}

/**
 * How a weight cell reads — **the rendering of the valuation it divides**.
 *
 * It cannot be decided on its own: the weight is `Valorisation ÷ Valorisation
 * totale`, so whatever empties the first empties this one for the same reason
 * and has the same sentence already written for it (`lib/absence.ts`). Deciding
 * here would be a second classification of one absence, and a second
 * classification of one absence is how the four renderings become five.
 *
 * The one case of its own is a whole of nothing — a set whose every line is
 * worth zero — where there is genuinely nothing to divide, and that is the em
 * dash's own sentence.
 */
export function weightRendering(row: ShareRow, whole: number): Rendering {
  const { valuation } = positionRenderings(row)
  if (valuation.kind !== 'figure') return valuation
  return weightShare(row, whole) === null ? DASH : FIGURE
}

/**
 * The portfolio's market value — a sum, **or the reason there is not one**.
 *
 * It borrows `lib/gain.ts`'s discriminant rather than returning `number | null`
 * for the reason written there: the nullity survives a return and the *case*
 * does not, so a caller holding only the null writes an em dash and says *there
 * is nothing to compute* about a rate the app fetches by itself.
 *
 * **And the reason is read off the line, never assumed** (#845). It was
 * `awaitingRate` written in, which was true while a rate was the only thing
 * that could empty a valuation; a line still being rebuilt empties it too, and
 * on a **fresh install every line is one** — so the header of a portfolio in its
 * first hour announced *en attente du taux de change* and sent its owner to
 * check a currency dial they had already answered.
 *
 * It is **refused and never shortened**: a total that quietly drops a line is a
 * wrong number where a refused one is an honest absence. A *series* omits
 * instead, having to draw the day either way (`CONTEXT.md` § Absence).
 */
export function valuationTotal(rows: readonly ShareRow[]): Sum {
  let total = 0
  for (const row of rows) {
    const value = marketValue(row)
    if (value === null) {
      return { known: false, because: absenceCase(row) === 'rebuilding' ? 'rebuilding' : 'awaitingRate' }
    }
    total += value
  }
  return { known: true, value: total }
}

/**
 * The sheet's per-account breakdown — **and it does not exist at one account**
 * (#720).
 *
 * The empty answer at N = 1 is the rule and not a shortcut: a breakdown of one
 * repeats the sheet's own header line for line, quantity for quantity, and a
 * table whose every column already appears three centimetres above it teaches
 * nothing. It comes back the moment a symbol is held on two accounts — which is
 * the most ordinary case of the domain even though none of the nineteen real
 * symbols shows it, so the rendering is what bends and never the model
 * (`buildShareRows`' own argument, one level down).
 *
 * Each line is a `ShareRow` of one account, so every figure on it is computed by
 * the functions above — the breakdown cannot drift from the line it decomposes.
 */
export function accountBreakdown(
  positions: readonly Position[],
  symbol: string,
  failures: ReadonlyMap<string, number>,
): ShareRow[] {
  const held = positions.filter((position) => position.symbol === symbol)
  const accounts = Array.from(new Set(held.map((position) => position.account)))
  if (accounts.length < 2) return []
  return accounts.map((account) => {
    const [row] = buildShareRows(
      held.filter((position) => position.account === account),
      failures,
    )
    return { ...row, accounts: [account] }
  })
}

/** The events of one security, newest first — what the sheet's list renders. */
export function shareEvents(
  events: readonly LedgerEvent[],
  symbol: string,
): LedgerEvent[] {
  return byDateDescending(events.filter((event) => event.symbol === symbol))
}

/**
 * A day of the ledger, as the chart announces it (#720).
 *
 * **One marker per day, carrying its count**, never one point per event: a
 * single symbol of the real portfolio carries `×2`, `×2`, `×3`, `×3` over four
 * days, so points drawn per event overlap and the reader is shown three
 * purchases as one with nothing saying so. The collision is measured, not
 * hypothetical.
 */
export interface EventMarker {
  /** The calendar day, `YYYY-MM-DD` — it is what the selection is keyed on. */
  day: string
  /** How many events fall on it. Above one it is announced as `×N`. */
  count: number
  /**
   * Where it sits along the visible series: the **rank** of the point it names,
   * `0` at the first and `1` at the last. A fraction rather than a pixel,
   * because the band that draws it is laid out in the chart's own width; and a
   * fraction of the **index** rather than of the elapsed time, because that is
   * the abscissa the chart itself uses — a Recharts category axis gives every
   * point one step whatever the interval before it. Written as a fraction of
   * the span it was a *second* statement of the x-axis, and the two part
   * company exactly where the reader needs them together: on `1M`, whose rung
   * is the raw series, the live scrape writes a point every 120 s in session
   * and the reconstruction one per hour or per day, so the density varies by a
   * factor of ~25 inside one window and a three-week-old event lands under the
   * curve of six days ago.
   */
  offset: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** One drawn point: where it is in time, and **which step of the axis it is**. */
interface Stop {
  index: number
  at: number
}

/**
 * The step nearest a day — zero distance to any point falling inside it.
 *
 * A day holding several points takes the **first** of them: a tie broken the
 * other way would put the marker of a purchase made at the open under the last
 * close of that session. Everything else is a plain distance to the nearer end
 * of the day, so an event on a closed market lands on the session that framed
 * it rather than on an edge of the plot.
 */
function nearestStop(stops: readonly Stop[], start: number): Stop {
  const end = start + DAY_MS
  let best = stops[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const stop of stops) {
    const distance = stop.at < start ? start - stop.at : stop.at < end ? 0 : stop.at - end
    if (distance < bestDistance) {
      bestDistance = distance
      best = stop
    }
  }
  return best
}

/**
 * The markers of one symbol over the points the chart is showing.
 *
 * Three decisions. **The window bounds the markers**, so changing the range
 * genuinely changes what is announced instead of piling every event the ledger
 * holds onto one edge; a day is kept when the *day* intersects the span, not
 * when its midnight does — a series whose first point is an afternoon close
 * would otherwise drop the very purchase that opened it. **A span of one point
 * has no abscissa**, so it carries no marker at all: placing one at a fraction
 * of nothing would be an invented position, which is the one thing a marker
 * must not be. And **a marker names a point of the series**, never an instant
 * of its span — which is what makes the chart and its band one statement of the
 * x-axis rather than two (see `offset` above).
 */
export function eventMarkers(
  events: readonly LedgerEvent[],
  symbol: string,
  points: readonly SeriesPoint[],
): EventMarker[] {
  if (points.length < 2) return []
  const stops: Stop[] = []
  for (const [index, point] of points.entries()) {
    const at = Date.parse(point.t)
    if (Number.isFinite(at)) stops.push({ index, at })
  }
  if (stops.length < 2) return []
  // The span is read off the stops rather than off the first and last rows, so
  // one unparseable timestamp shortens the range instead of voiding it.
  const first = Math.min(...stops.map((stop) => stop.at))
  const last = Math.max(...stops.map((stop) => stop.at))
  if (last <= first) return []
  const steps = points.length - 1

  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.symbol !== symbol || !event.date) continue
    counts.set(event.date, (counts.get(event.date) ?? 0) + 1)
  }

  return Array.from(counts.entries())
    .map(([day, count]) => ({ day, count, start: Date.parse(`${day}T00:00:00Z`) }))
    .filter(({ start }) => Number.isFinite(start) && start + DAY_MS > first && start <= last)
    .sort((left, right) => left.start - right.start)
    .map(({ day, count, start }) => ({
      day,
      count,
      offset: nearestStop(stops, start).index / steps,
    }))
}
