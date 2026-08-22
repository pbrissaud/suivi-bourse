/**
 * Handing a file to the reader — the last two lines of an export (#796).
 *
 * The gesture is a fetch now, so the bytes arrive in this process and nothing
 * has saved them: the browser's own *Save as* is still the whole of the
 * interface this wants, and this is how it is reached from a payload rather
 * than from a URL. It is a module of its own because it is the one thing in the
 * front that touches the document to do something other than render — a
 * detached anchor, clicked, and taken straight back out.
 *
 * The object URL is **revoked**: a blob held by a URL nobody released is a copy
 * of the whole ledger kept alive for as long as the tab is open, and a reader
 * who exports twice would hold two.
 */
import type { DownloadedFile } from '@/lib/api'

export function saveFile({ blob, filename }: DownloadedFile): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  // The server's name, never one composed here: which of the two names the
  // events resource answers under is a fact about what it held back.
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
