/**
 * Le contrat du combobox, sous la couture qui n'en est pas une : ce composant
 * est une primitive de `components/ui/`, et deux de ses règles ne sont pas
 * atteignables depuis la page qui l'utilise.
 *
 * Celle qui compte : **la ligne active est retenue par sa valeur et non par son
 * rang**. `items` est reconstruit à chaque relecture de la collection qui le
 * nourrit, et le panneau de saisie survit délibérément à au moins une — quand
 * une correction échoue parce que la ligne est partie ailleurs, le formulaire
 * réinvalide le grand livre sans se fermer. Un rang gardé en travers de cette
 * relecture désigne ce qui a pris sa place, et `Entrée` enregistrerait un
 * ticker que personne n'a choisi. Depuis la page, ce croisement est
 * inatteignable : tout geste qui change la collection pose le pointeur hors du
 * champ, ce qui referme la liste. Il se teste donc ici.
 */
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Combobox, type ComboboxItem } from '@/components/ui/combobox'

const ZZA = { value: 'ZZA', label: 'ZZA', hint: 'Zeta Alpha', mono: true }
const ZZC = { value: 'ZZC', label: 'ZZC', hint: 'Zeta Gamma', mono: true }

/**
 * Le champ seul, la collection en argument.
 *
 * Elle est remplacée par un `rerender` et non par un clic : tout geste au
 * pointeur hors du champ referme la liste — c'est la couche de radix qui fait
 * son travail — et referme donc aussi le croisement qu'on cherche à voir.
 */
function Harness({ items }: { items: readonly ComboboxItem[] }) {
  const [value, setValue] = useState('')
  return (
    <>
      <label htmlFor="ticker">Ticker</label>
      <Combobox
        id="ticker"
        value={value}
        onValueChange={setValue}
        items={items}
        listLabel="Les titres"
      />
    </>
  )
}

function list() {
  return screen.getByRole('listbox', { name: 'Les titres' })
}

function lines() {
  return within(list()).getAllByRole('option')
}

describe('la ligne active du combobox', () => {
  it('suit le ticker quand la collection bouge sous une liste ouverte', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness items={[ZZA, ZZC]} />)
    const field = screen.getByLabelText('Ticker')

    await user.type(field, 'zz')
    await user.keyboard('{ArrowDown}')
    expect(lines()[0]).toHaveAttribute('aria-selected', 'true')
    const chosen = lines()[0]?.textContent

    // La collection est relue et l'ordre s'inverse. La ligne active reste le
    // même titre, à son nouveau rang — pas le titre qui a pris sa place.
    rerender(<Harness items={[ZZC, ZZA]} />)
    const selected = lines().filter((line) => line.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0]?.textContent).toBe(chosen)
    expect(lines()[1]).toBe(selected[0])
  })

  it("n'active plus rien quand le titre choisi quitte la collection", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness items={[ZZA, ZZC]} />)
    const field = screen.getByLabelText('Ticker')

    await user.type(field, 'zz')
    await user.keyboard('{ArrowDown}')
    expect(field).toHaveAttribute('aria-activedescendant')

    // ZZA disparaît. Rien ne se reporte sur ZZC : la touche `Entrée` retourne
    // au formulaire, ce qui est l'état sûr.
    rerender(<Harness items={[ZZC]} />)
    expect(lines()).toHaveLength(1)
    expect(field).not.toHaveAttribute('aria-activedescendant')
    expect(lines().filter((l) => l.getAttribute('aria-selected') === 'true')).toHaveLength(0)
  })

  it('laisse une méthode de saisie valider sa composition', async () => {
    // `Entrée` sur un clavier à méthode de saisie valide ce qui est en train
    // d'être composé — ce n'est pas un choix dans la liste. Sans la garde, le
    // ticker actif remplacerait le texte au milieu d'un mot.
    const user = userEvent.setup()
    render(<Harness items={[ZZA, ZZC]} />)
    const field = screen.getByLabelText('Ticker')

    await user.type(field, 'zz')
    await user.keyboard('{ArrowDown}')
    expect(lines()[0]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    expect(field).toHaveValue('zz')
    expect(list()).toBeInTheDocument()

    // La même touche, composition terminée, choisit bien.
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field).toHaveValue('ZZA')
  })

  it('ne désigne aucune liste tant qu’elle est fermée', () => {
    // Un `aria-controls` qui pointe vers un identifiant absent est pire que pas
    // d'`aria-controls` du tout : le lecteur d'écran annonce une liste que le
    // document n'a pas.
    render(<Harness items={[ZZA, ZZC]} />)
    expect(screen.getByLabelText('Ticker')).not.toHaveAttribute('aria-controls')
  })
})
