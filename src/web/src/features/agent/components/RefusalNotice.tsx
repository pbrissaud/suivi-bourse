/**
 * A provider's refusal in the reader's words (#1269), for Settings and the
 * agent page alike: the sentence for its `reason`, then the provider's own
 * message behind a disclosure, folded for every reason. The whole block is
 * the alert; the raw English stays one click away, for the reader who wants to
 * act on it at the provider's. `children` sit under the disclosure: a link, a
 * *Réessayer*.
 */
import { ChevronRightIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useI18n, type MessageKey } from '@/lib/i18n'

const SENTENCES: Record<string, MessageKey> = {
  key: 'agent.refusal.key',
  quota: 'agent.refusal.quota',
  rate_limit: 'agent.refusal.rate_limit',
  model: 'agent.refusal.model',
  address: 'agent.refusal.address',
  overloaded: 'agent.refusal.overloaded',
  unreachable: 'agent.refusal.unreachable',
  unreadable: 'agent.refusal.unreadable',
  refused: 'agent.refusal.refused',
}

/** `provider` is the translated label; a `reason` this list does not know is `refused`. */
export function RefusalNotice({
  provider,
  reason,
  said,
  children,
}: {
  provider: string
  reason: string
  said: string
  children?: ReactNode
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div role="alert" className="space-y-1">
      <p className="text-sm text-destructive">
        {t(SENTENCES[reason] ?? SENTENCES.refused, { provider })}
      </p>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-8 items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11">
          <ChevronRightIcon
            aria-hidden
            className="size-4 transition-transform motion-reduce:transition-none group-data-[state=open]:rotate-90"
          />
          {t('agent.refusal.raw', { provider })}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-1">
          <p className="font-mono text-xs break-words">{said}</p>
        </CollapsibleContent>
      </Collapsible>
      {children}
    </div>
  )
}
