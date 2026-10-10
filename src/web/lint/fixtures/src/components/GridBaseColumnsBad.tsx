import { cn } from '@/lib/utils'

export function Bad({ x }: { x: string }) {
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2" /> {/* expect: grid-base-columns */}
      <div className={cn('grid md:grid-cols-3', x)} /> {/* expect: grid-base-columns */}
      <div className={cn({ 'grid lg:grid-cols-2': x })} /> {/* expect: grid-base-columns */}
      <div className="grid grid-cols-1 md:grid-cols-2" />
      <div className="grid gap-4" />
      <div className="flex lg:grid-cols-2" />
    </>
  )
}
