import { describe, expect, it } from 'vitest'

import {
  BLOCK_IDS,
  DASHBOARD_BLOCKS,
  type BlockSpec,
} from '@/features/dashboard/lib/dashboardBlocks'
import {
  defaultLayout,
  dropBlock,
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
} from '@/features/dashboard/lib/dashboardLayout'

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
  it('lays the allocation, the gain and the rhythm, then the movers, the comparison hidden (#1325)', () => {
    expect(defaultLayout()).toEqual([
      { id: 'allocation', width: 'half', hidden: false },
      { id: 'gain-breakdown', width: 'half', hidden: false },
      { id: 'rhythm', width: 'half', hidden: false },
      { id: 'movers', width: 'half', hidden: false },
      { id: 'benchmark', width: 'half', hidden: true },
    ])
  })

  it('leaves no free cell and no orphan on a fresh install', () => {
    const cells = resolveLayout(
      defaultLayout(),
      Object.fromEntries(BLOCK_IDS.map((id) => [id, 'renders'])) as Record<
        (typeof BLOCK_IDS)[number],
        RenderState
      >,
      'read',
      2,
    )

    expect(cells.some((cell) => cell.kind === 'free')).toBe(false)
    expect(cells.some((cell) => cell.kind === 'block' && cell.orphan)).toBe(false)
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

  it('drops a stored period, the window the breakdown no longer has (#1175)', () => {
    const saved = { version: 1, blocks: [{ id: 'a', width: 'half', hidden: false, period: 'ytd' }] }

    expect(normalizeLayout(saved, REGISTRY)[0]).toEqual(p('a', 'half'))
  })

  it('shows an arrivesHidden card on a fresh install, and lands it hidden on a saved layout (D7)', () => {
    expect(defaultLayout(REGISTRY).find((one) => one.id === 'n')).toEqual(p('n', 'half'))

    const saved = toStored([p('a', 'half'), p('b', 'half'), p('m', 'full')] as never)
    expect(normalizeLayout(saved, REGISTRY).at(-1)).toEqual(p('n', 'half', true))
  })
})

describe('newBlocks', () => {
  it('names a later card until a saved layout holds it, visible or not', () => {
    expect(newBlocks({ version: 1, blocks: [{ id: 'a' }] }, REGISTRY)).toEqual(['n'])
    expect(newBlocks({ version: 1, blocks: [{ id: 'n', hidden: true }] }, REGISTRY)).toEqual([])
  })

  it('names nothing on a fresh install: nothing is new to an owner who arranged nothing (#1280)', () => {
    expect(newBlocks(null, REGISTRY)).toEqual([])
    expect(newBlocks(null)).toEqual([])
  })

  it('names the two cards that arrived later in the shipped registry (#1206, #1205)', () => {
    expect(newBlocks({ version: 1, blocks: [{ id: 'gain-breakdown' }] })).toEqual([
      'allocation',
      'benchmark',
    ])
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

describe('dropBlock', () => {
  const layout = [p('a', 'half'), p('b', 'half'), p('m', 'full'), p('n', 'half', true)]

  it('puts a full card between two rows, never into the middle of a pair', () => {
    expect(ids(dropBlock(layout, 'm', 'a', 'before'))).toBe('m,a,b,n')
    expect(ids(dropBlock(layout, 'm', 'b', 'before'))).toBe('m,a,b,n')
    const pairLast = [p('m', 'full'), p('a', 'half'), p('b', 'half')]
    expect(ids(dropBlock(pairLast, 'm', 'a', 'after'))).toBe('a,b,m')
  })

  it('lets a half take the place of the half it is dropped on', () => {
    expect(ids(dropBlock(layout, 'a', 'b', 'after'))).toBe('b,a,m,n')
    const spread = [p('a', 'half'), p('m', 'full'), p('b', 'half')]
    expect(ids(dropBlock(spread, 'b', 'a', 'before'))).toBe('b,m,a')
  })

  it('sends a half dropped on a full card to the nearest half on that side', () => {
    const around = [p('a', 'half'), p('m', 'full'), p('b', 'half'), p('n', 'half')]
    expect(ids(dropBlock(around, 'a', 'm', 'after'))).toBe('b,m,a,n')
    expect(ids(dropBlock(around, 'n', 'm', 'before'))).toBe('n,m,b,a')
    expect(ids(dropBlock(layout, 'a', 'm', 'before'))).toBe('b,a,m,n')
  })

  it('agrees with the menu: one row up is « Monter »', () => {
    expect(dropBlock(layout, 'm', 'a', 'before')).toEqual(moveBlock(layout, 'm', -1))
    expect(dropBlock(layout, 'a', 'b', 'after')).toEqual(moveBlock(layout, 'a', 1))
  })

  it('has nothing to do at the edges, on itself, or on a hidden card', () => {
    expect(dropBlock(layout, 'm', 'b', 'after')).toBeNull()
    expect(dropBlock(layout, 'b', 'm', 'after')).toBeNull()
    expect(dropBlock(layout, 'a', 'a', 'after')).toBeNull()
    expect(dropBlock(layout, 'a', 'n', 'after')).toBeNull()
    expect(dropBlock(layout, 'n', 'a', 'after')).toBeNull()
  })

  it('keeps a hidden card in its slot', () => {
    const withHiddenFirst = [p('n', 'half', true), p('a', 'half'), p('m', 'full')]
    expect(ids(dropBlock(withHiddenFirst, 'm', 'a', 'before'))).toBe('n,m,a')
  })

  it('moves a full card past another full card, and a lone half nowhere past it', () => {
    expect(ids(dropBlock([p('m', 'full'), p('n', 'full')], 'n', 'm', 'before'))).toBe('n,m')
    expect(dropBlock([p('a', 'half'), p('m', 'full')], 'a', 'm', 'before')).toBeNull()
  })

  it('leaves the input untouched', () => {
    const before = JSON.stringify(layout)
    dropBlock(layout, 'm', 'a', 'before')
    expect(JSON.stringify(layout)).toBe(before)
  })
})

/**
 * Three tracks (#1325): the same stored list, drawn in rows of three. Half-only
 * cards `a`–`e`, a full card `m`, and `n`, a half that accepts the full width.
 */
describe('three columns', () => {
  const R3 = {
    a: { label: 'dashboard.breakdown.title', widths: ['half'], width: 'half', minHeight: 1 },
    b: { label: 'dashboard.rhythm.title', widths: ['half'], width: 'half', minHeight: 1 },
    c: { label: 'dashboard.breakdown.title', widths: ['half'], width: 'half', minHeight: 1 },
    d: { label: 'dashboard.rhythm.title', widths: ['half'], width: 'half', minHeight: 1 },
    e: { label: 'dashboard.breakdown.title', widths: ['half'], width: 'half', minHeight: 1 },
    m: { label: 'dashboard.movers.title', widths: ['half', 'full'], width: 'full', minHeight: 1 },
    n: { label: 'dashboard.movers.title', widths: ['half', 'full'], width: 'half', minHeight: 1 },
  } satisfies Record<string, BlockSpec>
  type Id3 = keyof typeof R3
  const states = (state: RenderState, ...except: [Id3, RenderState][]) =>
    ({
      ...Object.fromEntries(Object.keys(R3).map((id) => [id, state])),
      ...Object.fromEntries(except),
    }) as Record<Id3, RenderState>
  const q = (id: Id3, width: 'half' | 'full' = 'half', hidden = false): Placement<Id3> => ({
    id,
    width,
    hidden,
  })
  const half = (id: string) => ({ kind: 'block', id, span: 1, width: 'half', orphan: false })
  const whole = (id: string, orphan = false) => ({
    kind: 'block',
    id,
    span: 2,
    width: 'full',
    orphan,
  })
  const free = { kind: 'free' }
  const at3 = (
    placements: Placement<Id3>[],
    state = states('renders'),
    mode: 'read' | 'edit' = 'read',
  ) => resolveLayout(placements, state, mode, 3, R3)

  it('draws the shipped default as three halves and the movers across the row', () => {
    const cells = resolveLayout(
      defaultLayout(),
      Object.fromEntries(BLOCK_IDS.map((id) => [id, 'renders'])) as Record<
        (typeof BLOCK_IDS)[number],
        RenderState
      >,
      'read',
      3,
    )

    expect(cells).toEqual([
      half('allocation'),
      half('gain-breakdown'),
      half('rhythm'),
      { kind: 'block', id: 'movers', span: 2, width: 'full', orphan: true },
    ])
  })

  it('fills a row with three halves', () => {
    expect(at3([q('a'), q('b'), q('c')])).toEqual([half('a'), half('b'), half('c')])
  })

  it('leaves two tracks free beside a half-only card left alone by a fourth half', () => {
    expect(at3([q('a'), q('b'), q('c'), q('d')])).toEqual([
      half('a'),
      half('b'),
      half('c'),
      half('d'),
      free,
      free,
    ])
  })

  it('leaves one track free after two halves', () => {
    expect(at3([q('a'), q('b')])).toEqual([half('a'), half('b'), free])
  })

  it('draws a lone half that accepts the full width across the row, and says so', () => {
    expect(at3([q('a'), q('b'), q('c'), q('n')])).toEqual([
      half('a'),
      half('b'),
      half('c'),
      whole('n', true),
    ])
  })

  it('gives a full card the row, between rows of halves', () => {
    expect(at3([q('a'), q('b'), q('m', 'full'), q('c')])).toEqual([
      half('a'),
      half('b'),
      free,
      whole('m'),
      half('c'),
      free,
      free,
    ])
  })

  it('leaves hidden cards out', () => {
    expect(at3([q('a'), q('b', 'half', true), q('c'), q('d')])).toEqual([
      half('a'),
      half('c'),
      half('d'),
    ])
  })

  it('takes a card with nothing to say out in reading mode, and keeps its cell in edit mode', () => {
    const quiet = states('renders', ['b', 'nothing'])
    const four = [q('a'), q('b'), q('c'), q('d')]

    expect(at3(four, quiet)).toEqual([half('a'), half('c'), half('d')])
    expect(at3(four, quiet, 'edit')).toEqual(at3(four))
  })

  it('draws the same stored list at 1, 2 and 3 columns without writing a width', () => {
    const stored = [q('a'), q('b'), q('c'), q('m', 'full'), q('n'), q('d')]
    const before = JSON.stringify(stored)

    for (const columns of [1, 2, 3] as const) {
      const cells = resolveLayout(stored, states('renders'), 'read', columns, R3)
      expect(cells.flatMap((cell) => (cell.kind === 'block' ? [cell.id] : []))).toEqual(
        stored.map((one) => one.id),
      )
    }
    expect(JSON.stringify(stored)).toBe(before)
  })

  it('keeps the rows of two at two columns and on a phone for the moves', () => {
    const stored = [q('a'), q('b'), q('c'), q('m', 'full')]

    expect(ids(moveBlock(stored, 'm', -1, 1))).toBe(ids(moveBlock(stored, 'm', -1, 2)))
    expect(ids(moveBlock(stored, 'm', -1, 2))).toBe('a,b,m,c')
    expect(ids(moveBlock(stored, 'm', -1, 3))).toBe('m,a,b,c')
  })

  // The menu and the drag are one rule: dropping a card one row away is « Monter » / « Descendre ».
  describe.each([1, 2, 3] as const)('at %i columns', (columns) => {
    const stored = [q('a'), q('b'), q('c'), q('m', 'full'), q('d'), q('n'), q('e')]
    const perRow = columns === 3 ? 3 : 2
    const rowsDrawn = () => {
      const rows: string[][] = []
      let used = 0
      for (const cell of resolveLayout(stored, states('renders'), 'read', perRow, R3)) {
        if (used === 0) rows.push([])
        if (cell.kind === 'block') rows.at(-1)?.push(cell.id)
        used = (used + (cell.kind === 'block' && cell.span === 2 ? perRow : 1)) % perRow
      }
      return rows
    }

    it.each(
      stored.flatMap((one) => ([-1, 1] as const).map((direction) => [one.id, direction] as const)),
    )('drops %s one row %i away as the menu moves it', (id, direction) => {
      const moving = stored.find((one) => one.id === id) as Placement<Id3>
      const menu = moveBlock(stored, id, direction, columns)
      const side = direction < 0 ? 'before' : 'after'
      let over: Id3 | undefined
      if (moving.width === 'full') {
        const rows = rowsDrawn()
        const row = rows[rows.findIndex((one) => one.includes(id)) + direction]
        over = row?.[0] as Id3 | undefined
      } else {
        const halves = stored.filter((one) => one.width === 'half')
        over = halves[halves.indexOf(moving) + direction]?.id
      }
      const drop = over === undefined ? null : dropBlock(stored, id, over, side, columns)

      expect(drop).toEqual(menu)
      for (const next of menu ?? []) {
        expect(next.width).toBe(stored.find((one) => one.id === next.id)?.width)
      }
    })
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

  it('writes nothing for the default of an owner who never saved a layout (#1280)', () => {
    expect(mustWrite(defaultLayout(), null)).toBe(false)
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
