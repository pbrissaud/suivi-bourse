import { describe, expect, it } from 'vitest'

import { BLOCK_IDS, DASHBOARD_BLOCKS, type BlockSpec } from '@/lib/dashboardBlocks'
import {
  defaultLayout,
  moveBlock,
  mustWrite,
  newBlocks,
  normalizeLayout,
  positionOf,
  resolveLayout,
  sameLayout,
  toStored,
  withHidden,
  withWidth,
  type Placement,
  type RenderState,
} from '@/lib/dashboardLayout'

/**
 * A registry with a card that has not shipped yet, so the arrival rules (D7,
 * 18A) and the full/half mix can be exercised beyond the three cards of today.
 */
const REGISTRY = {
  a: { label: 'dashboard.breakdown.title', widths: ['half'], width: 'half', minHeight: 1 },
  b: { label: 'dashboard.rhythm.title', widths: ['half'], width: 'half', minHeight: 1 },
  m: { label: 'dashboard.movers.title', widths: ['half', 'full'], width: 'full', minHeight: 1 },
  n: {
    label: 'dashboard.movers.title',
    widths: ['half', 'full'],
    width: 'half',
    minHeight: 1,
    arrivesHidden: true,
  },
} satisfies Record<string, BlockSpec>
type Id = keyof typeof REGISTRY

const all = (state: RenderState) =>
  ({ a: state, b: state, m: state, n: state }) as Record<Id, RenderState>
const ids = (placements: readonly Placement<string>[] | null) =>
  placements === null ? null : placements.map((one) => one.id).join(',')
const p = (id: Id, width: 'half' | 'full', hidden = false): Placement<Id> => ({ id, width, hidden })

describe('the registry', () => {
  it('lays the gain and the rhythm side by side, then the movers across the full width', () => {
    expect(defaultLayout()).toEqual([
      { id: 'gain-breakdown', width: 'half', hidden: false },
      { id: 'rhythm', width: 'half', hidden: false },
      { id: 'movers', width: 'full', hidden: false },
    ])
  })

  it('gives every card its own default among the widths it accepts', () => {
    for (const id of BLOCK_IDS) {
      const spec: BlockSpec = DASHBOARD_BLOCKS[id]
      expect(spec.widths).toContain(spec.width)
    }
  })
})

describe('normalizeLayout', () => {
  it.each([
    ['nothing saved', null],
    ['not an object', 'layout'],
    ['a later version', { version: 2, blocks: [] }],
    ['no blocks', { version: 1 }],
  ])('reads %s as the default', (_, saved) => {
    expect(normalizeLayout(saved, REGISTRY)).toEqual(defaultLayout(REGISTRY))
  })

  it('keeps the saved order, drops an unknown id and a duplicate, and appends the rest', () => {
    const saved = {
      version: 1,
      blocks: [
        { id: 'm', width: 'half', hidden: false },
        { id: 'gone', width: 'full', hidden: false },
        { id: 'b', width: 'half', hidden: true },
        { id: 'm', width: 'full', hidden: false },
        'junk',
      ],
    }

    expect(normalizeLayout(saved, REGISTRY)).toEqual([
      p('m', 'half'),
      p('b', 'half', true),
      p('a', 'half'),
      p('n', 'half', true),
    ])
  })

  it('brings a width the card refuses back to its default', () => {
    const saved = { version: 1, blocks: [{ id: 'a', width: 'full', hidden: false }] }

    expect(normalizeLayout(saved, REGISTRY)[0]).toEqual(p('a', 'half'))
  })

  it('lands a card that arrived later hidden, and keeps the first three visible', () => {
    const saved = toStored([p('a', 'half'), p('b', 'half'), p('m', 'full')] as never)

    expect(normalizeLayout(saved, REGISTRY).at(-1)).toEqual(p('n', 'half', true))
  })
})

describe('newBlocks', () => {
  it('names a later card until a saved layout holds it, visible or not', () => {
    expect(newBlocks(null, REGISTRY)).toEqual(['n'])
    expect(newBlocks({ version: 1, blocks: [{ id: 'a' }] }, REGISTRY)).toEqual(['n'])
    expect(newBlocks({ version: 1, blocks: [{ id: 'n', hidden: true }] }, REGISTRY)).toEqual([])
  })

  it('names nothing in the shipped registry, where no card arrived later yet', () => {
    expect(newBlocks(null)).toEqual([])
  })
})

describe('resolveLayout', () => {
  const layout = [p('a', 'half'), p('b', 'half'), p('m', 'full')]

  it('pairs two halves on one row and gives a full card the row', () => {
    expect(resolveLayout(layout, all('renders'), 'read', 2, REGISTRY)).toEqual([
      { kind: 'block', id: 'a', span: 1, width: 'half', orphan: false },
      { kind: 'block', id: 'b', span: 1, width: 'half', orphan: false },
      { kind: 'block', id: 'm', span: 2, width: 'full', orphan: false },
    ])
  })

  it('leaves the other half free beside a half-only card alone on its row', () => {
    const cells = resolveLayout(
      [p('a', 'half'), p('m', 'full'), p('b', 'half')],
      all('renders'),
      'read',
      2,
      REGISTRY,
    )

    expect(cells).toEqual([
      { kind: 'block', id: 'a', span: 1, width: 'half', orphan: false },
      { kind: 'free' },
      { kind: 'block', id: 'm', span: 2, width: 'full', orphan: false },
      { kind: 'block', id: 'b', span: 1, width: 'half', orphan: false },
      { kind: 'free' },
    ])
  })

  it('draws a lone half full when the card accepts the full width, and says so', () => {
    const cells = resolveLayout(
      [p('m', 'half'), p('a', 'half', true)],
      all('renders'),
      'read',
      2,
      REGISTRY,
    )

    expect(cells).toEqual([{ kind: 'block', id: 'm', span: 2, width: 'full', orphan: true }])
  })

  it('takes a card with nothing to say out in reading mode, and keeps its cell in edit mode', () => {
    const states = { ...all('renders'), b: 'nothing' } as Record<Id, RenderState>

    expect(
      resolveLayout(layout, states, 'read', 2, REGISTRY).map(
        (cell) => cell.kind === 'block' && cell.id,
      ),
    ).toEqual(['a', false, 'm'])
    expect(resolveLayout(layout, states, 'edit', 2, REGISTRY)).toEqual(
      resolveLayout(layout, all('renders'), 'edit', 2, REGISTRY),
    )
  })

  it('holds the place of a card whose read is in flight (D4)', () => {
    expect(resolveLayout(layout, all('pending'), 'read', 2, REGISTRY)).toEqual(
      resolveLayout(layout, all('renders'), 'read', 2, REGISTRY),
    )
  })

  it('leaves hidden cards out', () => {
    const cells = resolveLayout(
      [p('a', 'half', true), p('b', 'half'), p('m', 'full')],
      all('renders'),
      'read',
      2,
      REGISTRY,
    )

    expect(cells[0]).toEqual({ kind: 'block', id: 'b', span: 1, width: 'half', orphan: false })
    expect(cells[1]).toEqual({ kind: 'free' })
  })

  it('draws one column as full cells at the half width, with no free half', () => {
    const cells = resolveLayout(
      [p('a', 'half'), p('m', 'full')],
      all('renders'),
      'read',
      1,
      REGISTRY,
    )

    expect(cells).toEqual([
      { kind: 'block', id: 'a', span: 2, width: 'half', orphan: false },
      { kind: 'block', id: 'm', span: 2, width: 'half', orphan: false },
    ])
  })
})

describe('moveBlock', () => {
  const layout = [p('a', 'half'), p('b', 'half'), p('m', 'full'), p('n', 'half', true)]

  it('jumps a full card over a whole pair, never into the middle of it', () => {
    expect(ids(moveBlock(layout, 'm', -1))).toBe('m,a,b,n')
    expect(ids(moveBlock([p('m', 'full'), p('a', 'half'), p('b', 'half')], 'm', 1))).toBe('a,b,m')
  })

  it('swaps a half with the next half in reading order, skipping full cards', () => {
    expect(ids(moveBlock(layout, 'a', 1))).toBe('b,a,m,n')
    const spread = [p('a', 'half'), p('m', 'full'), p('b', 'half')]
    expect(ids(moveBlock(spread, 'a', 1))).toBe('b,m,a')
  })

  it('has nowhere to go at either end', () => {
    expect(moveBlock(layout, 'a', -1)).toBeNull()
    expect(moveBlock(layout, 'b', 1)).toBeNull()
    expect(moveBlock(layout, 'm', 1)).toBeNull()
  })

  it('keeps a hidden card in its slot, and does not move one', () => {
    const withHiddenFirst = [p('n', 'half', true), p('a', 'half'), p('m', 'full')]

    expect(ids(moveBlock(withHiddenFirst, 'm', -1))).toBe('n,m,a')
    expect(moveBlock(layout, 'n', -1)).toBeNull()
  })

  it('leaves the input untouched', () => {
    const before = JSON.stringify(layout)
    moveBlock(layout, 'm', -1)
    expect(JSON.stringify(layout)).toBe(before)
  })
})

describe('the small edits', () => {
  const layout = [p('a', 'half'), p('m', 'full')]

  it('changes one width, hides and shows one card where it stands', () => {
    expect(withWidth(layout, 'm', 'half')[1]).toEqual(p('m', 'half'))
    expect(withHidden(layout, 'a', true)).toEqual([p('a', 'half', true), p('m', 'full')])
    expect(withHidden(withHidden(layout, 'a', true), 'a', false)).toEqual(layout)
  })

  it('counts positions among the visible cards', () => {
    expect(positionOf([p('n', 'half', true), p('a', 'half'), p('m', 'full')], 'm')).toEqual({
      position: 2,
      total: 2,
    })
  })

  it('compares two layouts by order, width and visibility', () => {
    expect(sameLayout(layout, [p('a', 'half'), p('m', 'full')])).toBe(true)
    expect(sameLayout(layout, [p('m', 'full'), p('a', 'half')])).toBe(false)
    expect(sameLayout(layout, withHidden(layout, 'a', true))).toBe(false)
  })
})

describe('mustWrite', () => {
  const read = toStored([
    p('a', 'half'),
    p('b', 'half'),
    p('m', 'full'),
    p('n', 'half', true),
  ] as never)

  it('writes nothing when the draft is what was read and nothing is new', () => {
    expect(mustWrite(normalizeLayout(read, REGISTRY), read, REGISTRY)).toBe(false)
  })

  it('writes a changed draft', () => {
    const draft = withHidden(normalizeLayout(read, REGISTRY), 'a', true)
    expect(mustWrite(draft, read, REGISTRY)).toBe(true)
  })

  it('writes an unchanged draft while a card is still new, to end its « Nouveau » (18A)', () => {
    const before = toStored([p('a', 'half'), p('b', 'half'), p('m', 'full')] as never)
    expect(mustWrite(normalizeLayout(before, REGISTRY), before, REGISTRY)).toBe(true)
  })
})
