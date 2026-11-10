/**
 * *Créer un jeton d'accès* and *Votre jeton d'accès* (`TokenSheet-Refonte`,
 * `TokenCreated-Refonte`): one side panel in two states. The form asks a label,
 * the scopes a token opens (`/api`, `/mcp`) and its expiry; once made, the same
 * panel shows the secret — **once** — with the two snippets that use it. A
 * regeneration lands on the same second state.
 *
 * Mounted by the page only while it is open, so every opening starts blank.
 */
import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Refusal } from '@/components/Refusal'
import { Segmented } from '@/components/Segmented'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { claudeDesktopConfig } from '@/features/auth/lib/api'
import { SettingsSheet, SheetField } from '@/features/settings/components/SettingsSheet'
import { api, type IssuedAccessToken, type TokenExpiry, type TokenScope } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

const SCOPES: TokenScope[] = ['api', 'mcp']
const CODE = 'rounded-md bg-muted px-3.5 py-3 font-mono text-xs/4.5 break-all whitespace-pre-wrap'

/** The scopes of a token as words: « API », « MCP », « API et MCP ». */
export function scopeWords(scopes: readonly TokenScope[], and: string): string {
  return SCOPES.filter((one) => scopes.includes(one))
    .map((one) => one.toUpperCase())
    .join(` ${and} `)
}

export function TokenSheet({
  issued,
  onIssued,
  onClose,
}: {
  /** The secret just made or regenerated: the sheet then shows it, once. */
  issued: IssuedAccessToken | null
  onIssued: (answer: IssuedAccessToken) => void
  onClose: () => void
}) {
  return issued ? (
    <Created issued={issued} onClose={onClose} />
  ) : (
    <TokenForm onIssued={onIssued} onClose={onClose} />
  )
}

function TokenForm({
  onIssued,
  onClose,
}: {
  onIssued: (answer: IssuedAccessToken) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const client = useQueryClient()
  const labelId = useId()
  const scopeId = useId()
  const [label, setLabel] = useState('')
  // None by default: a token opens only what its maker ticked.
  const [scopes, setScopes] = useState<TokenScope[]>([])
  const [expires, setExpires] = useState<TokenExpiry>('1y')

  const write = useMutation({
    mutationFn: () => api.createToken({ label: label.trim(), scopes, expires }),
    onSuccess: (answer) => {
      void client.invalidateQueries({ queryKey: ['tokens'] })
      onIssued(answer)
    },
  })
  const valid = label.trim() !== '' && scopes.length > 0

  return (
    <SettingsSheet
      open
      onClose={onClose}
      title={t('settings.token.create.title')}
      onSubmit={() => {
        if (valid && !write.isPending) write.mutate()
      }}
      footer={
        <div className="ml-auto flex gap-2">
          <Button type="button" size="sheet" onClick={onClose}>
            {t('settings.access.cancel')}
          </Button>
          <Button type="submit" size="sheet" variant="primary" disabled={!valid || write.isPending}>
            {t('settings.token.create')}
          </Button>
        </div>
      }
    >
      <SheetField id={labelId} label={t('settings.token.label')}>
        <Input
          id={labelId}
          value={label}
          placeholder={t('settings.token.label.placeholder')}
          autoComplete="off"
          onChange={(event) => setLabel(event.target.value)}
        />
      </SheetField>

      <fieldset className="flex flex-col">
        <legend className="label mb-3">{t('settings.token.scope')}</legend>
        {SCOPES.map((scope) => (
          // The label points at the box by `htmlFor`, never wraps it: wrapping
          // lets the click reach the control twice, and the box lands back where
          // it started.
          <div
            key={scope}
            className="flex min-h-10 items-center justify-between gap-3 border-b text-md"
          >
            <label htmlFor={`${scopeId}-${scope}`} className="flex-1 cursor-pointer">
              {scope.toUpperCase()}
              <span className="text-muted-foreground"> · {t(`settings.token.scope.${scope}`)}</span>
            </label>
            <Checkbox
              id={`${scopeId}-${scope}`}
              checked={scopes.includes(scope)}
              onCheckedChange={(on) =>
                setScopes((current) =>
                  on === true ? [...current, scope] : current.filter((one) => one !== scope),
                )
              }
            />
          </div>
        ))}
      </fieldset>

      <div className="flex flex-col gap-3">
        <p className="label">{t('settings.token.expiry')}</p>
        <Segmented
          mode="radio"
          bordered
          size="compact"
          label={t('settings.token.expiry')}
          value={expires}
          onChange={setExpires}
          className="self-start"
          options={[
            { value: '90d', label: t('settings.token.expiry.90d') },
            { value: '1y', label: t('settings.token.expiry.1y') },
            { value: 'never', label: t('settings.token.expiry.never') },
          ]}
        />
      </div>

      {write.isError ? <Refusal>{t(problemMessageKey(write.error))}</Refusal> : null}
    </SettingsSheet>
  )
}

function Created({ issued, onClose }: { issued: IssuedAccessToken; onClose: () => void }) {
  const { t } = useI18n()
  const f = useFormatters()
  const [copied, setCopied] = useState(false)
  const { token, secret } = issued
  const origin = window.location.origin

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const meta = [
    token.label,
    scopeWords(token.scopes, t('settings.token.and')),
    token.expires_at
      ? t('settings.token.expires', { date: f.date(token.expires_at) })
      : t('settings.token.neverExpires'),
  ].join(' · ')

  return (
    <SettingsSheet
      open
      onClose={onClose}
      title={t('settings.token.created.title')}
      footer={
        <Button size="sheet" variant="primary" className="ml-auto" onClick={onClose}>
          {t('settings.token.done')}
        </Button>
      }
    >
      <div className="flex flex-col gap-2.5">
        <p className="label">{meta}</p>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <p className={CODE}>{secret}</p>
          <Button size="sheet" onClick={() => void copy()}>
            {t(copied ? 'settings.token.copied' : 'settings.token.copy')}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t('settings.token.once')}</p>
      </div>

      {token.scopes.includes('mcp') ? (
        <div className="flex flex-col gap-2">
          <p className="label">
            {t('settings.token.desktop')} <span className="fig">claude_desktop_config.json</span>
          </p>
          <pre className={CODE}>{claudeDesktopConfig(origin, secret)}</pre>
        </div>
      ) : null}

      {token.scopes.includes('api') ? (
        <div className="flex flex-col gap-2">
          <p className="label">
            {t('settings.token.script')} <span className="fig">/api</span>
          </p>
          <pre className={CODE}>
            {`curl -H "Authorization: Bearer ${secret}" ${origin}/api/positions`}
          </pre>
        </div>
      ) : null}
    </SettingsSheet>
  )
}
