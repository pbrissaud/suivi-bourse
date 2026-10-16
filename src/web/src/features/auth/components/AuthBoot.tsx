/**
 * What stands before the app (#1203): `/auth/status`, then the PIN screen or
 * the app, and over the app the dialog a session that ended opens.
 *
 * Nothing is drawn until the status answers, so the app never flashes before
 * the lock. Once the app is shown it stays mounted: a later `401` opens the
 * dialog over it, and what the reader typed is kept.
 */
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PinForm } from '@/features/auth/components/PinForm'
import { authApi, type AuthStatus } from '@/features/auth/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { sessionResumed, useSessionEnded } from '@/lib/session'

export const AUTH_STATUS_KEY = ['auth-status'] as const

interface AuthContextValue {
  status: AuthStatus
  /** What a gesture in the *Accès* block left true. */
  update: (status: AuthStatus) => void
  /** This device signed out: back to the PIN screen, nothing of the page kept. */
  signedOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) throw new Error('useAuth() outside <AuthBoot>')
  return value
}

export function AuthBoot({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const status = useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: authApi.status,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  // Latched: a refetch saying *signed out* must not unmount the page under the
  // reader. Only this device's own logout takes the app away.
  const [shown, setShown] = useState(false)
  const open = status.data !== undefined && (!status.data.enabled || status.data.authenticated)
  if (open && !shown) setShown(true)

  if (status.data === undefined) {
    if (!status.isError) return null
    return (
      <main className="mx-auto max-w-xl p-3.5 pt-[15dvh] md:p-5 md:pt-[15dvh]">
        <EmptyState
          title={t('empty.unread.title')}
          description={t(problemMessageKey(status.error))}
          action={
            <Button variant="outline" onClick={() => void status.refetch()}>
              {t('auth.retry')}
            </Button>
          }
        />
      </main>
    )
  }

  const update = (next: AuthStatus) => client.setQueryData(AUTH_STATUS_KEY, next)
  const unlocked = () => {
    sessionResumed()
    update({ ...status.data, enabled: true, authenticated: true })
  }

  if (!shown) return <PinScreen onUnlocked={unlocked} />

  const signedOut = () => {
    // A read still in flight may 401 after the logout: the screen asks once.
    sessionResumed()
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== AUTH_STATUS_KEY[0] })
    client.setQueryData(AUTH_STATUS_KEY, {
      enabled: true,
      authenticated: false,
      token_created_at: null,
    })
    setShown(false)
  }

  return (
    <AuthContext.Provider value={{ status: status.data, update, signedOut }}>
      {children}
      <SessionDialog />
    </AuthContext.Provider>
  )
}

function PinScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useI18n()
  const heading = useId()

  useEffect(() => {
    const was = document.title
    document.title = t('auth.screen.documentTitle')
    return () => {
      document.title = was
    }
  }, [t])

  return (
    <main className="flex min-h-dvh justify-center bg-background p-3.5 pt-[15dvh] md:items-center md:p-5">
      <div className="w-full max-w-[360px] space-y-5 md:rounded-section md:bg-muted md:px-6 md:py-5">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t('app.name')}</p>
          <h1 id={heading} className="text-2xl font-semibold">
            {t('auth.screen.title')}
          </h1>
        </div>
        <PinForm labelledBy={heading} onUnlocked={onUnlocked} />
      </div>
    </main>
  )
}

/** Modal and not dismissable: the page under it waits for the code. */
function SessionDialog() {
  const { t } = useI18n()
  const client = useQueryClient()
  const ended = useSessionEnded()
  const heading = useId()

  if (!ended) return null

  const resumed = () => {
    sessionResumed()
    // Signed in again, whatever the cached status said: another device may
    // have set the code since this page last asked.
    void client.invalidateQueries({ queryKey: AUTH_STATUS_KEY })
    // The reads the 401 broke are asked again; a refused write is not resent.
    void client.refetchQueries({ predicate: (query) => query.state.status === 'error' })
  }

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        aria-labelledby={heading}
        className="sm:max-w-sm"
      >
        <DialogHeader>
          <DialogTitle id={heading}>{t('auth.screen.title')}</DialogTitle>
          <DialogDescription>{t('auth.session.ended')}</DialogDescription>
        </DialogHeader>
        <PinForm labelledBy={heading} onUnlocked={resumed} />
      </DialogContent>
    </Dialog>
  )
}
