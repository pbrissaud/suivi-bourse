import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheetIcon, LockIcon, UploadIcon } from 'lucide-react'

import { ApiProblem, api, type WriteResult } from '@/lib/api'
import { WriteOutcome, WriteProblem } from '@/components/EventLedger'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * The files behind the ledger: what to import, and the one escape hatch a
 * workbook has.
 *
 * This is the **only** file-shaped surface in the app, and it is deliberate.
 * #653 keeps the *event* contract free of files and rows so a different store
 * could replace them without touching the front — but "this file cannot be
 * written" and "convert it" are properties of a file and of nothing else, so
 * pretending otherwise would have bought nothing and cost the user the
 * explanation.
 *
 * Importing is stricter than editing, and the page says so: a file that would
 * break the portfolio is refused whole, because the user still holds it and can
 * fix it — where refusing an in-place edit would leave them unable to repair
 * the ledger at all.
 */
export function EventFiles({ editable }: { editable: boolean }) {
  const client = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<ApiProblem | null>(null)
  const [outcome, setOutcome] = useState<WriteResult | null>(null)

  const files = useQuery({ queryKey: ['eventFiles'], queryFn: api.eventFiles })

  const settle = (result: WriteResult) => {
    setProblem(null)
    setOutcome(result)
    client.invalidateQueries({ queryKey: ['events'] })
    client.invalidateQueries({ queryKey: ['eventFiles'] })
    client.invalidateQueries({ queryKey: ['shares'] })
    client.invalidateQueries({ queryKey: ['accounts'] })
    client.invalidateQueries({ queryKey: ['portfolio'] })
  }

  const fail = (error: unknown) => {
    setOutcome(null)
    setProblem(
      error instanceof ApiProblem ? error : new ApiProblem({ status: 0, title: String(error) }),
    )
  }

  const upload = useMutation({
    mutationFn: (file: File) => api.importEventFile(file),
    onSuccess: settle,
    onError: fail,
  })

  const convert = useMutation({
    mutationFn: (name: string) => api.convertEventFile(name),
    onSuccess: settle,
    onError: fail,
  })

  const rows = files.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Fichiers</CardTitle>
        <CardDescription>
          Vos événements vivent dans ces fichiers. Vous pouvez continuer à les
          éditer à la main&nbsp;: l'application les relit à chaque modification.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {problem && <WriteProblem problem={problem} />}
        {outcome && <WriteOutcome result={outcome} onDismiss={() => setOutcome(null)} />}

        <ul className="divide-y rounded-lg border text-sm">
          {rows.map((file) => (
            <li key={file.name} className="flex items-center gap-2 px-3 py-2">
              <span className="font-mono">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                {file.rows} ligne{file.rows > 1 ? 's' : ''}
              </span>
              {!file.editable && (
                <Badge variant="outline">
                  <LockIcon /> lecture seule
                </Badge>
              )}
              <span className="flex-1" />
              {!file.editable && editable && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={convert.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Convertir ${file.name} en CSV ?\n\n` +
                          `Le classeur est conservé sous ${file.name}.bak — il ne sera ` +
                          `simplement plus lu. Les lignes deviennent modifiables ici.`,
                      )
                    ) {
                      convert.mutate(file.name)
                    }
                  }}
                >
                  <FileSpreadsheetIcon /> Convertir en CSV
                </Button>
              )}
            </li>
          ))}
          {rows.length === 0 && (
            <li className="px-3 py-4 text-center text-muted-foreground">
              Aucun fichier d'événements.
            </li>
          )}
        </ul>

        {/* Why a workbook is read-only, said once and next to the badge that
            raises the question — rather than in a tooltip nobody opens. */}
        {rows.some((file) => !file.editable) && (
          <p className="text-xs text-muted-foreground">
            Un classeur <code>.xlsx</code> est lu avec ses formules déjà
            calculées&nbsp;: le réenregistrer écrirait les valeurs{' '}
            <em>par-dessus</em> les formules. Il reste donc en lecture seule. La
            conversion écrit un <code>.csv</code> équivalent et met le classeur
            de côté sans le supprimer.
          </p>
        )}

        {editable && (
          <div className="space-y-1.5">
            <input
              ref={input}
              type="file"
              accept=".csv,.xlsx"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) upload.mutate(file)
                e.target.value = ''
              }}
            />
            <Button
              variant="outline"
              onClick={() => input.current?.click()}
              disabled={upload.isPending}
            >
              <UploadIcon /> Importer un fichier
            </Button>
            <p className="text-xs text-muted-foreground">
              Un <code>.csv</code> ou <code>.xlsx</code> aux colonnes attendues.
              Un fichier qui rendrait le portefeuille incohérent est{' '}
              <strong>refusé en entier</strong>, avec le détail ligne par
              ligne&nbsp;: corrigez-le chez vous et réimportez-le. Un nom déjà
              présent n'est jamais remplacé.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
