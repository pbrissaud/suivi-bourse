// The rail's stacked bar closes a whole, which no ShareBar claims.
export function Segment({ share }: { share: number }) {
  return <div style={{ width: `${share * 100}%` }} />
}
