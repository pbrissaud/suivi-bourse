import { useQuery } from '@tanstack/react-query'

import { Unreadable } from '@/components/Unreadable'
import { ThemeEditor } from '@/features/settings/components/ThemeEditor'
import { settingsApi } from '@/features/settings/lib/api'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { oneFailure, readConditions } from '@/lib/status'

/**
 * The theme, off Settings › Affichage: the token list on the left, the real
 * pages on the right, « ← Réglages » on the first line. The title is fixed and
 * carries no subtitle.
 */
export default function ThemePage() {
  const { t } = useI18n()
  usePageHeading(t('settings.theme.title'))
  const theme = useQuery({ queryKey: ['theme'], queryFn: settingsApi.theme })
  const failure = oneFailure(readConditions({ queries: [theme] }))

  if (failure !== null) return <Unreadable failure={failure} />
  // Nothing is drawn over a read still in flight: the editor pins the stored
  // theme when it opens, so it opens once the store has answered.
  if (!theme.isSuccess) return null
  return <ThemeEditor stored={theme.data} />
}
