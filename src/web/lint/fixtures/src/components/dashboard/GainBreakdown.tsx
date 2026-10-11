// A cascade of the gain's four terms onto their total, exempt for the rail's reason.
export function Term({ share }: { share: number }) {
  return <div style={{ width: `${share * 100}%` }} />
}
