/**
 * Where the reporting currency is chosen — **one field, two mounts** (#726).
 *
 * The modal asks the question and the installation tab is where it is changed
 * afterwards; both are the same field, for the reason `EntryPair` is one
 * component: two designs of one choice is how a product ends up saying two
 * different things about one rule.
 *
 * Two properties are the component rather than its usage:
 *
 *  - **The list is closed** (`lib/currencies.ts`). A free-text field accepts a
 *    code whose rate will never come, and the breakdown that follows is total
 *    and all but mute. **What is closed is what the field offers, not what it
 *    can show**: the server's rule is the shape, and two roads reach it without
 *    passing here — a headless `curl` on `PUT /api/settings`, which is the one
 *    non-interactive path ADR-0015 keeps open, and #710's `base_currency`
 *    import column. A stored code the list does not carry therefore gets an
 *    option of its own, or a controlled `select` with no matching option falls
 *    back to the empty one and the screen states the question is *unanswered*
 *    over a store that holds the answer.
 *  - **The screen says how long the answer stays changeable, where the answer
 *    is given.** The rule is the dial's own — free while the ledger is empty,
 *    fixed from the first recorded event, because adopting another unit
 *    afterwards re-reads every amount already stored rather than converting it
 *    (ADR-0002). A reader who learns that on the refusal has learnt it too late.
 *    Not observed is **not a sentence**: with no ledger read landed, neither
 *    half is something this screen has the standing to write (ADR-0026).
 */
import { CURRENCIES, isSupported } from '@/lib/currencies'
import { useI18n } from '@/lib/i18n'

export interface CurrencyFieldProps {
  id: string
  /** The code in force in the form. The empty string is *unanswered*. */
  value: string
  onChange: (value: string) => void
  /** `undefined` — the ledger has not been read, so neither half is claimed. */
  mutable?: boolean
  /** Whether the reader is told a locale suggested this. Modal only. */
  suggested?: boolean
}

export function CurrencyField({ id, value, onChange, mutable, suggested }: CurrencyFieldProps) {
  const { t } = useI18n()

  return (
    <div className="space-y-1">
      <select
        id={id}
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {/* The unanswered state is an option of its own: a `<select>` opening on
            the first code of the list would answer the question by rendering. */}
        <option value="">{t('currency.unanswered')}</option>
        {/* What another road already stored, shown rather than swallowed. It is
            named as being outside the list, so the reader can tell an answer
            the app will honour from one the field would have offered. */}
        {value !== '' && !isSupported(value) ? (
          <option value={value}>{t('currency.offList', { code: value })}</option>
        ) : null}
        {CURRENCIES.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>
      {suggested ? <p className="text-xs text-muted-foreground">{t('currency.suggested')}</p> : null}
      {mutable === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          {t(mutable ? 'currency.mutable' : 'currency.fixed')}
        </p>
      )}
    </div>
  )
}
