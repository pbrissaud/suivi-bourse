export async function bare() {
  await fetch('/api/positions') // expect: no-bare-fetch
  await window.fetch('/api/positions') // expect: no-bare-fetch
  await globalThis.fetch('/api/positions') // expect: no-bare-fetch
  return refetch()
}

function refetch() {
  return null
}
