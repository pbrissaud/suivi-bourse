/**
 * The reconstruction, where the bell's card leads (#787, #727, #830, ADR-0021,
 * ADR-0037, ADR-0038).
 *
 * It was a **band** — the top of every page, on every route — and that is the
 * most expensive surface the product has. It earned it while the dot could not
 * carry the fact: green meant *the scheduler is running*, which is true during a
 * rebuild, so something else had to say the consolidated figures were behind.
 * Now the bell says it (`lib/status.ts`), and what an icon cannot carry lands
 * here, one click along the link the `reconstruction_running` card already
 * offers — which is this page since ADR-0038 renamed the destination.
 *
 * What it carries is what the band carried, and each half is a decision #727
 * measured:
 *
 *  - **the bar is `(horizon → today) / (first event → today)`**, and its two
 *    ends are the two facts the reader has: today, and the oldest day their own
 *    ledger names. It is a bar and never a target *time* — a mute symbol backs
 *    off to twenty-four hours, so a promised hour is a promise the app cannot
 *    keep;
 *  - **which account is holding it back**, because the global series is written
 *    only where *every* account is (ADR-0018). Without that name the rule *one
 *    slow account delays the whole home page* is invisible, and its owner reads
 *    the delay as a fault of the whole portfolio.
 *
 * `ratio: null` is *nothing to draw* — no account reports a horizon, or the
 * ledger's first event is today — and the block then says the reconstruction is
 * running without pretending to measure it.
 *
 * **A block with nothing in it does not exist**: nothing is rebuilding, nothing
 * is rendered. And nothing at all while the runtime read is in flight, which is
 * the same rule one page over (ADR-0026): *not observed yet* is not *not
 * running*.
 *
 * **It is not named after the workload, and that is the point** (#830). The
 * card below it in `JobsBlock` is the backfill's *line* — it exists always and
 * says what the last pass was worth — while this one exists only while the
 * reconstruction is under way and says how far it has got. Two cards wearing
 * one name on one page would read as one fact announced twice; the English
 * catalogue already told them apart (*Rebuilding your history* against
 * *Historical reconstruction*) and the French now does too.
 */
import { Link } from '@tanstack/react-router'

import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { declaredLabel, DEFAULT_ACCOUNT_LABEL } from '@/lib/accounts'
import type { AccountsResponse, RuntimeState } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { rebuildProgress } from '@/lib/status'

export interface RebuildBlockProps {
  /** `null` — the runtime read has not landed, which is not *not rebuilding*. */
  runtime: RuntimeState | null
  /** The oldest day the ledger names: the bar's denominator, and only that. */
  firstEvent: string | null
  /**
   * The declaration, for the lagging account's **name** (#729). `null` removes a
   * name from a sentence and falls back to the id — it falsifies nothing, which
   * is why the block does not wait for it.
   */
  accounts: AccountsResponse | null
}

export function RebuildBlock({ runtime, firstEvent, accounts }: RebuildBlockProps) {
  const { t } = useI18n()

  if (runtime === null || runtime.rebuilding !== true) return null

  const { account, ratio } = rebuildProgress(runtime.accounts ?? [], firstEvent, new Date())
  const declared = account === null ? null : (accounts?.accounts ?? []).find((one) => one.id === account)
  const name =
    account === null ? null : (declared ? declaredLabel(declared) : null) ?? t(DEFAULT_ACCOUNT_LABEL)
  const percent = ratio === null ? null : Math.round(ratio * 100)

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold tracking-tight">{t('installation.rebuild.title')}</h2>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Named or not, it is not the same sentence: *which* account is late is
            the whole of what makes the rule visible, and inventing a name for an
            account nothing reported would be worse than the shorter one. */}
        <p className="max-w-prose text-sm text-muted-foreground">
          {name === null
            ? t('installation.rebuild.body')
            : t('installation.rebuild.body.account', { account: name })}
        </p>
        {percent === null ? null : (
          // A native `<progress>`, so the figure is **announced** rather than
          // drawn: the bar is the rendering and the percentage is the fact.
          <progress
            className="h-1.5 w-full"
            value={percent}
            max={100}
            aria-label={t('installation.rebuild.progress', { percent: percent / 100 })}
          />
        )}
        {/* Where the figures it is holding up are read. */}
        <Link to="/" className="text-sm font-medium underline underline-offset-4">
          {t('installation.rebuild.link')}
        </Link>
      </CardContent>
    </Card>
  )
}
