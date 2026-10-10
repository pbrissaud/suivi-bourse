export function Bad({ share }: { share: number }) {
  return (
    <>
      <div style={{ width: `${share * 100}%` }} /> {/* expect: share-width */}
      <div style={{ height: 4, width: `${Math.min(share, 1) * 100} %` }} /> {/* expect: share-width */}
      <div style={{ width: '100%' }} />
      <div style={{ width: `${share}px` }} />
      <div style={{ height: `${share * 100}%` }} />
    </>
  )
}
