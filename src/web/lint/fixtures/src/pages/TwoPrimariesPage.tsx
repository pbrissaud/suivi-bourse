import { Button } from '@/components/ui/button'

export function TwoPrimariesPage() {
  return (
    <>
      <Button variant="primary">Importer</Button> {/* expect: one-primary-per-page */}
      <Button variant="primary">Saisir</Button> {/* expect: one-primary-per-page */}
      <Button variant="outline">Exporter</Button>
    </>
  )
}
