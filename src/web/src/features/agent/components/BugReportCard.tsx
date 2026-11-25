/**
 * A bug report the agent drafted (#1630): its title, the start of its body as
 * plain text, and the prefilled GitHub form. Nothing is stored, so there is
 * nothing to confirm: the owner reviews and files the issue there.
 */
import type { BugReport } from '@/features/agent/lib/agentChat'
import { useI18n } from '@/lib/i18n'

export function BugReportCard({ report }: { report: BugReport }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-3 rounded-card border bg-card p-3.5">
      <p className="text-prose break-words">{report.title}</p>
      <p className="line-clamp-6 text-sm break-words whitespace-pre-wrap text-muted-foreground">
        {report.body}
      </p>
      <a
        href={report.url}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start text-sm font-medium underline underline-offset-4 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {t('agent.bugReport.open')}
      </a>
    </div>
  )
}
