/**
 * The bell, and the panel behind it — **the app's one global indicator**
 * (#829, ADR-0037, ADR-0022).
 *
 * It replaces three things at once: the status dot, whose colour it wears; the
 * sidebar's status card, whose sentence it says in prose one click away; and the
 * banner, whose three conditions are entries in it. What was four renderings of
 * one fact is one control with **two channels** — the icon carries the health
 * colour, the badge carries the count — and one destination.
 *
 * It lives in the content header for the reason the dot did: that bar is the
 * only surface that survives the **three** sidebar states, shadcn hiding
 * `SidebarMenuBadge` in icon mode and the drawer taking the whole navigation
 * with it. The sidebar card was the one of the four that vanished in the rail
 * and in the drawer — the widths where a reader has least to look at — which is
 * why it is the one that went.
 *
 * **The badge is deliberately neutral in colour** so the two channels do not
 * compete for the same signal.
 *
 * Four reads, and each is one the shell already made or one the panel is: the
 * health the icon is, the installation facts, the advisories, and the config the
 * currency entry is read off. Nothing here is rendered until they land —
 * *a read in flight is not an absence* (ADR-0026) — which is what makes
 * *Nothing to report* a statement about the panel rather than about a silence.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bell } from 'lucide-react'

import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { currencyUnanswered } from '@/lib/firstRun'
import { useI18n, type MessageKey } from '@/lib/i18n'
import {
  acknowledgeable,
  grouped,
  notifications,
  openCount,
  selfEnding,
  type Acknowledgement,
  type Destination,
  type Said,
  type Subject,
} from '@/lib/notifications'
import { installationState, oneFailure, readConditions, type InstallationState } from '@/lib/status'
import { cn } from '@/lib/utils'

/**
 * The five states, in colour, and **declared exactly once**. It used to be the
 * dot's and to be read a second time by the sidebar's card; there is one
 * consumer now, and a second copy of the mapping would be a second opinion on
 * what *attention* looks like.
 *
 * It is a **text** colour rather than a background: the channel is the bell's
 * own icon, not a disc beside it, which is what makes the count's badge the
 * only other thing on the control.
 *
 * `rebuilding` shares `attention`'s tone and not its word: both say *not
 * everything on screen is what it will be*, which is what a colour can carry,
 * and only a sentence can say that one needs a hand and the other only time.
 */
export const STATE_TONE: Record<InstallationState, string> = {
  unknown: 'text-muted-foreground',
  ok: 'text-gain',
  attention: 'text-attention',
  rebuilding: 'text-attention',
  unreachable: 'text-destructive',
}

const SUBJECT_LABELS: Record<Subject, MessageKey> = {
  health: 'notification.subject.health',
  installation: 'notification.subject.installation',
  portfolio: 'notification.subject.portfolio',
  accounts: 'notification.subject.accounts',
}

export function Notifications() {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)

  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const facts = useQuery({ queryKey: ['installation-facts'], queryFn: api.installationFacts })
  const advisories = useQuery({ queryKey: ['advisories'], queryFn: api.advisories })
  // The same read the first-run modal composes its predicate from — one query
  // key, so it is one request and **no new API state** for either surface.
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })

  const state = installationState({ health: health.data, error: health.error })
  // **Nothing is claimed on a silence.** `pending` is the read's own word for
  // *it has not answered and it has not failed*, which is the one state in
  // which this panel says nothing at all — headings, cards and the empty
  // sentence alike.
  const pending = [health, facts, advisories, config].some(
    (read) => read.status === 'pending',
  )

  const entries = notifications({
    health: health.status === 'pending' ? null : state,
    facts: facts.data ?? null,
    advisories: advisories.data ?? null,
    currencyUnanswered: currencyUnanswered(config.data?.settings),
    list: f.list,
  })

  // One sentence for a read that did not answer, and the health read is the
  // cause of the others: when the app is not answering at all, the bell is red
  // and the panel's own health card says so — repeating it here would put two
  // announcers on one fact.
  const failure = oneFailure(
    readConditions({
      namedElsewhere: health.error,
      errors: [facts.error, advisories.error, config.error],
    }),
  )

  const count = openCount(entries)
  const ackable = acknowledgeable(entries)
  const groups = grouped(entries)

  const acknowledge = useMutation({
    // The **register** picks the resource, and that is the whole of what it is
    // for: two gestures with one name on screen, two routes underneath, and
    // neither payload read — what comes back is the list, re-read below.
    mutationFn: async (gesture: Acknowledgement) => {
      if (gesture.register === 'fact') await api.acknowledgeInstallationFact(gesture.key)
      else await api.acknowledgeAdvisory(gesture.key)
    },
    // Both lists are re-read rather than patched in place: the server drops the
    // row of an installation fact whose predicate has stopped standing, and an
    // advisory is derived per read — a client editing its own copy would keep
    // showing what the installation has grown out of.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['installation-facts'] })
      void client.invalidateQueries({ queryKey: ['advisories'] })
    },
  })

  /**
   * *Acknowledge the N acknowledgeable* — **one gesture, one at a time**.
   *
   * Sequential rather than parallel: each acknowledgement is a write on one
   * DuckDB connection behind the writers' mutex, and N requests racing for it
   * buys nothing a reader can see.
   */
  const acknowledgeAll = useMutation({
    mutationFn: async () => {
      for (const entry of ackable) {
        if (entry.acknowledge === null) continue
        await acknowledge.mutateAsync(entry.acknowledge)
      }
    },
  })

  const say = (said: Said) => ('text' in said ? said.text : t(said.key, said.values))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="relative flex size-7 items-center justify-center rounded-md hover:bg-accent"
        // **Two channels in one name.** The state is the icon's colour, which
        // says nothing to a screen reader, and the count is the badge, which is
        // `aria-hidden` for the same reason every figure drawn twice is. The
        // count joins the name only once the reads have landed: a number said
        // over a silence is a claim about the reader's installation.
        aria-label={
          pending
            ? `${t('notification.open')} — ${t('status.dot', { state })}`
            : `${t('notification.open')} — ${t('status.dot', { state })} — ${t(
                'notification.count',
                { count },
              )}`
        }
      >
        <Bell aria-hidden className={cn('size-4', STATE_TONE[state])} />
        {pending || count === 0 ? null : (
          <span
            aria-hidden
            className="tabular absolute -top-0.5 -right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-muted-foreground px-1 text-[10px] leading-4 font-semibold text-background"
          >
            {count}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={16}
        aria-label={t('notification.title')}
        className="flex max-h-[min(32rem,calc(100vh-6rem))] w-[min(24rem,calc(100vw-2rem))] flex-col gap-0 p-0"
      >
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">{t('notification.title')}</h2>
          {pending ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              // **It cannot reach zero, so it states its own scope.** Three of
              // the four sources never decrement on their own, which ADR-0037
              // accepts with the objection in view; what it owes in exchange is
              // a control that says what it clears rather than promising a
              // clean slate. Disabled, it says **why** in prose underneath.
              disabled={ackable.length === 0 || acknowledgeAll.isPending}
              onClick={() => acknowledgeAll.mutate()}
            >
              {t('notification.ackAll', { count: ackable.length })}
            </Button>
          )}
        </div>

        {pending || ackable.length > 0 || count === 0 ? null : (
          <p className="shrink-0 px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
            {t('notification.ackAll.none', { count: selfEnding(entries) })}
          </p>
        )}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          {failure ? <Refusal>{t(failure.message)}</Refusal> : null}

          {groups.map((group) => (
            <section key={group.subject} aria-labelledby={`notifications-${group.subject}`}>
              <h3
                id={`notifications-${group.subject}`}
                className="px-1 pb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
              >
                {t(SUBJECT_LABELS[group.subject])}
              </h3>
              <ul className="space-y-2">
                {group.entries.map((entry) => (
                  <li key={entry.id} className="space-y-2 rounded-xl border bg-card p-3">
                    <p className="text-sm font-semibold">{say(entry.title)}</p>
                    {entry.at === null ? null : (
                      <p className="text-xs text-muted-foreground">
                        {t('notification.seen', { date: f.dateTime(entry.at) })}
                      </p>
                    )}
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {say(entry.body)}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {entry.link === null ? null : (
                        <CardLink
                          label={t(entry.link.label)}
                          to={entry.link.to}
                          onFollow={() => setOpen(false)}
                        />
                      )}
                      {entry.acknowledge === null ? null : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          disabled={acknowledge.isPending || acknowledgeAll.isPending}
                          onClick={() => acknowledge.mutate(entry.acknowledge!)}
                        >
                          {t(
                            entry.register === 'advisory'
                              ? 'notification.ack.advisory'
                              : 'notification.ack',
                          )}
                        </Button>
                      )}
                    </div>
                    {/* *Put to sleep, never ended* — said on the card, because
                        it is the difference between the two acknowledgements
                        and the reader has no other way to know it. */}
                    {entry.register === 'advisory' ? (
                      <p className="text-xs text-muted-foreground">
                        {t('notification.ack.advisory.note')}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {/* **Said only when the panel is truly empty**, and never over a read
              that has not landed or one that failed: a pinned red card and this
              sentence cannot be on screen together (ADR-0037). */}
          {pending || failure !== null || count > 0 ? null : (
            <div className="px-3 py-10 text-center">
              <p className="text-sm">{t('notification.empty.title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('notification.empty.body')}</p>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * A card's link — **onto the figure, never onto the page** (ADR-0037).
 *
 * The four destinations are the four the panel can name, and each is spelled as
 * the router spells it rather than as a query string: the account *selected*,
 * the security's sheet *open*, the ledger *reduced* to the securities the card
 * names — every one of them a reduction that already exists and names itself.
 */
function CardLink({
  label,
  to,
  onFollow,
}: {
  label: string
  to: Destination
  onFollow: () => void
}) {
  const className =
    'inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:border-primary/50 hover:text-primary'

  if (to.to === '/comptes') {
    return (
      <Link to="/comptes" search={to.search} className={className} onClick={onFollow}>
        {label}
      </Link>
    )
  }
  if (to.to === '/titres') {
    return (
      <Link to="/titres" search={to.search} className={className} onClick={onFollow}>
        {label}
      </Link>
    )
  }
  if (to.to === '/donnees') {
    return (
      <Link to="/donnees" search={to.search} className={className} onClick={onFollow}>
        {label}
      </Link>
    )
  }
  return (
    <Link to="/reglages" className={className} onClick={onFollow}>
      {label}
    </Link>
  )
}

