// `ui/` is the registry's: every rule but the overline stops at it.
import { CartesianGrid, Tooltip } from 'recharts'
import { Refusal } from '@/components/Refusal'
import { Skeleton } from '@/components/ui/skeleton'

const STATE_TONE = {}

export function Exempt({ share, failure }: { share: number; failure: Error }) {
  return (
    <div className="grid lg:grid-cols-2 animate-spin" aria-busy role="progressbar" style={{ width: `${share * 100}%` }}>
      <Skeleton />
      <CartesianGrid />
      <Tooltip />
      <path fill="#fff" />
      <p>{"chart.reading.rising"}</p>
      <Refusal>{failure.message}</Refusal>
      {String(STATE_TONE)}
    </div>
  )
}
