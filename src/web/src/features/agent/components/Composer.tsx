/**
 * The composer (« Relevé », `Agent-Refonte.dc.html`): one plane holding the
 * question, « Joindre un relevé », the provider · model picker and the ↑ send
 * button — which never turns `primary` — and, fixed under it, the sentence that
 * says what leaves the server: « Simulations à partir de vos données, jamais un
 * conseil. Vos chiffres sont envoyés à {fournisseur}. » The second half is the
 * provider's own payload (`privacy`), in the reader's language, and the line is
 * drawn once the provider is read, whole.
 */
import { ArrowUp, Upload } from 'lucide-react'
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentTitle,
} from '@/components/ui/attachment'
import { Button } from '@/components/ui/button'
import { ModelPicker, type Runner } from '@/features/agent/components/ModelPicker'
import { StatementDialog, type StatementDraftIn } from '@/features/agent/components/StatementDialog'
import { isStatementFile, unreadableFiles } from '@/features/agent/lib/agentChat'
import type { ConfiguredProvider } from '@/features/agent/lib/api'
import { ACT } from '@/features/agent/lib/styles'
import { useI18n } from '@/lib/i18n'

export function Composer({
  busy,
  threadId,
  onAsk,
  onStop,
  onStatementSent,
  returned,
  providers,
  runner,
  onRunner,
}: {
  busy: boolean
  threadId: string
  onAsk: (text: string) => void
  onStop: () => void
  onStatementSent: () => void
  /** A question the server refused for want of a session, handed back. */
  returned: { text: string } | null
  providers: readonly ConfiguredProvider[]
  /** What the thread runs on, or `null` while the providers are not read. */
  runner: Runner | null
  onRunner: (next: Runner) => void
}) {
  const { t, language } = useI18n()
  const [text, setText] = useState('')
  const [refused, setRefused] = useState<string[]>([])
  // The statement being given, in its box: a dropped file's text, or empty (#1120).
  const [statement, setStatement] = useState<StatementDraftIn | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const fieldId = useId()

  // Focus goes to the input when the page mounts (11A).
  useEffect(() => {
    input.current?.focus()
  }, [])

  useEffect(() => {
    if (returned !== null) setText(returned.text)
  }, [returned])

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const question = text.trim()
    if (busy || question === '') return
    setRefused([])
    setText('')
    onAsk(question)
  }

  // Image or PDF with a text-only model (4A): refused before anything is sent.
  // Every model the agent runs on reads text only (`agent_routes` refuses
  // any other part), so a file is never sent. A `.txt` or `.csv` is text: it is
  // read here and offered as a statement, in a box that asks before it leaves.
  const refuse = (files: FileList) => {
    if (files.length === 0) return false
    if (unreadableFiles(files)) {
      setRefused(Array.from(files, (file) => file.name))
      return true
    }
    if (files.length === 1 && isStatementFile(files[0])) {
      const file = files[0]
      setRefused([])
      void file.text().then((text) => setStatement({ name: file.name, text }))
      return true
    }
    return false
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (refuse(event.clipboardData.files)) event.preventDefault()
  }
  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    if (refuse(event.dataTransfer.files)) event.preventDefault()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
  }

  const provider = providers.find((one) => one.id === runner?.provider_id)

  // The scroller's gutter, reserved here too: the plane ends where the messages do.
  return (
    <div className="mx-auto flex w-full max-w-reading scrollbar-thin scrollbar-gutter-stable flex-col gap-2 overflow-hidden px-4 pt-2 pb-5 md:px-8">
      {refused.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1">
          {refused.map((name) => (
            <Attachment key={name} state="error" size="sm">
              <AttachmentContent>
                <AttachmentTitle>{name}</AttachmentTitle>
                <AttachmentDescription>{t('agent.files.refused')}</AttachmentDescription>
              </AttachmentContent>
            </Attachment>
          ))}
        </div>
      ) : null}
      <form
        onSubmit={submit}
        className="flex flex-col gap-2 rounded-xl border border-input bg-background px-3 pt-3 pb-2.5"
      >
        <label htmlFor={fieldId} className="sr-only">
          {t('agent.input')}
        </label>
        <textarea
          id={fieldId}
          ref={input}
          value={text}
          rows={2}
          placeholder={t('agent.input.placeholder')}
          className="max-h-40 w-full resize-none border-0 bg-transparent p-0 text-prose outline-none placeholder:text-muted-foreground"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
        />
        <div className="flex items-center gap-4">
          <button
            type="button"
            className={ACT}
            disabled={busy}
            onClick={() => setStatement({ name: '', text: '' })}
          >
            <Upload className="size-4" aria-hidden="true" />
            {t('agent.statement.button')}
          </button>
          <span className="ml-auto flex items-center gap-4">
            {runner !== null ? (
              <ModelPicker
                providers={providers}
                value={runner}
                onChange={onRunner}
                disabled={busy}
              />
            ) : null}
            {busy ? (
              <Button type="button" variant="outline" onClick={onStop}>
                {t('agent.stop')}
              </Button>
            ) : (
              <Button
                type="submit"
                variant="outline"
                size="icon"
                aria-label={t('agent.send')}
                disabled={text.trim() === ''}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
            )}
          </span>
        </div>
      </form>
      <StatementDialog
        draft={statement}
        threadId={threadId}
        providerId={runner?.provider_id}
        onClose={() => setStatement(null)}
        onSent={onStatementSent}
      />
      {provider ? (
        <p className="text-center text-xs text-muted-foreground">
          {t('agent.cif')} {provider.privacy[language === 'en' ? 'en' : 'fr']}
        </p>
      ) : null}
    </div>
  )
}
