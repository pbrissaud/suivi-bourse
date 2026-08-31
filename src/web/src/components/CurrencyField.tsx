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
 *    import column. A stored code the list does not carry is therefore
 *    **rendered as the answer it is**, and named as one this field would not
 *    have offered. Since #794 that is the only place it can appear: the field
 *    is drawn on an unanswered dial alone, so a `select` never has a stored
 *    code to fail to match.
 *  - **The screen says how long the answer stays changeable, where the answer
 *    is given** — and since #794 it says the true thing: the currency is fixed
 *    **the moment it is answered**, because adopting another unit afterwards
 *    re-reads every amount already stored rather than converting it (ADR-0002).
 *    A reader who learns that on the refusal has learnt it too late.
 *  - **Once fixed, it stops being drawn as a field.** A `select` a reader can
 *    open, choose in, and then watch refuse the write is a form that lied about
 *    what it was; greyed out it invites the same click and reads as a form that
 *    refused. What is left is the answer, rendered, and the sentence that says
 *    it cannot be taken back — the same move the installation tab makes for
 *    what the container imposes.
 *    Not observed is **not a sentence** and not a rendering either: with the
 *    settings read not landed, neither half is something this screen has the
 *    standing to write (ADR-0026), and the field it draws in the meantime is
 *    the one the question is asked in.
 */
import { CURRENCIES, isSupported } from '@/lib/currencies'
import { useI18n } from '@/lib/i18n'

export interface CurrencyFieldProps {
  id: string
  /** The code in force in the form. The empty string is *unanswered*. */
  value: string
  onChange: (value: string) => void
  /**
   * Whether the answer is already given, and therefore fixed. `undefined` — the
   * settings have not been read, so neither half is claimed.
   */
  fixed?: boolean
  /** Whether the reader is told a locale suggested this. Modal only. */
  suggested?: boolean
}

export function CurrencyField({ id, value, onChange, fixed, suggested }: CurrencyFieldProps) {
  const { t } = useI18n()

  // The answer, and no field around it: what a reader can do here is read it.
  if (fixed === true) {
    return (
      <div className="space-y-1">
        {/* No `id`: nothing labels a paragraph, and the name sits above it —
            the shape the installation tab already gives what it only reads. */}
        {/* **The answer, and a mark saying it is settled** (#838). The drawing
            sets the code beside a small chip rather than under a sentence
            explaining it — the sentence stays, one rung down, because *why* it
            cannot be taken back is not something a chip can say. */}
        <p className="flex items-center gap-2.5">
          <span className="tabular text-lg font-semibold">
            {value === '' ? t('currency.unanswered')
              : isSupported(value) ? value
              : t('currency.offList', { code: value })}
          </span>
          <span className="eyebrow rounded-md bg-accent px-1.5 py-0.5">
            {t('currency.fixed.mark')}
          </span>
        </p>
        <p className="text-2xs leading-relaxed text-muted-foreground">{t('currency.fixed')}</p>
      </div>
    )
  }

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
        {CURRENCIES.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>
      {suggested ? <p className="text-xs text-muted-foreground">{t('currency.suggested')}</p> : null}
      {fixed === undefined ? null : (
        <p className="text-xs text-muted-foreground">{t('currency.untilAnswered')}</p>
      )}
    </div>
  )
}
