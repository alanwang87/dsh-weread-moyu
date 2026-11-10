/**
 * Offline reading verification: cached book must be readable WITHOUT login and
 * must resume at the last-read position after a page reload.
 *
 * Usage: <electron> offline-verify.mjs <tokenUrl>
 * Prereqs: the target host has a cached book (浮生六记) and NO active session (logged out).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tokenUrl = process.argv[2]
if (!tokenUrl) {
  console.error('usage: offline-verify.mjs <tokenUrl>')
  process.exit(2)
}
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]
const browser = BROWSERS.find((candidate) => existsSync(candidate))
const port = 9344
const userDataDir = join(tmpdir(), `weread-offline-${Date.now()}`)
mkdirSync(userDataDir, { recursive: true })
const chrome = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDevTools() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return r.json()
    } catch {}
    await sleep(250)
  }
  throw new Error('devtools not up')
}

class Cdp {
  constructor(wsUrl) {
    this.nextId = 1
    this.pending = new Map()
    this.socket = new WebSocket(wsUrl)
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', () => reject(new Error('socket error')))
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
        else pending.resolve(message.result)
      }
    })
  }
  async send(method, params = {}) {
    await this.ready
    const id = this.nextId++
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
    this.socket.send(JSON.stringify({ id, method, params }))
    return result
  }
  once(method) {
    return new Promise((resolve) => {
      const listener = (event) => {
        const message = JSON.parse(event.data)
        if (message.method === method) resolve(message.params)
      }
      this.socket.addEventListener('message', listener)
    })
  }
}

const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `: ${detail}`}`)
}

try {
  await waitForDevTools()
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(tokenUrl)}`, { method: 'PUT' })
  const target = await created.json()
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: tokenUrl })
  await loaded
  await sleep(13000)

  const evalJs = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) return { error: result.exceptionDetails.text }
    return result.result?.value
  }

  await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/继续/.test(x.textContent||'')); if(b) b.click() })()`)
  await sleep(1000)

  const ui = await evalJs(`(() => {
    const panel = document.getElementById('weread-moyu-panel')
    const booksSec = document.getElementById('weread-moyu-panel') ? panel : null
    const list = panel ? panel.querySelector('[id*="books"], [class*="books-list"]') : null
    const body = document.querySelector('.wm-scroll')
    const firstPara = document.querySelector('.wm-scroll .wm-body p')
    const status = panel ? (panel.innerText.match(/内容来源：[^\\n]*/) || [''])[0] : ''
    let cfg = {}
    try { cfg = JSON.parse(localStorage.getItem('weread-moyu:config') || '{}') } catch {}
    return {
      panelText: panel ? panel.innerText.slice(0, 400) : '',
      shelfHasOfflineBook: panel ? /浮生六记/.test(panel.innerText) : false,
      offlineLabel: /离线缓存（免登录可读）/.test(panel ? panel.innerText : ''),
      firstPara: firstPara ? (firstPara.textContent || '').slice(0, 60) : '',
      isDemoMarker: /古文观止|桃花源记/.test(document.body.innerText),
      statusLine: status,
      cfgBookId: cfg.bookId || null,
      cfgChapterUid: cfg.chapterUid || null,
      cfgPos: cfg.pos || 0,
      chapterLabel: (() => { const c = panel ? panel.querySelector('.wm-peek-chap') : null; return c ? c.textContent : '' })(),
    }
  })()`)
  console.log('ui:', JSON.stringify(ui, null, 2))

  check('offline shelf lists the cached book (no login)', Boolean(ui.shelfHasOfflineBook), ui.panelText)
  check('offline shelf shows the 免登录 label', /离线缓存/.test(ui.panelText || '') && /免登录/.test(ui.panelText || ''), (ui.panelText || '').slice(0, 200))
  check('content is the real cached book (not demo)', Boolean(ui.firstPara) && !ui.isDemoMarker, ui.firstPara)
  check('status line reports 本地缓存', /本地缓存/.test(ui.statusLine), ui.statusLine)

  // Jump to chapter 5, then reload: it must resume at the same chapter.
  const jump = await evalJs(`(() => {
    const input = document.querySelector('#wm-jump-input')
    const btn = document.querySelector('#wm-jump-btn')
    if (!input || !btn) return { error: 'no jump controls' }
    input.value = '5'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return { ok: true }
  })()`)
  await sleep(3000)
  const beforeReload = await evalJs(`(() => {
    const panel = document.getElementById('weread-moyu-panel')
    const status = panel ? (panel.innerText.match(/内容来源：[^\\n]*/) || [''])[0] : ''
    let cfg = {}
    try { cfg = JSON.parse(localStorage.getItem('weread-moyu:config') || '{}') } catch {}
    return { statusLine: status, chapterUid: cfg.chapterUid, pos: cfg.pos }
  })()`)
  console.log('before reload:', JSON.stringify(beforeReload))
  check(
    'jump-to-chapter works offline',
    /第\s*5\s*章/.test(beforeReload.statusLine || '') && String(beforeReload.chapterUid ?? '') !== '',
    JSON.stringify(beforeReload),
  )

  const reloaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.reload')
  await reloaded
  await sleep(12000)

  await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/继续/.test(x.textContent||'')); if(b) b.click() })()`)
  await sleep(1500)

  const resumed = await evalJs(`(() => {
    const panel = document.getElementById('weread-moyu-panel')
    const body = document.querySelector('.wm-scroll .wm-body p')
    const status = panel ? (panel.innerText.match(/内容来源：[^\\n]*/) || [''])[0] : ''
    let cfg = {}
    try { cfg = JSON.parse(localStorage.getItem('weread-moyu:config') || '{}') } catch {}
    return {
      statusLine: status,
      firstPara: body ? (body.textContent || '').slice(0, 60) : '',
      isDemoMarker: /古文观止|桃花源记/.test(document.body.innerText),
      cfgChapterUid: cfg.chapterUid,
      cfgPos: cfg.pos,
    }
  })()`)
  console.log('after reload:', JSON.stringify(resumed, null, 2))

  check('after reload still offline-readable (not demo)', Boolean(resumed.firstPara) && !resumed.isDemoMarker, resumed.firstPara)
  check(
    'after reload resumes the saved chapter',
    String(resumed.cfgChapterUid ?? '') === String(beforeReload.chapterUid ?? '') &&
      /第\s*5\s*章/.test(resumed.statusLine || ''),
    `cfg=${resumed.cfgChapterUid} status=${resumed.statusLine.slice(0, 120)}`,
  )
  check('after reload status still shows 本地缓存', /本地缓存/.test(resumed.statusLine || ''), resumed.statusLine)

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync('D:\\Alan\\插件\\examples\\live-offline.png', Buffer.from(shot.data, 'base64'))
  console.log('screenshot:', 'D:\\Alan\\插件\\examples\\live-offline.png')
} catch (error) {
  console.error('offline verify failed:', error?.message || error)
  process.exitCode = 1
} finally {
  chrome.kill()
  await sleep(400)
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}

const failed = checks.filter((item) => !item.ok)
if (failed.length > 0) {
  console.log(`\n${failed.length} check(s) failed`)
  process.exitCode = 1
}
