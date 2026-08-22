/**
 * The reduction bar — **chips, and a count that is true of what they hold**
 * (#723, #795, ADR-0020, ADR-0031).
 *
 * A ledger is opened to check what has just happened, so the rows come sorted by
 * date descending and *« page 4 sur 6 »* was never on the table: a page number
 * means nothing on an axis of dates, and a reader looking for last Tuesday would
 * have to guess which page holds it. Since ADR-0031 the table **reveals** forty
 * rows at a time instead, which is a rendering budget rather than a place in a
 * sequence — and nothing about that changes what this bar is for. What reduces
 * is here, and it is named.
 *
 * **The two filters are chips rather than dropdowns**, which is the change #795
 * makes and it is not only a shape: a `<select>` collapsed to `Tous` states the
 * absence of a reduction and nothing else, so the six types and the accounts an
 * install actually uses were facts a reader had to open a menu to learn. Laid
 * out, the vocabulary of the ledger is on screen before the first click, the one
 * in force is pressed, and the way out is the chip beside it. Two groups,
 * because they are two questions: the types on one side, the accounts on the
 * other.
 *
 * **The full-text search stays, and it is not a convenience.** It is the
 * consequence of the identity column: on nineteen purchases of the same ETF the
 * free-text label is the only discriminant a row owns, and on a cash movement it
 * is the only name at all. It reads the ticker, the label and the account —
 * everything the identity and account columns show — with accents folded, and
 * nothing about it is expressible as a chip.
 *
 * The account chips appear **at N ≥ 2 only**. ADR-0013 seeds a `default` row
 * that is never removed, so a single-account install would get a group with one
 * option beside its own exit: a filter that cannot filter, which is the same
 * defect as a column that cannot discriminate. The one exception is a reduction
 * already **in force**: the group stays whatever N is, because a filter with no
 * way out is worse than a filter that cannot filter.
 *
 * **A reduction that came from a gesture names itself and can be undone** (#724).
 * The securities filter has no control to type into — it arrives from the
 * assumed-currency notice of the other tab, which names *every* security it
 * concerns — so without a line stating it the ledger would simply be shorter
 * than the reader expects, with the search field empty and nothing on screen
 * saying why or how to get the rest back. It lists them all, in one line, for
 * the same reason: a set stated as its first element reads as its whole.
 *
 * **The count is the reduction's**, not the store's: it is rendered here, beside
 * the chips that made it, and it moves when they move.
 */
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EVENT_TYPES } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { LedgerFilters as Filters } from '@/lib/ledger'
import { TYPE_LABEL } from '@/components/data/LedgerTable'
import { cn } from '@/lib/utils'

export interface LedgerFiltersProps {
  filters: Filters
  onChange: (filters: Filters) => void
  /** The accounts the ledger actually names — never the declared list. */
  accounts: readonly string[]
  /** How many rows survive the reduction, stated where the reduction is made. */
  shown: number
}

export function LedgerFilters({ filters, onChange, accounts, shown }: LedgerFiltersProps) {
  const { t } = useI18n()
  const f = useFormatters()

  // **A reduction in force always has a chip that releases it.** `accounts` is
  // what the *ledger* names, and the ledger changes under the reader: revoking
  // from the band above this bar the import that carried every `beta` event
  // takes `beta` out of the list while `filters.account` still holds it, and the
  // group would then disappear with the only control that could clear it —
  // leaving a table that is simply shorter than it should be and nothing on
  // screen saying why, which is the defect #724 was written against.
  const named =
    filters.account !== null && !accounts.includes(filters.account)
      ? [...accounts, filters.account]
      : accounts

  return (
    <div className="flex min-w-0 grow flex-wrap items-center gap-x-4 gap-y-3">
      <div className="grow sm:max-w-xs">
        <label htmlFor="ledger-search" className="sr-only">
          {t('data.search.label')}
        </label>
        <Input
          id="ledger-search"
          type="search"
          value={filters.query}
          placeholder={t('data.search.placeholder')}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
        />
      </div>

      {/* The group carries the question, so a chip only has to carry its own
          answer: read out, `Type · Achat` rather than six buttons named after
          nothing. */}
      <div role="group" aria-label={t('data.filter.type')} className="flex flex-wrap gap-1.5">
        <Chip
          pressed={filters.type === null}
          label={t('data.filter.type.all')}
          onPress={() => onChange({ ...filters, type: null })}
        />
        {EVENT_TYPES.map((type) => (
          <Chip
            key={type}
            pressed={filters.type === type}
            label={t(TYPE_LABEL[type])}
            // Pressing the one in force does **not** clear it: the exit is a
            // chip of its own and it is always on screen, so a second gesture
            // meaning *undo* would give the same control two behaviours
            // depending on a state the reader has to have noticed.
            onPress={() => onChange({ ...filters, type })}
          />
        ))}
      </div>

      {named.length > 1 || filters.account !== null ? (
        <div role="group" aria-label={t('data.filter.account')} className="flex flex-wrap gap-1.5">
          <Chip
            pressed={filters.account === null}
            label={t('data.filter.account.all')}
            onPress={() => onChange({ ...filters, account: null })}
          />
          {named.map((account) => (
            <Chip
              key={account}
              pressed={filters.account === account}
              label={account}
              mono
              onPress={() => onChange({ ...filters, account })}
            />
          ))}
        </div>
      ) : null}

      <p className="ml-auto text-sm text-muted-foreground">
        {t('data.filter.count', { count: shown })}
      </p>

      {filters.symbols && filters.symbols.length > 0 ? (
        <div className="flex w-full flex-wrap items-center gap-3 rounded-md border border-dashed border-input px-3 py-2">
          <p className="text-sm text-muted-foreground">
            {t('data.filter.symbols', {
              count: filters.symbols.length,
              // A sentence, so the enumeration is the language's (#768) and
              // not a machine-readable list wearing a sentence's clothes.
              symbols: f.list(filters.symbols),
            })}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => onChange({ ...filters, symbols: null })}
          >
            {t('data.filter.symbols.clear')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One chip. `aria-pressed` and not a `radio`: a reader arriving by keyboard on
 * a radiogroup lands on the *checked* option and moves with the arrows, which
 * would make the six types one stop and hide five of them behind a gesture the
 * chips exist to remove. Pressed is also stated in **two** ways — the state and
 * the ground — because a colour alone is not read by everyone.
 */
function Chip({
  pressed,
  label,
  mono,
  onPress,
}: {
  pressed: boolean
  label: string
  mono?: boolean
  onPress: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onPress}
      className={cn(
        'h-7 rounded-full border px-3 text-xs font-medium transition-colors',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        mono && 'font-mono',
        // Solid, and not the mint on a wash of the mint: that pairing reads at
        // 4,06:1 at 12 px on the light ground, where `--primary` against
        // `--primary-foreground` is the contrast the preset guarantees (5,21
        // light, 10,84 dark) — the same one every primary button rests on.
        pressed
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
}
