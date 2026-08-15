/**
 * An account's own surface — **and it shrank into a promotion** (#722,
 * ADR-0018, ADR-0016, ADR-0019).
 *
 * Two things left, and the room is not filled back in:
 *
 *  - **the six statistics** — `Valeur totale`, `Titres`, `Liquidités`, `Versé
 *    net`, `TRI`, `perf` — every one of them already read one line higher, in
 *    the row this panel was opened from. A panel that repeats its own row is a
 *    second announcer of six figures at once.
 *  - **the positions table**, which duplicated a page whose nine columns have
 *    just been fixed (#719). A link to that page, reduced to this account, does
 *    the work — and it does it better: the reduction is a URL, so it survives a
 *    reload and can be handed to somebody else.
 *
 * What is left is what the table **cannot** say, and there are two of them:
 *
 *  - **`Gain total` dominating its four terms.** `−0,62 €` over `−47,65 ·
 *    +60,97 · 0,00 · −13,95` is not a detail pane, it is the *explanation* of
 *    the figure in the row: one sees that the account went nowhere because its
 *    latent and its realised gains cancel and it has no dividend. That retracts
 *    nothing of ADR-0016's rule — a total and its terms never share a **row** —
 *    it is the other half of it: a **block** is the only place subordination can
 *    be expressed, and this is the account's block.
 *  - **the value-against-contributed curve**, the only surface in the product
 *    where it exists per account (ADR-0019: the comparison refuses it at N).
 *
 * **Nothing is composed before `/api/positions` has answered**, which is
 * `DashboardHead`'s rule and was held here for the *failure* branch alone: a
 * `503` said so, and a request still in flight had its three position terms
 * summed over an empty array and rendered as `0,00 €` beside a fourth term the
 * account row already carried. Opened cold — arriving straight on `/comptes`,
 * where nothing has read the positions yet — the panel therefore announced a
 * `Gain total` **its own row contradicted**, then exchanged it for another
 * number. Three zeros are not an explanation of a total, so the block and the
 * link that counts the same rows both wait.
 *
 * **The total is computed from its four terms and never read** (ADR-0018). The
 * row this panel opened from renders `gain_absolu`, which is the same number
 * written down elsewhere; computing here is what makes the four terms an
 * identity rather than a decomposition somebody has to trust — and it is what
 * keeps the headline when a field the perf cache could not write for one account
 * would otherwise blank it.
 *
 * The naming clause travels with it (#745, #729): `default` reads its label off
 * the catalogue until its owner gives it one, every other account shows what it
 * declares.
 */
import { Link } from '@tanstack/react-router'

import { AccountCurve } from '@/components/accounts/AccountCurve'
import { Band } from '@/components/Band'
import { Explain } from '@/components/Explain'
import { Stat } from '@/components/Stat'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { Rendering } from '@/lib/absence'
import {
  accountPositions,
  declaredLabel,
  positionCount,
  valueSeries,
  DEFAULT_ACCOUNT_LABEL,
  type AccountRow,
} from '@/lib/accounts'
import type { PerfPoint, Position } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import {
  GAIN_TERMS,
  gainTotal,
  portfolioTerms,
  sumRendering,
  termAmount,
  termCarriesSign,
  termIsRendered,
  termRendering,
  type GainTermName,
} from '@/lib/gain'
import { useI18n, type MessageKey, type MessageValues } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { signClass } from '@/lib/sign'

const TERM_LABELS: Record<GainTermName, MessageKey> = {
  unrealised: 'gain.term.unrealised',
  realised: 'gain.term.realised',
  dividends: 'gain.term.dividends',
  transferFees: 'gain.term.transferFees',
}

type Translate = (key: MessageKey, values?: MessageValues) => string

/** The same three-way switch every surface uses — written once per file, on
 *  purpose: written per *site*, the dash wins even where the rule says *name it*. */
function figure(rendering: Rendering, format: () => string, t: Translate) {
  switch (rendering.kind) {
    case 'figure':
      return format()
    case 'dash':
      return ABSENT
    case 'named':
      return t(rendering.message, rendering.values)
  }
}

export interface AccountSheetProps {
  row: AccountRow | null
  /**
   * The whole payload's rows, or **`null` while the read has not landed** —
   * which is not the same shape as *the payload is empty*, and the difference
   * is the block above. `?? []` here summed three terms over nothing and
   * printed them as zeros beside a fourth read off the account row, so a panel
   * opened cold announced `Gain total −3,00 €` — a figure the row it came from
   * contradicted — and then swapped it for another number.
   *
   * The three position terms are summed over the ones this account holds,
   * closed lines included (ADR-0017) — folding is `lib/accounts.ts`'s, so the
   * panel and the link cannot disagree about what they are counting.
   */
  positions: readonly Position[] | null
  /**
   * The account's own perf series, whole — the page has already read it — or
   * **`null` while that read is in flight** (ADR-0026).
   *
   * `[]` and *not answered yet* were one value, and the curve's own rule turned
   * the second into the first: *a block with nothing in it does not exist*,
   * whose sentence here is *an account with no cash ledger has no value to
   * trace against a contribution*. `account_series` reads ~2 500 days per
   * account, so the window is narrow and real.
   *
   * It waits for **its own** read and not for the N the comparison above is one
   * object of: a panel is about one account.
   */
  points: readonly PerfPoint[] | null
  currency: string | null
  /** The positions read failed: the block says so rather than summing nothing. */
  positionsError: unknown
  onClose: () => void
}

export function AccountSheet({
  row,
  positions,
  points,
  currency,
  positionsError,
  onClose,
}: AccountSheetProps) {
  const { t } = useI18n()
  const f = useFormatters()

  if (row === null) {
    return <Sheet open={false} onOpenChange={() => onClose()} />
  }

  // **A read that has not landed is not a fact** — `DashboardHead`'s own rule,
  // which this file already held for the *error* branch and not for this one.
  // Three of the four terms come off `/api/positions`, so composing them before
  // it answers writes three zeros and a real fourth term, i.e. a head that
  // contradicts the very cell the panel was opened from. The two objects that
  // read the positions therefore wait together: the block, and the link whose
  // count is drawn from the same rows.
  const held = positions === null ? null : accountPositions(positions, row.id)
  const terms = held === null ? null : portfolioTerms(held, row.transfer_fees)
  const total = terms === null ? null : gainTotal(terms)
  const curve = points === null ? null : valueSeries(points)
  const lines = positions === null ? 0 : positionCount(positions, row.id)

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full gap-6 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)}</SheetTitle>
          <SheetDescription>{t('accounts.sheet.description')}</SheetDescription>
        </SheetHeader>

        <div className="space-y-8 px-4 pb-8">
          {/* The positions are this block's own read, and the shell cannot
              cover their failure: `/api/runtime` opens no store (#668). Three
              of the four terms come off them, so a silent `0,00 €` here would
              be a figure invented out of a request that did not answer. */}
          {positionsError ? (
            <Band>{t(problemMessageKey(positionsError))}</Band>
          ) : terms === null || total === null ? null : (
            <Stat
              size="head"
              label={t('accounts.column.gainTotal')}
              value={figure(
                sumRendering(total),
                () => f.currency(total.known ? total.value : null, currency),
                t,
              )}
              valueClassName={signClass(total.known ? total.value : null)}
              // The page's **fifth** bubble, and the rule is *one per figure and
              // per surface*: the four others are on the table's column heads,
              // and a table is read scrolled with this panel shut.
              explain={
                <Explain
                  figure={t('accounts.column.gainTotal')}
                  body="accounts.sheet.gainTotal.explain"
                  anchor="total-gain"
                />
              }
            >
              <ul className="mt-3 flex flex-col gap-3 border-t pt-3">
                {GAIN_TERMS.map((term) => {
                  const amount = termAmount(terms, term)
                  // The fourth renders **only when it is not zero**: an account
                  // whose broker moves money for free reads three terms and
                  // never learns the fourth exists.
                  if (!termIsRendered(term, amount)) return null
                  return (
                    <li key={term}>
                      <Stat
                        size="term"
                        label={t(TERM_LABELS[term])}
                        value={figure(
                          termRendering(terms, term),
                          () => f.currency(amount, currency),
                          t,
                        )}
                        // Colour only where the sign can turn — a dividend is
                        // never negative and a transfer fee never positive.
                        valueClassName={
                          amount === null
                            ? signClass(null)
                            : termCarriesSign(term)
                              ? signClass(amount)
                              : signClass(0)
                        }
                      />
                    </li>
                  )
                })}
              </ul>
            </Stat>
          )}

          {/* A block with nothing in it does not exist (#724's rule): an account
              with no cash ledger has no value to draw against a contribution,
              and its row has already named that reason one line higher. That
              rule is about a series that **answered** empty — a read still in
              flight is `null` and says nothing at all (ADR-0026). */}
          {curve === null || curve.length === 0 ? null : (
            <div className="border-t pt-6">
              <AccountCurve points={curve} currency={currency} />
            </div>
          )}

          {/* The link, and not a table: the page it leads to has just fixed its
              nine columns, and its own header sums the lines it sits above. At
              zero positions there is nothing to lead to, so there is no link —
              a reduction onto an empty page is a dead end with a count on it.
              A read that has not landed counts zero for the same reason the
              block above renders nothing: it is not yet a count. */}
          {lines === 0 ? null : (
            <div className="border-t pt-6">
              <Link
                to="/titres"
                search={{ compte: row.id }}
                className="font-medium underline underline-offset-4"
              >
                {t('accounts.sheet.positions', { count: lines })}
              </Link>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
