/**
 * *Sécurité* — the optional PIN (#1203), off by default, on the row pattern
 * (#1279).
 *
 * Its first row, « Demander un code », is the switch: it reflects what is
 * stored and flips only once its Dialog's action has succeeded — turning it on
 * asks *new code, then confirm*, turning it off asks the current code in an
 * `alertdialog`. With the code off the section is that one row. With it on,
 * four rows follow — the code, the auto-lock, the access token, this device.
 * The auto-lock is a value saved on change (#1313); each other procedure opens
 * a Dialog, never a card under its row. The token is shown once, in a Dialog
 * only *J’ai copié le jeton* closes. Focus returns to the control that opened a
 * Dialog when it closes.
 */
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockContent, CodeBlockLine } from '@/components/ui/code-block'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/components/AuthBoot'
import {
  authApi,
  claudeDesktopConfig,
  refusedWith,
  type IssuedToken,
} from '@/features/auth/lib/api'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { useRowSave } from '@/features/settings/lib/useRowSave'
import { useFormatters } from '@/lib/format'
import { sessionEnded } from '@/lib/session'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

type Procedure = 'enable' | 'disable' | 'change' | 'regenerate'

const PIN = /^[0-9]{6}$/
const SWITCH_ID = 'security-ask'

/** `auth_rules.SESSION_PRESETS`, in seconds; the server refuses any other. */
const LIFETIME_LABEL: Record<number, MessageKey> = {
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
  const f = useFormatters()
  const { status, update, signedOut } = useAuth()
  const [open, setOpen] = useState<Procedure | null>(null)
  const [token, setToken] = useState<IssuedToken | null>(null)
  const noteId = useId()
  const enabled = status.enabled
  // The control that opened a Dialog: it gets the focus back when it closes.
  // Radix gives it back to a `DialogTrigger` only, and these open from a switch.
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

  const issued = (answer: IssuedToken) => {
    setOpen(null)
    setToken(answer)
    update({
      ...status,
      enabled: true,
      authenticated: true,
      token_created_at: answer.token_created_at,
    })
  }

  const logout = useMutation({ mutationFn: authApi.logout, onSuccess: signedOut })

  return (
    <SettingsSection id="security" title={t('settings.security.title')} read={read}>
      <SettingRow
        id={SWITCH_ID}
        label={t('settings.security.ask')}
        description={enabled ? undefined : t('settings.access.off')}
      >
        <Switch
          id={SWITCH_ID}
          aria-describedby={enabled ? noteId : `${SWITCH_ID}-description ${noteId}`}
          className="pointer-coarse:after:-inset-3.5"
          checked={enabled}
          onCheckedChange={(on) => procedure(on ? 'enable' : 'disable')}
        />
        <p id={noteId} className="sr-only">
          {t('settings.access.switch.note')}
        </p>
      </SettingRow>

      {enabled ? (
        <>
          <SettingRow label={t('settings.access.code')}>
            <Button variant="outline" className="max-md:h-11" onClick={() => procedure('change')}>
              {t('settings.security.changeCode')}
            </Button>
          </SettingRow>
          <LifetimeRow />
          <SettingRow
            label={t('settings.access.token')}
            description={[
              t('settings.access.token.use'),
              status.token_created_at
                ? t('settings.security.token.made', { date: f.date(status.token_created_at) })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <Button
              variant="outline"
              className="max-md:h-11"
              onClick={() => procedure('regenerate')}
            >
              {t('settings.access.regenerate')}
            </Button>
          </SettingRow>
          <SettingRow label={t('settings.access.device')}>
            <Button
              variant="outline"
              className="max-md:h-11"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              {t('settings.access.logout')}
            </Button>
            {logout.isError ? (
              <p role="alert" className="max-w-72 text-right text-xs text-destructive">
                {t(problemMessageKey(logout.error))}
              </p>
            ) : null}
          </SettingRow>
        </>
      ) : null}

      <EnableDialog
        refocus={refocus}
        open={open === 'enable'}
        onClose={close}
        onDone={(answer) => {
          toast.success(t('settings.access.receipt.enabled'))
          issued(answer)
        }}
      />
      <CurrentCodeDialog
        refocus={refocus}
        open={open === 'disable'}
        title="settings.access.disable"
        note="settings.access.disable.line"
        action="settings.access.disable"
        destructive
        onClose={close}
        run={authApi.disable}
        onDone={() => {
          close()
          toast.success(t('settings.access.receipt.disabled'))
          update({ enabled: false, authenticated: false, token_created_at: null })
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
      <CurrentCodeDialog
        refocus={refocus}
        open={open === 'regenerate'}
        title="settings.security.regenerate.title"
        note="settings.access.regenerate.note"
        action="settings.access.regenerate"
        onClose={close}
        run={authApi.regenerate}
        onDone={(answer) => {
          toast.success(t('settings.access.receipt.regenerated'))
          issued(answer as IssuedToken)
        }}
      />
      <TokenDialog token={token} refocus={refocus} onDone={() => setToken(null)} />
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
  const id = 'security-lifetime'
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
    <SettingRow
      id={id}
      label={t('settings.security.lock')}
      description={t('settings.security.lock.help')}
      state={save.state}
    >
      <Select value={String(value)} onValueChange={(next) => save.save(Number(next))}>
        <SelectTrigger id={id} aria-describedby={`${id}-description`} className="w-44 max-md:h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(LIFETIME_LABEL).map(([seconds, label]) => (
            <SelectItem key={seconds} value={seconds}>
              {t(label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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

/** A procedure's Dialog: a form, Escape and the close button give up. */
function CodeDialog({
  open,
  refocus,
  title,
  note,
  destructive = false,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean
  refocus: (event: Event) => void
  title: MessageKey
  note?: MessageKey
  destructive?: boolean
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
        // A destructive confirmation says so to assistive technology.
        role={destructive ? 'alertdialog' : 'dialog'}
        {...(note ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader>
          <DialogTitle>{t(title)}</DialogTitle>
          {note ? <DialogDescription>{t(note)}</DialogDescription> : null}
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
      <Input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete={current ? 'current-password' : 'new-password'}
        maxLength={6}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ''))}
        className="fig max-md:h-11"
      />
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
  destructive = false,
  onClose,
}: {
  label: MessageKey
  pending: boolean
  destructive?: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="outline" className="max-md:h-11" onClick={onClose}>
        {t('settings.access.cancel')}
      </Button>
      <Button
        type="submit"
        variant={destructive ? 'destructive' : 'primary'}
        className="max-md:h-11"
        disabled={pending}
      >
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
  onDone: (answer: IssuedToken) => void
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
    onSuccess: (answer) => {
      clear()
      onDone(answer)
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

function CurrentCodeDialog({
  open,
  refocus,
  title,
  note,
  action,
  destructive = false,
  onClose,
  run,
  onDone,
}: {
  open: boolean
  refocus: (event: Event) => void
  title: MessageKey
  note: MessageKey
  action: MessageKey
  destructive?: boolean
  onClose: () => void
  run: (current: string) => Promise<unknown>
  onDone: (answer: unknown) => void
}) {
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [invalid, setInvalid] = useState<MessageKey | null>(null)
  const clear = () => {
    setCurrent('')
    setInvalid(null)
  }
  const mutation = useMutation({
    mutationFn: () => run(current),
    onSuccess: (answer) => {
      clear()
      onDone(answer)
    },
  })
  const give = () => {
    clear()
    mutation.reset()
    onClose()
  }

  if (destructive) {
    return (
      <ConfirmDestructive
        open={open}
        onOpenChange={(next) => (next ? undefined : give())}
        title={t('settings.access.disable.title')}
        line={t('settings.access.disable.line')}
        confirmLabel={t('settings.access.disable.cta')}
        pending={mutation.isPending}
        onCloseAutoFocus={refocus}
        error={<Refused error={invalid ?? mutation.error} />}
        onConfirm={() => {
          const wrong = PIN.test(current) ? null : 'settings.access.sixDigits'
          setInvalid(wrong)
          if (wrong === null) mutation.mutate()
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

  return (
    <CodeDialog
      refocus={refocus}
      open={open}
      title={title}
      note={note}
      onClose={give}
      onSubmit={(event) => {
        event.preventDefault()
        const wrong = PIN.test(current) ? null : 'settings.access.sixDigits'
        setInvalid(wrong)
        if (wrong === null) mutation.mutate()
      }}
    >
      <CodeField
        label={t('settings.access.current')}
        value={current}
        onChange={setCurrent}
        current
      />
      <Refused error={invalid ?? mutation.error} />
      <Actions label={action} pending={mutation.isPending} onClose={give} />
    </CodeDialog>
  )
}

/** Shown once: only *J’ai copié le jeton* closes it — not Escape, not a click outside. */
function TokenDialog({
  token,
  refocus,
  onDone,
}: {
  token: IssuedToken | null
  refocus: (event: Event) => void
  onDone: () => void
}) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const config = token ? claudeDesktopConfig(window.location.origin, token.token) : ''

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Dialog open={token !== null}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={refocus}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('settings.access.token.title')}</DialogTitle>
          <DialogDescription>{t('settings.access.token.once')}</DialogDescription>
        </DialogHeader>
        {token ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <code className="fig text-sm break-all">{token.token}</code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copy(token.token)}
              >
                {t(copied ? 'settings.access.token.copied' : 'settings.access.token.copy')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('settings.access.token.desktop')}</p>
            <CodeBlock size="sm">
              <CodeBlockContent wrap>
                {config.split('\n').map((line, index) => (
                  <CodeBlockLine key={index}>{line}</CodeBlockLine>
                ))}
              </CodeBlockContent>
            </CodeBlock>
            <p className="text-xs text-muted-foreground">{t('settings.access.token.script')}</p>
            <CodeBlock size="sm">
              <CodeBlockContent wrap>
                <CodeBlockLine>
                  {`curl -H "Authorization: Bearer ${token.token}" ${window.location.origin}/api/positions`}
                </CodeBlockLine>
              </CodeBlockContent>
            </CodeBlock>
          </>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="primary"
            type="button"
            className="max-md:h-11"
            onClick={() => {
              setCopied(false)
              onDone()
            }}
          >
            {t('settings.access.token.done')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
