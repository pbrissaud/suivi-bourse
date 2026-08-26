/**
 * Settings — **the fifth page** (ADR-0038).
 *
 * ADR-0030 cut the data page into three tabs and defended ADR-0020's four-page
 * cut with one sentence: *a tab is not a page*. Two records took tabs off that
 * page afterwards — ADR-0036 withdrew the notices' exception, ADR-0037 moved
 * them behind the header's bell — and what was left was the ledger and the
 * installation. **A two-tab bar is a bar that should not exist**: it spends a
 * control and a level of nesting on a choice between two things that have
 * nothing to do with each other, what the owner *declared* and what the
 * installation *is*. So the installation becomes an address of its own, and
 * ADR-0020's cut is amended in its count and kept in its principle — the
 * principle was never *four*, it was that a page answers one question and a
 * bookmark survives.
 *
 * **What it renders is `Installation`, unchanged.** That block already *is*
 * what ADR-0038 describes a settings page as being — the settings, the store
 * with its size and its last write, the orphaned securities, the rebuild the
 * dot leads to — so this ticket gives it an address and nothing else. The tab
 * it also sits on, the tab bar around it and the three corrections of wording
 * ADR-0038 asks for are the next ticket's (#830), which is why the block is
 * still where it is and this page is three lines: a route that renders a copy
 * of a surface is a page, a route that renders a stub is a promise.
 */
import { Installation } from '@/components/data/Installation'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'

export default function SettingsPage() {
  const { t } = useI18n()

  // The heading is the shell's to draw (#789) and the page's to declare, which
  // is what gives a screen reader a title on this route like on the other four.
  usePageHeading(t('page.settings'))

  return <Installation />
}
