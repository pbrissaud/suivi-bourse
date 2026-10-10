import { Refusal } from '@/components/Refusal'

export function Bad({ failure, write }: { failure: Error | null; write: { error: Error | null } }) {
  return (
    <>
      {failure ? <Refusal>{failure.message}</Refusal> : null} {/* expect: refusal-for-writes */}
      <Refusal /> {/* expect: refusal-for-writes */}
      <Refusal title={String(write.error)}>{failure?.message}</Refusal> {/* expect: refusal-for-writes */}
      {write.error ? <Refusal>{write.error.message}</Refusal> : null}
    </>
  )
}
