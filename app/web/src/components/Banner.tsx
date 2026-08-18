/**
 * The banner: **one band, never two**, and it lives *inside* the content column.
 *
 * Mounted full width under a sidebar its left edge would run behind the column
 * — it has no honest left edge there (ADR-0022). "Visible from any page" loses
 * nothing: the content column is present on all four.
 *
 * What it says is a **condition the reader can make stop**, in causal order; a
 * fact they can only acknowledge belongs to the installation tab's notices
 * instead — which is the line ADR-0021 draws and #726 finally wrote down.
 * Three are observable: the app not answering, which is the first cause of an
 * empty screen; the **reporting currency unanswered** (#726), which is not an
 * acknowledgeable notice and keeps its gesture, a link to its own field; and the
 * **reconstruction** (#727), which is the one condition that ends by itself and
 * the only one carrying a progress bar.
 *
 * The bar is `(horizon → today) / (first event → today)` and the sentence
 * **names the account that is late**, because the global series is written only
 * where every account is (ADR-0018): without the name, *one slow account delays
 * the whole home page* is a rule nothing on screen states, and the owner reads
 * the delay as a fault of the portfolio as a whole.
 *
 * Three reads and two of them are **armed by the first**: `/api/events` and
 * `/api/accounts` are asked for only while the rebuild is running, so a shell on
 * every page of a settled install costs exactly what it did before — one runtime
 * request. The first is the bar's denominator (the oldest day the ledger names,
 * which is the reader's own fact), the second is the account's *declared* name,
 * through the same function the accounts page and the declaration block call
 * (#729) so that two surfaces cannot name one thing two ways.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { Band } from '@/components/Band'
import { declaredLabel } from '@/lib/accounts'
import { api } from '@/lib/api'
import { currencyUnanswered } from '@/lib/firstRun'
import { useI18n } from '@/lib/i18n'
import { oneBand, shellConditions } from '@/lib/status'

export function Banner() {
  const { t } = useI18n()
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  // The same read the first-run modal composes its predicate from — one query
  // key, so it is one request, and **no new API state** for either surface.
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const rebuilding = runtime.data?.rebuilding === true
  const events = useQuery({ queryKey: ['events'], queryFn: api.events, enabled: rebuilding })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts, enabled: rebuilding })

  // The oldest day the ledger names. A read that has not landed leaves the bar
  // out and the sentence in: *the reconstruction is running* is true either way,
  // and a denominator nobody has answered is not a measurement.
  const firstEvent = (events.data ?? []).reduce<string | null>(
    (oldest, event) =>
      event.date !== null && (oldest === null || event.date < oldest) ? event.date : oldest,
    null,
  )

  const band = oneBand(
    shellConditions({
      error: runtime.error,
      currencyUnanswered: currencyUnanswered(config.data?.settings),
      runtime: runtime.data,
      firstEvent,
      nameAccount: (id) => {
        // **An optional read, so the `?? []` survives** (ADR-0026): not finding
        // the declaration removes a *name* from the sentence and falls back to
        // the id — it falsifies nothing, and withholding the band over it would
        // hide the condition the reader is waiting on.
        const declared = (accounts.data?.accounts ?? []).find((account) => account.id === id)
        return (declared ? declaredLabel(declared) : null) ?? t('accounts.default.label')
      },
      now: new Date(),
    }),
  )

  if (!band) return null

  const percent = band.progress === undefined ? null : Math.round(band.progress * 100)

  return (
    <Band className="rounded-none border-x-0 border-t-0">
      <div className="space-y-2">
        <p>{t(band.message, band.values)}</p>
        {band.gesture ? (
          <Link
            to={band.gesture.to}
            hash={band.gesture.hash}
            className="text-sm font-medium underline underline-offset-4"
          >
            {t(band.gesture.label)}
          </Link>
        ) : null}
        {percent === null ? null : (
          // A native `<progress>`, so the figure is announced rather than
          // drawn: the bar is the rendering and the percentage is the fact.
          <progress
            className="h-1.5 w-full"
            value={percent}
            max={100}
            aria-label={t('banner.rebuilding.progress', { percent: percent / 100 })}
          />
        )}
      </div>
    </Band>
  )
}
