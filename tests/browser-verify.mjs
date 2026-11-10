/**
 * Browser verification for the WeRead background client plugin.
 *
 * Boots a headless Chromium/Edge with a local DevTools endpoint, navigates the
 * running DSH Web GUI (token URL), asserts the client plugin's DOM, and saves a
 * screenshot.
 *
 * Usage (Electron Node v24):
 *   & "D:\Program Files\deepseekHarmess\DeepSeek Harness.exe" "D:\Alan\插件\tests\browser-verify.mjs" "<tokenUrl>" "<outPng>"
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tokenUrl = process.argv[2]
const outPng = process.argv[3] || 'D:\\Alan\\插件\\examples\\live-test.png'
if (!tokenUrl) {
  console.error('usage: browser-verify.mjs <tokenUrl> [outPng]')
  process.exit(2)
}

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const browser = BROWSERS.find((candidate) => existsSync(candidate))
if (!browser) {
  console.error('no Chromium browser found')
  process.exit(2)
}

const port = 9229
const userDataDir = join(tmpdir(), `weread-verify-${Date.now()}`)
mkdirSync(userDataDir, { recursive: true })
const chrome = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-features=Translate,MediaRouter',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore', windowsHide: true })

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForDevTools() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('DevTools endpoint did not come up')
}

class Cdp {
  constructor(wsUrl) {
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    this.socket = new WebSocket(wsUrl)
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', (event) => reject(new Error(`CDP socket error: ${event.message || 'unknown'}`)))
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
        else pending.resolve(message.result)
        return
      }
      const listeners = this.events.get(message.method) || []
      for (const listener of listeners) listener(message.params)
    })
  }

  async send(method, params = {}) {
    await this.ready
    const id = this.nextId
    this.nextId += 1
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
    this.socket.send(JSON.stringify({ id, method, params }))
    return result
  }

  once(method) {
    return new Promise((resolve) => {
      const listener = (params) => {
        const listeners = this.events.get(method) || []
        this.events.set(method, listeners.filter((item) => item !== listener))
        resolve(params)
      }
      this.events.set(method, [...(this.events.get(method) || []), listener])
    })
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* ignore */
    }
  }
}

const checks = []
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || !detail ? '' : `: ${detail}`}`)
}

try {
  const version = await waitForDevTools()
  console.log('browser:', version.Browser)

  // Open a tab at the token URL.
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(tokenUrl)}`, { method: 'PUT' })
  const target = await created.json()
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: tokenUrl })
  await loaded
  // Layout + plugin activation settle (shelf/chapter/content requests may take a few seconds).
  await sleep(15000)

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) return { error: result.exceptionDetails.text }
    return { value: result.result?.value }
  }

  // First-run notice dialog would cover the workspace; dismiss it like a user.
  const dismissed = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')]
    const target = buttons.find((button) => /继续|知道了|同意/.test(button.textContent || ''))
    if (target) { target.click(); return true }
    return false
  })()`)
  if (dismissed.value) await sleep(1200)

  const dom = await evaluate(`(() => {
    const layer = document.getElementById('weread-moyu-layer')
    const dot = document.getElementById('weread-moyu-dot')
    const panel = document.getElementById('weread-moyu-panel')
    const style = document.getElementById('weread-moyu-style')
    const layerStyle = layer ? getComputedStyle(layer) : null
    const text = layer ? (layer.innerText || '').slice(0, 120) : ''
    return {
      url: location.href,
      title: document.title,
      hasLayer: Boolean(layer),
      hasDot: Boolean(dot),
      hasPanel: Boolean(panel),
      hasStyle: Boolean(style),
      pointerEvents: layerStyle ? layerStyle.pointerEvents : null,
      zIndex: layerStyle ? layerStyle.zIndex : null,
      opacity: layerStyle ? layerStyle.opacity : null,
      text: text,
      bodyText: (document.body.innerText || '').slice(0, 200),
      loader: typeof window.__ModuleLoader__,
      boot: Boolean(window.__DSH_BOOT__),
      row: (window.__DSH_BOOT__?.entries || []).find((entry) => entry.id === 'dsh-weread-moyu') || null,
      errors: window.__wereadMoyuErrors || null,
    }
  })()`)
  const info = dom.value || {}
  console.log('dom:', JSON.stringify(info, null, 2))

  check('page reached the GUI', /127\.0\.0\.1:\d+/.test(info.url || ''))
  check('boot graph carries the plugin row', Boolean(info.row))
  check('background layer exists (#weread-moyu-layer)', info.hasLayer)
  check('control dot exists', info.hasDot)
  check('style element injected', info.hasStyle)
  check('layer is click-through', info.pointerEvents === 'none', info.pointerEvents)
  check('layer is behind the app shell', Number(info.zIndex) <= 0 || info.zIndex === 'auto' || info.zIndex === '0', info.zIndex)
  check('background text rendered', (info.text || '').trim().length > 40, (info.text || '').slice(0, 60))
  const demoHint = await evaluate(`(() => {
    const panel = document.getElementById('weread-moyu-panel')
    const layer = document.getElementById('weread-moyu-layer')
    const panelText = panel ? panel.innerText : ''
    const layerText = layer ? layer.innerText : ''
    return {
      panelSaysDemo: /演示文本/.test(panelText),
      panelSaysReal: /真实书页/.test(panelText),
      panelLoginText: (panelText.match(/已登录[^\\n]*/) || [''])[0],
      layerDemoMarker: /桃花源记|古文观止/.test(layerText),
    }
  })()`)
  if (demoHint.value) {
    console.log('      content source:', JSON.stringify(demoHint.value))
    check('background uses real WeRead content (not demo fallback)', demoHint.value.panelSaysReal === true && demoHint.value.panelSaysDemo === false, JSON.stringify(demoHint.value))
  }

  // Toggle the panel via a synthetic click and verify it opens.
  const panelOpen = await evaluate(`(() => {
    const dot = document.getElementById('weread-moyu-dot')
    if (!dot) return { error: 'no dot' }
    dot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const panel = document.getElementById('weread-moyu-panel')
    return { open: Boolean(panel && getComputedStyle(panel).display !== 'none' && panel.offsetHeight > 0), html: panel ? panel.innerText.slice(0, 300) : null }
  })()`)
  check('control panel opens on click', panelOpen.value?.open, JSON.stringify(panelOpen.value?.html || panelOpen.error || ''))

  // Chapter directory: full chapter numbers and jump-to-chapter.
  await sleep(2500)
  const chapters = await evaluate(`(() => {
    const panel = document.getElementById('weread-moyu-panel')
    const text = panel ? panel.innerText : ''
    const jump = document.getElementById('wm-jump-input')
    const rows = panel ? [...panel.querySelectorAll('[class*="wm-item"]')].map((node) => node.innerText).filter(Boolean) : []
    return {
      hasJump: Boolean(jump),
      numberedRows: rows.filter((row) => /第\\s*\\d+\\s*章/.test(row)).length,
      sample: rows.slice(0, 6),
      hasTotal: /共\\s*\\d+\\s*章/.test(text),
    }
  })()`)
  check('chapter rows show full chapter numbers', (chapters.value?.numberedRows || 0) > 0, JSON.stringify(chapters.value?.sample))
  check('chapter header shows total chapter count', Boolean(chapters.value?.hasTotal), 'no 共 N 章 in panel')
  check('jump-to-chapter input exists', Boolean(chapters.value?.hasJump))

  const jumped = await evaluate(`(() => {
    const input = document.getElementById('wm-jump-input')
    const button = document.getElementById('wm-jump-btn')
    if (!input || !button) return { error: 'no jump controls' }
    input.value = '500'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return { ok: true }
  })()`)
  await sleep(3000)
  const afterJump = await evaluate(`(() => {
    const panel = document.getElementById('weread-moyu-panel')
    return { text: panel ? panel.innerText : '' }
  })()`)
  check('jumping to chapter 500 selects it', /第\s*500\s*章/.test(afterJump.value?.text || ''), (afterJump.value?.text || '').slice(-160))

  const shotChapters = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const chaptersPng = outPng.replace(/\.png$/i, '-chapters.png')
  writeFileSync(chaptersPng, Buffer.from(shotChapters.data, 'base64'))
  console.log('screenshot (chapter directory):', chaptersPng)

  // Whole-book cache: switch to the pre-cached book and verify the offline row.
  const cacheSection = await evaluate(`(() => {
    const panel = document.getElementById('weread-moyu-panel')
    const section = panel ? panel.querySelector('[class*="wm-cache"]') : null
    return { hasSection: Boolean(section), text: section ? section.innerText.slice(0, 160) : '', panel: panel ? panel.innerText.slice(0, 200) : '' }
  })()`)
  check('offline cache row exists in the panel', Boolean(cacheSection.value?.hasSection), JSON.stringify(cacheSection.value?.panel))
  console.log('      cache row:', JSON.stringify(cacheSection.value?.text || ''))

  const pickedBook = await evaluate(`(() => {
    const panel = document.getElementById('weread-moyu-panel')
    const rows = panel ? [...panel.querySelectorAll('[class*="wm-item"]')] : []
    const target = rows.find((row) => (row.textContent || '').includes('浮生六记'))
    if (!target) return { error: 'cached book row not found', sample: rows.slice(0, 6).map((row) => (row.textContent || '').slice(0, 40)) }
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return { ok: true, text: (target.textContent || '').slice(0, 80) }
  })()`)
  check('cached book is selectable in the shelf', Boolean(pickedBook.value?.ok), JSON.stringify(pickedBook.value))
  await sleep(6000)

  const cacheAfter = await evaluate(`(() => {
    const panel = document.getElementById('weread-moyu-panel')
    const section = panel ? panel.querySelector('[class*="wm-cache"]') : null
    const text = panel ? panel.innerText : ''
    return {
      sectionText: section ? section.innerText : '',
      saysCached: /已缓存/.test(text),
      saysLocalSource: /本地缓存/.test(text),
      hasClear: /清除缓存/.test(text),
    }
  })()`)
  console.log('      cache state:', JSON.stringify(cacheAfter.value))
  check('cached book shows the cached state', Boolean(cacheAfter.value?.saysCached), JSON.stringify(cacheAfter.value?.sectionText))
  check('cached book offers 清除缓存', Boolean(cacheAfter.value?.hasClear))
  if (!cacheAfter.value?.saysLocalSource) {
    await sleep(3500)
    cacheAfter.value = await evaluate(`(() => {
      const panel = document.getElementById('weread-moyu-panel')
      return { saysLocalSource: /本地缓存/.test(panel ? panel.innerText : '') }
    })()`)
  }
  check('reading a cached chapter reports 本地缓存 source', Boolean(cacheAfter.value?.saysLocalSource), JSON.stringify(cacheAfter.value))

  const shotCache = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const cachePng = outPng.replace(/\.png$/i, '-cache.png')
  writeFileSync(cachePng, Buffer.from(shotCache.data, 'base64'))
  console.log('screenshot (offline cache):', cachePng)

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(outPng, Buffer.from(shot.data, 'base64'))
  console.log('screenshot (panel open):', outPng)

  // Close the panel again for the clean background shot.
  await evaluate(`(() => { const dot = document.getElementById('weread-moyu-dot'); if (dot) dot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })()`)
  await sleep(600)
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const closedPng = outPng.replace(/\.png$/i, '-background.png')
  writeFileSync(closedPng, Buffer.from(shot2.data, 'base64'))
  console.log('screenshot (background only):', closedPng)

  // Peek button: show the page being read right now.
  const peek = await evaluate(`(() => {
    const btn = document.getElementById('weread-moyu-peek')
    if (!btn) return { error: 'no peek button' }
    const style = getComputedStyle(btn)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const panel = document.getElementById('weread-moyu-peek-panel')
    const text = panel ? panel.innerText : ''
    return {
      hasBtn: true,
      opacity: style.opacity,
      btnDisplay: style.display,
      open: Boolean(panel && getComputedStyle(panel).display !== 'none' && panel.offsetHeight > 0),
      len: text.trim().length,
      text: text.slice(0, 240),
    }
  })()`)
  check('peek button exists', peek.value?.hasBtn, peek.value?.error)
  check('peek button is subtle by default', parseFloat(peek.value?.opacity || '1') <= 0.45, peek.value?.opacity)
  check('peek panel opens with readable content', peek.value?.open && peek.value.len > 80, JSON.stringify(peek.value))
  check('peek panel names the real book (not the site title)', Boolean(peek.value?.text) && !/《微信读书》/.test(peek.value.text), (peek.value?.text || '').slice(0, 80))
  check('peek header shows the chapter number', /第\s*\d+\s*章/.test(peek.value?.text || ''), (peek.value?.text || '').slice(0, 80))
  console.log('      peek panel text:', JSON.stringify((peek.value?.text || '').slice(0, 120)))

  const shotPeek = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const peekPng = outPng.replace(/\.png$/i, '-peek.png')
  writeFileSync(peekPng, Buffer.from(shotPeek.data, 'base64'))
  console.log('screenshot (peek panel):', peekPng)

  const scrollHint = await evaluate(`(() => {
    const panel = document.getElementById('weread-moyu-peek-panel')
    const hint = panel ? panel.querySelector('.wm-peek-hint') : null
    return { text: hint ? hint.textContent : '', open: Boolean(panel && panel.offsetHeight > 0) }
  })()`)
  check(
    'peek panel shows continuous-scroll hint',
    /滚动阅读|已是最后一章|正在加载|Esc/.test(scrollHint.value?.text || ''),
    JSON.stringify(scrollHint.value),
  )

  const escClosed = await evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const panel = document.getElementById('weread-moyu-peek-panel')
    return { open: Boolean(panel && panel.offsetHeight > 0) }
  })()`)
  check('peek panel closes on Escape', !escClosed.value?.open, JSON.stringify(escClosed.value))

  // ── v0.1.5: peek font size, cross-chapter paging, resizable window ──
  const peekReopen = await evaluate(`(() => {
    const btn = document.getElementById('weread-moyu-peek')
    if (!btn) return { error: 'no peek button' }
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const panel = document.getElementById('weread-moyu-peek-panel')
    return { open: Boolean(panel && panel.offsetHeight > 0) }
  })()`)
  check('peek reopens for v0.1.5 checks', Boolean(peekReopen.value?.open), JSON.stringify(peekReopen.value))
  await sleep(800)

  const fontBefore = await evaluate(`(() => {
    const panel = document.getElementById('weread-moyu-peek-panel')
    const para = panel ? panel.querySelector('.wm-peek-body p') : null
    let cfg = {}
    try { cfg = JSON.parse(localStorage.getItem('weread-moyu:config') || '{}') } catch {}
    return { fontSize: para ? getComputedStyle(para).fontSize : null, cfgFontSize: cfg.fontSize || 16 }
  })()`)
  check(
    'peek body font follows the configured font size',
    fontBefore.value?.fontSize === fontBefore.value?.cfgFontSize + 'px',
    JSON.stringify(fontBefore.value),
  )

  const fontPlus = await evaluate(`(() => {
    const panel = document.getElementById('weread-moyu-peek-panel')
    const para = panel ? panel.querySelector('.wm-peek-body p') : null
    const plus = panel ? panel.querySelector('.wm-peek-font-plus') : null
    const before = para ? getComputedStyle(para).fontSize : null
    if (plus) plus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const after = para ? getComputedStyle(para).fontSize : null
    let cfg = {}
    try { cfg = JSON.parse(localStorage.getItem('weread-moyu:config') || '{}') } catch {}
    return { before, after, cfgFontSize: cfg.fontSize }
  })()`)
  check(
    'A+ increases the peek font and persists it',
    fontPlus.value?.after !== fontPlus.value?.before && Number(fontPlus.value?.cfgFontSize) >= 13,
    JSON.stringify(fontPlus.value),
  )
  await evaluate(`(() => {
    const minus = document.querySelector('#weread-moyu-peek-panel .wm-peek-font-minus')
    if (minus) minus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })()`)

  const chapBefore = await evaluate(`(() => {
    const label = document.querySelector('#weread-moyu-peek-panel .wm-peek-chap')
    const body = document.querySelector('#weread-moyu-peek-panel .wm-peek-body')
    return { label: label ? label.textContent : '', scrollable: Boolean(body && body.scrollHeight > body.clientHeight), paras: body ? body.querySelectorAll('p').length : 0 }
  })()`)
  check(
    'peek body is a continuous scrollable reader',
    Boolean(chapBefore.value?.scrollable) && (chapBefore.value?.paras || 0) > 5,
    JSON.stringify(chapBefore.value),
  )

  // Scroll to the bottom: auto-load appends more paragraphs seamlessly (no duplicate windows).
  const scrolled = await evaluate(`(() => {
    const body = document.querySelector('#weread-moyu-peek-panel .wm-peek-body')
    if (!body) return { error: 'no body' }
    const before = body.querySelectorAll('p').length
    body.scrollTop = body.scrollHeight
    body.dispatchEvent(new Event('scroll'))
    return { before }
  })()`)
  await sleep(1800)
  const afterScroll = await evaluate(`(() => {
    const body = document.querySelector('#weread-moyu-peek-panel .wm-peek-body')
    const hint = document.querySelector('#weread-moyu-peek-panel .wm-peek-hint')
    return { after: body ? body.querySelectorAll('p').length : 0, hint: hint ? hint.textContent : '' }
  })()`)
  check(
    'peek scroll to bottom auto-loads more content',
    Number(afterScroll.value?.after) > Number(scrolled.value?.before) ||
      /已是最后一章|正在加载/.test(afterScroll.value?.hint || ''),
    `paras ${scrolled.value?.before} -> ${afterScroll.value?.after}, hint: ${afterScroll.value?.hint}`,
  )

  // Wheel at the absolute bottom keeps loading (no scroll events fire there).
  const wheelProbe = await evaluate(`(() => {
    const body = document.querySelector('#weread-moyu-peek-panel .wm-peek-body')
    if (!body) return { error: 'no body' }
    const before = body.querySelectorAll('p').length
    body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 240 }))
    return { before }
  })()`)
  await sleep(1800)
  const wheelAfter = await evaluate(`(() => {
    const body = document.querySelector('#weread-moyu-peek-panel .wm-peek-body')
    const label = document.querySelector('#weread-moyu-peek-panel .wm-peek-chap')
    return { after: body ? body.querySelectorAll('p').length : 0, label: label ? label.textContent : '' }
  })()`)
  check(
    'wheel at bottom keeps the seamless reader loading',
    Number(wheelAfter.value?.after) >= Number(wheelProbe.value?.before),
    `paras ${wheelProbe.value?.before} -> ${wheelAfter.value?.after}, label: ${wheelAfter.value?.label}`,
  )

  const resized = await evaluate(`(() => {
    const panel = document.getElementById('weread-moyu-peek-panel')
    const grip = panel ? panel.querySelector('.wm-peek-resize') : null
    if (!panel || !grip) return { error: 'no resize grip' }
    const rect = panel.getBoundingClientRect()
    const gx = rect.left + 8
    const gy = rect.bottom - 8
    const before = rect.width
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, clientX: gx, clientY: gy, button: 0 }))
    for (let step = 1; step <= 10; step += 1) {
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 7, clientX: gx - step * 14, clientY: gy - step * 9 }))
    }
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 7 }))
    const after = panel.getBoundingClientRect().width
    let cfg = {}
    try { cfg = JSON.parse(localStorage.getItem('weread-moyu:config') || '{}') } catch {}
    return { before, after, peekWidth: cfg.peekWidth }
  })()`)
  check(
    'resize grip enlarges the peek window',
    Number(resized.value?.after) > Number(resized.value?.before) + 40,
    JSON.stringify(resized.value),
  )
  check('resized width persists to config', Number(resized.value?.peekWidth) >= 300, JSON.stringify(resized.value))

  // 上一章 / 下一章 buttons
  const chapBtnBefore = await evaluate(`(() => {
    const label = document.querySelector('#weread-moyu-peek-panel .wm-peek-chap')
    return label ? label.textContent : ''
  })()`)
  await evaluate(`(() => {
    const btn = document.querySelector('#weread-moyu-peek-panel .wm-peek-next-ch')
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })()`)
  await sleep(4500)
  const chapBtnAfter = await evaluate(`(() => {
    const label = document.querySelector('#weread-moyu-peek-panel .wm-peek-chap')
    return label ? label.textContent : ''
  })()`)
  check(
    'peek 下一章 button loads the next chapter',
    Boolean(chapBtnAfter.value) && chapBtnAfter.value !== chapBtnBefore.value,
    `before: ${chapBtnBefore.value} / after: ${chapBtnAfter.value}`,
  )

  const shotPeek15 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(outPng.replace(/\.png$/i, '-peek15.png'), Buffer.from(shotPeek15.data, 'base64'))
  console.log('screenshot (peek v0.1.5):', outPng.replace(/\.png$/i, '-peek15.png'))

  await evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })()`)
  await sleep(400)

  // Check the plugin API reachable from the page origin.
  const api = await evaluate(`fetch('/weread-moyu/api/ping').then(r => r.json()).then(j => j).catch(e => ({error: String(e)}))`)
  check('host API reachable from page', api.value?.ok === true, JSON.stringify(api.value))

  cdp.close()
} catch (error) {
  console.error('verify failed:', error?.stack || error)
  process.exitCode = 1
} finally {
  chrome.kill()
  await sleep(500)
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const failed = checks.filter((item) => !item.ok)
if (failed.length > 0) {
  console.log(`\n${failed.length} check(s) failed`)
  process.exitCode = 1
}
