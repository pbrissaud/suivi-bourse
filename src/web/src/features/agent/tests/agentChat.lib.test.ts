import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  bugReportOf,
  exampleQuestions,
  toolSentence,
  turnRefusal,
} from '@/features/agent/lib/agentChat'
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

describe('the sentence a tool call is shown as', () => {
  it('says the System page read in plain words, and names a tool it does not know', () => {
    expect(toolSentence('get_system_status')).toEqual({ key: 'agent.tool.get_system_status' })
    expect(toolSentence('read_logs')).toEqual({ key: 'agent.tool.read_logs' })
    expect(toolSentence('propose_setting')).toEqual({ key: 'agent.tool.propose_setting' })
    expect(toolSentence('web_search')).toEqual({ key: 'agent.tool.web_search' })
    expect(toolSentence('draft_bug_report')).toEqual({ key: 'agent.tool.draft_bug_report' })
    expect(toolSentence('unheard_of')).toEqual({
      key: 'agent.tool.other',
      values: { name: 'unheard_of' },
    })
  })
})

describe('the bug report a call drafted', () => {
  const QUERY = 'title=Prix%20fig%C3%A9%20%26%20faux&body=Ligne%201%0ALigne%202'
  const URL_OK = `https://github.com/pbrissaud/suivi-bourse/issues/new?${QUERY}`
  const part = (over: object): UIMessage['parts'][number] =>
    ({
      type: 'tool-draft_bug_report',
      toolCallId: 'b1',
      state: 'output-available',
      input: {},
      output: { url: URL_OK, note: 'n' },
      ...over,
    }) as UIMessage['parts'][number]

  it('reads the title and the body out of the link', () => {
    expect(bugReportOf(part({}))).toEqual({
      url: URL_OK,
      title: 'Prix figé & faux',
      body: 'Ligne 1\nLigne 2',
    })
  })

  it.each([
    ['a running call', { state: 'input-available', output: undefined }],
    ['a failed call', { state: 'output-error', output: undefined, errorText: 'x' }],
    ['another tool', { type: 'tool-web_search' }],
    [
      'another host',
      { output: { url: `https://evil.test/pbrissaud/suivi-bourse/issues/new?${QUERY}` } },
    ],
    ['a lookalike host', { output: { url: `https://github.com.evil.test/issues/new?${QUERY}` } }],
    [
      'another repository',
      { output: { url: `https://github.com/pbrissaud/other/issues/new?${QUERY}` } },
    ],
    [
      'another path',
      { output: { url: `https://github.com/pbrissaud/suivi-bourse/issues?${QUERY}` } },
    ],
    ['a script', { output: { url: 'javascript:alert(1)' } }],
    ['a url that is not text', { output: { url: 3 } }],
    ['a text output', { output: URL_OK }],
    ['a null output', { output: null }],
  ])('is none for %s', (_name, over) => {
    expect(bugReportOf(part(over))).toBeNull()
  })
})
