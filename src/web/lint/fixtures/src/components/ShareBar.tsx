// The primitive: the one place a share is drawn.
export function ShareBar({ share }: { share: number }) {
  return <div style={{ width: `${share * 100}%` }} />
}
