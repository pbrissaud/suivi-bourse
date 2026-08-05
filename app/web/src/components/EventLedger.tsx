import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, LockIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react'

import {
  ApiProblem,
  api,
  EVENT_COLUMNS,
  type DeclaredAccount,
  type EventColumn,
  type EventDraft,
  type LedgerEvent,
  type WriteResult,
} from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/**
 * The event ledger — one table over every file, and the page's whole point.
 *
 * #652 déc. 14 fixed the shape: the files are **merged and sorted by date**,
 * with the file itself a discreet column rather than a hierarchy. A ledger
 * organised by file would be organising by an accident of how the user chose to
 * split their exports; what they think in is dates.
 *
 * Editing is **inline** rather than in a sheet, and against the app's own
 * grammar on purpose. The row that most needs editing is the one carrying an
 * error, and its error message is printed right under it — putting the form
 * somewhere else would separate the complaint from the correction. It is also
 * the shape a spreadsheet has, which is what these files are.
 *
 * The trap the whole component is built around: **an event's id changes when an
 * event before it in the same file is deleted**, because the id is an address
 * and not a content hash (#653 — duplicate events are legitimate, so a hash
 * would collide). So every write invalidates the collection and refetches; the
 * cache is never patched in place.
 */

const LABELS: Record<EventColumn, string> = {
  date: 'Date',
  event_type: 'Type',
  symbol: 'Symbole',
  name: 'Nom',
  quantity: 'Quantité',
  unit_price: 'Prix unitaire',
  fee: 'Frais',
  amount: 'Montant',
  notes: 'Notes',
  account: 'Compte',
}

const TYPES = ['BUY', 'SELL', 'GRANT', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL'] as const

/** The typed fields back as cells, which is what the write endpoints take. */
function toDraft(event: LedgerEvent): EventDraft {
  if (event.cells) return { ...event.cells } as EventDraft
  const draft: EventDraft = {}
  for (const column of EVENT_COLUMNS) {
    const value = event[column as keyof LedgerEvent]
    draft[column] = value === null || value === undefined ? '' : String(value)
  }
  return draft
}

function cellText(event: LedgerEvent, column: EventColumn): string {
  if (event.cells) return event.cells[column] ?? ''
  const value = event[column as keyof LedgerEvent]
  return value === null || value === undefined ? '' : String(value)
}

export function EventLedger({
  editable,
  accounts,
}: {
  editable: boolean
  accounts: DeclaredAccount[]
}) {
  const client = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<EventDraft>({})
  const [creating, setCreating] = useState(false)
  const [filters, setFilters] = useState({ type: '', symbol: '', account: '', file: '' })
  const [problem, setProblem] = useState<ApiProblem | null>(null)
  const [outcome, setOutcome] = useState<WriteResult | null>(null)

  const events = useQuery({ queryKey: ['events'], queryFn: () => api.events() })

  /** Every write ends the same way, because every write can shift an address. */
  const settle = (result: WriteResult) => {
    setProblem(null)
    setOutcome(result)
    setEditing(null)
    setCreating(false)
    client.invalidateQueries({ queryKey: ['events'] })
    client.invalidateQueries({ queryKey: ['eventFiles'] })
    // A saved event changes positions, cash and therefore every page. Cheaper
    // to drop the lot than to reason about which figure moved.
    client.invalidateQueries({ queryKey: ['shares'] })
    client.invalidateQueries({ queryKey: ['accounts'] })
    client.invalidateQueries({ queryKey: ['portfolio'] })
  }

  const fail = (error: unknown) => {
    setOutcome(null)
    setProblem(
      error instanceof ApiProblem
        ? error
        : new ApiProblem({ status: 0, title: String(error) }),
    )
  }

  const save = useMutation({
    mutationFn: ({ id, etag }: { id: string; etag: string }) =>
      api.updateEvent(id, etag, draft),
    onSuccess: settle,
    onError: fail,
  })

  const create = useMutation({
    mutationFn: () => api.createEvent(draft),
    onSuccess: settle,
    onError: fail,
  })

  const remove = useMutation({
    mutationFn: ({ id, etag }: { id: string; etag: string }) => api.deleteEvent(id, etag),
    onSuccess: settle,
    onError: fail,
  })

  const rows = events.data ?? []

  const files = useMemo(
    () => [...new Set(rows.map((row) => row.source))].sort(),
    [rows],
  )
  const symbols = useMemo(
    () => [...new Set(rows.map((row) => row.symbol).filter(Boolean) as string[])].sort(),
    [rows],
  )

  // Sorted by date — the merge #652 déc. 14 asks for. Newest first: a ledger is
  // opened to check what just happened, not to read it from the beginning.
  // Rows that failed to parse have no usable date, so they float to the top,
  // which is also where they are most useful.
  const visible = useMemo(() => {
    return rows
      .filter((row) => !filters.type || row.event_type === filters.type)
      .filter((row) => !filters.symbol || row.symbol === filters.symbol)
      .filter((row) => !filters.account || row.account === filters.account)
      .filter((row) => !filters.file || row.source === filters.file)
      .slice()
      .sort((a, b) => {
        if (!a.date) return -1
        if (!b.date) return 1
        return b.date.localeCompare(a.date)
      })
  }, [rows, filters])

  const startEdit = (event: LedgerEvent) => {
    setProblem(null)
    setOutcome(null)
    setEditing(event.id)
    setDraft(toDraft(event))
  }

  const startCreate = () => {
    setProblem(null)
    setOutcome(null)
    setEditing(null)
    setDraft({
      date: new Date().toISOString().slice(0, 10),
      event_type: 'BUY',
      account: accounts.length === 1 ? accounts[0].id : '',
    })
    setCreating(true)
  }

  const brokenCount = rows.filter((row) => row.error).length

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Journal des événements</h2>
          <p className="text-sm text-muted-foreground">
            Tous vos fichiers fusionnés et triés par date. Le fichier d'origine
            reste indiqué en fin de ligne.
          </p>
        </div>
        {editable && (
          <Button onClick={startCreate}>
            <PlusIcon /> Ajouter un événement
          </Button>
        )}
      </div>

      <Filters
        filters={filters}
        onChange={setFilters}
        files={files}
        symbols={symbols}
        accounts={accounts}
      />

      {/* The two outcomes of a write, and they are not the same news. A refusal
          changed nothing; a save whose reload failed changed the file and left
          the app on its previous configuration. */}
      {problem && <WriteProblem problem={problem} />}
      {outcome && <WriteOutcome result={outcome} onDismiss={() => setOutcome(null)} />}

      {events.isError && (
        <Alert variant="destructive">
          <AlertTitle>Journal indisponible</AlertTitle>
          <AlertDescription>{(events.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {brokenCount > 0 && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>
            {brokenCount} ligne{brokenCount > 1 ? 's' : ''} illisible
            {brokenCount > 1 ? 's' : ''}
          </AlertTitle>
          <AlertDescription>
            Tant qu'une ligne est illisible, l'application tourne sur la dernière
            configuration valide et <strong>refusera de démarrer</strong> au
            prochain redémarrage. Corrigez-les ici&nbsp;: leur contenu brut est
            éditable ligne par ligne.
          </AlertDescription>
        </Alert>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {EVENT_COLUMNS.map((column) => (
                <TableHead key={column}>{LABELS[column]}</TableHead>
              ))}
              <TableHead>Fichier</TableHead>
              <TableHead className="text-right">{editable ? 'Actions' : ''}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((event) =>
              editing === event.id ? (
                <EditRow
                  key={event.id}
                  event={event}
                  draft={draft}
                  onChange={setDraft}
                  onCancel={() => setEditing(null)}
                  onSave={() => save.mutate({ id: event.id, etag: event.etag })}
                  saving={save.isPending}
                />
              ) : (
                <ReadRow
                  key={event.id}
                  event={event}
                  editable={editable}
                  onEdit={() => startEdit(event)}
                  onDelete={() => {
                    if (window.confirm(`Supprimer cet événement de ${event.source} ?`)) {
                      remove.mutate({ id: event.id, etag: event.etag })
                    }
                  }}
                />
              ),
            )}
            {visible.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={EVENT_COLUMNS.length + 2}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {rows.length === 0
                    ? "Aucun événement. Ajoutez-en un, ou importez un fichier d'export de votre courtier."
                    : 'Aucun événement ne correspond à ces filtres.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Sheet open={creating} onOpenChange={(open) => !open && setCreating(false)}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Nouvel événement</SheetTitle>
            <SheetDescription>
              La ligne est validée avant d'être écrite&nbsp;: si elle rend le
              portefeuille incohérent, rien n'est enregistré.
            </SheetDescription>
          </SheetHeader>

          <div className="grid gap-3 overflow-y-auto px-4 pb-4">
            {EVENT_COLUMNS.map((column) => (
              <div key={column} className="grid gap-1.5">
                <Label htmlFor={`new-${column}`}>{LABELS[column]}</Label>
                <Field
                  id={`new-${column}`}
                  column={column}
                  value={draft[column] ?? ''}
                  accounts={accounts}
                  onChange={(value) => setDraft({ ...draft, [column]: value })}
                />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Les champs attendus dépendent du type&nbsp;: un{' '}
              <code>DEPOSIT</code> ne porte ni titre ni quantité, un{' '}
              <code>DIVIDEND</code> porte un montant et pas de prix unitaire.
            </p>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              Enregistrer
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </section>
  )
}

function ReadRow({
  event,
  editable,
  onEdit,
  onDelete,
}: {
  event: LedgerEvent
  editable: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const writable = editable && event.editable

  return (
    <>
      <TableRow className={event.error ? 'bg-destructive/5' : undefined}>
        {EVENT_COLUMNS.map((column) => (
          <TableCell
            key={column}
            className={
              column === 'notes' ? 'max-w-40 truncate text-muted-foreground' : undefined
            }
          >
            {cellText(event, column) || <span className="text-muted-foreground">—</span>}
          </TableCell>
        ))}
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
          {event.source}
          {/* The lock badge #652 déc. 14 asks for. A workbook is read here and
              never written: openpyxl loads it with its formulas already
              evaluated, so saving would put the values over them. */}
          {!event.editable && (
            <Badge variant="outline" className="ml-1.5">
              <LockIcon /> xlsx
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-right whitespace-nowrap">
          {writable && (
            <>
              <Button variant="ghost" size="icon-xs" onClick={onEdit} aria-label="Modifier">
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onDelete}
                aria-label="Supprimer"
              >
                <Trash2Icon />
              </Button>
            </>
          )}
        </TableCell>
      </TableRow>

      {/* The complaint sits directly under the row it is about — which is the
          argument for editing inline rather than in a sheet. */}
      {event.error && (
        <TableRow className="bg-destructive/5 hover:bg-destructive/5">
          <TableCell colSpan={EVENT_COLUMNS.length + 2} className="pt-0 text-xs text-destructive">
            {event.error}
            {!event.editable &&
              " — cette ligne est dans un classeur : convertissez le fichier en CSV pour pouvoir la corriger ici."}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function EditRow({
  event,
  draft,
  onChange,
  onCancel,
  onSave,
  saving,
}: {
  event: LedgerEvent
  draft: EventDraft
  onChange: (draft: EventDraft) => void
  onCancel: () => void
  onSave: () => void
  saving: boolean
}) {
  return (
    <>
      <TableRow className="bg-muted/50">
        {EVENT_COLUMNS.map((column) => (
          <TableCell key={column} className="p-1">
            <Field
              column={column}
              value={draft[column] ?? ''}
              onChange={(value) => onChange({ ...draft, [column]: value })}
              onSubmit={onSave}
              onCancel={onCancel}
            />
          </TableCell>
        ))}
        <TableCell className="text-xs text-muted-foreground">{event.source}</TableCell>
        {/* Pinned to the right edge, which is not decoration: ten inputs make
            the row wider than the viewport, so an ordinary last cell scrolls
            out of sight and the save button is only findable by dragging the
            table sideways — away from the field being corrected. */}
        <TableCell className="sticky right-0 bg-muted text-right whitespace-nowrap">
          <Button size="xs" onClick={onSave} disabled={saving}>
            Enregistrer
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onCancel} aria-label="Annuler">
            <XIcon />
          </Button>
        </TableCell>
      </TableRow>

      {/* The complaint stays on screen while it is being answered. Dropping it
          the moment the editor opens takes away the only statement of what to
          change, at the exact moment the user needs it. */}
      {event.error && (
        <TableRow className="bg-muted/50 hover:bg-muted/50">
          <TableCell colSpan={EVENT_COLUMNS.length + 2} className="pt-0 text-xs text-destructive">
            {event.error}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

/**
 * One editable cell.
 *
 * Deliberately a free-text input for every column, including the type and the
 * account. A `select` would be friendlier and would also make it **impossible
 * to see** what a broken row actually contains — and repairing a broken row is
 * the reason the inline editor exists. The server is the authority on what is
 * valid, and it answers with the validator's own words.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function Field({
  id,
  column,
  value,
  accounts,
  onChange,
  onSubmit,
  onCancel,
}: {
  id?: string
  column: EventColumn
  value: string
  accounts?: DeclaredAccount[]
  onChange: (value: string) => void
  onSubmit?: () => void
  onCancel?: () => void
}) {
  const numeric = ['quantity', 'unit_price', 'fee', 'amount'].includes(column)

  /**
   * The date picker, **but only over a value it can hold**.
   *
   * Found by opening the editor on a broken row: `<input type="date">` silently
   * discards anything it cannot parse, so the cell reading `pas-une-date`
   * rendered as an empty picker — the defect invisible in the one place built
   * to show it. Falling back to a text field keeps the bad value on screen,
   * which is the entire reason the API sends the raw cells back. A number field
   * does the same thing for `1 250,00`, so it takes the same rule.
   */
  const malformed = value !== '' && (column === 'date' ? !ISO_DATE.test(value) : numeric && Number.isNaN(Number(value)))
  const type = malformed ? 'text' : column === 'date' ? 'date' : numeric ? 'number' : 'text'

  return (
    <>
      <Input
        id={id}
        list={
          column === 'event_type'
            ? 'event-types'
            : column === 'account' && accounts?.length
              ? 'event-accounts'
              : undefined
        }
        type={type}
        step={numeric ? 'any' : undefined}
        placeholder={column === 'date' ? 'AAAA-MM-JJ' : undefined}
        aria-invalid={malformed || undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // The grid a spreadsheet trains for: Enter commits, Escape backs out.
        // Without it the only way to save is a button that lives past the right
        // edge of a row ten inputs wide.
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit?.()
          if (e.key === 'Escape') onCancel?.()
        }}
        className={numeric ? 'w-24' : column === 'date' ? 'w-36' : 'w-32'}
      />
      {/* Datalists, not selects: they suggest without forbidding, so a value the
          app does not recognise stays visible and correctable. */}
      {column === 'event_type' && (
        <datalist id="event-types">
          {TYPES.map((type) => (
            <option key={type} value={type} />
          ))}
        </datalist>
      )}
      {column === 'account' && accounts?.length ? (
        <datalist id="event-accounts">
          {accounts.map((account) => (
            <option key={account.id} value={account.id} />
          ))}
        </datalist>
      ) : null}
    </>
  )
}

function Filters({
  filters,
  onChange,
  files,
  symbols,
  accounts,
}: {
  filters: { type: string; symbol: string; account: string; file: string }
  onChange: (filters: { type: string; symbol: string; account: string; file: string }) => void
  files: string[]
  symbols: string[]
  accounts: DeclaredAccount[]
}) {
  const select = (key: keyof typeof filters, label: string, options: string[]) => (
    <select
      key={key}
      aria-label={label}
      value={filters[key]}
      onChange={(e) => onChange({ ...filters, [key]: e.target.value })}
      className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
    >
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  )

  return (
    <div className="flex flex-wrap gap-2">
      {select('type', 'Tous les types', [...TYPES])}
      {select('symbol', 'Tous les titres', symbols)}
      {accounts.length > 0 && select('account', 'Tous les comptes', accounts.map((a) => a.id))}
      {files.length > 1 && select('file', 'Tous les fichiers', files)}
    </div>
  )
}

export function WriteProblem({ problem }: { problem: ApiProblem }) {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>
        {problem.status === 409
          ? 'Cette ligne a changé entre-temps'
          : problem.status === 422
            ? 'Enregistrement refusé — rien n\'a été écrit'
            : problem.title}
      </AlertTitle>
      <AlertDescription>
        {problem.status === 409 ? (
          <p>
            Le fichier a été modifié depuis l'affichage de ce journal. Rechargez
            la page&nbsp;: sans cette vérification, la modification serait partie
            sur une autre ligne.
          </p>
        ) : (
          <p>{problem.detail ?? problem.message}</p>
        )}
        {problem.errors.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-xs">
            {problem.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function WriteOutcome({
  result,
  onDismiss,
}: {
  result: WriteResult
  onDismiss: () => void
}) {
  if (result.reloaded) {
    return (
      <Alert>
        <AlertTitle>Enregistré{result.source ? ` dans ${result.source}` : ''}</AlertTitle>
        <AlertDescription>
          La configuration a été rechargée&nbsp;; les positions et la performance
          suivront au prochain cycle.{' '}
          <button className="underline" onClick={onDismiss}>
            Masquer
          </button>
        </AlertDescription>
      </Alert>
    )
  }

  /* The half-state, and it is a real one: the write landed and the
     configuration still does not load. Saying "saved" alone would be a lie by
     omission — the user would edit three rows and wonder why nothing moves. */
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>Écrit, mais la configuration reste invalide</AlertTitle>
      <AlertDescription>
        <p>
          Votre modification est bien dans le fichier. L'application continue de
          tourner sur la dernière configuration valide&nbsp;; il reste ceci à
          corriger&nbsp;:
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-xs">
          {result.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
