/**
 * The agent's memory (#1619): every confirmed fact and project of the profile
 * (#1116), one ruled row each with its value, its confirmation date, *Modifier*
 * and *Oublier*. The rows are the empty thread's own (`FactDetail`), read under
 * the same key, so an edit or a forgetting made here shows there too.
 * Under them, the owner's own About-me text (#1620), sent with every question.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId, useRef, useState } from 'react'

import { EmptyState } from '@/components/EmptyState'
import { Refusal } from '@/components/Refusal'
import { Unreadable } from '@/components/Unreadable'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { entries, FactDetail } from '@/features/agent/components/AgentProfile'
import { agentApi } from '@/features/agent/lib/api'
import { ABOUT_MAX, type Profile, profileApi } from '@/features/agent/lib/profile'
import { ACT } from '@/features/agent/lib/styles'
import { ApiProblem } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { oneFailure, readConditions } from '@/lib/status'

export function AgentMemoryView() {
  const { t } = useI18n()
  const list = useRef<HTMLDivElement>(null)
  const profile = useQuery({ queryKey: ['profile'], queryFn: profileApi.profile })
  const failure = oneFailure(readConditions({ queries: [profile] }))
  const all = profile.data && entries(profile.data)

  return (
    <div className="flex flex-col gap-9">
      {/* The control line: the way back, and nothing to act on yet. */}
      <div>
        <Link to="/agent" className={ACT}>
          {t('agent.stats.back')}
        </Link>
      </div>
      {/* A forgotten fact takes its row, and the last one the list: the focus lands here. */}
      <div
        ref={list}
        role="group"
        tabIndex={-1}
        aria-label={t('agent.memory.title')}
        className="focus:outline-none"
      >
        {failure !== null ? (
          <Unreadable failure={failure} />
        ) : all === undefined ? null : all.length === 0 ? (
          // A saved About text is something the agent knows: the sentence would be false.
          profile.data?.about ? null : (
            <EmptyState title={t('agent.memory.empty')} />
          )
        ) : (
          <ul className="border-t">
            {all.map((entry) => (
              <li key={entry.key} className="border-b py-2.5">
                <FactDetail entry={entry} onForgotten={() => list.current?.focus()} row />
              </li>
            ))}
          </ul>
        )}
      </div>
      {failure === null && profile.data ? <AboutMe profile={profile.data} /> : null}
    </div>
  )
}

/**
 * The About-me text: a field, its count against the server's bound, *Enregistrer*
 * and *Effacer*. No `maxLength`: a pasted text too long is the server's to
 * refuse, in its own words, and nothing is saved.
 */
function AboutMe({ profile }: { profile: Profile }) {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const id = useId()
  const [draft, setDraft] = useState(profile.about?.text ?? '')
  const field = useRef<HTMLTextAreaElement>(null)
  const providers = useQuery({ queryKey: ['agent-providers'], queryFn: agentApi.providers })
  const provider = providers.data?.find((p) => p.is_default)
  // `null` is *Effacer*: the cached profile then holds no text.
  const write = useMutation({
    mutationFn: async (text: string | null) => {
      if (text !== null) return profileApi.putFact('about', text)
      await profileApi.forgetFact('about')
      return { ...profile, about: null }
    },
    onSuccess: (saved, text) => {
      client.setQueryData(['profile'], saved)
      setDraft(saved.about?.text ?? '')
      // *Effacer* is disabled now: the focus goes back to the field.
      if (text === null) field.current?.focus()
    },
  })
  const described = [
    `${id}-count`,
    provider ? `${id}-privacy` : null,
    write.error ? `${id}-error` : null,
  ]

  return (
    <div className="flex max-w-prose flex-col gap-3">
      <h2 id={`${id}-title`} className="text-prose font-medium">
        {t('agent.memory.about.title')}
      </h2>
      <Textarea
        ref={field}
        aria-labelledby={`${id}-title`}
        aria-describedby={described.filter(Boolean).join(' ')}
        aria-invalid={write.error !== null || undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex gap-2">
          {/* Outline: a fact being edited above holds the screen's one filled button. */}
          <Button
            variant="outline"
            className="min-h-11"
            disabled={write.isPending}
            onClick={() => write.mutate(draft)}
          >
            {t('agent.profile.save')}
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={write.isPending || !profile.about}
            onClick={() => write.mutate(null)}
          >
            {t('agent.memory.about.clear')}
          </Button>
        </div>
        <p id={`${id}-count`} className="fig text-xs text-muted-foreground">
          {t('agent.memory.about.count', {
            count: f.number([...draft.trim()].length, 0),
            max: f.number(ABOUT_MAX, 0),
          })}
        </p>
      </div>
      {write.error ? (
        <div id={`${id}-error`}>
          {/* The server's own words: its refusal names the bound. */}
          <Refusal>
            {write.error instanceof ApiProblem && write.error.detail
              ? write.error.detail
              : t('agent.profile.failed')}
          </Refusal>
        </div>
      ) : null}
      {provider ? (
        <p id={`${id}-privacy`} className="text-xs text-muted-foreground">
          {provider.privacy.local
            ? t('agent.memory.about.local')
            : t('agent.memory.about.sent', { host: provider.privacy.host })}
        </p>
      ) : null}
    </div>
  )
}
