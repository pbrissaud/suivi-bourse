/**
 * The file chosen on the empty ledger, carried to the import page.
 *
 * A `File` does not travel in a URL, and the page it goes to reads it once: a
 * module slot, emptied by the first reader, is the whole mechanism.
 */
let held: File | null = null

export function handOver(file: File): void {
  held = file
}

export function takeHandover(): File | null {
  const file = held
  held = null
  return file
}
