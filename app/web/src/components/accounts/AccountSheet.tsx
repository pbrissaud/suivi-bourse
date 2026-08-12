/**
 * An account's own surface — **and it arrives empty on purpose.**
 *
 * What goes in it is #722, whole and by name: `Gain total` visually dominating
 * its **four** terms in ADR-0016's form — the one place on this page where the
 * form can appear naked, a table row having only a horizontal axis — the
 * account's value-against-contributed curve, which exists per account here and
 * nowhere else, a link to the shares page filtered on this account instead of a
 * second positions table, and the page's **fifth** icon on that block.
 *
 * What this ticket owes is the **gesture**: the label of a row, and only the
 * label, opens this. That is what makes the table the chart's control without
 * adding a control — the click on the row isolates the curve, the click on the
 * one non-numeric cell opens the account — and a gesture nothing opens is a
 * gesture nothing tests. `ShareSheet` landed the same way for #720.
 *
 * The naming clause travels with it (#745): `default` reads its label and its
 * type off the catalogue, every other account shows what it declares.
 */
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { declaredLabel, DEFAULT_ACCOUNT_LABEL, type AccountRow } from '@/lib/accounts'
import { useI18n } from '@/lib/i18n'

export interface AccountSheetProps {
  row: AccountRow | null
  onClose: () => void
}

export function AccountSheet({ row, onClose }: AccountSheetProps) {
  const { t } = useI18n()

  return (
    <Sheet open={row !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full gap-6 sm:max-w-xl">
        {row === null ? null : (
          <SheetHeader>
            <SheetTitle>
              {declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)}
            </SheetTitle>
            <SheetDescription>{t('accounts.sheet.description')}</SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  )
}
