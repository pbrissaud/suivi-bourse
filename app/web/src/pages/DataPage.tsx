/**
 * The data page — **two tabs under one route** (#723, ADR-0020).
 *
 * The word matters: a tab is not a page, so the product's cut at four pages
 * holds. And the line between the two is not *data against settings* but **what
 * the user declared** against **what the installation is** — ADR-0014's boot test
 * (can this be answered before the store opens?) transposed to the render.
 *
 * This ticket delivers the first tab in its journal half. The import block, the
 * export and the accounts declaration land under it with #728 and #729; the
 * second tab — advisories, settings, the store — is #724, and its badge will
 * count **unacknowledged advisories and nothing else**.
 */
import { Ledger } from '@/components/data/Ledger'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/lib/i18n'

export default function DataPage() {
  const { t } = useI18n()

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('page.data')}</h1>
      </header>

      <Tabs defaultValue="ledger">
        <TabsList>
          <TabsTrigger value="ledger">{t('data.tab.ledger')}</TabsTrigger>
          <TabsTrigger value="installation">{t('data.tab.installation')}</TabsTrigger>
        </TabsList>
        <TabsContent value="ledger">
          <Ledger />
        </TabsContent>
        <TabsContent value="installation">
          {/* Its own sentence, and not the four pages' `page.pending`: this
              ticket's opening argument is that **a tab is not a page**, and
              reusing the string would have the product say the opposite inside
              the very object that makes the cut at four pages hold. */}
          <p className="text-sm text-muted-foreground">{t('data.tab.installation.pending')}</p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
