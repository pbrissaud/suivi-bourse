/**
 * *Canal de notification* (§ 3.6): where the server sends what the bell holds —
 * a late price, a new version, a failed task — when nobody has the app open. A
 * channel is a kind (ntfy, e-mail, webhook, Apprise), the address it posts to,
 * a secret where its kind has one, and the notices it carries.
 *
 * The secret is typed here and never read back: the server answers its last
 * four characters. Left empty on an edit, the stored one stays.
 */
import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Refusal } from '@/components/Refusal'
import { TextTabs } from '@/components/TextTabs'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsSheet, SheetField } from '@/features/settings/components/SettingsSheet'
import {
  api,
  type ChannelKind,
  type ChannelScope,
  type NotificationChannel,
  type NotificationChannelDraft,
} from '@/lib/api'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'

export const CHANNEL_KINDS: readonly ChannelKind[] = ['ntfy', 'email', 'webhook', 'apprise']
export const CHANNEL_SCOPES: readonly ChannelScope[] = [
  'late_price',
  'update_available',
  'job_failed',
]

export const KIND_LABEL: Record<ChannelKind, MessageKey> = {
  ntfy: 'settings.channel.kind.ntfy',
  email: 'settings.channel.kind.email',
  webhook: 'settings.channel.kind.webhook',
  apprise: 'settings.channel.kind.apprise',
}

export const SCOPE_LABEL: Record<ChannelScope, MessageKey> = {
  late_price: 'settings.channel.scope.late_price',
  update_available: 'settings.channel.scope.update_available',
  job_failed: 'settings.channel.scope.job_failed',
}

const TARGET_LABEL: Record<ChannelKind, MessageKey> = {
  ntfy: 'settings.channel.target.ntfy',
  email: 'settings.channel.target.email',
  webhook: 'settings.channel.target.webhook',
  apprise: 'settings.channel.target.apprise',
}

const SECRET_LABEL: Record<ChannelKind, MessageKey> = {
  ntfy: 'settings.channel.secret.token',
  email: 'settings.channel.secret.password',
  webhook: 'settings.channel.secret.token',
  apprise: 'settings.channel.secret.token',
}

export function ChannelSheet({
  channel,
  onClose,
}: {
  /** The channel being edited, or `null` for a new one. */
  channel: NotificationChannel | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const client = useQueryClient()
  const ids = [useId(), useId(), useId(), useId(), useId(), useId(), useId()]
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? 'ntfy')
  const [target, setTarget] = useState(channel?.target ?? '')
  const [secret, setSecret] = useState('')
  const [scopes, setScopes] = useState<ChannelScope[]>(
    channel?.scopes ?? ['late_price', 'update_available', 'job_failed'],
  )
  const [enabled, setEnabled] = useState(channel?.enabled ?? true)
  const [host, setHost] = useState(String(channel?.options.host ?? ''))
  const [port, setPort] = useState(String(channel?.options.port ?? ''))
  const [username, setUsername] = useState(String(channel?.options.username ?? ''))
  const [sender, setSender] = useState(String(channel?.options.sender ?? ''))
  const [starttls, setStarttls] = useState(channel?.options.starttls !== false)
  const [removing, setRemoving] = useState(false)

  const options = (): NotificationChannel['options'] => ({
    ...(channel?.options ?? {}),
    ...(kind === 'email'
      ? {
          host: host.trim(),
          ...(port.trim() !== '' ? { port: Number(port) } : {}),
          username: username.trim(),
          sender: sender.trim(),
          starttls,
        }
      : {}),
  })

  const write = useMutation({
    mutationFn: () => {
      const typed = secret.trim() !== '' ? { secret: secret.trim() } : {}
      if (channel) {
        return api.changeNotificationChannel(channel.id, {
          target: target.trim(),
          options: options(),
          scopes,
          enabled,
          ...typed,
        })
      }
      const draft: NotificationChannelDraft = {
        kind,
        target: target.trim(),
        options: options(),
        scopes,
        enabled,
        ...typed,
      }
      return api.addNotificationChannel(draft)
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['notification-channels'] })
      onClose()
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteNotificationChannel(channel?.id ?? ''),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['notification-channels'] })
      onClose()
    },
  })

  const valid = target.trim() !== '' && scopes.length > 0
  const name = channel ? t(KIND_LABEL[channel.kind]) : ''

  return (
    <SettingsSheet
      open
      onClose={onClose}
      title={channel ? name : t('settings.channel.add')}
      onSubmit={() => {
        if (valid && !write.isPending) write.mutate()
      }}
      footer={
        <>
          {channel ? (
            <button
              type="button"
              className="mr-auto text-md text-destructive underline decoration-border underline-offset-3 outline-none focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => {
                remove.reset()
                setRemoving(true)
              }}
            >
              {t('settings.channel.remove.link')}
            </button>
          ) : (
            <span className="mr-auto" />
          )}
          <Button type="button" size="sheet" onClick={onClose}>
            {t('settings.access.cancel')}
          </Button>
          <Button type="submit" size="sheet" variant="primary" disabled={!valid || write.isPending}>
            {t('settings.save')}
          </Button>
        </>
      }
    >
      {/* The kind is the channel's identity: chosen on a new one, only read on an old one. */}
      {channel === null ? (
        <TextTabs
          size="sheet"
          label={t('settings.channel.kind')}
          value={kind}
          onChange={setKind}
          tabs={CHANNEL_KINDS.map((one) => ({ value: one, label: t(KIND_LABEL[one]) }))}
        />
      ) : null}

      <SheetField id={ids[0]} label={t(TARGET_LABEL[kind])}>
        <Input
          id={ids[0]}
          className="fig"
          value={target}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTarget(event.target.value)}
        />
      </SheetField>

      {kind === 'email' ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
          <SheetField id={ids[1]} label={t('settings.channel.smtp.host')}>
            <Input
              id={ids[1]}
              className="fig"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          </SheetField>
          <SheetField
            id={ids[2]}
            label={t('settings.channel.smtp.port')}
            optional={t('data.form.optional')}
          >
            <Input
              id={ids[2]}
              className="fig"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </SheetField>
          <SheetField
            id={ids[3]}
            label={t('settings.channel.smtp.username')}
            optional={t('data.form.optional')}
          >
            <Input
              id={ids[3]}
              className="fig"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </SheetField>
          <SheetField id={ids[4]} label={t('settings.channel.smtp.sender')}>
            <Input
              id={ids[4]}
              className="fig"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            />
          </SheetField>
          <label className="col-span-2 flex items-center justify-between text-md">
            {t('settings.channel.smtp.starttls')}
            <Switch checked={starttls} onCheckedChange={setStarttls} />
          </label>
        </div>
      ) : null}

      <SheetField id={ids[5]} label={t(SECRET_LABEL[kind])} optional={t('data.form.optional')}>
        <Input
          id={ids[5]}
          type="password"
          className="fig"
          autoComplete="off"
          spellCheck={false}
          value={secret}
          placeholder={channel?.secret_last4 ? `…${channel.secret_last4}` : undefined}
          onChange={(event) => setSecret(event.target.value)}
        />
      </SheetField>

      <fieldset className="flex flex-col">
        <legend className="label mb-3">{t('settings.channel.scope')}</legend>
        {CHANNEL_SCOPES.map((scope) => (
          <label
            key={scope}
            className="flex min-h-10 items-center justify-between gap-3 border-b text-md"
          >
            {t(SCOPE_LABEL[scope])}
            <Checkbox
              aria-label={t(SCOPE_LABEL[scope])}
              checked={scopes.includes(scope)}
              onCheckedChange={(on) =>
                setScopes((current) =>
                  on === true ? [...current, scope] : current.filter((one) => one !== scope),
                )
              }
            />
          </label>
        ))}
      </fieldset>

      <div className="flex items-center justify-between gap-4 border-t pt-5">
        <label htmlFor={ids[6]}>{t('settings.channel.enabled')}</label>
        <Switch id={ids[6]} checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {write.isError ? <Refusal>{problemSentence(t, write.error)}</Refusal> : null}

      <ConfirmDestructive
        open={removing}
        onOpenChange={(next) => (next ? undefined : setRemoving(false))}
        title={t('settings.channel.remove.title', { name })}
        line={t('settings.channel.remove.line')}
        confirmLabel={t('settings.channel.remove')}
        pending={remove.isPending}
        error={remove.isError ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}
        onConfirm={() => remove.mutate()}
      />
    </SettingsSheet>
  )
}
