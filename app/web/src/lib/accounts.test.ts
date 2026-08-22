/**
 * The account's arithmetic, pinned (#721, ADR-0019, ADR-0028).
 *
 * The measured counter-example is the reason the rebasing exists: the store
 * answers `alpha 171,5` against `beta 115,0`, and read as they stand those are
 * a figure counted from 2019 beside one counted from 2025. Rebased on a common
 * window the two **swap places between one month and one year**, every figure
 * correct along the way. Those numbers are the test.
 *
 * Since ADR-0028 the surface that reads them is a master-detail, so the rail's
 * two derivations are here too: what an account weighs, and which one the URL
 * opens.
 */
import { describe, expect, it } from 'vitest'

import {
  accountChoice,
  accountEvents,
  accountPositions,
  accountWeights,
  accountWorth,
  buildAccountRows,
  chooseAccount,
  declaredLabel,
  declaredType,
  degradedReason,
  DEFAULT_RANGE,
  firstDay,
  LAST_EVENTS,
  distinctSymbols,
  reassignmentOf,
  rebase,
  RANGES,
  removalOf,
  settledSeries,
  submittedAccount,
  valueSeries,
  windowStart,
} from '@/lib/accounts'
import type { PerfPoint } from '@/lib/api'
import {
  aFileAccount,
  anAccount,
  anAccountHistory,
  anAccountsPayload,
  anAccountWithoutSeries,
  anEvent,
  aPortfolioHistory,
  defaultAccounts,
  ledgerEvents,
  noAccountsDeclared,
  sharesPortfolio,
  unassignedLedger,
  theSeededAccount,
} from '@/test/factories'

const NOW = new Date('2026-03-02T12:00:00.000Z')

function series(account: string): PerfPoint[] {
  return anAccountHistory(account).points
}

const ALL = [series('alpha'), series('beta'), series('gamma')]

/** The scalar the strip and the `perf` column both read, as a percentage. */
function performance(account: string, from: string): number | null {
  const value = rebase(account, series(account), from).performance
  return value === null ? null : Number((value * 100).toFixed(2))
}

describe('the one range control', () => {
  it('offers four presets and never MAX', () => {
    // What fails at `MAX` is not the differing bases — an account entering
    // mid-chart reads perfectly — it is that a time-weighted index has no
    // bounded amplitude, so one account's old spike sets the scale for every
    // other curve on the plot.
    expect([...RANGES]).toEqual(['1M', 'YTD', '1Y', 'SINCE_OPENING'])
    expect(RANGES).not.toContain('MAX')
    expect(DEFAULT_RANGE).toBe('1Y')
  })

  it('stops the longest window at the youngest account’s opening', () => {
    // A `max`, not a `min`: reaching back before an account existed is the
    // unbounded window under another name.
    expect(firstDay(series('alpha'))).toBe('2019-10-30')
    expect(firstDay(series('beta'))).toBe('2025-09-01')
    expect(windowStart('SINCE_OPENING', NOW, ALL)).toBe('2025-09-01')
  })

  it('resolves the three dated presets off the clock alone', () => {
    expect(windowStart('1M', NOW, ALL)).toBe('2026-02-02')
    expect(windowStart('YTD', NOW, ALL)).toBe('2026-01-01')
    expect(windowStart('1Y', NOW, ALL)).toBe('2025-03-02')
  })

  it('keeps a dated preset inside the month it aims at, whatever the day of the month', () => {
    // `Date.UTC(y, m − 1, 31)` on a 28-day February answers the 3rd of March,
    // so `1M` asked for on a 31st would cover 28 days instead of the month, and
    // `1Y` on a 29 February would start on the 1st.
    expect(windowStart('1M', new Date('2026-03-31T12:00:00.000Z'), ALL)).toBe('2026-02-28')
    expect(windowStart('1Y', new Date('2024-02-29T12:00:00.000Z'), ALL)).toBe('2023-02-28')
  })

  it('has nothing to compare when no series carries an index', () => {
    expect(windowStart('SINCE_OPENING', NOW, [series('gamma')])).toBeNull()
  })
})

describe('the rebasing', () => {
  it('starts every curve at 100 on the first day of the window', () => {
    const alpha = rebase('alpha', series('alpha'), '2025-03-02')
    expect(alpha.points[0]).toEqual({ t: '2025-03-02', index: 100 })
    expect(alpha.points[alpha.points.length - 1].index).toBeCloseTo(114.33, 2)
  })

  it('inverts the ranking between one month and one year, both figures correct', () => {
    //   1 an  : beta +15,00 % > alpha +14,33 %
    //   1 mois: alpha +3,94 % > beta  +2,68 %
    expect(performance('alpha', '2025-03-02')).toBeCloseTo(14.33, 2)
    expect(performance('beta', '2025-03-02')).toBeCloseTo(15.0, 2)
    expect(performance('alpha', '2026-02-02')).toBeCloseTo(3.94, 2)
    expect(performance('beta', '2026-02-02')).toBeCloseTo(2.68, 2)
  })

  it('never reads the stored index, which is what it exists to replace', () => {
    // `171,5` read as an index on base 100 is `+71,50 %` — 6,8 years — beside
    // `+15,00 %` over 2,4. Rebased over the window they share, the same account
    // is **down**.
    expect(anAccount().twr_index).toBe(171.5)
    expect(performance('alpha', '2025-09-01')).toBeCloseTo(-4.72, 2)
    expect(performance('beta', '2025-09-01')).toBeCloseTo(15.0, 2)
  })

  it('marks a curve that enters after the window starts, and only that one', () => {
    // An account opened three weeks ago still enters in the middle of a
    // one-year window: the marker says so, and moving the window would not.
    expect(rebase('beta', series('beta'), '2025-03-02').entry).toEqual({
      t: '2025-09-01',
      index: 100,
    })
    expect(rebase('alpha', series('alpha'), '2025-03-02').entry).toBeNull()
  })

  it('draws nothing at all for a series with no index', () => {
    const gamma = rebase('gamma', series('gamma'), '2026-01-01')
    expect(gamma.points).toEqual([])
    expect(gamma.performance).toBeNull()
  })

  it('gives a series of its own the same scalar, whatever level it is of', () => {
    // One shape for the account and for the portfolio, deliberately: the
    // dashboard reads a global scalar off this very function, so two shapes
    // would mean two rebasings and, sooner or later, two answers to *how did
    // this period go*.
    const portfolio = rebase('p', aPortfolioHistory().points, '2025-03-02')
    expect(portfolio.performance! * 100).toBeCloseTo(6.78, 2)
  })
})

describe('the rows, and the weights the rail draws off them', () => {
  const rows = buildAccountRows(defaultAccounts())

  it('keeps the declaration order the resource answered in', () => {
    // Not sorted by value: the rail draws the weights, so the eye already has
    // the ranking, and a list re-ordering itself as figures land would move the
    // entry under the reader's pointer.
    expect(rows.map((row) => row.id)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('reads the cash balance only where a total value exists', () => {
    // Without a cash ledger the balance is `−6 517,26 €` — the replay debits
    // every purchase and nothing ever credits it. Arithmetically defined,
    // semantically false.
    const [gamma] = buildAccountRows([
      anAccount({ id: 'gamma', total_value: null, cash_balance: -6517.26 }),
    ])
    expect(gamma.cash_balance).toBeNull()
  })

  it('weighs an account on its securities where no cash ledger was ever kept', () => {
    // `gamma` holds 600,00 € of shares and has no `total_value` at all (#708).
    // Read as `total_value` and nothing else it would weigh zero — and the
    // failure would be silent, the bar still adding up to a hundred per cent.
    expect(accountWorth(rows[2])).toBe(600)
    const weights = accountWeights(rows)
    expect(weights.get('alpha')).toBeCloseTo(1800 / 3300, 6)
    expect(weights.get('gamma')).toBeCloseTo(600 / 3300, 6)
    expect([...weights.values()].reduce<number>((sum, share) => sum + (share ?? 0), 0)).toBeCloseTo(1, 6)
  })

  it('has no share to state for an account nothing has been written about', () => {
    const [empty] = buildAccountRows([anAccountWithoutSeries({ id: 'delta' })])
    expect(accountWorth(empty)).toBeNull()
    expect(accountWeights([...rows, empty]).get('delta')).toBeNull()
  })

  it('divides nothing by nothing nowhere', () => {
    // An install whose accounts are all worth zero has no shares to state, and
    // `0 / 0` renders as `NaN %`.
    const flat = buildAccountRows([anAccount({ total_value: 0, holdings_value: 0 })])
    expect(accountWeights(flat).get('alpha')).toBeNull()
  })

  it('waits for the N series together where a comparison is the object (#775)', () => {
    // The dashboard's accounts card is that surface now: an account landing
    // after the others moves `windowStart`, so every curve is rebased on another
    // day and the whole card is redrawn under the reader's eyes.
    const landed = anAccountHistory('alpha').points
    expect(settledSeries([landed, null])).toBeNull()
    expect(settledSeries([landed, []])).toEqual([landed, []])
    // No account at all is not *in flight*: it is a declaration with nothing
    // in it, and the page's own empty state owns that one.
    expect(settledSeries([])).toEqual([])
  })
})

describe('which account the detail is about', () => {
  const rows = buildAccountRows(defaultAccounts())

  it('opens the one the URL names', () => {
    expect(chooseAccount(rows, 'beta')?.id).toBe('beta')
  })

  it('falls back to the first declared one rather than to an empty page', () => {
    // An id naming nothing is what a bookmark becomes when an account is
    // renamed away or an import is revoked: answering it with an empty detail
    // beside a full rail reads as a broken page, not as a stale link.
    expect(chooseAccount(rows, undefined)?.id).toBe('alpha')
    expect(chooseAccount(rows, 'gone')?.id).toBe('alpha')
  })

  it('has nothing to open where nothing is declared', () => {
    expect(chooseAccount([], 'alpha')).toBeNull()
  })
})

describe('a row with no figures names its reason', () => {
  it('tells one absent figure from every absent figure, which look alike', () => {
    const [withoutLedger] = buildAccountRows([defaultAccounts()[2]])
    const [withoutSeries] = buildAccountRows([anAccountWithoutSeries({ id: 'delta' })])

    expect(degradedReason(withoutLedger, true)).toBe('withoutCashLedger')
    expect(degradedReason(withoutSeries, true)).toBe('rebuilding')
  })

  it('does not announce a rebuild to an account with nothing to rebuild', () => {
    // A positive observation is what the second sentence needs: the
    // reconstruction being over, an account with no series has nothing coming.
    // A runtime read that has not landed keeps the rebuild's sentence.
    const [empty] = buildAccountRows([anAccountWithoutSeries({ id: 'delta' })])
    expect(degradedReason(empty, false)).toBe('empty')
    expect(degradedReason(empty, null)).toBe('rebuilding')
  })

  it('says nothing about a row whose figures are all there', () => {
    const [alpha] = buildAccountRows([anAccount()])
    expect(degradedReason(alpha, true)).toBeNull()
  })
})

// ------------------------------------------------------------------------- //
// The detail (#722, ADR-0028)
// ------------------------------------------------------------------------- //

describe('what one account’s detail is about', () => {
  it('keeps its closed lines in the set the four terms are summed over', () => {
    // A sold position has a realised gain and dividends, and dropping it here
    // produces the *other correct figure* — the one the shares page spent a
    // session refusing to show as the owner's gain (ADR-0017).
    const held = accountPositions(sharesPortfolio(), 'alpha')
    expect(held.map((one) => one.symbol)).toEqual(['ZZA', 'ZZD'])
    expect(held.some((one) => one.quantity === 0)).toBe(true)
  })

  it('counts symbols, because a row of the page it links to is a symbol', () => {
    // The link announces the count it is about to lead to, so the two have to
    // be counting the same thing — and `lib/shares.ts` folds `(account,
    // symbol)` into one line.
    expect(distinctSymbols(accountPositions(sharesPortfolio(), 'alpha'))).toBe(2)
    expect(distinctSymbols(accountPositions(sharesPortfolio(), 'gamma'))).toBe(1)
    expect(distinctSymbols(accountPositions(sharesPortfolio(), 'delta'))).toBe(0)
  })

  it('reads the curve off the whole series, not off the visible window', () => {
    // The range control drives the *comparison*; an account's own history is
    // not one, and ADR-0019 says this surface is where it lives whole.
    const points = valueSeries(series('alpha'))
    expect(points).toHaveLength(series('alpha').length)
    expect(points[0].t).toBe('2019-10-30')
    expect(points[0].value).toBe(1800)
    expect(points[0].contributed).toBe(1380)
  })

  it('draws nothing where an account has no value to draw against', () => {
    // #708 writes `total_value` and `net_contributed` together or not at all,
    // and a line along the floor would say the owner put nothing in.
    expect(valueSeries(series('gamma'))).toEqual([])
  })

  it('shows the account’s own last events, newest first and capped', () => {
    const events = accountEvents(ledgerEvents(), 'alpha')
    expect(events.map((event) => event.date)).toEqual([
      '2026-02-10',
      '2026-01-12',
      '2026-01-05',
      '2025-12-24',
    ])
    expect(accountEvents(ledgerEvents(), 'beta')).toEqual([])
    expect(accountEvents(ledgerEvents(), 'alpha', 2)).toHaveLength(2)
    expect(LAST_EVENTS).toBeGreaterThan(0)
  })

  it('reads a blank account as the seeded row, which is the aggregator’s rule', () => {
    // An install that recorded events before declaring anything writes them
    // under a row nobody named (ADR-0013) — the population #725 exists for, and
    // the one a strict `event.account === id` would show as an empty detail.
    expect(accountEvents(unassignedLedger(), 'default')).toHaveLength(3)
    expect(accountEvents([anEvent({ account: '  ' })], 'default')).toHaveLength(1)
  })
})

// ------------------------------------------------------------------------- //
// The declaration (#729)
// ------------------------------------------------------------------------- //

describe('the name one account wears, on both pages', () => {
  it('reads the catalogue while the seeded row still wears the seed', () => {
    // `null` is *read the catalogue*, and it is the only thing that keeps the
    // declaration table and the accounts page from naming one row two ways:
    // both call this function, so the rule cannot be written twice.
    expect(declaredLabel(theSeededAccount())).toBeNull()
    expect(declaredType(theSeededAccount())).toBeNull()
    expect(declaredLabel(theSeededAccount({ label: '  ' }))).toBeNull()
  })

  it('hands the row back the moment its owner names it', () => {
    // The whole point of the block: a rename rendered nowhere is not a rename.
    expect(declaredLabel(theSeededAccount({ label: 'Mon PEA' }))).toBe('Mon PEA')
    expect(declaredType(theSeededAccount({ type: 'PEA' }))).toBe('PEA')
  })

  it('never sends any other account to the catalogue, and falls back to the id', () => {
    expect(declaredLabel(anAccount({ id: 'pea', label: 'Default account' }))).toBe('Default account')
    expect(declaredLabel(anAccount({ id: 'pea', label: null }))).toBe('pea')
    expect(declaredType(anAccount({ id: 'pea', type: null }))).toBeNull()
  })
})

describe('a removal that cannot happen names its reason', () => {
  it('follows `accounts.delete_account`’s own order', () => {
    // Not alphabetical: the seeded row first, then the events naming it, then
    // the file that declared it. The middle one before the last on purpose —
    // both apply to a file-provisioned account an event names, and only one of
    // them is actionable, forgetting the import being refused in cascade.
    expect(removalOf(theSeededAccount(), 0)).toEqual({ kind: 'seeded' })
    expect(removalOf(aFileAccount({ id: 'beta' }), 71)).toEqual({
      kind: 'namedByEvents',
      count: 71,
    })
    expect(removalOf(aFileAccount({ id: 'beta' }), 0)).toEqual({ kind: 'fromFile' })
    expect(removalOf(anAccount({ id: 'gamma' }), 0)).toEqual({ kind: 'offered' })
  })
})

describe('what the create form may offer as an account (#764’s deferral)', () => {
  it('tells the three absences apart, because they are three repairs', () => {
    expect(accountChoice(undefined, false)).toEqual({ kind: 'pending' })
    expect(accountChoice(undefined, true)).toEqual({ kind: 'failed' })
    expect(accountChoice(noAccountsDeclared(), false)).toEqual({
      kind: 'unassigned',
      account: theSeededAccount(),
    })
  })

  it('does not ask a question whose answer is already known', () => {
    const one = anAccountsPayload([anAccount({ id: 'alpha' })])
    expect(accountChoice(one, false).kind).toBe('single')
    expect(accountChoice(anAccountsPayload(), false).kind).toBe('choose')
  })

  it('sends the blank as a blank, so the two roads keep one rule', () => {
    // Resolving `default` here would be a second spelling of #698's rule, on the
    // one road that could then disagree with the file's — and the server refuses
    // an empty account once something *is* declared, which this state is not.
    expect(submittedAccount(accountChoice(noAccountsDeclared(), false), '')).toEqual({
      account: '',
    })
    expect(
      submittedAccount(accountChoice(anAccountsPayload([anAccount({ id: 'alpha' })]), false), ''),
    ).toEqual({ account: 'alpha' })
    expect(submittedAccount(accountChoice(anAccountsPayload(), false), 'beta')).toEqual({
      account: 'beta',
    })
  })

  it('never blames the reader for a list that is not there', () => {
    // *This kind of event needs this field* over an empty control sends them
    // looking for something to type where there is nothing to choose.
    expect(submittedAccount({ kind: 'pending' }, '')).toEqual({
      error: 'data.form.account.pending',
    })
    expect(submittedAccount({ kind: 'failed' }, '')).toEqual({
      error: 'data.form.account.failed',
    })
    // And it does ask, where the question is real and unanswered.
    expect(submittedAccount(accountChoice(anAccountsPayload(), false), ' ')).toEqual({
      error: 'data.form.required',
    })
  })
})

describe('réaffecter, jamais refuser (#725)', () => {
  it('rides inside the first declaration, where there is no target to name', () => {
    // Nothing declared: the gesture has no list to choose from, so it is the
    // declaration itself that carries it — one request, one gesture.
    expect(reassignmentOf(noAccountsDeclared(), unassignedLedger())).toEqual({
      kind: 'firstDeclaration',
      count: 3,
    })
  })

  it('stands on its own once something is declared, which a file can do', () => {
    // The state reachable with **no gesture in this app at all**: an accounts
    // file declares as much as the form does, and the event file beside it is
    // refused for the blank column it was right to carry.
    const declared = anAccountsPayload(
      [theSeededAccount(), anAccount({ id: 'pea', label: 'PEA' })],
      true,
    )
    const offer = reassignmentOf(declared, unassignedLedger())

    expect(offer.kind).toBe('standing')
    expect(offer.kind === 'standing' && offer.count).toBe(3)
    // The seeded row is in the payload — an event names it — and is the one
    // account that cannot be a target: it is what those events already say.
    expect(offer.kind === 'standing' && offer.targets.map((row) => row.id)).toEqual(['pea'])
  })

  it('is absent on the real portfolio, whose events all name an account', () => {
    // The criterion the other way round: `ledgerEvents()` is the fixture drawn
    // from the real one, and there is no `default` anywhere in it — so nothing
    // is offered, and the constraint is unobservable there.
    expect(reassignmentOf(anAccountsPayload(), ledgerEvents())).toEqual({ kind: 'none' })
  })

  it('leaves alone the row its owner has named', () => {
    // The N = 1 gesture #729 built the declaration block for: renaming the
    // seeded row is how an install with a page and no file declares its one
    // account. Its events then name the account their owner named, and offering
    // to move them off it — pre-ticked, on a second declaration — would take a
    // whole ledger off the one line they had put a name on.
    const named = anAccountsPayload([theSeededAccount({ label: 'Mon PEA' })], false)
    expect(reassignmentOf(named, unassignedLedger())).toEqual({ kind: 'none' })

    // The other seeded column says as much, and a file that took the row over
    // says it a third way (#698).
    const retyped = anAccountsPayload([theSeededAccount({ type: 'PEA' })], false)
    expect(reassignmentOf(retyped, unassignedLedger())).toEqual({ kind: 'none' })
    const taken = anAccountsPayload(
      [theSeededAccount({ source_id: 2, editable: false }), anAccount({ id: 'pea' })],
      true,
    )
    expect(reassignmentOf(taken, unassignedLedger())).toEqual({ kind: 'none' })
  })

  it('claims nothing while the read has not landed', () => {
    expect(reassignmentOf(undefined, unassignedLedger())).toEqual({ kind: 'none' })
  })

  it('offers nothing once the window is spent', () => {
    const declared = anAccountsPayload([anAccount({ id: 'pea', label: 'PEA' })], true)
    const reassigned = unassignedLedger().map((event) => ({ ...event, account: 'pea' }))

    expect(reassignmentOf(declared, reassigned)).toEqual({ kind: 'none' })
  })
})
