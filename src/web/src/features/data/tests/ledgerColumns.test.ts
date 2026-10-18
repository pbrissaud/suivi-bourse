/**
 * **The ledger's column budget** (#1264). jsdom lays nothing out, so a table
 * 1 342 px wide in a column of 834 is a fact only a browser has; what can be
 * held is the arithmetic of `LEDGER_COLUMNS` and the classes that read it —
 * the precedent is `contentWidth.test.ts`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { LEDGER_COLUMNS } from '@/features/data/components/LedgerTable'
import { formatCurrency, formatDay, formatQuantity } from '@/lib/format'
import { ROUTES } from '@/lib/api'
import { LOCALES } from '@/lib/i18n'
import { aLedgerPayload } from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const SOURCE = path.resolve(import.meta.dirname, '../../..')
const read = (file: string) => fs.readFileSync(path.join(SOURCE, file), 'utf8')

/** Mono at 13 px, and the `xl` cell padding (DESIGN.md, #838). */
const CHAR = 7.8
const PADDING = 32

const columns = Object.entries(LEDGER_COLUMNS)
const sum = (cells: { min: number }[]) => cells.reduce((total, { min }) => total + min, 0)

// 1440 px, the sidebar open, the content gutter, the card's 1 px borders.
const SIDEBAR =
  Number(/const SIDEBAR_WIDTH = '([\d.]+)rem'/.exec(read('components/ui/sidebar.tsx'))?.[1]) * 16
const GUTTER = Number(/\blg:p-(\d+)\b/.exec(read('components/Shell.tsx'))?.[1]) * 4
const CONTAINER_AT_1440 = 1440 - SIDEBAR - 2 * GUTTER - 2

describe('the ledger’s column budget', () => {
  it('fits every column at 1440 px with the sidebar open', () => {
    expect(CONTAINER_AT_1440).toBe(1182)
    for (const [, column] of columns)
      expect(column.from ?? 0).toBeLessThanOrEqual(CONTAINER_AT_1440)
    expect(sum(Object.values(LEDGER_COLUMNS))).toBeLessThanOrEqual(CONTAINER_AT_1440)
  })

  it('fits the columns it shows at every width one of them appears at', () => {
    for (const [id, { from }] of columns) {
      if (from === undefined) continue
      const shown = Object.values(LEDGER_COLUMNS).filter((c) => (c.from ?? 0) <= from)
      expect(sum(shown), id).toBeLessThanOrEqual(from)
    }
  })

  it('leaves the label column its 240 px floor at 1440 px', () => {
    const others = sum(Object.values(LEDGER_COLUMNS).filter((c) => c !== LEDGER_COLUMNS.what))
    expect(CONTAINER_AT_1440 - others).toBeGreaterThanOrEqual(LEDGER_COLUMNS.what.min)
  })

  it('gives each figure column room for the widest figure the formatter writes', () => {
    const FR = LOCALES.fr
    const widest = {
      amount: formatCurrency(FR, -1234567.89, 'EUR'),
      unitPrice: formatCurrency(FR, 123456.78, 'EUR'),
      fee: formatCurrency(FR, 1234.56, 'EUR'),
      quantity: formatQuantity(FR, 0.12345678),
      date: formatDay(FR, '2026-12-31'),
    }
    for (const [id, text] of Object.entries(widest)) {
      const need = text.length * CHAR + PADDING
      expect(need, `${id}: ${text}`).toBeLessThanOrEqual(
        LEDGER_COLUMNS[id as keyof typeof LEDGER_COLUMNS].min,
      )
    }
  })

  it('names the same width in `from` and in `show`', () => {
    for (const [id, { from, show }] of columns) {
      if (from === undefined) continue
      const rem = Number(/@min-\[([\d.]+)rem\]\/ledger:table-cell/.exec(show ?? '')?.[1])
      expect(rem * 16, id).toBe(from)
    }
  })

  it('hides each column by the class its threshold names', async () => {
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload())))
    renderApp({ url: '/ledger' })
    const table = await screen.findByRole('table', { name: 'Vos événements' })
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1))

    const heads = within(table).getAllByRole('columnheader')
    const head = (name: string) => heads.find((h) => h.textContent?.trim() === name) as HTMLElement
    const named = {
      account: 'Compte',
      quantity: 'Quantité',
      unitPrice: 'Prix unitaire',
      fee: 'Frais',
    } as const
    for (const [id, name] of Object.entries(named)) {
      const show = LEDGER_COLUMNS[id as keyof typeof named].show as string
      expect(head(name), id).toHaveClass(...show.split(' '))
    }
    expect(head('De quoi il s’agit')).toHaveClass('w-full', 'max-w-0')
    for (const name of ['Date', 'Type', 'Montant']) expect(head(name)).not.toHaveClass('hidden')
  })

  it('declares the container the thresholds are measured on', () => {
    const ledger = read('features/data/components/Ledger.tsx')
    expect(ledger).toMatch(/<Card className="[^"]*@container\/ledger\b[^"]*">/)
  })
})
