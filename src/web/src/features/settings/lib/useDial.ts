/**
 * One dial of the registry, saved by itself (#1279).
 *
 * The page has no section-level Save: a row owns its draft, its request and its
 * receipt. What the old form got right stays, and is reused rather than
 * rewritten — `changedValues` decides whether the value moved (a blank field is
 * not a reset, an unchanged one restarts no timer) and `draftFrom` reads the
 * stored value as text.
 *
 * **One save in flight per row.** « Moved » compares with the value last sent,
 * not the stored one: Enter then blur sends one `PUT`, and a value typed during
 * a save waits for it, so on/off/on ends on « on » whichever way the answers
 * come back. Only the last answer writes the cache.
 *
 * **A refusal keeps what was typed**, whatever it was (a `422`, a `5xx`, a
 * fetch that rejected): the row says so, and the next blur or Enter retries.
 * Escape gives the stored value back. Reseeding follows the stored value only
 * while the row holds no draft, so typing in one row while another saves
 * touches nothing here.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  type ConfigResponse,
  type SettingDescription,
  settingsApi,
  type SettingsWriteResponse,
} from '@/features/settings/lib/api'
import { changedValues, draftFrom } from '@/features/settings/lib/installation'
import { ApiProblem } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { PROBLEM_TYPES, problemMessageKey } from '@/lib/problem'

/** What a dial's change reaches beyond the registry's own list. */
const REACHES: Record<string, readonly string[]> = {
  base_currency: ['positions', 'portfolio-totals'],
  update_check: ['release'],
}

export type DialState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; reason: string }

/** A number as the field shows it: at most two decimals, no trailing zero (« 1,5 » minutes). */
const shown = (n: number) => String(Math.round(n * 100) / 100)

/**
 * `scale` is how many of the registry's units one of the field's is worth: a
 * dial stored in seconds and shown in minutes is `60`. The field, the draft and
 * the refusals speak the field's unit; the wire speaks the registry's.
 */
export function useDial(key: string, scale = 1) {
  const { t } = useI18n()
  const client = useQueryClient()
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  const setting = config.data?.settings.find((one) => one.key === key)
  const storedWire = setting ? (draftFrom([setting])[key] ?? '') : ''
  const stored =
    scale !== 1 && storedWire !== '' && Number.isFinite(Number(storedWire))
      ? shown(Number(storedWire) / scale)
      : storedWire
  /** The field's text in the registry's unit; what is not a number goes as typed. */
  const wire = (value: string) => {
    const n = Number(value.trim().replace(',', '.'))
    return scale === 1 || value.trim() === '' || !Number.isFinite(n)
      ? value
      : String(Math.round(n * scale))
  }

  // `null` follows the stored value; a string is a draft the row owns.
  const [typed, setTyped] = useState<string | null>(null)
  const [state, setState] = useState<DialState>({ kind: 'idle' })
  const draft = typed ?? stored

  const sending = useRef<string | null>(null)
  const queued = useRef<string | null>(null)
  const latest = useRef(setting)
  latest.current = setting

  /** `kept` is what the server holds right now: the registry row the last answer left. */
  function refusal(error: unknown, value: string, kept: SettingDescription): string {
    const number = Number(wire(value))
    if (
      error instanceof ApiProblem &&
      error.type === PROBLEM_TYPES.invalidSetting &&
      kept.type === 'integer' &&
      Number.isFinite(number)
    ) {
      const stays = Number(kept.value) / scale
      if (kept.maximum !== null && number > kept.maximum) {
        return t('settings.row.atMost', { max: kept.maximum / scale, stored: stays })
      }
      if (kept.minimum !== null && number < kept.minimum) {
        return t('settings.row.atLeast', { min: kept.minimum / scale, stored: stays })
      }
    }
    if (problemMessageKey(error) === 'problem.unreachable') {
      return kept.type === 'integer' && kept.value !== null
        ? t('settings.row.unreachable.stored', { stored: Number(kept.value) / scale })
        : t('settings.row.unreachable')
    }
    return t('settings.row.notSaved', { reason: t(problemMessageKey(error)) })
  }

  async function send(first: string, base: SettingDescription) {
    let value = first
    let from = base
    let answered = false
    let ok = true
    sending.current = value
    for (;;) {
      ok = true
      if (Object.keys(changedValues([from], { [key]: wire(value) })).length > 0) {
        setState({ kind: 'saving' })
        let answer: SettingsWriteResponse | null = null
        try {
          answer = await settingsApi.saveSettings(
            from.type === 'boolean' ? { [key]: value === 'true' } : { [key]: wire(value).trim() },
          )
        } catch (error) {
          ok = false
          setState({ kind: 'failed', reason: refusal(error, value, from) })
        }
        const fresh = answer?.settings.find((one) => one.key === key)
        if (fresh) {
          from = fresh
          answered = true
        }
      }
      // A value typed meanwhile goes next, and makes this answer a stale one.
      const next = queued.current
      queued.current = null
      if (next === null) break
      value = next
      sending.current = next
    }
    // A commit during the cache write below compares with what the server holds
    // now, not with the row the page last rendered.
    if (answered) latest.current = from
    sending.current = null
    if (answered) {
      // Only this row, and only after a read that was already on its way is
      // dropped: another row's answer may be newer than the whole list this one
      // carries, and a late `GET` would write the old value back.
      await client.cancelQueries({ queryKey: ['config'] })
      client.setQueryData<ConfigResponse>(['config'], (previous) =>
        previous
          ? {
              ...previous,
              settings: previous.settings.map((one) => (one.key === key ? from : one)),
            }
          : previous,
      )
      for (const name of ['runtime', ...(REACHES[key] ?? [])]) {
        client.invalidateQueries({ queryKey: [name] })
      }
    }
    if (ok) {
      // Moved or not, the stored value is what the field shows again.
      setTyped((now) => (now === value ? null : now))
      // A blur that moved nothing leaves the last receipt alone, except a refusal
      // the field no longer carries.
      setState((now) =>
        answered ? { kind: 'saved' } : now.kind === 'failed' ? { kind: 'idle' } : now,
      )
    }
  }

  /** Save `value` (the draft by default) unless it is where the row already is. */
  function commit(value: string = draft) {
    const current = latest.current
    if (!current) return
    if (sending.current !== null) {
      queued.current = value === sending.current ? null : value
      return
    }
    void send(value, current)
  }

  /** A switch or a select: the value shows at once, and is saved. */
  function set(value: string) {
    setTyped(value)
    commit(value)
  }

  /** The props of a number or text field: saves on blur and Enter, Escape gives up. */
  const field = {
    value: draft,
    'aria-invalid': state.kind === 'failed' || undefined,
    onChange: (event: { target: { value: string } }) => {
      setTyped(event.target.value)
      setState((now) => (now.kind === 'saving' ? now : { kind: 'idle' }))
    },
    onBlur: () => commit(),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') commit(event.currentTarget.value)
      // What is already on its way cannot be taken back: Escape would only show
      // the old value for as long as the answer takes.
      if (event.key === 'Escape' && sending.current === null) {
        setTyped(null)
        setState({ kind: 'idle' })
      }
    },
  }

  return { setting, draft, state, field, set }
}
