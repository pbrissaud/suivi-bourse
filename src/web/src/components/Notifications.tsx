/**
 * The bell, and the popover behind it (#829, « Relevé »).
 *
 * The bell holds **only what concerns the owner's figures**, in plain French:
 * a late price, a finished import, an installed update. It reads the `user`
 * register of the advisories (`GET /api/advisories?register=user`), and the
 * server writes the sentences — with the security's name, in the reader's
 * language — so this file holds no phrase per family. The technical state of
 * the app (series rebuilt, orphans, tokens, a stopped job) is Système's, and the
 * footer says so.
 *
 * The icon wears the app's health colour, and the count of what is unread sits
 * beside it. The panel is a 400 px popover: a title and « Tout marquer lu », a
 * ruled row per notification (TriangleAlert on the ones to look at, a read one
 * in `muted-foreground`, the time in mono on the right), a footer.
 *
 * Nothing is rendered until the reads land — *a read in flight is not an
 * absence* — which is what makes *Rien à signaler* a statement about the
 * panel rather than about a silence.
 *
 * **The one announcer has an echo** (#1180). When the bell turns
 * `unreachable`, a toast says so once — *the server is not answering, the
 * figures are from HH:MM* — because a reader watching figures that no longer
 * move has no reason to look at a 16 px icon. It is derived from the very
 * state the icon wears, so the two cannot disagree; it opens on the
 * *transition* only, stays dismissed once dismissed until the next outage, and
 * closes silently on recovery. The bell stays red throughout: the toast echoes
 * it, it does not replace it.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bell, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import { Unreadable } from '@/components/Unreadable'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { type Advisory, api, get, ROUTES } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { installationState, oneFailure, readConditions, type InstallationState } from '@/lib/status'
import { cn } from '@/lib/utils'

/**
 * The five states, in colour, and **declared exactly once**. There is one
 * consumer, and a second copy of the mapping would be a second opinion on what
 * *attention* looks like.
 *
 * It is a **text** colour rather than a background: the channel is the bell's
 * own icon, not a disc beside it, which is what makes the count the only other
 * thing on the control.
 *
 * `rebuilding` shares `attention`'s tone and not its word: both say *not
 * everything on screen is what it will be*, which is what a colour can carry.
 * Since #1130 `--attention` is the foreground, so those two carry no hue: the
 * icon says it.
 */
export const STATE_TONE: Record<InstallationState, string> = {
  unknown: 'text-muted-foreground',
  ok: 'text-foreground',
  attention: 'text-attention',
  rebuilding: 'text-attention',
  unreachable: 'text-destructive',
}

/**
 * One notification of the `user` register — `GET /api/advisories?register=user&asleep=include`.
 * The sentences are the server's (French or English, with the security's name);
 * `acknowledged_until` is set on a read one, which is why the asleep ones are
 * asked for: a read notification stays in the list, in `muted-foreground`.
 */
export type UserNotification = Advisory & { acknowledged_until?: string | null }

const USER_NOTIFICATIONS = `${ROUTES.advisories}?register=user&asleep=include`

/** The kinds that call for a look: they carry the TriangleAlert while unread. */
const TO_LOOK_AT = ['late_price', 'no_price']

/** Where a kind leads. Everything the bell can say is read in Système or in the ledger. */
function destination(kind: string): '/system' | '/ledger' {
  return kind === 'import_finished' ? '/ledger' : '/system'
}

/** One id, so an outage is one toast however many polls fail in a row. */
const OUTAGE_TOAST = 'outage'

const DAY_MS = 86_400_000

export function Notifications() {
  const { t, language } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)

  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const notes = useQuery({
    queryKey: ['advisories', 'user'],
    queryFn: () => get<UserNotification[]>(USER_NOTIFICATIONS),
  })

  const state = installationState({ health: health.data, error: health.error })

  // **The echo of the bell** (#1180): opened on the transition into
  // `unreachable` and on nothing else, so a dismissed toast stays dismissed
  // while the polls keep failing. `dataUpdatedAt` is the last answer the
  // health read got — the instant the figures on screen are from. A read
  // that never answered goes back to `pending` on every poll, which clears
  // its error: that is no news, and it neither opens nor closes anything.
  const wasUnreachable = useRef(false)
  useEffect(() => {
    if (health.status === 'pending') return
    const unreachable = state === 'unreachable'
    if (unreachable === wasUnreachable.current) return
    wasUnreachable.current = unreachable
    if (!unreachable) {
      toast.dismiss(OUTAGE_TOAST)
      return
    }
    toast(t('outage.title'), {
      id: OUTAGE_TOAST,
      description:
        health.dataUpdatedAt === 0
          ? t('outage.bodyNoFigures')
          : t('outage.body', { at: health.dataUpdatedAt }),
      icon: <Bell aria-hidden className="size-4 text-destructive" />,
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
      // A 44 px target around sonner's 20 px cross, without redrawing it.
      classNames: { closeButton: "after:absolute after:-inset-3 after:content-['']" },
    })
  }, [state, health.status, health.dataUpdatedAt, t])

  // **Nothing is claimed on a silence.** `pending` is the read's own word for
  // *it has not answered and it has not failed*, which is the one state in
  // which this panel says nothing at all.
  const pending = [health, notes].some((read) => read.status === 'pending')

  // One sentence for a read that did not answer, and the health read is the
  // cause of the others: when the app is not answering at all, the bell is red
  // and says so — repeating it here would put two announcers on one fact.
  const failure = oneFailure(readConditions({ namedElsewhere: health.error, queries: [notes] }))

  const items = notes.data ?? []
  const unread = items.filter((item) => !item.acknowledged_until)

  const markRead = useMutation({
    // One at a time: each is a write on one connection behind the writers'
    // mutex, and N requests racing for it buys nothing a reader can see.
    mutationFn: async () => {
      for (const item of unread) await api.acknowledgeAdvisory(item.key)
    },
    // Re-read rather than patched in place: the server owns what is asleep.
    onSettled: () => client.invalidateQueries({ queryKey: ['advisories'] }),
  })

  /** The instant, as the day's habit says it: a time today, « hier », a day. */
  function when(iso: string): string {
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) return ''
    const now = new Date()
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    if (at.getTime() >= midnight) {
      return new Intl.DateTimeFormat(f.locale, { hour: '2-digit', minute: '2-digit' }).format(at)
    }
    if (at.getTime() >= midnight - DAY_MS) return t('notification.yesterday')
    return new Intl.DateTimeFormat(f.locale, { day: 'numeric', month: 'short' }).format(at)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="relative flex size-8 items-center justify-center rounded-lg outline-hidden hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-11"
        // **Two channels in one name.** The state is the icon's colour, which
        // says nothing to a screen reader, and the count is the badge, which is
        // `aria-hidden` for the same reason every figure drawn twice is. The
        // count joins the name only once the reads have landed: a number said
        // over a silence is a claim about the reader's installation.
        aria-label={
          pending
            ? `${t('notification.open')} — ${t('status.dot', { state })}`
            : `${t('notification.open')} — ${t('status.dot', { state })} — ${
                unread.length === 0
                  ? t('notification.count.none')
                  : t('notification.count', { count: unread.length })
              }`
        }
      >
        <Bell aria-hidden className={cn('size-4', STATE_TONE[state])} />
        {pending || unread.length === 0 ? null : (
          <span
            aria-hidden
            className="fig absolute top-0.5 right-0 inline-flex h-3.75 min-w-3.75 items-center justify-center rounded-full bg-muted-foreground px-1 text-xs leading-none font-bold text-background"
          >
            {unread.length}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={16}
        aria-label={t('notification.title')}
        className="flex max-h-[min(72vh,calc(100vh-6rem))] w-[min(25rem,calc(100vw-2rem))] flex-col gap-0 rounded-card bg-background p-0"
      >
        <header className="flex shrink-0 items-baseline justify-between gap-3 px-5 pt-4 pb-1">
          <h2 className="text-prose font-semibold">{t('notification.title')}</h2>
          {pending || unread.length === 0 ? null : (
            <button
              type="button"
              className="text-sm text-muted-foreground underline decoration-border underline-offset-3 hover:text-foreground disabled:opacity-50"
              disabled={markRead.isPending}
              onClick={() => markRead.mutate()}
            >
              {t('notification.markAllRead')}
            </button>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          {pending ? null : failure ? <Unreadable failure={failure} /> : null}

          {pending || failure !== null ? null : items.length === 0 ? (
            // « Rien à signaler » only when the icon says nothing either: a bell
            // wearing the attention colour over an empty list contradicts itself.
            state === 'attention' || state === 'rebuilding' ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('status.dot', { state })}{' '}
                <Link
                  to="/system"
                  className="underline underline-offset-4"
                  onClick={() => setOpen(false)}
                >
                  {t('notification.state.link')}
                </Link>
              </p>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('notification.empty.title')}
              </p>
            )
          ) : (
            <ul>
              {items.map((item) => {
                const read = Boolean(item.acknowledged_until)
                const look = !read && TO_LOOK_AT.includes(item.kind)
                return (
                  <li key={item.key} className="border-b last:border-b-0">
                    <Link
                      // A line with no price is fixed on its own page.
                      {...(item.kind === 'no_price' && typeof item.detail.symbol === 'string'
                        ? { to: '/shares/$symbol', params: { symbol: item.detail.symbol } }
                        : { to: destination(item.kind) })}
                      onClick={() => setOpen(false)}
                      className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2.5 py-3 text-sm"
                    >
                      <span aria-hidden className="flex pt-0.5">
                        {look ? <TriangleAlert className="size-3.5" /> : null}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span
                          className={cn(read ? 'font-normal text-muted-foreground' : 'font-medium')}
                        >
                          {item.texts?.[language].title ?? item.message}
                        </span>
                        {item.texts?.[language].sub ? (
                          <span className="text-muted-foreground">{item.texts[language].sub}</span>
                        ) : null}
                      </span>
                      <span className="fig text-muted-foreground">{when(item.observed_at)}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 px-5 pt-2.5 pb-3.5 text-sm text-muted-foreground">
          <span>
            {t('notification.footer.before')}{' '}
            <Link to="/system" className="text-inherit" onClick={() => setOpen(false)}>
              {t('nav.system')}
            </Link>
          </span>
          <Link
            to="/settings"
            className="text-inherit underline decoration-border underline-offset-3 hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            {t('nav.settings')}
          </Link>
        </footer>
      </PopoverContent>
    </Popover>
  )
}
