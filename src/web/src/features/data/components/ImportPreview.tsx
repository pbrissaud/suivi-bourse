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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { accountsApi } from '@/features/accounts/lib/api'
import { EventFigure, TypeWord } from '@/features/data/components/LedgerTable'
import { FormatDocsButton } from '@/features/data/components/FormatDocsButton'
import { UploadZone } from '@/features/data/components/UploadZone'
import { takeHandover } from '@/features/data/lib/handoff'
import {
  dataApi,
  type ImportMatchCriterion,
  type ImportPreview as Preview,
  type ImportPreviewRow,
  type ImportResolution,
  type ImportRowStatus,
  type LedgerEvent,
} from '@/features/data/lib/api'
import { dashboardApi } from '@/features/dashboard/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'
import { oneFailure, readConditions } from '@/lib/status'

/** The lines drawn before *tout afficher*. */
const SHOWN = 25
const SEARCH_PAUSE_MS = 300
const SEARCH_MIN = 2
const SEARCH_MAX = 64

type Tab = 'all' | ImportRowStatus

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
      return dataApi.commitImport(token, associate)
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

  const into = (
    <FilterButton
      label={t('import.into')}
      options={declared.map((entry) => ({ value: entry.id, label: entry.label ?? entry.id }))}
      value={target ?? ''}
      onChange={(next) => {
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
  pending,
  error,
  anotherFile,
  onCommit,
}: ReadingProps) {
  const { t } = useI18n()
  const f = useFormatters()
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
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-baseline gap-2.5">
          {back}
          <span className="truncate font-medium">{file.name}</span>
          <span className="fig text-sm whitespace-nowrap text-muted-foreground">
            {t('import.lines', { count: preview.rows.length })} · {f.bytes(file.size)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {anotherFile}
          <Button
            type="button"
            variant="primary"
            disabled={pending || importing === 0}
            onClick={onCommit}
          >
            {t('import.commit', { count: importing })}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {problemSentence(t, error)}
        </p>
      ) : null}

      <div className="mt-5 flex items-end justify-between gap-4 border-b">
        <TextTabs
          label={t('import.tabs.label')}
          value={tab}
          onChange={onTab}
          className="border-b-0"
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
                  {t(`import.tab.${status}`)} <span className="fig">{preview.counts[status]}</span>
                </>
              ),
            })),
          ]}
        />
        <div className="flex items-center gap-5 pb-3">
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            {t(preview.has_accounts ? 'import.intoUnnamed' : 'import.into')}&nbsp;{into}
          </span>
        </div>
      </div>

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
      <span title={row.reason ?? undefined} className="inline-flex items-center gap-1.5">
        <TriangleAlert aria-hidden className="size-3.5" />
        {t('import.issue.unreadable')}
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
