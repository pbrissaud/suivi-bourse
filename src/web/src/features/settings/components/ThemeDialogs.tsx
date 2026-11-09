/**
 * The two ways into a theme that are not the form: **import by id or address**
 * (the server's one call to tweakcn.com, on click) and **paste** the JSON of
 * `tweakcn.com/r/themes/<id>` for an instance with no way out (#1248). Both are
 * Dialogs, hidden while the form has unapplied edits.
 */
import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { settingsApi, type ThemeVars } from '@/features/settings/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey, providerRefusal, refusedKey } from '@/lib/problem'
import atelier from '@/theme/atelier.json'

/** The editor shows Atelier's own JSON when nothing is stored (#1295). */
const pretty = (theme: ThemeVars | null) => JSON.stringify(theme ?? atelier, null, 2)

/** The last path segment of an address, or the id itself. */
const themeId = (value: string) =>
  value.trim().split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() ?? ''

export function ImportDialog({
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
            className="fig"
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
          <Button type="button" size="sheet" onClick={onClose}>
            {t('settings.theme.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sheet"
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

export function JsonDialog({
  current,
  onKept,
  onClose,
}: {
  /** The theme in force, or `null` for Atelier's own. */
  current: ThemeVars | null
  onKept: (kept: ThemeVars) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [json, setJson] = useState(() => pretty(current))
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
          className="max-h-96 fig text-xs md:text-xs"
        />
        {error !== null ? (
          <p id="theme-json-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" size="sheet" onClick={onClose}>
            {t('settings.theme.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sheet"
            type="button"
            disabled={json.trim() === '' || applying.isPending}
            onClick={apply}
          >
            {t('settings.theme.apply')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
