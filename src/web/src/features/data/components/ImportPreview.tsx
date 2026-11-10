/**
 * **The import, as a page** (« Relevé », mockup `GrandLivre-Import-Refonte`,
 * `/ledger/import`): a statement is read against one account, every line gets
 * its *Issue*, and only then is anything written.
 *
 * Two steps on the server, one gesture here. The file is previewed
 * (`POST /api/events/import/preview`) — nothing is stored but a token — and the
 * table below is that answer, line by line: `new`, `duplicate` (with what it
 * matched on), `unknown_security` (with *Associer*, which names the ticker the
 * line is about) and `unreadable`. The filled button commits the token with the
 * owner's resolutions, and the server writes the new rows only, judging them
 * again under its lock.
 *
 * The account is an answer like the others: changing it
 * reads the same file again, since a line may be a duplicate in one account and
 * new in another. Resolutions are dropped with the reading they were about.
 *
 * A read in flight, an empty file and a refused one are three different
 * sentences, and the wait is dressed because it is the reader's own act.
 *
 * Three things the first staging pass asked for. A line the app cannot read says
 * why, in French, in its row (a stable `reason_code`, never the server's English).
 * A file that states no unit for its amounts is asked what they are written in,
 * for each security quoted outside the base currency, before anything is written.
 * And under 768 px the table is a ruled list (DESIGN.md › Responsive), each row
 * carrying its own Issue: nothing hides behind a sideways scroll.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import { EmptyState } from '@/components/EmptyState'
import { FilterButton } from '@/components/FilterButton'
import { TextTabs } from '@/components/TextTabs'
import { Unreadable } from '@/components/Unreadable'
import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxItem } from '@/components/ui/combobox'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { accountsApi } from '@/features/accounts/lib/api'
import { EventFigure, TYPE_LABEL, TypeWord } from '@/features/data/components/LedgerTable'
import { FormatDocsButton } from '@/features/data/components/FormatDocsButton'
import { UploadZone } from '@/features/data/components/UploadZone'
import { takeHandover } from '@/features/data/lib/handoff'
import {
  dataApi,
  type ImportAmountsIn,
  type ImportMatchCriterion,
  type ImportPreview as Preview,
  type ImportPreviewRow,
  type ImportResolution,
  type ImportRowStatus,
  type LedgerEvent,
} from '@/features/data/lib/api'
import { dashboardApi } from '@/features/dashboard/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { isMessageKey, type MessageKey, useI18n } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'
import { oneFailure, readConditions } from '@/lib/status'
import { cn } from '@/lib/utils'

/** The lines drawn before *tout afficher*. */
const SHOWN = 25
const SEARCH_PAUSE_MS = 300
const SEARCH_MIN = 2
const SEARCH_MAX = 64

type Tab = 'all' | ImportRowStatus

/** How the owner says a foreign security's amounts are written: as the base, or in its quote currency. */
type AmountsIn = ImportAmountsIn['amounts_in']

const CRITERIA: Record<ImportMatchCriterion, MessageKey> = {
  isin: 'import.criterion.isin',
  symbol: 'import.criterion.symbol',
  date: 'import.criterion.date',
  quantity: 'import.criterion.quantity',
  price: 'import.criterion.price',
  amount: 'import.criterion.amount',
}

export function ImportPreview({ account: asked }: { account?: string }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [account, setAccount] = useState<string | undefined>(asked)
  const [tab, setTab] = useState<Tab>('all')
  const [all, setAll] = useState(false)
  // The ticker the owner gave a line, by its row number: dropped with the reading.
  const [resolved, setResolved] = useState<Readonly<Record<number, string>>>({})
  // What each foreign security's amounts are written in; none said = as the base.
  const [amountsIn, setAmountsIn] = useState<Readonly<Record<string, AmountsIn>>>({})

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: dashboardApi.portfolioTotals })
  const currency = totals.data?.base_currency ?? null
  const declared = accounts.data?.accounts ?? []
  const target = account ?? declared[0]?.id

  const read = useMutation({
    mutationFn: (next: { file: File; account: string }) =>
      dataApi.previewImport(next.file, next.account),
  })
  const preview: Preview | undefined = read.data

  /** Read `next` again under the answers standing now, with `change` applied. */
  const reading = (next: File, change: { account?: string } = {}) => {
    const into = change.account ?? target
    if (into === undefined) return
    setResolved({})
    setAmountsIn({})
    setTab('all')
    setAll(false)
    read.mutate({ file: next, account: into })
  }

  const commit = useMutation({
    mutationFn: (token: string) => {
      const associate: ImportResolution[] = Object.entries(resolved).map(([row, security]) => ({
        row: Number(row),
        security,
      }))
      const foreign: ImportAmountsIn[] = (preview?.foreign_lines ?? []).map((line) => ({
        symbol: line.symbol,
        currency: line.currency,
        amounts_in: amountsIn[line.symbol] ?? 'base',
      }))
      return dataApi.commitImport(token, associate, foreign)
    },
    onSuccess: (receipt) => {
      // Every figure in the product is downstream of the ledger.
      void client.invalidateQueries()
      toast.success(t('import.done', { count: receipt.imported }))
      void navigate({ to: '/ledger', search: {} })
    },
  })

  // A file chosen on the empty ledger arrives here already picked: read it as
  // soon as an account is there to read it against.
  useEffect(() => {
    if (target === undefined) return
    const handed = takeHandover()
    if (!handed) return
    setFile(handed)
    read.mutate({ file: handed, account: target })
  }, [target, read.mutate])

  const failure = oneFailure(readConditions({ queries: [accounts] }))
  if (failure !== null) return <Unreadable failure={failure} />
  if (!accounts.data) return null

  const back = (
    <Link
      to="/ledger"
      search={{}}
      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft aria-hidden className="size-3.5" />
      {t('nav.ledger')}
    </Link>
  )

  if (declared.length === 0) {
    return (
      <EmptyState
        title={t('import.noAccount.title')}
        description={t('import.noAccount.body')}
        action={
          <Link to="/accounts" search={{}} className="font-medium underline underline-offset-4">
            {t('import.noAccount.link')}
          </Link>
        }
      />
    )
  }

  const pick = (next: File) => {
    setFile(next)
    commit.reset()
    reading(next)
  }

  // A file that names an account on its lines does not need the first account
  // of the list standing in for the rest: until one is picked (or when only one
  // exists) the control says so instead of quietly choosing.
  const blank = preview?.has_accounts === true && account === undefined && declared.length > 1
  const options = declared.map((entry) => ({ value: entry.id, label: entry.label ?? entry.id }))
  const into = (
    <FilterButton
      label={t('import.into')}
      options={blank ? [{ value: '', label: t('import.into.choose') }, ...options] : options}
      value={blank ? '' : (target ?? '')}
      onChange={(next) => {
        if (next === '') return
        setAccount(next)
        if (file) reading(file, { account: next })
      }}
    />
  )

  // Before any file: where it goes, and the door.
  if (file === null) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          {back}
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            {t('import.into')}&nbsp;{into}
          </span>
        </div>
        <UploadZone onFile={pick} disabled={read.isPending} />
        <div>
          <FormatDocsButton />
        </div>
      </div>
    )
  }

  const anotherFile = (
    <Button
      type="button"
      disabled={read.isPending || commit.isPending}
      onClick={() => setFile(null)}
    >
      {t('import.otherFile')}
    </Button>
  )

  if (read.isPending && !preview) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          {back}
          {anotherFile}
        </div>
        <p role="status" className="text-muted-foreground">
          {t('import.reading', { file: file.name })}
        </p>
      </div>
    )
  }

  if (read.error || !preview) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          {back}
          {anotherFile}
        </div>
        <p role="alert" className="text-destructive">
          {problemSentence(t, read.error)}
        </p>
      </div>
    )
  }

  return (
    <Reading
      preview={preview}
      accountNames={Object.fromEntries(declared.map((a) => [a.id, a.label ?? a.id]))}
      file={file}
      back={back}
      into={into}
      tab={tab}
      onTab={(next) => {
        setTab(next)
        setAll(false)
      }}
      all={all}
      onAll={() => setAll(true)}
      resolved={resolved}
      onResolve={(row, symbol) =>
        setResolved((current) => {
          const { [row]: _, ...rest } = current
          return symbol === '' ? rest : { ...rest, [row]: symbol }
        })
      }
      currency={currency}
      needsAccount={blank && preview.unnamed_rows > 0}
      amountsIn={amountsIn}
      onAmountsIn={(symbol, next) => setAmountsIn((current) => ({ ...current, [symbol]: next }))}
      pending={read.isPending || commit.isPending}
      error={commit.error}
      anotherFile={anotherFile}
      onCommit={() => commit.mutate(preview.token)}
    />
  )
}

interface ReadingProps {
  preview: Preview
  accountNames: Readonly<Record<string, string>>
  file: File
  back: React.ReactNode
  into: React.ReactNode
  tab: Tab
  onTab: (tab: Tab) => void
  all: boolean
  onAll: () => void
  resolved: Readonly<Record<number, string>>
  onResolve: (row: number, symbol: string) => void
  currency: string | null
  /** Some lines name no account and none was picked to receive them. */
  needsAccount: boolean
  amountsIn: Readonly<Record<string, AmountsIn>>
  onAmountsIn: (symbol: string, next: AmountsIn) => void
  pending: boolean
  error: unknown
  anotherFile: React.ReactNode
  onCommit: () => void
}

function Reading({
  preview,
  accountNames,
  file,
  back,
  into,
  tab,
  onTab,
  all,
  onAll,
  resolved,
  onResolve,
  currency,
  needsAccount,
  amountsIn,
  onAmountsIn,
  pending,
  error,
  anotherFile,
  onCommit,
}: ReadingProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const mobile = useIsMobile()
  const importing = preview.counts.new + Object.keys(resolved).length
  const rows = useMemo(
    () => (tab === 'all' ? preview.rows : preview.rows.filter((row) => row.status === tab)),
    [preview.rows, tab],
  )
  const drawn = all ? rows : rows.slice(0, SHOWN)
  const statuses = (['new', 'duplicate', 'unknown_security', 'unreadable'] as const).filter(
    (status) => preview.counts[status] > 0,
  )

  if (preview.rows.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          {back}
          {anotherFile}
        </div>
        <EmptyState title={t('import.empty.title')} description={t('import.empty.body')} />
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          {back}
          <span className="min-w-0 truncate font-medium">{file.name}</span>
          <span className="fig text-sm whitespace-nowrap text-muted-foreground">
            {t('import.lines', { count: preview.rows.length })} · {f.bytes(file.size)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {anotherFile}
          <Button
            type="button"
            variant="primary"
            disabled={pending || importing === 0 || needsAccount}
            onClick={onCommit}
          >
            {t('import.commit', { count: importing })}
          </Button>
        </div>
      </div>
      {needsAccount ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('import.unnamed.pick')}</p>
      ) : null}
      <CurrencyQuestion
        preview={preview}
        amountsIn={amountsIn}
        onAmountsIn={onAmountsIn}
        disabled={pending}
      />
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {problemSentence(t, error)}
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-end justify-between gap-x-4 border-b">
        <div className="max-w-full min-w-0 overflow-x-auto">
          <TextTabs
            label={t('import.tabs.label')}
            value={tab}
            onChange={onTab}
            className="border-b-0 whitespace-nowrap"
            tabs={[
              {
                value: 'all' as const,
                label: (
                  <>
                    {t('import.tab.all')} <span className="fig">{preview.rows.length}</span>
                  </>
                ),
              },
              ...statuses.map((status) => ({
                value: status,
                label: (
                  <>
                    {t(`import.tab.${status}`)}{' '}
                    <span className="fig">{preview.counts[status]}</span>
                  </>
                ),
              })),
            ]}
          />
        </div>
        <div className="flex items-center gap-5 pb-3">
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            {t(preview.has_accounts ? 'import.intoUnnamed' : 'import.into')}&nbsp;{into}
          </span>
        </div>
      </div>

      {mobile ? (
        <ul aria-label={t('import.table')} className="mt-2 flex flex-col">
          {drawn.map((row) => (
            <RuledLine
              key={row.row}
              row={row}
              currency={currency}
              accounts={preview.has_accounts ? accountNames : null}
              resolved={resolved[row.row]}
              onResolve={(symbol) => onResolve(row.row, symbol)}
              disabled={pending}
            />
          ))}
        </ul>
      ) : (
        <Table>
          <caption className="sr-only">{t('import.table')}</caption>
          <TableHeader className="[&_th]:pt-4">
            <TableRow>
              <TableHead>{t('import.column.row')}</TableHead>
              <TableHead>{t('data.column.date')}</TableHead>
              <TableHead>{t('data.column.type')}</TableHead>
              {preview.has_accounts ? <TableHead>{t('import.column.account')}</TableHead> : null}
              <TableHead>{t('data.column.what')}</TableHead>
              <TableHead numeric>{t('data.column.quantity')}</TableHead>
              <TableHead numeric>{t('data.column.unitPrice')}</TableHead>
              <TableHead numeric>{t('data.column.amount')}</TableHead>
              <TableHead>{t('import.column.issue')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drawn.map((row) => (
              <Line
                key={row.row}
                row={row}
                currency={currency}
                accounts={preview.has_accounts ? accountNames : null}
                resolved={resolved[row.row]}
                onResolve={(symbol) => onResolve(row.row, symbol)}
                disabled={pending}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {drawn.length < rows.length ? (
        <p className="pt-4 text-sm text-muted-foreground">
          {t('import.more', { count: rows.length - drawn.length })} ·{' '}
          <button
            type="button"
            className="underline decoration-border underline-offset-3 hover:text-foreground"
            onClick={onAll}
          >
            {t('import.showAll')}
          </button>
        </p>
      ) : null}
    </div>
  )
}

/** The row as the ledger's own helpers read an event: `null` where the line has no type. */
function asEvent(row: ImportPreviewRow): LedgerEvent | null {
  if (row.event_type === null) return null
  return {
    date: row.date,
    event_type: row.event_type,
    symbol: row.symbol,
    name: row.name,
    quantity: row.quantity,
    unit_price: row.unit_price,
    fee: row.fee,
    amount: row.amount,
    notes: row.notes,
    account: '',
  }
}

/** The sentence of an unreadable line, in French, from the code the server gave it. */
function Reason({ row }: { row: ImportPreviewRow }) {
  const { t } = useI18n()
  const code = row.reason_code ?? 'other'
  const values = row.reason_values ?? {}
  // `import.reason.<code>`; a code this catalogue does not know reads as *other*.
  const named = `import.reason.${code === 'bad_kind' && !values.value ? 'empty_kind' : code}`
  const key = isMessageKey(named) ? named : 'import.reason.other'
  const fieldKey = `import.reason.field.${(values.field ?? '').replace(' ', '_')}`
  const field = isMessageKey(fieldKey) ? fieldKey : undefined
  return (
    <span className="block text-xs text-muted-foreground">
      {t(key, {
        value: values.value ?? '',
        field: field === undefined ? (values.field ?? '') : t(field),
      })}
    </span>
  )
}

/**
 * The line on a phone: what it is on the first row, its figure on the right, its
 * date, type and numbers under it, and its Issue under that. A ruled row, not a
 * card (DESIGN.md): the Issue is never a column that can leave the screen.
 */
function RuledLine({
  row,
  currency,
  accounts,
  resolved,
  onResolve,
  disabled,
}: {
  row: ImportPreviewRow
  currency: string | null
  accounts: Readonly<Record<string, string>> | null
  resolved: string | undefined
  onResolve: (symbol: string) => void
  disabled: boolean
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const event = asEvent(row)
  const settled = resolved !== undefined
  const skipped = row.status === 'duplicate'
  const detail = [
    row.date ? f.date(row.date) : null,
    row.event_type ? t(TYPE_LABEL[row.event_type]) : null,
    row.quantity === null || row.unit_price === null
      ? null
      : `${f.quantity(row.quantity)} × ${f.currency(row.unit_price, currency)}`,
    accounts && row.account ? (accounts[row.account] ?? row.account) : null,
  ].filter(Boolean)
  return (
    <li className={cn('border-b py-3', skipped && 'text-muted-foreground')}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium">
          {settled ? resolved : (row.name ?? row.symbol ?? ABSENT)}
        </span>
        <span className="fig font-medium whitespace-nowrap">
          {event ? <EventFigure event={event} currency={currency} /> : ABSENT}
        </span>
      </div>
      <div className="fig mt-0.5 text-xs text-muted-foreground">
        {t('import.column.row')} {row.row}
        {detail.length > 0 ? ` · ${detail.join(' · ')}` : ''}
      </div>
      <div className="mt-1.5 text-sm">
        <Issue row={row} resolved={resolved} onResolve={onResolve} disabled={disabled} />
      </div>
    </li>
  )
}

/** What the owner is asked when a file states no unit for its amounts: one line per foreign security. */
function CurrencyQuestion({
  preview,
  amountsIn,
  onAmountsIn,
  disabled,
}: {
  preview: Preview
  amountsIn: Readonly<Record<string, AmountsIn>>
  onAmountsIn: (symbol: string, next: AmountsIn) => void
  disabled: boolean
}) {
  const { t } = useI18n()
  const base = preview.base_currency
  if (base === null || (preview.foreign_lines.length === 0 && preview.unverified.length === 0)) {
    return null
  }
  return (
    <section aria-label={t('import.currency.title')} className="mt-4 flex flex-col gap-2 text-sm">
      {preview.foreign_lines.map((line) => (
        <p key={line.symbol} className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span>
            {t('import.currency.line', {
              symbol: line.symbol,
              currency: line.currency,
              rows: line.rows,
            })}
          </span>
          <span className={cn(disabled && 'pointer-events-none opacity-60')}>
            <FilterButton<AmountsIn>
              label={t('import.currency.title')}
              neutral="base"
              value={amountsIn[line.symbol] ?? 'base'}
              onChange={(next) => onAmountsIn(line.symbol, next)}
              options={[
                { value: 'base', label: t('import.currency.base', { currency: base }) },
                { value: 'quote', label: t('import.currency.quote', { currency: line.currency }) },
              ]}
            />
          </span>
        </p>
      ))}
      {preview.unverified.length > 0 ? (
        <p className="text-muted-foreground">
          {t('import.currency.unverified', {
            symbols: preview.unverified.join(', '),
            currency: base,
          })}
        </p>
      ) : null}
    </section>
  )
}

function Line({
  row,
  currency,
  accounts,
  resolved,
  onResolve,
  disabled,
}: {
  row: ImportPreviewRow
  currency: string | null
  accounts: Readonly<Record<string, string>> | null
  resolved: string | undefined
  onResolve: (symbol: string) => void
  disabled: boolean
}) {
  const f = useFormatters()
  const event = asEvent(row)
  const settled = resolved !== undefined
  // A skipped line reads as history: muted all along.
  const skipped = row.status === 'duplicate'
  const sub = [row.symbol ?? row.isin, row.notes].filter(Boolean).join(' · ')
  return (
    <TableRow tall className={skipped ? 'text-muted-foreground' : undefined}>
      <TableCell className="fig text-muted-foreground">{row.row}</TableCell>
      <TableCell className="fig">{row.date ? f.date(row.date) : ABSENT}</TableCell>
      <TableCell>{row.event_type ? <TypeWord type={row.event_type} /> : ABSENT}</TableCell>
      {accounts ? (
        <TableCell>{row.account ? (accounts[row.account] ?? row.account) : ABSENT}</TableCell>
      ) : null}
      <TableCell className="max-w-0 min-w-48">
        <span className="block truncate font-medium">
          {settled ? resolved : (row.name ?? row.symbol ?? ABSENT)}
        </span>
        {sub === '' ? null : (
          <span className="block truncate text-xs text-muted-foreground">{sub}</span>
        )}
      </TableCell>
      <TableCell numeric>{row.quantity === null ? ABSENT : f.quantity(row.quantity)}</TableCell>
      <TableCell numeric>
        {row.unit_price === null ? ABSENT : f.currency(row.unit_price, currency)}
      </TableCell>
      <TableCell numeric className="font-medium">
        {event ? <EventFigure event={event} currency={currency} /> : ABSENT}
      </TableCell>
      <TableCell>
        <Issue row={row} resolved={resolved} onResolve={onResolve} disabled={disabled} />
      </TableCell>
    </TableRow>
  )
}

/** What becomes of one line: a word, and for a stranger a way to name it. */
function Issue({
  row,
  resolved,
  onResolve,
  disabled,
}: {
  row: ImportPreviewRow
  resolved: string | undefined
  onResolve: (symbol: string) => void
  disabled: boolean
}) {
  const { t } = useI18n()
  const [asking, setAsking] = useState(false)

  if (row.status === 'new') {
    return <span className="text-muted-foreground">{t('import.issue.new')}</span>
  }
  if (row.status === 'duplicate') {
    const matched = (row.matched_on ?? []).map((criterion) => t(CRITERIA[criterion]))
    const same =
      matched.length > 1
        ? matched.length === 2
          ? t('import.issue.and', { first: matched[0], second: matched[1] })
          : matched.join(', ')
        : matched.join('')
    return (
      <span className="text-foreground">
        {matched.length === 0
          ? t('import.issue.duplicate')
          : `${t('import.issue.duplicate')} · ${t('import.issue.same', { same })}`}
      </span>
    )
  }
  if (row.status === 'unreadable') {
    return (
      <span className="block min-w-0">
        <span className="inline-flex items-center gap-1.5">
          <TriangleAlert aria-hidden className="size-3.5" />
          {t('import.issue.unreadable')}
        </span>
        <Reason row={row} />
      </span>
    )
  }
  // `unknown_security`
  if (resolved !== undefined) {
    return (
      <span className="flex items-center justify-between gap-3">
        <span>{t('import.associated', { symbol: resolved })}</span>
        <Button type="button" size="sm" disabled={disabled} onClick={() => onResolve('')}>
          {t('import.associate.undo')}
        </Button>
      </span>
    )
  }
  return (
    <span className="flex items-center justify-between gap-3">
      {asking ? (
        <Associate
          row={row}
          onPick={(symbol) => {
            onResolve(symbol)
            setAsking(false)
          }}
        />
      ) : (
        <>
          <span className="inline-flex items-center gap-1.5">
            <TriangleAlert aria-hidden className="size-3.5" />
            {t('import.issue.unknown')}
          </span>
          <Button type="button" size="sm" disabled={disabled} onClick={() => setAsking(true)}>
            {t('import.associate')}
          </Button>
        </>
      )}
    </span>
  )
}

/** The ticker of a line the app could not name: type one, or take Yahoo's, seeded with the ISIN. */
function Associate({ row, onPick }: { row: ImportPreviewRow; onPick: (symbol: string) => void }) {
  const { t } = useI18n()
  const id = useId()
  const [typed, setTyped] = useState('')
  const [asked, setAsked] = useState('')
  useEffect(() => {
    const pause = setTimeout(() => setAsked(typed.trim()), SEARCH_PAUSE_MS)
    return () => clearTimeout(pause)
  }, [typed])
  // Until something is typed, the ISIN is the best question there is.
  const query = asked.length >= SEARCH_MIN ? asked : (row.isin ?? '')
  const searched = useQuery({
    queryKey: ['securities', query],
    queryFn: () => dataApi.searchSecurities(query),
    enabled: query.length >= SEARCH_MIN && query.length <= SEARCH_MAX,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const items: ComboboxItem[] = (searched.data?.securities ?? []).map((line) => ({
    value: line.symbol,
    label: line.symbol,
    hint: [line.name, line.exchange].filter(Boolean).join(' · ') || null,
    mono: true,
  }))
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {t('import.associate.label', { row: row.row })}
      </label>
      <Combobox
        id={id}
        autoFocus
        value={typed}
        items={items}
        placeholder={t('import.associate.placeholder')}
        listLabel={t('data.form.symbol.suggestions')}
        onValueChange={(next, chosen) => {
          setTyped(next)
          if (chosen) onPick(next)
        }}
        // A ticker typed by hand is taken when the field is left.
        onBlur={() => {
          if (typed.trim() !== '') onPick(typed.trim())
        }}
      />
    </>
  )
}
