import { cn } from '@/lib/utils'

export function Bad({ up }: { up: boolean }) {
  return (
    <>
      <p className="text-gain" /> {/* expect: sign-colours */}
      <p className="flex bg-loss/20 p-2" /> {/* expect: sign-colours */}
      <p className={cn('hover:border-gain', up && `ring-loss`)} /> {/* expect: sign-colours */}
      <p className="bg-linear-160 from-gain/8 to-card" /> {/* expect: sign-colours */}
      <p className="text-chart-2" /> {/* expect: sign-colours */}
      <path stroke="var(--chart-2)" /> {/* expect: sign-colours */}
      <path stroke="var(--gain)" />
      <p className="text-gaining text-foreground bg-chart-1" />
    </>
  )
}
