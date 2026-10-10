/**
 * **The Biome plugins catch what they are written to catch, and nothing else**
 * (#1129).
 *
 * The front's conventions that are an *absence* of a pattern are GritQL rules
 * in `lint/*.grit`, run by `pnpm lint`. A rule that stops matching passes in
 * silence, on the front as on anything else, so this file is the coverage half
 * every source-walking test used to carry on its own: it lints the fixtures
 * under `lint/fixtures/src/`, which mirror the real paths, and asks that the
 * diagnostics be **exactly** the lines marked `expect: <rule-id>`.
 *
 * One set against another, which is what makes it catch all three failures: a
 * rule that stops matching (a marker with no hit), an exemption that breaks (a
 * hit with no marker, from `ui/`, `test/` or a named file), and a node renamed
 * by a Biome bump (either). Biome is pinned exactly in `package.json` for that
 * last reason.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

import { WEB_ROOT } from '@/test/stylesheet'

const FIXTURES = path.join(WEB_ROOT, 'lint', 'fixtures')

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    return entry.isDirectory() ? files(full) : [full]
  })
}

/** `file:line rule-id` for every line marked `expect: <rule-id>`. */
function expected(): string[] {
  return files(FIXTURES).flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, at) => {
        const marker = /expect: ([\w-]+)/.exec(line)
        return marker ? [`${path.relative(WEB_ROOT, file)}:${at + 1} ${marker[1]}`] : []
      }),
  )
}

/** `file:line rule-id` for every plugin diagnostic Biome reports. */
function reported(): string[] {
  // Biome exits non-zero on the errors it is asked to find, so the status is
  // not the verdict: the output is.
  const run = spawnSync(
    path.join(WEB_ROOT, 'node_modules', '.bin', 'biome'),
    ['lint', '--reporter=github', '--max-diagnostics=none', 'lint/fixtures'],
    { cwd: WEB_ROOT, encoding: 'utf8' },
  )
  expect(run.error).toBeUndefined()
  return [
    ...run.stdout.matchAll(/^::error title=plugin,file=([^,]+),line=(\d+),.*?::\[([\w-]+)\]/gm),
  ].map(([, file, line, rule]) => `${path.relative(WEB_ROOT, file)}:${line} ${rule}`)
}

it('reports exactly the lines the fixtures mark, for every rule', () => {
  const marked = expected()
  expect(new Set(reported())).toEqual(new Set(marked))
  // Every plugin is proved by at least one hit, so none can sit in `lint/`
  // unregistered or matching nothing.
  const rules = fs.readdirSync(path.join(WEB_ROOT, 'lint')).filter((file) => file.endsWith('.grit'))
  expect(new Set(marked.map((one) => `${one.split(' ')[1]}.grit`))).toEqual(new Set(rules))
})
