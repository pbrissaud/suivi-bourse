/**
 * *Thème* — the theme over the bundled Atelier, kept in the store (#1248).
 *
 * Two ways in from tweakcn: **import by id** (the server's one call to
 * tweakcn.com, on click) or **paste** the JSON of `tweakcn.com/r/themes/<id>`
 * for an instance with no way out. Every write refills the JSON with what the
 * server kept and points `<link href="/api/theme.css">` at a fresh URL, so the
 * page repaints without a reload.
 */
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRightIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Section } from '@/components/ui/section'
import { Textarea } from '@/components/ui/textarea'
import { settingsApi, type ThemeVars } from '@/features/settings/lib/api'
import { ApiProblem } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey, providerRefusal } from '@/lib/problem'

const pretty = (theme: ThemeVars | null) => (theme ? JSON.stringify(theme, null, 2) : '')

/** The stylesheet `index.html` links, fetched again. */
function repaint() {
  const link = document.querySelector<HTMLLinkElement>('link[href^="/api/theme.css"]')
  if (link) link.href = `/api/theme.css?v=${Date.now()}`
}

/** The key a 422 names, when it names one. */
function refusedKey(error: unknown): string | null {
  if (!(error instanceof ApiProblem) || error.status !== 422) return null
  const key = error.members.key
  return typeof key === 'string' && key !== '' ? key : null
}

export function ThemeBlock({ stored }: { stored: ThemeVars | null }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const [id, setId] = useState('')
  const [json, setJson] = useState(() => pretty(stored))
  const [open, setOpen] = useState(false)
  const [unparsable, setUnparsable] = useState<string | null>(null)
  const [done, setDone] = useState<'applied' | 'restored' | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const idField = useRef<HTMLInputElement>(null)

  const kept = (answer: ThemeVars | null) => {
    client.setQueryData(['theme'], answer)
    setJson(pretty(answer))
    setDone(answer ? 'applied' : 'restored')
    repaint()
  }

  const importing = useMutation({
    mutationFn: () => settingsApi.importTheme(id.trim()),
    onSuccess: (answer) => {
      kept(answer)
      setOpen(true)
    },
    onError: () => idField.current?.focus(),
  })
  const applying = useMutation({
    mutationFn: (body: unknown) => settingsApi.saveTheme(body),
    onSuccess: kept,
    onError: () => textarea.current?.focus(),
  })
  const resetting = useMutation({
    mutationFn: settingsApi.resetTheme,
    onSuccess: () => kept(null),
  })

  const edited = () => {
    setDone(null)
    setUnparsable(null)
    importing.reset()
    applying.reset()
  }

  const apply = () => {
    let body: unknown
    try {
      body = JSON.parse(json)
    } catch (error) {
      setUnparsable(error instanceof Error ? error.message : String(error))
      textarea.current?.focus()
      return
    }
    applying.mutate(body)
  }

  const importRefused = importing.isError && refusedKey(importing.error) === 'id'
  const importFailure = providerRefusal(importing.error)
  const jsonKey = refusedKey(applying.error)
  const jsonError =
    unparsable !== null
      ? t('settings.theme.unparsable', { message: unparsable })
      : applying.isError
        ? jsonKey !== null
          ? t('settings.theme.refused', { key: jsonKey })
          : t(problemMessageKey(applying.error))
        : null
  const state =
    done === 'applied'
      ? 'settings.theme.applied'
      : done === 'restored'
        ? 'settings.theme.restored'
        : stored
          ? 'settings.theme.custom'
          : 'settings.theme.bundled'

  return (
    <Section title={t('settings.theme.title')}>
      <div className="space-y-5">
        <p role="status" className="text-sm text-muted-foreground">
          {t(state)}
        </p>
        <div className="space-y-1.5">
          <label htmlFor="theme-id" className="block text-sm">
            {t('settings.theme.import.label')}
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
            <Input
              ref={idField}
              id="theme-id"
              value={id}
              placeholder={t('settings.theme.import.placeholder')}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={importRefused ? true : undefined}
              aria-describedby={importing.isError ? 'theme-id-error' : undefined}
              onChange={(event) => {
                setId(event.target.value)
                edited()
              }}
              className="font-mono"
            />
            <Button
              type="button"
              variant={open ? 'secondary' : 'default'}
              disabled={id.trim() === '' || importing.isPending}
              onClick={() => importing.mutate()}
            >
              {t('settings.theme.import')}
            </Button>
          </div>
          {importing.isError ? (
            <p id="theme-id-error" role="alert" className="text-sm text-destructive">
              {importRefused
                ? t('settings.theme.import.invalid')
                : importFailure
                  ? t('settings.theme.import.failed', { reason: importFailure.said })
                  : t(problemMessageKey(importing.error))}
            </p>
          ) : null}
        </div>

        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="group flex min-h-8 items-center gap-1 rounded-sm text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11">
            <ChevronRightIcon
              aria-hidden
              className="size-4 transition-transform motion-reduce:transition-none group-data-[state=open]:rotate-90"
            />
            {t('settings.theme.json')}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-3">
            <Textarea
              ref={textarea}
              aria-label={t('settings.theme.json')}
              value={json}
              spellCheck={false}
              aria-invalid={jsonError !== null ? true : undefined}
              aria-describedby={
                jsonError !== null ? 'theme-json-error theme-json-help' : 'theme-json-help'
              }
              onChange={(event) => {
                setJson(event.target.value)
                edited()
              }}
              className="max-h-96 font-mono text-xs md:text-xs"
            />
            {jsonError !== null ? (
              <p id="theme-json-error" role="alert" className="text-sm text-destructive">
                {jsonError}
              </p>
            ) : null}
            <p
              id="theme-json-help"
              className="max-w-prose text-2xs leading-relaxed text-muted-foreground"
            >
              {t('settings.theme.json.help')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={json.trim() === '' || applying.isPending}
                onClick={apply}
              >
                {t('settings.theme.apply')}
              </Button>
              {stored ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={resetting.isPending}
                  onClick={() => resetting.mutate()}
                >
                  {t('settings.theme.reset')}
                </Button>
              ) : null}
            </div>
            {resetting.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {t(problemMessageKey(resetting.error))}
              </p>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </Section>
  )
}
