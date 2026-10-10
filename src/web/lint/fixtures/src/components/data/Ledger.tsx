export function Ledger({ runtime }: { runtime: { error: Error | null } }) {
  return runtime?.error ? <p /> : null // expect: no-runtime-error-on-surfaces
}
