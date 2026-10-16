/**
 * *Accès* — the optional PIN (#1203), off by default.
 *
 * The switch reflects what is stored and flips only once a card's action has
 * succeeded: turning it on opens *new code, then confirm*, turning it off asks
 * the current code. With the PIN on, three ruled rows — the code, the MCP token,
 * this device — each open their own card under them, one at a time. The token
 * is shown once, in a card only *J'ai copié le jeton* closes.
 */
import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockContent, CodeBlockLine } from '@/components/ui/code-block'
import { Input } from '@/components/ui/input'
import { Section } from '@/components/ui/section'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/components/AuthBoot'
import {
  authApi,
  claudeDesktopConfig,
  refusedWith,
  type IssuedToken,
} from '@/features/auth/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

type Card = 'enable' | 'disable' | 'change' | 'regenerate'

const PIN = /^[0-9]{6}$/

export function AccessBlock() {
  const { t } = useI18n()
  const f = useFormatters()
  const { status, update, signedOut } = useAuth()
  const [card, setCard] = useState<Card | null>(null)
  const [token, setToken] = useState<IssuedToken | null>(null)
  const noteId = useId()
  const enabled = status.enabled

  const issued = (answer: IssuedToken) => {
    setCard(null)
    setToken(answer)
    update({ enabled: true, authenticated: true, token_created_at: answer.token_created_at })
  }

  const logout = useMutation({ mutationFn: authApi.logout, onSuccess: signedOut })

  const row = (label: ReactNode, action: ReactNode, opened: ReactNode) => (
    <div className="border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">{label}</span>
        {action}
      </div>
      {opened}
    </div>
  )

  return (
    <Section
      title={t('settings.access.title')}
      aside={
        <span className="flex items-center gap-3">
          {enabled ? (
            <span role="status" className="text-sm text-muted-foreground">
              {t('settings.access.on')}
            </span>
          ) : null}
          <Switch
            aria-label={t('settings.access.switch')}
            aria-describedby={noteId}
            checked={enabled}
            onCheckedChange={(on) => setCard(on ? 'enable' : 'disable')}
          />
        </span>
      }
    >
      <p id={noteId} className="sr-only">
        {t('settings.access.switch.note')}
      </p>
      {token ? (
        <TokenCard token={token} onDone={() => setToken(null)} />
      ) : !enabled ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('settings.access.off')}</p>
          {card === 'enable' ? (
            <EnableCard
              onClose={() => setCard(null)}
              onDone={(answer) => {
                toast.success(t('settings.access.receipt.enabled'))
                issued(answer)
              }}
            />
          ) : null}
        </div>
      ) : (
        <div>
          {card === 'disable' ? (
            <div className="pb-3">
              <CurrentCodeCard
                note="settings.access.disable.note"
                action="settings.access.disable"
                destructive
                onClose={() => setCard(null)}
                run={authApi.disable}
                onDone={() => {
                  setCard(null)
                  toast.success(t('settings.access.receipt.disabled'))
                  update({ enabled: false, authenticated: false, token_created_at: null })
                }}
              />
            </div>
          ) : null}
          {row(
            t('settings.access.code'),
            <Button variant="outline" size="sm" onClick={() => setCard('change')}>
              {t('settings.access.change')}
            </Button>,
            card === 'change' ? (
              <ChangeCard
                onClose={() => setCard(null)}
                onDone={() => {
                  setCard(null)
                  toast.success(t('settings.access.receipt.changed'))
                }}
              />
            ) : null,
          )}
          {row(
            status.token_created_at
              ? t('settings.access.token.made', { date: f.date(status.token_created_at) })
              : t('settings.access.token'),
            <Button variant="outline" size="sm" onClick={() => setCard('regenerate')}>
              {t('settings.access.regenerate')}
            </Button>,
            card === 'regenerate' ? (
              <CurrentCodeCard
                note="settings.access.regenerate.note"
                action="settings.access.regenerate"
                onClose={() => setCard(null)}
                run={authApi.regenerate}
                onDone={(answer) => {
                  toast.success(t('settings.access.receipt.regenerated'))
                  issued(answer as IssuedToken)
                }}
              />
            ) : null,
          )}
          {row(
            t('settings.access.device'),
            <Button
              variant="outline"
              size="sm"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              {t('settings.access.logout')}
            </Button>,
            logout.isError ? (
              <p role="alert" className="pt-2 text-sm text-destructive">
                {t(problemMessageKey(logout.error))}
              </p>
            ) : null,
          )}
        </div>
      )}
    </Section>
  )
}

/** A `surface` card under its row; Escape closes it. */
function CodeCard({
  onClose,
  onSubmit,
  children,
}: {
  onClose?: () => void
  onSubmit: (event: FormEvent) => void
  children: ReactNode
}) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && onClose) {
      event.stopPropagation()
      onClose()
    }
  }
  return (
    <form
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      className="mt-3 max-w-sm space-y-3 rounded-card bg-card p-3.5"
    >
      {children}
    </form>
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
        className="font-mono"
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
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={pending}>
        {t(label)}
      </Button>
      <Button type="button" variant="ghost" onClick={onClose}>
        {t('settings.access.cancel')}
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

function EnableCard({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: (answer: IssuedToken) => void
}) {
  const { t } = useI18n()
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [invalid, setInvalid] = useState<MessageKey | null>(null)
  const enable = useMutation({ mutationFn: authApi.enable, onSuccess: onDone })

  return (
    <CodeCard
      onClose={onClose}
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
      <Actions label="settings.access.enable" pending={enable.isPending} onClose={onClose} />
    </CodeCard>
  )
}

function ChangeCard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [invalid, setInvalid] = useState<MessageKey | null>(null)
  const change = useMutation({
    mutationFn: () => authApi.change(current, pin),
    onSuccess: onDone,
  })

  return (
    <CodeCard
      onClose={onClose}
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
      <Actions label="settings.access.change" pending={change.isPending} onClose={onClose} />
    </CodeCard>
  )
}

function CurrentCodeCard({
  note,
  action,
  destructive = false,
  onClose,
  run,
  onDone,
}: {
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
  const mutation = useMutation({ mutationFn: () => run(current), onSuccess: onDone })

  return (
    <CodeCard
      onClose={onClose}
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
      <p className="text-xs text-muted-foreground">{t(note)}</p>
      <Refused error={invalid ?? mutation.error} />
      <Actions
        label={action}
        pending={mutation.isPending}
        destructive={destructive}
        onClose={onClose}
      />
    </CodeCard>
  )
}

/** Shown once: only *J'ai copié le jeton* closes it. */
function TokenCard({ token, onDone }: { token: IssuedToken; onDone: () => void }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const config = claudeDesktopConfig(window.location.origin, token.token)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-card bg-card p-3.5">
      <p className="text-sm font-medium">{t('settings.access.token.title')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm break-all">{token.token}</code>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
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
      <p className="text-xs text-muted-foreground">{t('settings.access.token.once')}</p>
      <Button type="button" onClick={onDone}>
        {t('settings.access.token.done')}
      </Button>
    </div>
  )
}
