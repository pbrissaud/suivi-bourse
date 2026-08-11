/**
 * A share's own surface — **and it arrives holding one tenant, the chart.**
 *
 * The rest of the sheet is #720: ADR-0016's form expressed naked — `Gain total`
 * visually dominating its three terms, which is possible here and nowhere else
 * on the page because this is not a table — the position facts dropping to a
 * second rank, the event list and the selection that links it to the chart's
 * markers, and the fundamentals. What #719 owes is the chart with its four
 * presets and its one resolution announcer, and a chart nothing mounts is a
 * chart nothing tests.
 *
 * What is already decided and does **not** come back: `RuntimeDetail` (a
 * per-account backfill readout on a share's card), the per-account breakdown
 * when it would have one line, and `Variation` — the percentage already glued to
 * the latent gain in the table.
 */
import { useState } from 'react'

import { PriceChart } from '@/components/shares/PriceChart'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { ChartWindow } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { ShareRow } from '@/lib/shares'

export interface ShareSheetProps {
  row: ShareRow | null
  onClose: () => void
}

export function ShareSheet({ row, onClose }: ShareSheetProps) {
  const { t } = useI18n()
  // The range is the sheet's, not the chart's: reopening on another share keeps
  // the range the reader last chose, which is the one thing a chart control
  // must not forget between two lines of the same table.
  const [window, setWindow] = useState<ChartWindow>('1Y')

  return (
    <Sheet open={row !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full gap-6 sm:max-w-xl">
        {row === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle>{row.name ?? row.symbol}</SheetTitle>
              <SheetDescription>{t('shares.sheet.description')}</SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-4">
              <PriceChart symbol={row.symbol} window={window} onWindowChange={setWindow} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
