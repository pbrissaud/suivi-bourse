/**
 * A refusal says the server's reason (#1377) and names the field it refused
 * (#1395); and the sentences around an import and a share read in the singular
 * where there is one (#1387, #1396, #1397).
 */
import { describe, expect, it } from 'vitest'

import { ApiProblem } from '@/lib/api'
import { formatMessage } from '@/lib/i18n'
import { PROBLEM_TYPES, problemMessage, refusedKey } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'

const refused = (members: Record<string, unknown>) =>
  new ApiProblem({ status: 422, type: PROBLEM_TYPES.invalidFile, ...members })

describe('a refused file (#1377)', () => {
  it('says the reason the server gave, with the file it names', () => {
    const said = problemMessage(
      refused({ detail: 'Missing required columns: event_type', file: 'a.csv' }),
    )
    expect(said).toEqual({
      message: 'problem.invalidFile.named.reason',
      values: { file: 'a.csv', reason: 'Missing required columns: event_type' },
    })
    expect(formatMessage('fr', said.message, said.values)).toContain(
      '« Missing required columns: event_type »',
    )
  })

  it('says the reason without a file, and the advice without a reason', () => {
    expect(problemMessage(refused({ detail: 'row 2: Invalid date format' })).message).toBe(
      'problem.invalidFile.reason',
    )
    expect(problemMessage(refused({ file: 'a.csv' })).message).toBe('problem.invalidFile.named')
    expect(problemMessage(refused({})).message).toBe('problem.invalidFile')
  })
})

describe('the field a request refusal names (#1395)', () => {
  it('is the key of a bad request, and nothing else', () => {
    const bad = (type: string) =>
      new ApiProblem({ status: 422, type, key: 'quantity', detail: 'quantity must be positive' })
    expect(refusedKey(bad(PROBLEM_TYPES.badRequest))).toBe('quantity')
    expect(refusedKey(bad(PROBLEM_TYPES.invalidSetting))).toBeNull()
    expect(refusedKey(new ApiProblem({ status: 422, type: PROBLEM_TYPES.badRequest }))).toBeNull()
    expect(refusedKey(new Error('offline'))).toBeNull()
  })
})

describe('the plurals that carried their article outside (#1387, #1396)', () => {
  it('says where one event goes, and where two go', () => {
    expect(formatMessage('fr', 'data.import.blocked.one', { count: 1 })).toContain(
      'dites où va l’événement de ce compte',
    )
    expect(formatMessage('fr', 'data.import.blocked.one', { count: 2 })).toContain(
      'dites où vont les 2 événements de ce compte',
    )
    expect(formatMessage('en', 'data.import.blocked.one', { count: 1 })).toContain(
      "say where this account's event goes",
    )
    expect(formatMessage('en', 'data.import.blocked.one', { count: 2 })).toContain(
      "say where this account's 2 events go",
    )
  })

  it('agrees a share count with its number, fractions in French included', () => {
    const shares = (lang: 'fr' | 'en', count: number, quantity: string) =>
      formatMessage(lang, 'shares.events.quantity', { count, quantity })
    expect(shares('fr', 1, '1')).toBe('1 titre')
    expect(shares('fr', 1.5, '1,5')).toBe('1,5 titre')
    expect(shares('fr', 2, '2')).toBe('2 titres')
    expect(shares('en', 1, '1')).toBe('1 share')
    expect(shares('en', 2, '2')).toBe('2 shares')
  })
})

describe('an import with nothing new, or one day (#1397)', () => {
  const forecast = {
    kind: 'import.forecast' as const,
    count: 0,
    duplicates: 3,
    from: '1 avr. 2025',
    to: '1 oct. 2025',
    accounts: 2,
    symbols: 3,
  }

  it('says nothing is new rather than promising a period', () => {
    const said = receiptMessage(forecast)
    expect(said).toEqual({ message: 'receipt.import.nothingNew', values: { count: 3 } })
    expect(formatMessage('fr', said.message, said.values)).toBe(
      'Rien de nouveau : les 3 lignes de ce fichier sont déjà dans votre grand livre.',
    )
    expect(receiptMessage({ ...forecast, kind: 'import.written' }).message).toBe(
      'receipt.import.nothingNew.written',
    )
  })

  it('reads a one-day file as that day, not as a range', () => {
    const said = receiptMessage({ ...forecast, count: 2, from: '1 août 2025', to: '1 août 2025' })
    expect(formatMessage('fr', said.message, said.values)).toContain(
      '2 événements seront écrits, le 1 août 2025,',
    )
    const range = receiptMessage({ ...forecast, count: 2 })
    expect(formatMessage('fr', range.message, range.values)).toContain(
      'du 1 avr. 2025 au 1 oct. 2025',
    )
  })
})
