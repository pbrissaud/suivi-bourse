/**
 * The « Relevé » primitives: text tabs, the filter button, the one
 * confirmation. They are tested on their own, since the pages that use them
 * arrive with the chantiers that redraw those pages.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { FilterButton } from '@/components/FilterButton'
import { TextTabs } from '@/components/TextTabs'
import { I18nProvider } from '@/lib/i18n'

beforeEach(() => localStorage.setItem('sb.lang', 'fr'))

const TABS = [
  { value: 'all', label: 'Tout' },
  { value: 'warn', label: 'Avertissements' },
  { value: 'err', label: 'Erreurs' },
] as const

function Tabs({ size }: { size?: 'page' | 'sheet' }) {
  const [value, setValue] = useState<(typeof TABS)[number]['value']>('all')
  return <TextTabs label="Niveau" tabs={TABS} value={value} onChange={setValue} size={size} />
}

describe('TextTabs', () => {
  it('is a tablist with one tab stop, moved by the arrows', async () => {
    const user = userEvent.setup()
    render(<Tabs />)
    const list = screen.getByRole('tablist', { name: 'Niveau' })
    const [first, second] = within(list).getAllByRole('tab')
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(second).toHaveAttribute('tabindex', '-1')

    first.focus()
    await user.keyboard('{ArrowRight}')
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(second).toHaveFocus()
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(within(list).getAllByRole('tab')[2]).toHaveAttribute('aria-selected', 'true')
  })

  it('draws the sheet variant smaller and tighter', () => {
    render(<Tabs size="sheet" />)
    const list = screen.getByRole('tablist')
    expect(list).toHaveClass('gap-4.5')
    expect(within(list).getAllByRole('tab')[0]).toHaveClass('text-md')
  })
})

describe('FilterButton', () => {
  const OPTIONS = [
    { value: 'all', label: 'Tous les comptes' },
    { value: 'pea', label: 'PEA' },
  ]

  it('shows the value, muted until it narrows, and picks from a listbox', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <I18nProvider>
        <FilterButton label="Compte" options={OPTIONS} value="all" onChange={onChange} />
      </I18nProvider>,
    )
    const button = screen.getByRole('button', { name: /Compte : Tous les comptes/ })
    expect(button).toHaveClass('text-muted-foreground')

    await user.click(button)
    expect(screen.queryByRole('searchbox')).toBeNull()
    await user.click(screen.getByRole('option', { name: 'PEA' }))
    expect(onChange).toHaveBeenCalledWith('pea')
  })

  it('carries a search field past eight entries', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 9 }, (_, at) => ({ value: `f${at}`, label: `Fonds ${at}` }))
    render(
      <I18nProvider>
        <FilterButton label="Fonds" options={many} value="f1" onChange={() => {}} />
      </I18nProvider>,
    )
    const button = screen.getByRole('button', { name: /Fonds 1/ })
    expect(button).toHaveClass('text-foreground')
    await user.click(button)
    await user.type(screen.getByRole('searchbox'), '7')
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })
})

describe('ConfirmDestructive', () => {
  it('names what goes, opens on Annuler and confirms with the verb', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <I18nProvider>
        <ConfirmDestructive
          open
          onOpenChange={() => {}}
          title="Purger 2 historiques ?"
          items={[
            { key: 'CSPX.AS', value: '4 120 cours' },
            { key: 'BNP.PA', value: '812 cours' },
          ]}
          line="Irréversible. Un historique purgé se reconstruit."
          confirmLabel="Purger"
          onConfirm={onConfirm}
        />
      </I18nProvider>,
    )
    const dialog = await screen.findByRole('alertdialog', { name: 'Purger 2 historiques ?' })
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2)
    expect(dialog).toHaveAccessibleDescription(/^Irréversible\./)
    expect(within(dialog).getByRole('button', { name: 'Annuler' })).toHaveFocus()
    expect(dialog).toHaveClass('rounded-card')

    await user.click(within(dialog).getByRole('button', { name: 'Purger' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
