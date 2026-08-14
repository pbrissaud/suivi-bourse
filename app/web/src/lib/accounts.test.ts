/**
 * The comparison's arithmetic, pinned (#721, ADR-0019).
 *
 * The measured counter-example is the reason the rebasing exists: the store
 * answers `alpha 171,5` against `beta 115,0`, and read as they stand those are
 * a figure counted from 2019 beside one counted from 2025. Rebased on a common
 * window the two **swap places between one month and one year**, every figure
 * correct along the way. Those numbers are the test.
 */
import { describe, expect, it } from 'vitest'

import {
  accountChoice,
  accountPositions,
  buildAccountRows,
  declarationRows,
  declaredLabel,
  declaredType,
  degradedReason,
  DEFAULT_RANGE,
  DIMMED_OPACITY,
  firstDay,
  originOf,
  portfolioRow,
  positionCount,
  rebase,
  RANGES,
  removalOf,
  seriesColour,
  sortRows,
  submittedAccount,
  valueSeries,
  visibleColumns,
  windowStart,
  type AccountRow,
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

  it('gives the portfolio a scalar of its own, read from its own series', () => {
    // It is never drawn — its curve is the dashboard's — so this figure lives
    // in the table's `Portefeuille` row and nowhere else.
    const portfolio = rebase('p', aPortfolioHistory().points, '2025-03-02')
    expect(portfolio.performance! * 100).toBeCloseTo(6.78, 2)
  })
})

describe('the drawing’s two constants', () => {
  it('keeps an unselected curve well above the opacity where it becomes a filter', () => {
    expect(DIMMED_OPACITY).toBeGreaterThan(0.16)
  })

  it('gives each curve a hue of its own — identity, never rank', () => {
    expect(seriesColour(0)).not.toBe(seriesColour(1))
    expect(seriesColour(0)).toBe(seriesColour(6))
  })
})

describe('the table', () => {
  const rows = buildAccountRows(defaultAccounts(), new Map([['alpha', 0.1433]]))

  it('keeps the declaration order, whatever the window does', () => {
    // Sorting by `perf` would make the ranking a property of the range control,
    // and the rows would jump on every click of a preset.
    expect(sortRows(rows, null).map((row) => row.id)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('sorts on a header, absences last in both directions', () => {
    expect(sortRows(rows, { column: 'total_value', direction: 'desc' }).map((r) => r.id)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ])
    expect(sortRows(rows, { column: 'total_value', direction: 'asc' }).map((r) => r.id)).toEqual([
      'beta',
      'alpha',
      'gamma',
    ])
  })

  it('reads the cash balance only where a total value exists', () => {
    // Without a cash ledger the balance is `−6 517,26 €` — the replay debits
    // every purchase and nothing ever credits it. Arithmetically defined,
    // semantically false: five dashes, not four.
    const gamma = buildAccountRows(
      [anAccount({ id: 'gamma', total_value: null, cash_balance: -6517.26 })],
      new Map(),
    )[0]
    expect(gamma.cash_balance).toBeNull()
  })

  it('drops a column absent for every account, and keeps it for one out of three', () => {
    expect(visibleColumns(rows)).toContain('cash_balance')

    const noCash = defaultAccounts().map((account) => ({
      ...account,
      total_value: null,
      cash_balance: null,
      net_contributed: null,
      xirr: null,
    }))
    const dropped = visibleColumns(buildAccountRows(noCash, new Map()))
    expect(dropped).not.toContain('cash_balance')
    expect(dropped).not.toContain('total_value')
    expect(dropped).toContain('holdings_value')
  })

  it('reads the portfolio row rather than summing the accounts', () => {
    // The accounts cannot be summed at all here: `gamma` has no cash ledger, so
    // `total_value` is not a number on that line (#708). The consolidated
    // figures have exactly one source.
    const portfolio = portfolioRow(
      { day: '2026-03-02', total_value: 2800, xirr: 0.0322 } as never,
      0.0678,
    )
    expect(portfolio.total_value).toBe(2800)
    expect(rows.reduce((sum, row) => sum + (row.total_value ?? 0), 0)).not.toBe(2800)
  })
})

describe('a row with no figures names its reason', () => {
  const visible = visibleColumns(buildAccountRows(defaultAccounts(), new Map()))

  function reasonOf(row: AccountRow, rebuilding: boolean | null) {
    return degradedReason(row, visible, rebuilding)
  }

  it('tells five dashes from eight, which are indistinguishable without it', () => {
    const [withoutLedger] = buildAccountRows(
      [defaultAccounts()[2]],
      new Map(),
    )
    const [withoutSeries] = buildAccountRows([anAccountWithoutSeries({ id: 'delta' })], new Map())

    expect(reasonOf(withoutLedger, true)).toBe('withoutCashLedger')
    expect(reasonOf(withoutSeries, true)).toBe('rebuilding')
    expect(reasonOf(withoutLedger, true)).not.toBe(reasonOf(withoutSeries, true))
  })

  it('does not announce a rebuild to an account with nothing to rebuild', () => {
    // A positive observation is what the second sentence needs: the
    // reconstruction being over, an account with no series has nothing coming.
    // A runtime read that has not landed keeps the rebuild's sentence.
    const [empty] = buildAccountRows([anAccountWithoutSeries({ id: 'delta' })], new Map())
    expect(reasonOf(empty, false)).toBe('empty')
    expect(reasonOf(empty, null)).toBe('rebuilding')
  })

  it('says nothing about a row whose figures are all on screen', () => {
    const [alpha] = buildAccountRows([anAccount()], new Map([['alpha', 0.1433]]))
    expect(reasonOf(alpha, true)).toBeNull()
  })

  it('says nothing about a column the page has dropped', () => {
    // A dropped column is not an absence the reader can see, so it is not one
    // to explain — which is what keeps the dashes a **difference between the
    // accounts** rather than a property of the installation.
    const rows = buildAccountRows(
      [anAccount({ id: 'one', total_value: null, cash_balance: null, net_contributed: null, xirr: null })],
      new Map([['one', 0.1]]),
    )
    expect(degradedReason(rows[0], visibleColumns(rows), true)).toBeNull()
  })
})

// ------------------------------------------------------------------------- //
// The account's own panel (#722)
// ------------------------------------------------------------------------- //

describe('what one account’s panel is about', () => {
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
    expect(positionCount(sharesPortfolio(), 'alpha')).toBe(2)
    expect(positionCount(sharesPortfolio(), 'gamma')).toBe(1)
    expect(positionCount(sharesPortfolio(), 'delta')).toBe(0)
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

describe('where a declaration comes from — three answers, not two', () => {
  it('does not credit the owner with the row nobody declared', () => {
    // Read as `source_id === null` the column said *declared in the app* about
    // the seeded row, on the first-run screen where it is the only row there is.
    expect(originOf(theSeededAccount())).toBe('seed')
    expect(originOf(anAccount())).toBe('app')
    expect(originOf(aFileAccount())).toBe('file')
  })

  it('counts a relabelled seed as the owner’s own, and a file’s take-over as a file’s', () => {
    expect(originOf(theSeededAccount({ label: 'Mon PEA' }))).toBe('app')
    expect(originOf(theSeededAccount({ source_id: 2, editable: false }))).toBe('file')
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

describe('the row set is what the resource served', () => {
  it('joins the ledger’s counts to those rows and synthesises none', () => {
    const rows = declarationRows(anAccountsPayload(), ledgerEvents())

    expect(rows.map((row) => row.account.id)).toEqual(['alpha', 'beta', 'gamma'])
    // The four fixture events all name `alpha`; nothing invents a fourth row for
    // an account the resource did not serve.
    expect(rows.map((row) => row.events)).toEqual([4, 0, 0])
  })

  it('counts an event with a blank account against the seeded row', () => {
    // #698's rule, read from the ledger's side: a blank account means `default`
    // until something is declared, so the count has to resolve it the same way.
    const rows = declarationRows(noAccountsDeclared(), [
      anEvent({ account: '' }),
      anEvent({ account: 'default', date: '2026-01-12' }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].events).toBe(2)
  })

  it('answers nothing while the read has not landed — never an empty declaration', () => {
    // `/api/accounts` never serves an empty list (ADR-0013), so *no row* has
    // exactly one meaning left and the block renders nothing on it.
    expect(declarationRows(undefined, ledgerEvents())).toEqual([])
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
