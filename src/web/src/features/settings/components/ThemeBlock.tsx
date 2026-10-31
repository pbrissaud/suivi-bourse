/**
 * *Thème* — the theme over the bundled Atelier, kept in the store (#1248).
 *
 * At rest the section shows the two palettes and what can be done with them:
 * **Modifier** opens the form with its live preview (`ThemeForm`, #1314),
 * the tweakcn import and the JSON are Dialogs. An imported theme carries keys
 * the form does not show, so the JSON stays as the expert's way in. Both are
 * hidden while editing, so the theme being edited cannot be replaced
 * underneath.
 *
 * Two ways in from tweakcn: **import by id or address** (the server's one call
 * to tweakcn.com, on click) or **paste** the JSON of `tweakcn.com/r/themes/<id>`
 * for an instance with no way out. Every write points
 * `<link href="/api/theme.css">` at a fresh URL, so the page repaints without
 * a reload.
 */
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Section } from '@/components/ui/section'
import { Textarea } from '@/components/ui/textarea'
import { ThemeForm } from '@/features/settings/components/ThemeForm'
import { settingsApi, type ThemeVars } from '@/features/settings/lib/api'
import { read } from '@/features/settings/lib/themeForm'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey, providerRefusal, refusedKey } from '@/lib/problem'
import { repaint } from '@/lib/themePreview'
import atelier from '@/theme/atelier.json'

/** The editor shows Atelier's own JSON when nothing is stored (#1295). */
const pretty = (theme: ThemeVars | null) => JSON.stringify(theme ?? atelier, null, 2)

/** The last path segment of an address, or the id itself. */
const themeId = (value: string) =>
  value.trim().split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() ?? ''

/** What the strips show of a palette. */
const SWATCHES = ['background', 'card', 'foreground', 'primary', 'chart-1', 'destructive']

function ImportDialog({
  onKept,
  onClose,
}: {
  onKept: (kept: ThemeVars) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [id, setId] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const importing = useMutation({
    mutationFn: () => settingsApi.importTheme(themeId(id)),
    onSuccess: onKept,
    onError: () => field.current?.focus(),
  })
  const refused = importing.isError && refusedKey(importing.error) === 'id'
  const failure = providerRefusal(importing.error)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.theme.import.open')}</DialogTitle>
          <DialogDescription>{t('settings.theme.import.help')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="theme-id" className="block text-sm">
            {t('settings.theme.import.label')}
          </label>
          <Input
            ref={field}
            id="theme-id"
            value={id}
            placeholder={t('settings.theme.import.placeholder')}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={refused ? true : undefined}
            aria-describedby={importing.isError ? 'theme-id-error' : undefined}
            onChange={(event) => {
              setId(event.target.value)
              importing.reset()
            }}
            className="font-mono"
          />
          {importing.isError ? (
            <p id="theme-id-error" role="alert" className="text-sm text-destructive">
              {refused
                ? t('settings.theme.import.invalid')
                : failure
                  ? t('settings.theme.import.failed', { reason: failure.said })
                  : t(problemMessageKey(importing.error))}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('settings.theme.cancel')}
          </Button>
          <Button
            type="button"
            disabled={themeId(id) === '' || importing.isPending}
            onClick={() => importing.mutate()}
          >
            {t('settings.theme.import')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function JsonDialog({
  stored,
  onKept,
  onClose,
}: {
  stored: ThemeVars | null
  onKept: (kept: ThemeVars) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [json, setJson] = useState(() => pretty(stored))
  const [unparsable, setUnparsable] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const applying = useMutation({
    mutationFn: (body: unknown) => settingsApi.saveTheme(body),
    onSuccess: onKept,
    onError: () => textarea.current?.focus(),
  })

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

  const key = refusedKey(applying.error)
  const error =
    unparsable !== null
      ? t('settings.theme.unparsable', { message: unparsable })
      : applying.isError
        ? key !== null
          ? t('settings.theme.refused', { key })
          : t(problemMessageKey(applying.error))
        : null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('settings.theme.json')}</DialogTitle>
          <DialogDescription id="theme-json-help">
            {t('settings.theme.json.help')}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          ref={textarea}
          aria-label={t('settings.theme.json')}
          value={json}
          spellCheck={false}
          aria-invalid={error !== null ? true : undefined}
          aria-describedby={error !== null ? 'theme-json-error theme-json-help' : 'theme-json-help'}
          onChange={(event) => {
            setJson(event.target.value)
            setUnparsable(null)
            applying.reset()
          }}
          className="max-h-96 font-mono text-xs md:text-xs"
        />
        {error !== null ? (
          <p id="theme-json-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('settings.theme.cancel')}
          </Button>
          <Button type="button" disabled={json.trim() === '' || applying.isPending} onClick={apply}>
            {t('settings.theme.apply')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ThemeBlock({ stored }: { stored: ThemeVars | null }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const [dialog, setDialog] = useState<'import' | 'json' | null>(null)
  /** The theme the form opened on, pinned: a refetch of the stored one does not move it. */
  const [editing, setEditing] = useState<ThemeVars | null>(null)
  const [done, setDone] = useState<'applied' | 'restored' | null>(null)

  /** The store kept `answer`; resolves once the page has repainted with it. */
  const kept = (answer: ThemeVars | null) => {
    client.setQueryData(['theme'], answer)
    setDone(answer ? 'applied' : 'restored')
    return repaint()
  }
  // A dialog's write: the repaint failing leaves the page as it was, and says nothing.
  const dialogKept = (answer: ThemeVars) => {
    kept(answer).catch(() => {})
    setDialog(null)
  }
  const resetting = useMutation({
    mutationFn: settingsApi.resetTheme,
    onSuccess: () => {
      kept(null).catch(() => {})
    },
  })

  const state =
    done === 'applied'
      ? 'settings.theme.applied'
      : done === 'restored'
        ? 'settings.theme.restored'
        : stored
          ? 'settings.theme.custom'
          : 'settings.theme.bundled'
  const saved = stored ?? (atelier as ThemeVars)

  return (
    <Section title={t('settings.theme.title')}>
      <div className="space-y-5">
        <p role="status" className="text-sm text-muted-foreground">
          {t(state)}
        </p>

        {editing ? (
          <ThemeForm baseline={editing} onApplied={kept} onClose={() => setEditing(null)} />
        ) : (
          <>
            <div className="space-y-2">
              {(['light', 'dark'] as const).map((ground) => (
                <div key={ground} className="flex items-center gap-3">
                  <span className="label w-14">{t(`settings.theme.ground.${ground}`)}</span>
                  <div aria-hidden className="flex gap-1.5">
                    {SWATCHES.map((key) => (
                      <span
                        key={key}
                        className="size-6 rounded-full border"
                        style={{ background: read(saved, ground, key) }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => setEditing(saved)}>
                {t('settings.theme.edit')}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setDialog('import')}>
                {t('settings.theme.import.open')}
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
              <Button type="button" variant="link" onClick={() => setDialog('json')}>
                {t('settings.theme.json')}
              </Button>
            </div>
            {resetting.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {t(problemMessageKey(resetting.error))}
              </p>
            ) : null}
          </>
        )}
      </div>

      {dialog === 'import' ? (
        <ImportDialog onKept={dialogKept} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'json' ? (
        <JsonDialog stored={stored} onKept={dialogKept} onClose={() => setDialog(null)} />
      ) : null}
    </Section>
  )
}
