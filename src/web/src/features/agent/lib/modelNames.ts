/**
 * The display name of a model (« Claude Sonnet 5.5 » for `claude-sonnet-5-5`).
 * A provider gives it only when it is asked for its models, and a page that
 * only reads must not call one, so the names seen are kept in this browser and
 * every place that shows a model id reads them back, falling back to the id.
 */
const KEY = 'sb.modelNames'

function read(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

export function rememberModels(models: readonly { id: string; name: string }[]): void {
  try {
    const known = read()
    for (const { id, name } of models) known[id] = name
    window.localStorage.setItem(KEY, JSON.stringify(known))
  } catch {
    // Storage refused: the id is shown, as before.
  }
}

export function modelName(id: string): string {
  return read()[id] ?? id
}
