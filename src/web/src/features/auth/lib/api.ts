/**
 * The PIN's routes (#1203), answered by the gate in front of the socket.
 *
 * Every refusal is a `problem+json` like the API's, so it arrives as an
 * `ApiProblem`: `401` with `remaining` is a wrong code, `403` a wrong *current*
 * code, `429` too many attempts with `retry_after` in seconds.
 */
import { ApiProblem, authFetch, get, ROUTES, send } from '@/lib/api'

export interface AuthStatus {
  enabled: boolean
  authenticated: boolean
  /** When the MCP token was made; only to a signed-in reader. Never the token. */
  token_created_at: string | null
}

/** What enabling and regenerating answer: the token, shown once. */
export interface IssuedToken {
  token: string
  token_created_at: string
}

export const authApi = {
  status: () => get<AuthStatus>(ROUTES.authStatus),
  signIn: (pin: string) => send<AuthStatus>(ROUTES.authPin, 'POST', { pin }),
  logout: async () => {
    const response = await authFetch(ROUTES.authLogout, { method: 'POST' })
    if (!response.ok) throw new ApiProblem({ status: response.status })
  },
  enable: (pin: string) => send<IssuedToken>(ROUTES.authEnable, 'POST', { pin }),
  change: (current: string, pin: string) =>
    send<{ enabled: true }>(ROUTES.authChange, 'POST', { current, pin }),
  disable: (current: string) => send<{ enabled: false }>(ROUTES.authDisable, 'POST', { current }),
  regenerate: (current: string) => send<IssuedToken>(ROUTES.authToken, 'POST', { current }),
}

/** A number member of a refusal, or `null`. */
function member(error: unknown, name: string): number | null {
  if (!(error instanceof ApiProblem)) return null
  const value = error.members[name]
  return typeof value === 'number' ? value : null
}

/** Free attempts left after a wrong code, or `null` when the refusal says nothing. */
export function remainingAttempts(error: unknown): number | null {
  return member(error, 'remaining')
}

/** Seconds to wait before the next attempt, or `null` when none is owed. */
export function retryAfter(error: unknown): number | null {
  const seconds = member(error, 'retry_after')
  return seconds !== null && seconds > 0 ? seconds : null
}

export function refusedWith(error: unknown, status: number): boolean {
  return error instanceof ApiProblem && error.status === status
}

/** The Claude Desktop entry for the app's `/mcp`, the token in its header. */
export function claudeDesktopConfig(origin: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'suivi-bourse': {
          command: 'npx',
          args: ['mcp-remote', `${origin}/mcp`, '--header', 'Authorization:${AUTH_HEADER}'],
          env: { AUTH_HEADER: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )
}
