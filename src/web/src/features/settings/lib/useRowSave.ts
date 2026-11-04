/**
 * A row's value saved by itself, outside the settings registry (#1279): the
 * agent's switch, its model, its thinking level.
 *
 * The rules are `useDial`'s. **One save in flight per row**: a value chosen
 * while one is on its way is sent after it, and only the last answer reaches
 * `onAnswer` (the last that passed, which is what the server holds), so on/off/on ends on « on » whichever way the answers come back.
 * A failure of any kind is said on the row, in `state`.
 */
import { useRef, useState } from 'react'

import type { DialState } from '@/features/settings/lib/useDial'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

export function useRowSave<T, A>({
  send,
  onAnswer,
}: {
  send: (value: T) => Promise<A>
  /** The last answer, once nothing else is waiting. */
  onAnswer: (answer: A) => void
}) {
  const { t } = useI18n()
  const [state, setState] = useState<DialState>({ kind: 'idle' })
  // What the row shows while a save is on its way: the value chosen last.
  const [chosen, setChosen] = useState<{ value: T } | null>(null)
  const sending = useRef(false)
  const queued = useRef<{ value: T } | null>(null)

  async function run(first: T) {
    sending.current = true
    let value = first
    let answer: { value: A } | null = null
    for (;;) {
      setState({ kind: 'saving' })
      try {
        answer = { value: await send(value) }
        setState({ kind: 'saved' })
      } catch (error) {
        // An earlier answer of this run, if any, is still what the server holds.
        setState({
          kind: 'failed',
          reason: t('settings.row.notSaved', { reason: t(problemMessageKey(error)) }),
        })
      }
      const next = queued.current
      queued.current = null
      if (next === null) break
      value = next.value
    }
    sending.current = false
    if (answer) onAnswer(answer.value)
    setChosen(null)
  }

  function save(value: T) {
    setChosen({ value })
    if (sending.current) {
      queued.current = { value }
      return
    }
    void run(value)
  }

  return { state, save, chosen }
}
