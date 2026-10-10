export function Elsewhere({ runtime }: { runtime: { error: Error | null } }) {
  return runtime.error ? <p /> : null
}
