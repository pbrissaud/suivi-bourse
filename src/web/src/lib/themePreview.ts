/**
 * Painting a theme that is not saved yet (#1314), and repainting the one that is.
 *
 * The preview is **one `<style id="theme-preview">`** appended after the
 * `/api/theme.css` link, holding the candidate theme under the same selectors
 * the server uses (`tweakcn.render_css`): same specificity, so it wins by
 * document order. Reverting it is removing the element. Inline variables on
 * `<html>` were the other way, and would paint both grounds with one palette.
 */
import type { ThemeVars } from '@/features/settings/lib/api'

const ID = 'theme-preview'

/**
 * `tweakcn.render_css` for a theme the server has already cleaned: both
 * grounds, a key emitted only when both say it, keys in alphabetical order.
 */
export function previewCss({ theme, light, dark }: ThemeVars): string {
  const grounds = [
    ['html:root', { ...theme, ...light }],
    ['html:root.dark', { ...theme, ...dark }],
  ] as const
  const keys = Object.keys(grounds[0][1])
    .filter((key) => key in grounds[1][1])
    .sort()
  return grounds
    .map(
      ([selector, values]) =>
        `${selector}{\n${keys.map((k) => `  --${k}: ${values[k]};`).join('\n')}\n}\n`,
    )
    .join('')
}

let frame = 0
let pending = ''

/** Paint `css` over the app; calls inside one frame coalesce into one write. */
export function showPreview(css: string) {
  pending = css
  frame ||= requestAnimationFrame(() => {
    frame = 0
    let style = document.getElementById(ID)
    if (!style) {
      style = document.createElement('style')
      style.id = ID
      document.head.append(style)
    }
    style.textContent = pending
  })
}

export function clearPreview() {
  cancelAnimationFrame(frame)
  frame = 0
  document.getElementById(ID)?.remove()
}

/**
 * The stylesheet `index.html` links, fetched again. Resolves when the new one
 * has loaded — the preview comes off only then, so applying never flashes the
 * saved theme — and rejects if it could not.
 */
export function repaint(): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>('link[href^="/api/theme.css"]')
  if (!link) return Promise.resolve()
  return new Promise((resolve, reject) => {
    link.addEventListener('load', () => resolve(), { once: true })
    link.addEventListener('error', () => reject(new Error('theme.css did not load')), {
      once: true,
    })
    link.href = `/api/theme.css?v=${Date.now()}`
  })
}
