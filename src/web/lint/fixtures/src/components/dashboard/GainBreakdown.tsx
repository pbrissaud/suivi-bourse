// The gain's four terms close one total, for the rail's reason.
export function Term({ share }: { share: number }) {
  return <div style={{ width: `${share * 100}%` }} />
}
