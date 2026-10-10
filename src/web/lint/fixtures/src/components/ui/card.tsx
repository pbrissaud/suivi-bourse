import { cn } from '@/lib/utils'

export function Card({ className }: { className?: string }) {
  return (
    <>
      <div className="rounded-xl border shadow" /> {/* expect: flat-card */}
      <div className={cn('bg-card shadow-sm', className)} /> {/* expect: flat-card */}
      <div className="rounded-xl hover:shadow-lg" /> {/* expect: flat-card */}
      <div className={cn({ 'shadow-sm': className })} /> {/* expect: flat-card */}
      <div className="rounded-xl border noshadow" />
    </>
  )
}
