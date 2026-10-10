import { Skeleton } from '@/components/ui/skeleton' // expect: no-wait-dressing
import { cn } from '@/lib/utils'

export function Bad({ x }: { x: string }) {
  return (
    <>
      <div className="h-4 animate-spin" /> {/* expect: no-wait-dressing */}
      <div className={cn('md:animate-pulse', x)} /> {/* expect: no-wait-dressing */}
      <div className={cn({ 'animate-spin': x })} /> {/* expect: no-wait-dressing */}
      <Skeleton /> {/* expect: no-wait-dressing */}
      <div role="progressbar" /> {/* expect: no-wait-dressing */}
      <div aria-busy={true} /> {/* expect: no-wait-dressing */}
      {/* animate-spin in a comment, aria-busy too */}
      <div className="animate-spinner" role="status" />
      <SkeletonText />
    </>
  )
}

function SkeletonText() {
  return null
}
