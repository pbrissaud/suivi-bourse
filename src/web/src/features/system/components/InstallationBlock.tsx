import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { Refusal } from '@/components/Refusal'
import { Section } from '@/components/ui/section'
import { Switch } from '@/components/ui/switch'
import { FactRow } from '@/features/system/components/DataBlock'
import { settingsApi } from '@/features/settings/lib/api'
import { HelpLinks } from '@/components/AppSidebar'
import { api, type RuntimeState } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

const UPDATE_CHECK = 'update_check'

interface InstallationBlockProps {
  /** `null` while `GET /api/runtime` is unread. */
  runtime: RuntimeState | null
  /** When this process started (`GET /api/jobs/history`), or `null` while unread. */
  startedAt: string | null
}

/**
 * *Installation*: the version and whether a newer one is reported, since when
 * the process runs, where the quotes come from and how fast the source
 * answers, and the way to the journal.
 */
export function InstallationBlock({ runtime, startedAt }: InstallationBlockProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()

  const build = runtime?.build
  // The same key as the navigation's foot, so the release is asked once.
  const release = useQuery({
    queryKey: ['release', build?.version],
    queryFn: api.release,
    enabled: build?.source === 'release',
  })
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  const setting = config.data?.settings.find((one) => one.key === UPDATE_CHECK)
  const reporting = setting?.value === true

  const write = useMutation({
    mutationFn: (on: boolean) => settingsApi.saveSettings({ [UPDATE_CHECK]: on }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['config'] }),
        client.invalidateQueries({ queryKey: ['release'] }),
      ]),
  })

  if (runtime === null) return <Section title={t('system.installation')}>{null}</Section>

  const version = build?.version ?? build?.revision?.slice(0, 7) ?? null
  const latest = release.data?.latest ?? null
  const source = runtime.quote_source

  return (
    <Section title={t('system.installation')}>
      <dl className="text-sm">
        {/* A release is a version; a build from a commit says it is a build. */}
        <FactRow
          label={t(build?.version ? 'system.installation.version' : 'system.installation.build')}
        >
          {version === null ? (
            <span className="fig">{ABSENT}</span>
          ) : (
            <>
              <span className="font-mono">{version}</span>
              {latest !== null ? (
                <> · {t('system.installation.available', { version: latest.version })}</>
              ) : build?.source === 'release' && reporting && release.data !== undefined ? (
                <> · {t('system.installation.current')}</>
              ) : null}
            </>
          )}
        </FactRow>
        {setting === undefined ? null : (
          <FactRow label={t('system.installation.report')}>
            <Switch
              checked={reporting}
              disabled={write.isPending}
              aria-label={t('system.installation.report')}
              onCheckedChange={(on) => write.mutate(on)}
            />
          </FactRow>
        )}
        <FactRow label={t('system.installation.since')}>
          <span className="fig">{startedAt === null ? null : f.dateTime(startedAt)}</span>
        </FactRow>
        <FactRow label={t('system.installation.source')}>
          <span className="fig">{source.name}</span>
          {source.response_seconds === null ? null : (
            <>
              {' · '}
              {t('system.installation.responds')}{' '}
              <span className="fig">
                {t('system.installation.seconds', { value: f.number(source.response_seconds, 1) })}
              </span>
            </>
          )}
        </FactRow>
        <FactRow label={t('system.installation.docs')}>
          <span className="flex gap-3 text-sm text-muted-foreground">
            <HelpLinks className="underline decoration-border underline-offset-3 hover:text-foreground" />
          </span>
        </FactRow>
        <FactRow label={t('system.installation.journal')}>
          <Link
            to="/system/logs"
            className="text-sm text-muted-foreground underline decoration-border underline-offset-3 hover:text-foreground"
          >
            {t('system.installation.journal.open')}
          </Link>
        </FactRow>
      </dl>
      {write.error ? <Refusal className="mt-3">{t(problemMessageKey(write.error))}</Refusal> : null}
    </Section>
  )
}
