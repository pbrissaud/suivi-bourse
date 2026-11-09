/**
 * **Where a statement is handed over** (« Relevé », #811): the import page's
 * first screen, before any file is in hand.
 *
 * The picker is the target and the rectangle is around it: what carries the
 * accessible name is a real `<input type="file">` with a real `<label>`, and
 * the drop handler is the same call reached another way, so a reader without a
 * pointer is never left outside. A drag that carries no file — a selected word,
 * a link — is left alone, so the browser keeps its own behaviour for it.
 *
 * One file at a time: the preview names its format, its account and every line,
 * and a batch would have to say which file each line came from.
 */
import { useId, useRef, useState, type DragEvent } from 'react'
import { Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** The two formats, stated to the picker and to the reader alike. */
const ACCEPTED = '.csv,.xlsx'

export function UploadZone({
  onFile,
  disabled = false,
}: {
  onFile: (file: File) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const field = useId()
  const [over, setOver] = useState(false)
  const carriesFile = (event: DragEvent) => event.dataTransfer.types.includes('Files')

  return (
    <div
      onDragOver={(event) => {
        if (!carriesFile(event)) return
        event.preventDefault()
        setOver(true)
      }}
      // Moving onto a child of the target also leaves the target: only a real
      // exit puts the highlight down.
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(event) => {
        if (!carriesFile(event)) return
        event.preventDefault()
        setOver(false)
        const [file] = Array.from(event.dataTransfer.files ?? [])
        if (file && !disabled) onFile(file)
      }}
      className={cn(
        'flex flex-col items-center gap-4 rounded-lg border border-dashed px-6 py-16 text-center',
        over && 'border-foreground',
      )}
    >
      <Upload aria-hidden className="size-5 text-muted-foreground" />
      <p className="max-w-prose text-muted-foreground">{t('import.drop')}</p>
      <input
        ref={input}
        id={field}
        type="file"
        accept={ACCEPTED}
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile(file)
          event.target.value = ''
        }}
      />
      <Button type="button" disabled={disabled} onClick={() => input.current?.click()}>
        {t('import.choose')}
      </Button>
      {/* The label the input is reached by: visually hidden, not absent — the
          button above is what a pointer presses. */}
      <label htmlFor={field} className="sr-only">
        {t('import.choose')}
      </label>
    </div>
  )
}
