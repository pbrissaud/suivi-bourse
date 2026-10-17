import { describe, expect, it } from 'vitest'

import { exampleQuestions, turnRefusal } from '@/features/agent/lib/agentChat'
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
      key: 'agent.example.sell',
      values: { name: 'Many cheap', account: 'CTO' },
    })
    expect(questions[2]).toEqual({ key: 'agent.example.account', values: { account: 'PEA' } })
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
      'agent.example.totals',
      'agent.example.rhythm',
      'agent.example.events',
    ])
  })
})

describe('a failed turn that is the provider’s', () => {
  const chunk = (body: unknown) => new Error(JSON.stringify(body))

  it('reads the provider, the reason and the message without its prefix', () => {
    expect(
      turnRefusal(
        chunk({ error: 'Anthropic: invalid x-api-key', provider: 'Anthropic', reason: 'key' }),
      ),
    ).toEqual({ provider: 'Anthropic', reason: 'key', said: 'invalid x-api-key' })
    expect(
      turnRefusal(chunk({ error: 'no prefix', provider: 'Anthropic', reason: 'key' }))?.said,
    ).toBe('no prefix')
  })

  it.each([
    ['plain text', new Error("The agent: 'a bug'")],
    ['an empty object', chunk({})],
    ['a missing reason', chunk({ error: 'x', provider: 'A' })],
    ['a non-string message', chunk({ error: 1, provider: 'A', reason: 'key' })],
    ['null', new Error('null')],
    ['a number', new Error('3')],
  ])('is not one for %s', (_name, error) => {
    expect(turnRefusal(error)).toBeNull()
  })
})
