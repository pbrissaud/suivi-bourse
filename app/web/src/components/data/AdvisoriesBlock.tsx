/**
 * *Notices* — the first block of the installation tab (#724, #709, ADR-0021).
 *
 * What this block is for, in one line: **the banner shows conditions the owner
 * can end; this counts facts they can only acknowledge.** Everything below
 * follows from that sentence.
 *
 *  - **The block does not exist when there is nothing in it.** The layout shifts
 *    when a notice appears, and that is the point: a badge that promised
 *    something and left the reader hunting for it would be the failure.
 *  - **There is no *acknowledge all*.** Five at the very most, and a bulk
 *    acknowledgement is exactly how the one notice the app cannot recompute —
 *    *your v4 amounts were read as already being in your reporting currency* —
 *    gets swept away unread. The gesture is per notice or it is not one.
 *  - **A notice carries a gesture when it has one, and says what to do outside
 *    when it does not.** The assumed-currency notice names the events it was
 *    made about, so it leads to them, in the ledger, already reduced to what it
 *    names. A `config.yaml` on disk and a variable in the container's
 *    environment are outside the app's reach, and their own sentence — the
 *    server's, because it names *this* installation's paths and variables —
 *    already says what to do about them. Inventing a button there would be
 *    inventing a power the app does not have.
 *  - **The sentence is composed here, from `key` and `detail`** (#768,
 *    ADR-0024). This block rendered `advisory.message` verbatim, and those five
 *    sentences are built in English by `advisories.py` — so the whole content of
 *    a French reader's notices was English, inside a frame whose title, date and
 *    button were not. `lib/advisories.ts` holds the choice and the two forms it
 *    was taken against; `message` stays the log line and what a client with no
 *    interface reads.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { advisoryGesture, advisoryText, shownAdvisories } from '@/lib/advisories'
import { api, type Advisory } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

export interface AdvisoriesBlockProps {
  advisories: readonly Advisory[]
  /**
   * Take the reader to the ledger, reduced to **every** security a notice
   * names — never the first of them, which would state a repair perimeter
   * smaller than the sentence rendered right above the button.
   */
  onShowInLedger: (symbols: readonly string[]) => void
}

export function AdvisoriesBlock({ advisories, onShowInLedger }: AdvisoriesBlockProps) {
  const { t } = useI18n()
  const format = useFormatters()
  const client = useQueryClient()

  const acknowledge = useMutation({
    mutationFn: (key: string) => api.acknowledgeAdvisory(key),
    // The list is re-read rather than patched in place: the server drops a row
    // whose predicate has stopped standing, so a client editing its own copy
    // would keep showing notices the installation has grown out of.
    onSuccess: () => client.invalidateQueries({ queryKey: ['advisories'] }),
  })

  const shown = shownAdvisories(advisories)
  if (shown.length === 0) return null

  return (
    <section aria-labelledby="installation-advisories" className="space-y-4">
      <h2 id="installation-advisories" className="text-lg font-semibold tracking-tight">
        {t('installation.advisories')}
      </h2>

      <ul className="space-y-3">
        {shown.map((advisory) => {
          const gesture = advisoryGesture(advisory)
          // `null` is a key outside the closed list of five, and the server's
          // own English sentence is then better than an empty notice.
          const said = advisoryText(advisory, format.list)
          return (
            <li
              key={advisory.key}
              className="space-y-3 rounded-lg border border-attention/40 bg-attention/5 p-4"
            >
              <p className="text-sm leading-relaxed">
                {said ? t(said.key, said.values) : advisory.message}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-xs text-muted-foreground">
                  {t('installation.advisory.seen', {
                    date: format.dateTime(advisory.first_seen_at),
                  })}
                </p>
                <div className="ml-auto flex items-center gap-2">
                  {gesture ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onShowInLedger(gesture.symbols)}
                    >
                      {t('installation.advisory.showEvents')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={acknowledge.isPending}
                    onClick={() => acknowledge.mutate(advisory.key)}
                  >
                    {t('installation.advisory.acknowledge')}
                  </Button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
