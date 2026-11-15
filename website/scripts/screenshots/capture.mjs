#!/usr/bin/env node
// Regenerates every app screenshot of the documentation site. See README.md.
//
//   node website/scripts/screenshots/capture.mjs [--skip-build] [--keep]
//
// Boots a throwaway instance on a fresh store (never an existing one), seeds it
// with events.csv, drives headless Chrome over CDP and writes
// website/static/img/app/{en,fr}/<name>.png plus the 8 home images.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '../../..')
const OUT = path.join(REPO, 'website/static/img/app')
const HOME_OUT = path.join(REPO, 'website/static/img')
const FIXTURE = path.join(HERE, 'events.csv')
const PREVIEW_FIXTURE = path.join(HERE, 'import-preview.csv')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DOCS_URL = 'https://suivi-bourse-docs.pbrissaud.net/suivi-bourse'
const ARGS = new Set(process.argv.slice(2))
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null

const CATALOGUE = Object.fromEntries(['en', 'fr'].map((lang) => [
  lang, JSON.parse(readFileSync(path.join(REPO, `src/web/src/i18n/${lang}.json`), 'utf8')),
]))
const LOCALE = { en: 'en-IE', fr: 'fr-FR' } // both regions suggest EUR
// Account labels are user data: written in the language being captured.
const LABELS = {
  en: { pea: 'PEA', cto: 'Brokerage account', av: 'Life insurance' },
  fr: { pea: 'PEA', cto: 'Compte-titres', av: 'Assurance-vie' },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function until(what, probe, { timeout = 60_000, every = 250 } = {}) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await probe()
      if (last) return last
    } catch (error) {
      last = error
    }
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

// --------------------------------------------------------------------------- //
// The instance: its own store, its own port, killed on exit.
// --------------------------------------------------------------------------- //

const children = []
process.on('exit', () => children.forEach((child) => child.kill('SIGTERM')))
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

async function bootApp(store, port) {
  const work = path.join(store, '..')
  const logFile = path.join(work, 'app.log')
  const uvDir = (...args) => execFileSync('uv', args).toString().trim()
  const child = spawn('uv', ['run', '--quiet', 'python', '-m', 'application.boot'], {
    cwd: REPO,
    env: {
      ...process.env,
      // A HOME of its own: the app looks for v4 files under ~/.config and names the path it finds
      // in the journal; uv keeps its own cache and interpreters.
      HOME: work,
      UV_CACHE_DIR: uvDir('cache', 'dir'),
      UV_PYTHON_INSTALL_DIR: uvDir('python', 'dir'),
      SB_STORE_DIR: store,
      SB_WEB_PORT: String(port),
      SB_DOCUMENTATION_URL: DOCS_URL,
      LOG_LEVEL: 'INFO',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  let exited = false
  child.on('exit', () => { exited = true; writeFileSync(logFile, output) })
  const base = `http://127.0.0.1:${port}`
  await until('the app to answer /health', async () => {
    if (exited) throw new Error(`the app exited:\n${output.slice(-2000)}`)
    return (await fetch(`${base}/health`)).ok
  }, { timeout: 120_000 })
  return base
}

function api(base) {
  let cookie = null
  const call = async (method, route, body) => {
    const headers = body === undefined ? {} : { 'content-type': 'application/json' }
    if (cookie) headers.cookie = cookie
    const response = await fetch(`${base}${route}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    })
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${text.slice(0, 400)}`)
    return text ? JSON.parse(text) : null
  }
  return {
    get: (route) => call('GET', route),
    put: (route, body) => call('PUT', route, body),
    post: (route, body) => call('POST', route, body),
    patch: (route, body) => call('PATCH', route, body),
    del: (route) => call('DELETE', route),
    async upload(route, file) {
      const form = new FormData()
      form.append('file', new Blob([readFileSync(file)], { type: 'text/csv' }), path.basename(file))
      const response = await fetch(`${base}${route}`, { method: 'POST', body: form })
      const text = await response.text()
      if (!response.ok) throw new Error(`POST ${route} -> ${response.status} ${text.slice(0, 400)}`)
      return JSON.parse(text)
    },
  }
}

// --------------------------------------------------------------------------- //
// Chrome over CDP.
// --------------------------------------------------------------------------- //

async function launchChrome(profile) {
  const port = await freePort()
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-extensions', '--mute-audio', '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' })
  children.push(child)
  const target = await until('Chrome to list a page', async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return list.find((entry) => entry.type === 'page')
  })
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`${waiter.method}: Chrome closed`))
    pending.clear()
  })
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let next = 0
  const pending = new Map()
  const listeners = new Set()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id !== undefined) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`))
      else waiter.resolve(message.result)
    } else {
      listeners.forEach((listener) => listener(message))
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next
    pending.set(id, { resolve, reject, method })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, on: (listener) => listeners.add(listener) }
}

class Page {
  constructor(cdp, base) {
    this.cdp = cdp
    this.base = base
    this.inflight = new Map()
    this.lang = 'en'
    this.boot = null
    cdp.on(({ method, params }) => {
      if (method === 'Network.requestWillBeSent') this.inflight.set(params.requestId, params.request.url)
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') this.inflight.delete(params.requestId)
      if (method === 'Page.frameStartedLoading') this.inflight.clear()
    })
  }

  async init() {
    const { cdp } = this
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-motion', value: 'reduce' },
        { name: 'prefers-color-scheme', value: 'light' },
      ],
    })
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Paris' })
    await this.viewport(1280, 800)
  }

  async viewport(width, height) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
  }

  /** The reader's preferences, written before the app reads them on every load. */
  async prefs({ lang = this.lang, theme = 'light', extra = {} } = {}) {
    this.lang = lang
    const { cdp } = this
    if (this.boot) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.boot })
    const values = { 'sb.lang': lang, 'sb.theme': theme, ...extra }
    const source = `try { for (const [k, v] of Object.entries(${JSON.stringify(values)})) {
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } } catch {}`
    this.boot = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier
    await cdp.send('Emulation.setLocaleOverride', {}).catch(() => {})
    await cdp.send('Emulation.setLocaleOverride', { locale: LOCALE[lang] })
    this.userAgent ??= (await this.eval('navigator.userAgent').catch(() => 'Mozilla/5.0')).replace('HeadlessChrome', 'Chrome')
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: this.userAgent,
      acceptLanguage: `${LOCALE[lang]},${lang}`,
    })
    await cdp.send('Network.setCookie', { name: 'sidebar_state', value: 'true', url: this.base })
  }

  t(key) {
    const text = CATALOGUE[this.lang][key]
    if (text === undefined) throw new Error(`no message ${key}`)
    return text
  }

  async eval(expression) {
    const { result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    })
    if (exceptionDetails) throw new Error(`${expression.slice(0, 120)}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
    return result.value
  }

  async goto(route) {
    // A full load every time: a hash-only change would keep the last screen's overlay open.
    await this.cdp.send('Page.navigate', { url: 'about:blank' })
    await this.cdp.send('Page.navigate', { url: `${this.base}${route}` })
    await sleep(300)
    await until(`${route} to load`, () => this.eval('document.readyState === "complete"'))
    await this.settle()
  }

  /** Nothing in flight for a while, fonts in, no toast, no spinner. */
  async settle({ quiet = 700, timeout = 30_000 } = {}) {
    const end = Date.now() + timeout
    let calm = 0
    while (Date.now() < end) {
      const busy = this.inflight.size > 0 || await this.eval(`(async () => {
        await document.fonts.ready
        return !!document.querySelector('[data-sonner-toast], [aria-busy="true"], .animate-spin, .animate-pulse')
      })()`)
      calm = busy ? 0 : calm + 100
      if (calm >= quiet) return
      await sleep(100)
    }
    log(`  (settle timed out on ${this.base}: ${[...this.inflight.values()].slice(0, 3).join(', ')})`)
  }

  /** The centre of the first visible element matching `selector` whose text holds `text`. */
  async locate(text, selector = 'button, a, [role=button], [role=tab], [role=menuitem], [role=option], [role=radio], [role=switch], [role=checkbox], label, summary', { exact = false } = {}) {
    return this.eval(`(() => {
      const want = ${JSON.stringify(text)}
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const hits = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => {
        const rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return false
        if (want === null) return true
        const label = norm(el.getAttribute('aria-label')) || norm(el.textContent)
        return ${exact} ? label === want : label.includes(want)
      })
      const el = hits[0]
      if (!el) return null
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = el.getBoundingClientRect()
      const at = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      // Only a point that hits the element itself: a page still scrolling or an overlay retries.
      const hit = document.elementFromPoint(at.x, at.y)
      return hit && (el === hit || el.contains(hit)) ? at : null
    })()`)
  }

  async click(text, selector, options) {
    const at = await until(`"${text}" to click`, () => this.locate(text, selector, options), { timeout: 15_000 })
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'mouse' })
    }
    await sleep(250)
  }

  async key(key, { code = key, modifiers = 0, keyCode } = {}) {
    for (const type of ['keyDown', 'keyUp']) {
      await this.cdp.send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: keyCode })
    }
    await sleep(200)
  }

  async type(text) {
    await this.cdp.send('Input.insertText', { text })
    await sleep(150)
  }

  /** Focus `selector`, clear it, type. */
  async fill(selector, text) {
    await until(`${selector} to fill`, () => this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.focus(); el.select?.(); return true
    })()`), { timeout: 15_000 })
    await this.type(text)
  }

  /** A native date input, through React's value setter. */
  async setDate(selector, iso) {
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, ${JSON.stringify(iso)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
  }

  async waitText(text, timeout = 30_000) {
    await until(`"${text}" on screen`, () => this.eval(`document.body.innerText.includes(${JSON.stringify(text)})`), { timeout })
  }

  async png() {
    await sleep(400)
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    return Buffer.from(data, 'base64')
  }
}

// --------------------------------------------------------------------------- //
// Files.
// --------------------------------------------------------------------------- //

const OXIPNG = (() => {
  try { return execFileSync('which', ['oxipng']).toString().trim() } catch { return null }
})()
let rawDir

function store(buffer, file, width) {
  mkdirSync(path.dirname(file), { recursive: true })
  const raw = path.join(rawDir, path.basename(path.dirname(file)) + '-' + path.basename(file))
  writeFileSync(raw, buffer)
  execFileSync('sips', ['--resampleWidth', String(width), raw, '--out', file], { stdio: 'ignore' })
  if (OXIPNG) execFileSync(OXIPNG, ['-o', '3', '--strip', 'safe', '-q', file])
}

const captured = []
const skipped = []

async function shot(page, name) {
  if (ONLY && !ONLY.has(name)) return
  await page.settle()
  store(await page.png(), path.join(OUT, page.lang, `${name}.png`), 1600)
  captured.push(`${page.lang}/${name}`)
  log(`  ${page.lang}/${name}.png`)
}

/** One screen, both of whose failures are reported rather than fatal. */
async function attempt(page, name, steps) {
  if (ONLY && !ONLY.has(name)) return
  try {
    await steps()
    await shot(page, name)
  } catch (error) {
    skipped.push(`${page.lang}/${name}: ${error.message.split('\n')[0]}`)
    log(`  SKIPPED ${page.lang}/${name}: ${error.message.split('\n')[0]}`)
    await page.key('Escape', { keyCode: 27 }).catch(() => {})
  }
}

export { Page, api, bootApp, launchChrome, freePort, until, sleep, log, shot, attempt, store, LABELS, CATALOGUE }

// --------------------------------------------------------------------------- //
// The run.
// --------------------------------------------------------------------------- //

async function main() {
  if (!ARGS.has('--skip-build')) {
    log('building the front (src/web → packages/app/src/api/static)')
    execFileSync('pnpm', ['build'], { cwd: path.join(REPO, 'src/web'), stdio: 'inherit' })
  }
  const work = mkdtempSync(path.join(process.env.SHOTS_TMP ?? os.tmpdir(), 'sb-shots-'))
  rawDir = path.join(work, 'raw')
  mkdirSync(rawDir)
  const storeDir = path.join(work, 'store')
  mkdirSync(storeDir)
  log(`work directory ${work}`)

  const agentStub = await startAgentStub()
  const base = await bootApp(storeDir, await freePort())
  const sb = api(base)
  log(`app on ${base}`)
  const config = await sb.get('/api/config')
  const currency = config.settings.find((setting) => setting.key === 'base_currency')
  if (currency.stored) throw new Error(`refusing to go on: ${base} already has a base currency — not a fresh store`)

  const cdp = await launchChrome(path.join(work, 'chrome'))
  const page = new Page(cdp, base)
  await page.init()

  await firstRun(page, sb)
  await seed(page, sb, agentStub)
  for (const lang of ['en', 'fr']) {
    await relabel(sb, lang, agentStub)
    await page.prefs({ lang })
    await pages(page, sb, agentStub)
  }
  await benchmarkAndNotices(page, sb)
  await relabel(sb, 'en', agentStub)
  await homeImages(page, sb)
  await lockScreens(page, sb, agentStub)

  log(`captured ${captured.length}, skipped ${skipped.length}`)
  skipped.forEach((line) => log(`  skipped ${line}`))
  if (!ARGS.has('--keep')) rmSync(work, { recursive: true, force: true })
  process.exit(skipped.length ? 1 : 0)
}

// The walk — before any data, the only moment it exists.
async function firstRun(page, sb) {
  log('first run')
  for (const lang of ['en', 'fr']) {
    await page.prefs({ lang, extra: { 'suivi-bourse.first-run.left': null } })
    await page.goto('/')
    await page.waitText(page.t('firstRun.currency.title'))
    await shot(page, 'first-run-currency')
  }
  await sb.put('/api/settings', { base_currency: 'EUR' })
  // Step 2, the models: a reload resumes on it while none is held. Its country follows navigator.languages.
  for (const lang of ['en', 'fr']) {
    await page.prefs({ lang, extra: { 'suivi-bourse.first-run.left': null } })
    await page.cdp.send('Network.setUserAgentOverride', { userAgent: page.userAgent, acceptLanguage: `${lang}-FR,${lang}` })
    await page.goto('/')
    await page.waitText(page.t('firstRun.models.title'))
    await page.waitText('PEA-PME')
    await shot(page, 'first-run-taxation')
  }
  await sb.post('/api/taxation-models/registry', { ids: ['fr/pea', 'fr/compte-titres', 'fr/assurance-vie'] })
  for (const lang of ['en', 'fr']) {
    await page.prefs({ lang, extra: { 'suivi-bourse.first-run.left': null } })
    await page.goto('/')
    await page.waitText(page.t('firstRun.account.title'))
    await shot(page, 'first-run-accounts')
    await page.click(page.t('firstRun.account.skip'))
    await page.waitText(page.t('firstRun.events.title'))
    await shot(page, 'first-run-events')
  }
  await page.prefs({ extra: { 'suivi-bourse.first-run.left': '1' } })
}

async function seed(page, sb, agentStub) {
  log('seeding')
  const models = Object.fromEntries((await sb.get('/api/taxation-models')).models.map((m) => [m.name, m.id]))
  const pick = (start) => Object.entries(models).find(([name]) => name.includes(start))[1]
  const plan = { pea: pick('PEA'), cto: pick('CTO'), av: pick('Assurance') }
  for (const [id, model] of Object.entries(plan)) {
    await sb.post('/api/accounts', { id, label: LABELS.en[id], taxation_model_id: model })
  }
  await sb.put('/api/settings', { backfill_interval: 10, backfill_delay: 0, benchmark_symbols: ['CSPX.AS'], update_check: false })
  const receipt = await sb.upload('/api/events/import?amounts_in=base&foreign=AAPL:USD&foreign=MSFT:USD&foreign=NVDA:USD', FIXTURE)
  log(`  imported ${receipt.written} events`)
  let kicked = false
  await until('the history rebuild', async () => {
    if (!kicked && (await sb.get('/health')).jobs.backfill.verdict === 'complete') {
      kicked = true
      await sb.post('/api/jobs/performance/run').catch(() => {})
    }
    const health = await sb.get('/health')
    const bench = await sb.get('/api/benchmark')
    return health.jobs.backfill.verdict === 'complete' && health.jobs.performance.verdict === 'ran' && bench.state === 'ready'
  }, { timeout: 15 * 60_000, every: 3000 })
  await sb.put('/api/settings', { backfill_interval: 60, backfill_delay: 10, update_check: true })
  const provider = await sb.post('/api/agent/providers', {
    kind: 'openai_compatible', label: agentStub.label.en, base_url: agentStub.baseUrl, default_model: agentStub.model,
  })
  agentStub.id = provider.id
  await sb.post(`/api/agent/providers/${provider.id}/test`, {})
  await sb.put('/api/agent/config', { enabled: true })
  await writeAnswers(sb, agentStub)
  await sleep(3000)
}

async function relabel(sb, lang, agentStub) {
  for (const [id, label] of Object.entries(LABELS[lang])) await sb.patch(`/api/accounts/${id}`, { label })
  await sb.patch(`/api/agent/providers/${agentStub.id}`, { label: agentStub.label[lang] })
  // Tokens have no rename: the demo ones are made again under the language's names.
  for (const token of (await sb.get('/api/tokens')).tokens) await sb.del(`/api/tokens/${token.id}`)
  for (const token of TOKENS[lang]) await sb.post('/api/tokens', token)
  // One conversation per language: the other pass's thread would show in the rail.
  for (const thread of await sb.get('/api/agent/threads')) await sb.del(`/api/agent/threads/${thread.id}`)
  await sleep(1500)
}

async function pages(page, sb, agentStub) {
  log(`pages (${page.lang})`)
  await page.viewport(1280, 800)
  await attempt(page, 'dashboard', () => page.goto('/'))
  // Not captured: `explain` (Explain.tsx is mounted by no screen) and `dashboard-edit` (the dashboard
  // has a fixed composition since 7 Nov 2026, nothing to arrange).
  await attempt(page, 'palette', async () => {
    await page.goto('/')
    await page.key('k', { code: 'KeyK', modifiers: 4, keyCode: 75 })
    await until('the palette', () => page.eval(`!!document.querySelector('[role=dialog] input')`))
  })
  await attempt(page, 'shares', () => page.goto('/shares'))
  await attempt(page, 'share-detail', () => page.goto('/shares/ASML.AS'))
  await attempt(page, 'accounts', () => page.goto('/accounts'))
  await attempt(page, 'account-form', async () => {
    await page.goto('/accounts')
    await page.click(page.t('accounts.detail.edit'))
    await until('the account sheet', () => page.eval(`!!document.querySelector('[data-slot=sheet-content]')`))
  })
  await attempt(page, 'ledger', () => page.goto('/ledger'))
  await attempt(page, 'event-form', async () => {
    await page.goto('/ledger?open=event')
    await until('the event sheet', () => page.eval(`!!document.querySelector('#event-date')`))
    await page.setDate('#event-date', '2026-11-13')
    await page.eval(`(() => {
      const el = document.querySelector('#event-account')
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      set.call(el, 'pea'); el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await page.click(null, '#event-symbol')
    await page.type('AI.PA')
    await sleep(800)
    await page.key('Enter', { keyCode: 13 })
    await page.fill('#event-quantity', '2')
    await page.fill('#event-unitPrice', page.lang === 'fr' ? '176,50' : '176.50')
    await page.fill('#event-fee', page.lang === 'fr' ? '1,99' : '1.99')
    await page.eval('document.activeElement.blur()')
  })
  await attempt(page, 'import-preview', async () => {
    await page.goto('/ledger/import')
    const { root } = await page.cdp.send('DOM.getDocument', { depth: -1 })
    const nodeId = await until('a file input', async () => (await page.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })).nodeId || null)
    await page.cdp.send('DOM.setFileInputFiles', { nodeId, files: [PREVIEW_FIXTURE] })
    await page.waitText('import-preview.csv')
  })
  await attempt(page, 'settings', () => page.goto('/settings'))
  await attempt(page, 'settings-taxation', async () => {
    await page.goto('/settings#taxation')
    await page.waitText(page.t('settings.taxation.add'))
  })
  await attempt(page, 'settings-agent', async () => {
    await page.goto('/settings#agent')
    await page.waitText(agentStub.label[page.lang])
  })
  await attempt(page, 'settings-theme', () => page.goto('/settings/theme'))
  await attempt(page, 'system', () => page.goto('/system'))
  await attempt(page, 'system-logs', () => page.goto('/system/logs'))
  await attempt(page, 'agent', async () => {
    agentStub.lang = page.lang
    await page.goto('/agent')
    await page.click(null, 'textarea')
    await page.type(agentStub.question[page.lang])
    await page.key('Enter', { keyCode: 13 })
    await page.waitText(agentStub.answerEnd[page.lang], 30_000)
  })
  await attempt(page, 'agent-stats', () => page.goto('/agent/stats'))
}

async function homeImages(page) {
  if (ONLY && !ONLY.has('home')) return
  log('home images')
  await page.viewport(1440, 1000)
  for (const theme of ['light', 'dark']) {
    await page.prefs({ lang: 'en', theme })
    for (const [name, route] of [['dashboard', '/'], ['shares', '/shares'], ['accounts', '/accounts'], ['ledger', '/ledger']]) {
      await page.goto(route)
      await page.settle()
      store(await page.png(), path.join(HOME_OUT, `app-${name}-${theme}.png`), 1920)
      captured.push(`home/app-${name}-${theme}`)
      log(`  app-${name}-${theme}.png`)
    }
  }
  await page.prefs({ lang: 'en', theme: 'light' })
  await page.viewport(1280, 800)
}

/**
 * The comparison in both languages from one data state, then the bell with one notice in it.
 * Markets are closed on the days these captures are usually taken, so the notice is a late
 * price on a market that never closes: a free grant of a sliver of bitcoin, with the staleness
 * horizon lowered to seconds. Both are undone right after; the bell is opened over Settings,
 * which shows no figure the grant could move.
 */
async function benchmarkAndNotices(page, sb) {
  for (const lang of ['en', 'fr']) {
    await page.prefs({ lang })
    await attempt(page, 'benchmark', () => page.goto('/benchmark'))
  }
  if (ONLY && !ONLY.has('notifications')) return
  log('notifications')
  const grant = await sb.post('/api/events', {
    date: '2026-10-01', event_type: 'GRANT', account: 'cto', symbol: 'BTC-EUR', name: 'Bitcoin', quantity: 0.001,
  })
  await sb.put('/api/settings', { staleness_horizon: 10 })
  try {
    await until('the late-price notice', async () =>
      (await sb.get('/api/advisories?register=user')).some((advisory) => advisory.kind === 'late_price'),
    { timeout: 5 * 60_000, every: 3000 })
    for (const lang of ['en', 'fr']) {
      await page.prefs({ lang })
      await attempt(page, 'notifications', async () => {
        await page.goto('/settings')
        await page.click(page.t('notification.open'), 'button[aria-label]')
        await page.waitText('Bitcoin')
      })
    }
  } finally {
    await sb.del(`/api/events/${grant.id}`)
    await sb.put('/api/settings', { staleness_horizon: 900 })
    await sleep(3000)
  }
}

// The PIN last: everything before it needs no session.
async function lockScreens(page, sb, agentStub) {
  if (ONLY && !ONLY.has('lock') && !ONLY.has('settings-security')) return
  log('lock screen')
  await sb.post('/auth/enable', { pin: PIN })
  await sb.post('/auth/pin', { pin: PIN }) // the script's own session, for the relabel below
  for (const lang of ['en', 'fr']) {
    await relabel(sb, lang, agentStub)
    await page.prefs({ lang })
    await page.cdp.send('Network.clearBrowserCookies')
    await page.cdp.send('Network.setCookie', { name: 'sidebar_state', value: 'true', url: page.base })
    await attempt(page, 'lock', async () => {
      await page.goto('/')
      await page.waitText(page.t('auth.screen.title'))
    })
    // Signed in through the screen itself, so Settings shows the code on.
    await attempt(page, 'settings-security', async () => {
      await page.goto('/')
      await page.click(null, 'input[autocomplete=current-password]')
      await page.type(PIN)
      await until('the session', () => page.eval(`!document.querySelector('input[autocomplete=current-password]')`))
      await page.goto('/settings#security')
      await page.waitText(page.t('settings.security.lock'))
    })
  }
}

const PIN = '271828'
const TOKENS = {
  en: [{ label: 'Nightly backup', scopes: ['api'], expires: '1y' }, { label: 'Desktop assistant', scopes: ['mcp'], expires: '90d' }],
  fr: [{ label: 'Sauvegarde nocturne', scopes: ['api'], expires: '1y' }, { label: 'Assistant de bureau', scopes: ['mcp'], expires: '90d' }],
}

// A stand-in for an OpenAI-compatible gateway: one model, one canned answer.
// Nothing leaves the machine and no key exists.
async function startAgentStub() {
  const stub = {
    lang: 'en',
    label: { en: 'Local gateway', fr: 'Passerelle locale' },
    model: 'llama-3.3-70b-instruct',
    question: {
      en: 'Which line weighs most in my portfolio, and how has it done?',
      fr: 'Quelle ligne pèse le plus dans mon portefeuille, et comment a-t-elle évolué ?',
    },
    answer: { en: 'No figures yet.', fr: 'Pas encore de chiffres.' },
    answerEnd: { en: 'No figures yet.', fr: 'Pas encore de chiffres.' },
  }
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', async () => {
      if (request.method === 'GET' && request.url.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: stub.model, object: 'model', created: 1730000000, owned_by: 'local' }] }))
        return
      }
      if (request.method === 'POST' && request.url.endsWith('/chat/completions')) {
        const asked = JSON.parse(body || '{}')
        const text = stub.answer[stub.lang]
        const usage = { prompt_tokens: 2140, completion_tokens: 96, total_tokens: 2236 }
        const head = { id: 'chatcmpl-stub', created: Math.floor(Date.now() / 1000), model: stub.model }
        if (!asked.stream) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ...head, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }))
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const chunk = (choices, extra = {}) => response.write(`data: ${JSON.stringify({ ...head, object: 'chat.completion.chunk', choices, ...extra })}\n\n`)
        chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])
        for (const piece of text.match(/[^ ]+ ?/g)) {
          chunk([{ index: 0, delta: { content: piece }, finish_reason: null }])
          await sleep(15)
        }
        chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
        chunk([], { usage })
        response.end('data: [DONE]\n\n')
        return
      }
      response.writeHead(404).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  stub.baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  return stub
}

/** The canned answer, written from the seeded portfolio's own figures. */
async function writeAnswers(sb, stub) {
  const { positions } = await sb.get('/api/positions')
  const lines = new Map()
  for (const p of positions) {
    const value = p.quantity * (p.converted?.value ?? p.price?.value ?? 0)
    const line = lines.get(p.symbol) ?? { name: p.name, value: 0, gain: 0, cost: 0 }
    line.value += value
    line.gain += p.latent_gain ?? 0
    line.cost += p.cost_basis ?? 0
    lines.set(p.symbol, line)
  }
  const total = [...lines.values()].reduce((sum, line) => sum + line.value, 0)
  const [symbol, top] = [...lines.entries()].sort((a, b) => b[1].value - a[1].value)[0]
  const share = Math.round((100 * top.value) / total)
  const pct = (100 * top.gain) / top.cost
  const en = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
  const fr = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
  stub.answer.en = `Your heaviest line is **${top.name}** (${symbol}): about ${share} % of what your securities are worth, held across your PEA and your life insurance.\n\nIts latent gain is ${en.format(top.gain)}, ${pct.toFixed(1)} % over what you paid for it, and you have kept adding to it every few months since November 2023. The next two lines together weigh less than it does alone.`
  stub.answer.fr = `Votre ligne la plus lourde est **${top.name}** (${symbol}) : environ ${share} % de la valeur de vos titres, répartie entre votre PEA et votre assurance-vie.\n\nSa plus-value latente est de ${fr.format(top.gain)}, soit ${pct.toFixed(1).replace('.', ',')} % au-dessus de ce que vous l’avez payée, et vous la renforcez tous les quelques mois depuis novembre 2023. Les deux lignes suivantes réunies pèsent moins qu’elle seule.`
  stub.answerEnd = { en: 'weigh less than it does alone', fr: 'pèsent moins qu’elle seule' }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
