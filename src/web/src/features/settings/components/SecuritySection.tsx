/**
 * *Sécurité* — the optional PIN (#1203) and the access tokens, on the row
 * pattern.
 *
 * *Code d'accès* states whether a code is set and offers what can be done with
 * it: off, « Activer le code »; on, « Changer le code » and « Désactiver ».
 * Each procedure opens a Dialog, never a card under its row, and focus returns
 * to the control that opened it. With the code on, two rows follow:
 * *Verrouillage automatique* — a value saved on change (#1313) — and the
 * *Jetons d'accès* list, whose secrets are shown once in a side panel. Revoking
 * and regenerating are `ConfirmDestructive`.
 */
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Refusal } from '@/components/Refusal'
import { Segmented } from '@/components/Segmented'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { REGEXP_ONLY_DIGITS } from 'input-otp'

import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { useAuth } from '@/features/auth/components/AuthBoot'
import { authApi, refusedWith } from '@/features/auth/lib/api'
import {
  AddRow,
  ListRow,
  ListSetting,
  TextAction,
} from '@/features/settings/components/ListSetting'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { scopeWords, TokenSheet } from '@/features/settings/components/TokenSheet'
import { useRowSave } from '@/features/settings/lib/useRowSave'
import { api, type AccessToken, type IssuedAccessToken } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey, problemSentence } from '@/lib/problem'
import { sessionEnded } from '@/lib/session'

type Procedure = 'enable' | 'disable' | 'change'

const PIN = /^[0-9]{6}$/

/** `auth_rules.SESSION_PRESETS`, in seconds; the server refuses any other. */
const LIFETIMES = [900, 3600, 86400, 604800, 2592000] as const
const LIFETIME_LABEL: Record<(typeof LIFETIMES)[number], MessageKey> = {
  900: 'settings.security.lock.900',
  3600: 'settings.security.lock.3600',
  86400: 'settings.security.lock.86400',
  604800: 'settings.security.lock.604800',
  2592000: 'settings.security.lock.2592000',
}
/** What a stored `NULL` means: `auth_rules.DEFAULT_SESSION_SECONDS`. */
const DEFAULT_LIFETIME = 2592000

/**
 * `read` is the settings read its neighbours stand on: while the app does not
 * answer, whether a code is set cannot be told, so nothing is drawn (#1418).
 */
export function SecuritySection({ read }: { read: SectionRead }) {
  const { t } = useI18n()
  const { status, update } = useAuth()
  const [open, setOpen] = useState<Procedure | null>(null)
  const enabled = status.enabled
  // The control that opened a Dialog: it gets the focus back when it closes.
  // Radix gives it back to a `DialogTrigger` only, and these open from buttons.
  const opener = useRef<HTMLElement | null>(null)
  const procedure = (next: Procedure) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpen(next)
  }
  const refocus = (event: Event) => {
    event.preventDefault()
    opener.current?.focus()
  }
  const close = () => setOpen(null)

  return (
    <SettingsSection id="security" title={t('settings.security.title')} read={read}>
      <SettingRow
        label={t('settings.access.code')}
        description={t(enabled ? 'settings.security.code.on' : 'settings.security.code.off')}
      >
        <div className="flex gap-2">
          {enabled ? (
            <>
              <Button onClick={() => procedure('change')}>
                {t('settings.security.changeCode')}
              </Button>
              <Button onClick={() => procedure('disable')}>{t('settings.security.disable')}</Button>
            </>
          ) : (
            <Button onClick={() => procedure('enable')}>{t('settings.access.enable')}</Button>
          )}
        </div>
      </SettingRow>

      {enabled ? (
        <>
          <LifetimeRow />
          <TokensList />
        </>
      ) : null}

      <EnableDialog
        refocus={refocus}
        open={open === 'enable'}
        onClose={close}
        onDone={() => {
          close()
          toast.success(t('settings.access.receipt.enabled'))
          update({ enabled: true, authenticated: true })
        }}
      />
      <DisableDialog
        refocus={refocus}
        open={open === 'disable'}
        onClose={close}
        onDone={() => {
          close()
          toast.success(t('settings.access.receipt.disabled'))
          update({ enabled: false, authenticated: false })
        }}
      />
      <ChangeDialog
        refocus={refocus}
        open={open === 'change'}
        onClose={close}
        onDone={() => {
          close()
          toast.success(t('settings.access.receipt.changed'))
        }}
      />
    </SettingsSection>
  )
}

/**
 * « Verrouillage automatique »: how long a session lives without activity,
 * saved on change. The answer re-signs this device, so lowering it does not
 * lock out the one who lowered it.
 */
function LifetimeRow() {
  const { t } = useI18n()
  const { status, update } = useAuth()
  const save = useRowSave({
    send: async (seconds: number) => {
      try {
        return await authApi.lifetime(seconds)
      } catch (error) {
        // `authFetch` leaves a 401 under `/auth/*` to its caller: here it is a
        // session that lapsed while the page was read.
        if (refusedWith(error, 401)) sessionEnded()
        throw error
      }
    },
    onAnswer: (answer) =>
      update((current) => ({ ...current, session_seconds: answer.session_seconds })),
    reason: lifetimeRefusal,
  })
  const stored = status.session_seconds ?? DEFAULT_LIFETIME
  const value = save.chosen?.value ?? (stored in LIFETIME_LABEL ? stored : DEFAULT_LIFETIME)

  return (
    <SettingRow label={t('settings.security.lock')} state={save.state}>
      <Segmented
        mode="radio"
        bordered
        size="compact"
        label={t('settings.security.lock')}
        value={String(value)}
        onChange={(next) => save.save(Number(next))}
        options={LIFETIMES.map((seconds) => ({
          value: String(seconds),
          label: t(LIFETIME_LABEL[seconds]),
        }))}
      />
    </SettingRow>
  )
}

/** The gate's refusals all carry `/problems/auth`: the status says which one. */
function lifetimeRefusal(error: unknown): MessageKey {
  if (refusedWith(error, 401)) return 'settings.security.lock.ended'
  if (refusedWith(error, 409)) return 'settings.security.lock.off'
  if (refusedWith(error, 503)) return 'problem.storageUnavailable'
  return problemMessageKey(error)
}

/** *Jetons d'accès · API et MCP*: the list, its two text actions, its add row. */
function TokensList() {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.tokens })
  const [sheet, setSheet] = useState(false)
  /** What the panel shows once a secret exists: from a creation or a regeneration. */
  const [issued, setIssued] = useState<IssuedAccessToken | null>(null)
  const [revoking, setRevoking] = useState<AccessToken | null>(null)
  const [regenerating, setRegenerating] = useState<AccessToken | null>(null)

  const remove = useMutation({
    mutationFn: (token: AccessToken) => api.deleteToken(token.id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tokens'] })
      setRevoking(null)
    },
  })
  const write = useMutation({
    mutationFn: (token: AccessToken) => api.regenerateToken(token.id),
    onSuccess: (answer) => {
      void client.invalidateQueries({ queryKey: ['tokens'] })
      setRegenerating(null)
      setIssued(answer)
      setSheet(true)
    },
  })
  const closeSheet = () => {
    setSheet(false)
    setIssued(null)
  }

  return (
    <ListSetting label={t('settings.token.list')} hint={t('settings.token.list.hint')}>
      {tokens.data?.tokens.map((token) => (
        <ListRow
          key={token.id}
          name={token.label}
          sub={
            <>
              {scopeWords(token.scopes, t('settings.token.and'))} ·{' '}
              <span className="fig">{`sb_${token.prefix}…`}</span> ·{' '}
              {token.last_used_at
                ? t('settings.token.used', { date: f.date(token.last_used_at) })
                : t('settings.token.neverUsed')}
            </>
          }
          actions={
            <>
              <TextAction
                aria-label={`${t('settings.token.regenerate')} ${token.label}`}
                onClick={() => {
                  write.reset()
                  setRegenerating(token)
                }}
              >
                {t('settings.token.regenerate')}
              </TextAction>
              <TextAction
                aria-label={`${t('settings.token.revoke')} ${token.label}`}
                onClick={() => {
                  remove.reset()
                  setRevoking(token)
                }}
              >
                {t('settings.token.revoke')}
              </TextAction>
            </>
          }
        />
      ))}
      <AddRow onClick={() => setSheet(true)}>{t('settings.token.add')}</AddRow>

      {sheet ? <TokenSheet issued={issued} onIssued={setIssued} onClose={closeSheet} /> : null}

      <ConfirmDestructive
        open={revoking !== null}
        onOpenChange={(next) => (next ? undefined : setRevoking(null))}
        title={t('settings.token.revoke.title', { name: revoking?.label ?? '' })}
        line={t('settings.token.revoke.line')}
        confirmLabel={t('settings.token.revoke')}
        pending={remove.isPending}
        error={remove.isError ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}
        onConfirm={() => {
          if (revoking) remove.mutate(revoking)
        }}
      />
      <ConfirmDestructive
        open={regenerating !== null}
        onOpenChange={(next) => (next ? undefined : setRegenerating(null))}
        title={t('settings.token.regenerate.title', { name: regenerating?.label ?? '' })}
        line={t('settings.token.regenerate.line')}
        confirmLabel={t('settings.token.regenerate')}
        pending={write.isPending}
        error={write.isError ? <Refusal>{problemSentence(t, write.error)}</Refusal> : null}
        onConfirm={() => {
          if (regenerating) write.mutate(regenerating)
        }}
      />
    </ListSetting>
  )
}

/** A procedure's Dialog: a form, Escape and the close button give up. */
function CodeDialog({
  open,
  refocus,
  title,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean
  refocus: (event: Event) => void
  title: MessageKey
  onClose: () => void
  onSubmit: (event: FormEvent) => void
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        onCloseAutoFocus={refocus}
        className="sm:max-w-sm"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t(title)}</DialogTitle>
          <DialogDescription className="sr-only">{t(title)}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          {children}
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CodeField({
  label,
  value,
  onChange,
  current = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  current?: boolean
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm">
        {label}
      </label>
      <InputOTP
        id={id}
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        autoComplete={current ? 'current-password' : 'off'}
        value={value}
        onChange={onChange}
      >
        <InputOTPGroup className="gap-2">
          {Array.from({ length: 6 }, (_, index) => (
            <InputOTPSlot
              key={index}
              index={index}
              masked
              className="h-10 w-9 rounded-md border first:rounded-md first:border-l last:rounded-md"
            />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  )
}

function Refused({ error }: { error: unknown }) {
  const { t } = useI18n()
  if (error === null || error === undefined) return null
  const key: MessageKey =
    typeof error === 'string'
      ? (error as MessageKey)
      : refusedWith(error, 429)
        ? 'settings.access.throttled'
        : refusedWith(error, 403)
          ? 'settings.access.wrongCurrent'
          : problemMessageKey(error)
  return (
    <p role="alert" className="text-sm text-destructive">
      {t(key)}
    </p>
  )
}

function Actions({
  label,
  pending,
  onClose,
}: {
  label: MessageKey
  pending: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" size="sheet" onClick={onClose}>
        {t('settings.access.cancel')}
      </Button>
      <Button type="submit" size="sheet" variant="primary" disabled={pending}>
        {t(label)}
      </Button>
    </div>
  )
}

/** The two-entry check: six digits, and the same six twice. */
function invalidNewCode(pin: string, again: string): MessageKey | null {
  if (!PIN.test(pin)) return 'settings.access.sixDigits'
  if (pin !== again) return 'settings.access.mismatch'
  return null
}

function EnableDialog({
  open,
  refocus,
  onClose,
  onDone,
}: {
  open: boolean
  refocus: (event: Event) => void
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useI18n()
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [invalid, setInvalid] = useState<MessageKey | null>(null)
  // The dialog stays mounted when closed: what was typed goes with each closing.
  const clear = () => {
    setPin('')
    setAgain('')
    setInvalid(null)
  }
  const enable = useMutation({
    mutationFn: authApi.enable,
    onSuccess: () => {
      clear()
      onDone()
    },
  })
  const give = () => {
    clear()
    enable.reset()
    onClose()
  }

  return (
    <CodeDialog
      refocus={refocus}
      open={open}
      title="settings.access.enable"
      onClose={give}
      onSubmit={(event) => {
        event.preventDefault()
        const wrong = invalidNewCode(pin, again)
        setInvalid(wrong)
        if (wrong === null) enable.mutate(pin)
      }}
    >
      <CodeField label={t('settings.access.new')} value={pin} onChange={setPin} />
      <CodeField label={t('settings.access.confirm')} value={again} onChange={setAgain} />
      <Refused error={invalid ?? enable.error} />
      <Actions label="settings.access.enable" pending={enable.isPending} onClose={give} />
    </CodeDialog>
  )
}

function ChangeDialog({
  open,
  refocus,
  onClose,
  onDone,
}: {
  open: boolean
  refocus: (event: Event) => void
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [invalid, setInvalid] = useState<MessageKey | null>(null)
  const clear = () => {
    setCurrent('')
    setPin('')
    setAgain('')
    setInvalid(null)
  }
  const change = useMutation({
    mutationFn: () => authApi.change(current, pin),
    onSuccess: () => {
      clear()
      onDone()
    },
  })
  const give = () => {
    clear()
    change.reset()
    onClose()
  }

  return (
    <CodeDialog
      refocus={refocus}
      open={open}
      title="settings.security.changeCode"
      onClose={give}
      onSubmit={(event) => {
        event.preventDefault()
        const wrong = PIN.test(current) ? invalidNewCode(pin, again) : 'settings.access.sixDigits'
        setInvalid(wrong)
        if (wrong === null) change.mutate()
      }}
    >
      <CodeField
        label={t('settings.access.current')}
        value={current}
        onChange={setCurrent}
        current
      />
      <CodeField label={t('settings.access.new')} value={pin} onChange={setPin} />
      <CodeField label={t('settings.access.confirm')} value={again} onChange={setAgain} />
      <Refused error={invalid ?? change.error} />
      <Actions label="settings.access.change" pending={change.isPending} onClose={give} />
    </CodeDialog>
  )
}

/** Switching the code off asks the current one, inside the destructive dialog. */
function DisableDialog({
  open,
  refocus,
  onClose,
  onDone,
}: {
  open: boolean
  refocus: (event: Event) => void
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [invalid, setInvalid] = useState<MessageKey | null>(null)
  const clear = () => {
    setCurrent('')
    setInvalid(null)
  }
  const disable = useMutation({
    mutationFn: () => authApi.disable(current),
    onSuccess: () => {
      clear()
      onDone()
    },
  })
  const give = () => {
    clear()
    disable.reset()
    onClose()
  }

  return (
    <ConfirmDestructive
      open={open}
      onOpenChange={(next) => (next ? undefined : give())}
      title={t('settings.access.disable.title')}
      line={t('settings.access.disable.line')}
      confirmLabel={t('settings.access.disable.cta')}
      pending={disable.isPending}
      onCloseAutoFocus={refocus}
      error={<Refused error={invalid ?? disable.error} />}
      onConfirm={() => {
        const wrong = PIN.test(current) ? null : 'settings.access.sixDigits'
        setInvalid(wrong)
        if (wrong === null) disable.mutate()
      }}
    >
      <CodeField
        label={t('settings.access.current')}
        value={current}
        onChange={setCurrent}
        current
      />
    </ConfirmDestructive>
  )
}
