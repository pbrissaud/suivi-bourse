import { describe, expect, it } from 'vitest'

import { exampleQuestions } from '@/lib/analyst'
import { aPosition } from '@/test/factories'

const label = (id: string) => id.toUpperCase()

describe('the questions an empty thread offers', () => {
  it('sells the line worth the most, its unit price times what is held', () => {
    const questions = exampleQuestions(
      [
        // 100 × 20 = 2 000: the larger line, at the lower unit price.
        aPosition({ name: 'Many cheap', account: 'cto', quantity: 100, price: 20 }),
        // 2 × 500 = 1 000.
        aPosition({ name: 'Few dear', account: 'pea', quantity: 2, price: 500 }),
      ],
      label,
    )
    expect(questions[0]).toEqual({
      key: 'analyst.example.sell',
      values: { name: 'Many cheap', account: 'CTO' },
    })
    expect(questions[2]).toEqual({ key: 'analyst.example.account', values: { account: 'PEA' } })
  })

  it('weighs a line with no price at its cost', () => {
    const questions = exampleQuestions(
      [
        aPosition({ name: 'Quoted', quantity: 1, price: 50 }),
        aPosition({ name: 'Unquoted', price: null, cost_basis: 900 }),
      ],
      label,
    )
    expect(questions[0].values?.name).toBe('Unquoted')
  })

  it('asks the general questions when nothing is held', () => {
    expect(exampleQuestions([], label).map((q) => q.key)).toEqual([
      'analyst.example.totals',
      'analyst.example.rhythm',
      'analyst.example.events',
    ])
  })
})
