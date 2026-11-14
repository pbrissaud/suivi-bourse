/**
 * *Notifications*: the outbound channels, as a ruled list — kind and address,
 * the notices it carries, « Tester », « Modifier » — ending on « Ajouter un
 * canal ». What the bell holds is the app's own; a channel sends the same to
 * wherever the owner reads when the app is closed.
 */
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

import {
  CHANNEL_SCOPES,
  ChannelSheet,
  KIND_LABEL,
  SCOPE_LABEL,
} from '@/features/settings/components/ChannelSheet'
import {
  AddRow,
  ListRow,
  ListSetting,
  TextAction,
} from '@/features/settings/components/ListSetting'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { api, type NotificationChannel } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'

export function NotificationsSection({ read }: { read: SectionRead }) {
  const { t } = useI18n()
  const channels = useQuery({
    queryKey: ['notification-channels'],
    queryFn: api.notificationChannels,
  })
  /** `undefined` closed, `null` a new channel, otherwise the one being edited. */
  const [sheet, setSheet] = useState<NotificationChannel | null | undefined>(undefined)

  const test = useMutation({
    mutationFn: (channel: NotificationChannel) => api.testNotificationChannel(channel.id),
    onSuccess: () => toast.success(t('settings.channel.tested')),
    onError: (error) => toast.error(problemSentence(t, error)),
  })

  return (
    <SettingsSection id="notifications" title={t('settings.notifications.title')} read={read}>
      <ListSetting label={t('settings.channel.list')}>
        {channels.data?.map((channel) => (
          <ListRow
            key={channel.id}
            name={
              <>
                {t(KIND_LABEL[channel.kind])}{' '}
                <span className="text-sm text-muted-foreground">· {channel.target}</span>
              </>
            }
            aside={
              channel.enabled
                ? CHANNEL_SCOPES.filter((scope) => channel.scopes.includes(scope))
                    .map((scope) => t(SCOPE_LABEL[scope]))
                    .join(', ')
                : t('settings.channel.off')
            }
            actions={
              <>
                <TextAction
                  disabled={test.isPending}
                  aria-label={`${t('settings.channel.test')} ${t(KIND_LABEL[channel.kind])}`}
                  onClick={() => test.mutate(channel)}
                >
                  {t('settings.channel.test')}
                </TextAction>
                <TextAction
                  aria-label={`${t('settings.provider.edit')} ${t(KIND_LABEL[channel.kind])}`}
                  onClick={() => setSheet(channel)}
                >
                  {t('settings.provider.edit')}
                </TextAction>
              </>
            }
          />
        ))}
        <AddRow hint={t('settings.channel.add.hint')} onClick={() => setSheet(null)}>
          {t('settings.channel.add')}
        </AddRow>
      </ListSetting>
      {sheet !== undefined ? (
        <ChannelSheet
          key={sheet?.id ?? 'new'}
          channel={sheet}
          onClose={() => setSheet(undefined)}
        />
      ) : null}
    </SettingsSection>
  )
}
