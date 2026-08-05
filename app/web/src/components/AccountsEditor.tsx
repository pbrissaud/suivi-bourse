import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, Trash2Icon } from 'lucide-react'

import { ApiProblem, api, type DeclaredAccount, type WriteResult } from '@/lib/api'
import { WriteOutcome, WriteProblem } from '@/components/EventLedger'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

/**
 * The `accounts:` block of `settings.yaml`, editable.
 *
 * Hot since #658: `settings.yaml` joined the mtime cache key, so a changed
 * block is picked up by the next reload rather than the next restart. Before
 * that this editor could not have existed — an edited declaration hid behind an
 * unchanged events directory, and the form would have lied.
 *
 * Only this block is rewritten. `mode:` and `events:` keep their exact bytes,
 * comments included: this is a file its owner also edits by hand.
 *
 * The refusal worth understanding is the one that looks harmless — **removing
 * an account the events still name**. Once any account is declared, every event
 * must carry a declared id, so dropping one invalidates every event that used
 * it, and since #658 an invalid configuration is fatal at boot: the failure
 * would land on the next restart, long after the click. The server checks the
 * candidate against the events on disk and refuses; the page shows the events.
 */
export function AccountsEditor({ eventsMode }: { eventsMode: boolean }) {
  const client = useQueryClient()
  const [rows, setRows] = useState<DeclaredAccount[]>([])
  const [dirty, setDirty] = useState(false)
  const [problem, setProblem] = useState<ApiProblem | null>(null)
  const [outcome, setOutcome] = useState<WriteResult | null>(null)

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })

  // Seeded from the server, and re-seeded whenever the server's answer changes
  // — but never over an edit in progress, which would wipe what is being typed
  // the moment a background refetch lands.
  useEffect(() => {
    if (!dirty && accounts.data) {
      setRows(
        accounts.data.accounts.map((account) => ({
          id: account.id,
          label: account.label,
          type: account.type,
          currency: account.currency,
        })),
      )
    }
  }, [accounts.data, dirty])

  const save = useMutation({
    mutationFn: () => api.setAccounts(rows),
    onSuccess: (result) => {
      setProblem(null)
      setOutcome(result)
      setDirty(false)
      client.invalidateQueries({ queryKey: ['accounts'] })
      client.invalidateQueries({ queryKey: ['portfolio'] })
      client.invalidateQueries({ queryKey: ['events'] })
    },
    onError: (error: unknown) => {
      setOutcome(null)
      setProblem(
        error instanceof ApiProblem
          ? error
          : new ApiProblem({ status: 0, title: String(error) }),
      )
    },
  })

  const update = (index: number, patch: Partial<DeclaredAccount>) => {
    setDirty(true)
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const declared = accounts.data?.declared === true

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Comptes déclarés</CardTitle>
        <CardDescription>
          Déclarer des comptes débloque le suivi des liquidités, des versements,
          du TRI et du TWR — par compte et au global.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {problem && <WriteProblem problem={problem} />}
        {outcome && <WriteOutcome result={outcome} onDismiss={() => setOutcome(null)} />}

        {!eventsMode && (
          <Alert>
            <AlertTitle>Sans effet en mode manuel</AlertTitle>
            <AlertDescription>
              La performance par compte se calcule à partir des événements. En
              mode <code>manual</code>, les comptes déclarés ici apparaîtront
              dans l'application mais leurs figures resteront vides.
            </AlertDescription>
          </Alert>
        )}

        {/* The order that works, stated before it is discovered the hard way.
            Declaring the first account makes the column required *retroactively*
            for every event already on disk. */}
        {eventsMode && !declared && (
          <Alert>
            <AlertTitle>Premier compte&nbsp;: renseignez d'abord la colonne</AlertTitle>
            <AlertDescription>
              Dès qu'un compte est déclaré, <strong>chaque</strong> événement
              doit en porter un. Renseignez la colonne <code>account</code> de
              vos événements existants (elle est ignorée tant que rien n'est
              déclaré), puis déclarez les comptes ici. Dans l'autre ordre, la
              déclaration est refusée — et à raison&nbsp;: elle rendrait la
              configuration illisible au prochain démarrage.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Identifiant"
                placeholder="pea"
                value={row.id}
                className="w-32 font-mono"
                onChange={(e) => update(index, { id: e.target.value })}
              />
              <Input
                aria-label="Libellé"
                placeholder="Mon PEA"
                value={row.label}
                className="w-44"
                onChange={(e) => update(index, { label: e.target.value })}
              />
              <Input
                aria-label="Type"
                placeholder="PEA"
                value={row.type}
                className="w-28"
                onChange={(e) => update(index, { type: e.target.value })}
              />
              <Input
                aria-label="Devise"
                placeholder="EUR"
                value={row.currency}
                className="w-24"
                onChange={(e) => update(index, { currency: e.target.value })}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Retirer"
                onClick={() => {
                  setDirty(true)
                  setRows(rows.filter((_, i) => i !== index))
                }}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Aucun compte déclaré. Le portefeuille est suivi au titre près.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDirty(true)
              setRows([...rows, { id: '', label: '', type: 'CTO', currency: 'EUR' }])
            }}
          >
            <PlusIcon /> Ajouter un compte
          </Button>
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Enregistrer
          </Button>
          {/* The id is what every event references, so renaming one is a
              rename of the data too. Said next to the button that does it. */}
          {dirty && (
            <span className="text-xs text-muted-foreground">
              Changer un identifiant impose de changer la colonne{' '}
              <code>account</code> de tous les événements concernés.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
