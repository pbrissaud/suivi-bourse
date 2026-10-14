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
 * The object URL is **revoked**, and revoked on a **later task**. Both halves
 * are load-bearing. A blob held by a URL nobody released is a copy of the whole
 * ledger kept alive for as long as the tab is open, and a reader who exports
 * twice holds two — but released in the same task as the click it is released
 * *before the save*: only Chrome starts reading the blob during `click()`,
 * where Firefox and Safari queue the download and resolve the `blob:` URL
 * afterwards. The reader would then be told the file is on their disk with
 * nothing written, which is the one failure a receipt must not be able to
 * report. The anchor stays in the document until then, for the same reason.
 *
 * No test sees this: jsdom implements neither object URLs nor downloads, so the
 * suite stands in for both and would pass on either ordering. It is written
 * down here because that is the only place it can be held.
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
  setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 0)
}
