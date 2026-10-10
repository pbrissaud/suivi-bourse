type Reads = { runtime: { error: Error | null } }

export function HoldingsPage({ runtime, reads }: Reads & { reads: Reads }) {
  if (reads.runtime.error) return null // expect: no-runtime-error-on-surfaces
  return runtime.error ? <p /> : null // expect: no-runtime-error-on-surfaces
}

export const fine = (shellRuntime: { error: null }) => shellRuntime.error
