import { cn } from '@/lib/utils'

export function Bad({ x }: { x: string }) {
  return (
    <>
      <p className="text-xs uppercase">a</p> {/* expect: no-overline */}
      <p className={cn('md:tracking-widest', x)}>b</p> {/* expect: no-overline */}
      <p className={`tracking-caps ${x}`}>c</p> {/* expect: no-overline */}
      <p className="tracking-wide">d</p> {/* expect: no-overline */}
      <p className="tracking-wider">e</p> {/* expect: no-overline */}
      <p className="eyebrow">f</p> {/* expect: no-overline */}
      <p className={cn({ 'xl:tracking-widest': x })}>h</p> {/* expect: no-overline */}
      <p className="notuppercase tracking-tight">g</p>
      {/* uppercase in a comment */}
    </>
  )
}
