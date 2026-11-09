/**
 * The six slots and one line under them (#1203, « Relevé »), on the PIN screen
 * and in the dialog a session that ended opens. No plane, no button.
 *
 * The code is sent at the sixth digit, typed or pasted; Enter and password
 * managers submit the form all the same. A wrong code clears the slots and
 * draws their borders in `destructive`; too many attempts disable them until an
 * **absolute** deadline, so a tab that slept resumes on the right second, and
 * name the reset command. The countdown is announced at its start and its end
 * only.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { REGEXP_ONLY_DIGITS } from 'input-otp'

import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { authApi, refusedWith, remainingAttempts, retryAfter } from '@/features/auth/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { cn } from '@/lib/utils'

const LENGTH = 6
/** Stands for the countdown while the sentence around it is cut in two. */
const CLOCK_MARK = '\u0000'

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
  const refused = wrong !== null || waiting

  // The clock inside the sentence is a figure, so it is set in mono.
  const [before, after] = t('auth.pin.throttled', { wait: CLOCK_MARK }).split(CLOCK_MARK)

  return (
    <form
      className="flex w-full flex-col items-center gap-7"
      onSubmit={(event) => submit(pin, event)}
    >
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
        <InputOTPGroup className="gap-2.5">
          {Array.from({ length: LENGTH }, (_, index) => (
            <InputOTPSlot
              key={index}
              index={index}
              masked
              className={cn(
                'h-13 w-11 rounded-lg border bg-background text-lg first:rounded-lg last:rounded-lg',
                refused && 'border-destructive',
              )}
            />
          ))}
        </InputOTPGroup>
      </InputOTP>

      {wrong !== null ? (
        <p id={errorId} role="alert">
          {t(wrong === 'last' ? 'auth.pin.wrong.last' : 'auth.pin.wrong')}
        </p>
      ) : failed ? (
        <p id={errorId} role="alert">
          {t(problemMessageKey(signIn.error))}
        </p>
      ) : waiting ? (
        <p id={waitId} aria-hidden="true">
          {before}
          <span className="fig">{clock(left)}</span>
          {after}
        </p>
      ) : (
        <p className="text-muted-foreground">{t('auth.pin.line')}</p>
      )}
      <p role="status" className="sr-only">
        {said}
      </p>

      {waiting ? (
        <div className="flex w-full flex-col gap-2 border-t pt-2 text-left text-sm text-muted-foreground">
          <span>{t('auth.pin.reset')}</span>
          <code className="fig block rounded-md bg-muted px-3 py-2.5 text-xs text-foreground">
            SB_RESET_AUTH=1
          </code>
        </div>
      ) : null}
    </form>
  )
}
