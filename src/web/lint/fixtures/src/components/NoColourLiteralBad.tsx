export function Bad({ x }: { x: string }) {
  return (
    <>
      <path fill="#fff" /> {/* expect: no-colour-literal */}
      <path stroke={'#1a2b3c80'} /> {/* expect: no-colour-literal */}
      <div style={{ color: 'oklch(0.5 0.1 200)' }} /> {/* expect: no-colour-literal */}
      <div style={{ color: 'hsl(200 50% 50%)' }} /> {/* expect: no-colour-literal */}
      <div style={{ color: `hsla(${x} 50% 50% / 0.5)` }} /> {/* expect: no-colour-literal */}
      <div style={{ color: 'rgb(0, 0, 0)' }} /> {/* expect: no-colour-literal */}
      <div style={{ color: 'rgba(0, 0, 0, 0.5)' }} /> {/* expect: no-colour-literal */}
      {/* #841 in a comment is an issue, not a colour */}
      <path fill="var(--gain)" />
      <a href="#accounts">x</a>
    </>
  )
}
