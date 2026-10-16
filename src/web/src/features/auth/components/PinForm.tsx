/**
 * The six slots and *Déverrouiller* (#1203), on the PIN screen and in the
 * dialog a session that ended opens.
 *
 * The code is sent at the sixth digit, typed or pasted; the button stays for
 * Enter and password managers. A wrong code clears the slots; too many attempts
 * disable them until an **absolute** deadline, so a tab that slept resumes on
 * the right second. The countdown is announced at its start and its end only.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { REGEXP_ONLY_DIGITS } from 'input-otp'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { authApi, refusedWith, remainingAttempts, retryAfter } from '@/features/auth/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

const LENGTH = 6

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function PinForm({
  labelledBy,
  onUnlocked,
}: {
  labelledBy: string
  onUnlocked: () => void
}) {
  const { t } = useI18n()
  const [pin, setPin] = useState('')
  const [wrong, setWrong] = useState<'wrong' | 'last' | null>(null)
  const [until, setUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [said, setSaid] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const waitId = useId()

  const signIn = useMutation({
    mutationFn: authApi.signIn,
    onSuccess: () => {
      setPin('')
      onUnlocked()
    },
    onError: (error) => {
      setPin('')
      const wait = retryAfter(error)
      if (wait !== null) {
        setUntil(Date.now() + wait * 1000)
        setNow(Date.now())
        setSaid(t('auth.pin.throttled', { wait: clock(wait) }))
      }
      if (refusedWith(error, 401)) setWrong(remainingAttempts(error) === 1 ? 'last' : 'wrong')
      else setWrong(null)
    },
  })

  const left = until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000))
  const waiting = left > 0
  const busy = signIn.isPending

  useEffect(() => {
    if (until === null) return
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [until])

  useEffect(() => {
    if (until !== null && left === 0) {
      setUntil(null)
      setSaid(t('auth.pin.again'))
    }
  }, [until, left, t])

  // Back in the first slot whenever it can be typed into again.
  useEffect(() => {
    if (!busy && !waiting) input.current?.focus()
  }, [busy, waiting])

  const submit = (code: string, event?: FormEvent) => {
    event?.preventDefault()
    if (busy || waiting || code.length !== LENGTH) return
    signIn.mutate(code)
  }

  const failed = signIn.isError && !waiting && wrong === null
  const describedBy = [wrong || failed ? errorId : null, waiting ? waitId : null]
    .filter(Boolean)
    .join(' ')

  return (
    <form className="space-y-4" onSubmit={(event) => submit(pin, event)}>
      <InputOTP
        ref={input}
        maxLength={LENGTH}
        value={pin}
        onChange={(value) => {
          setPin(value)
          if (value !== '') setWrong(null)
        }}
        onComplete={(value: string) => submit(value)}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        autoComplete="current-password"
        disabled={busy || waiting}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy || undefined}
        aria-invalid={wrong !== null || undefined}
        containerClassName="justify-center"
      >
        <InputOTPGroup className="gap-1 min-[340px]:gap-2">
          {Array.from({ length: LENGTH }, (_, index) => (
            <InputOTPSlot
              key={index}
              index={index}
              masked
              className="size-11 rounded-md border border-border bg-card text-base first:rounded-md last:rounded-md"
            />
          ))}
        </InputOTPGroup>
      </InputOTP>

      {wrong !== null ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {t(wrong === 'last' ? 'auth.pin.wrong.last' : 'auth.pin.wrong')}
        </p>
      ) : failed ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {t(problemMessageKey(signIn.error))}
        </p>
      ) : null}
      {waiting ? (
        <p id={waitId} aria-hidden="true" className="text-sm text-destructive tabular-nums">
          {t('auth.pin.throttled', { wait: clock(left) })}
        </p>
      ) : null}
      <p role="status" className="sr-only">
        {said}
      </p>

      <Button type="submit" className="h-11 w-full" disabled={busy || waiting}>
        {t(busy ? 'auth.pin.checking' : 'auth.pin.unlock')}
      </Button>

      <Collapsible>
        <CollapsibleTrigger className="text-xs text-primary underline-offset-4 hover:underline">
          {t('auth.pin.forgotten')}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 text-xs leading-relaxed text-muted-foreground">
          {t('auth.pin.forgotten.how')}
        </CollapsibleContent>
      </Collapsible>
    </form>
  )
}
