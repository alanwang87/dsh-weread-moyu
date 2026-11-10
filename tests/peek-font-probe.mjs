/**
 * One-off probe: does A+ actually change the peek font (with debounce delay)?
 * Usage: <electron> peek-font-probe.mjs <tokenUrl>
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tokenUrl = process.argv[2]
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]
const browser = BROWSERS.find((candidate) => existsSync(candidate))
const port = 9333
const userDataDir = join(tmpdir(), `peek-probe-${Date.now()}`)
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
      this.socket.addEventListener('error', (e) => reject(new Error('socket error')))
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
      const wrap = (params) => { resolve(params) }
      this.socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.method === method) wrap(message.params)
      })
    })
  }
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
  await sleep(12000)

  const evalJs = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) return { error: result.exceptionDetails.text }
    return result.result?.value
  }

  // dismiss notice, open peek
  await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/继续/.test(x.textContent||'')); if(b) b.click() })()`)
  await sleep(800)
  const open = await evalJs(`(() => { const btn=document.getElementById('weread-moyu-peek'); if(!btn) return {error:'no btn'}; btn.click(); return {open: true} })()`)
  console.log('open:', JSON.stringify(open))
  await sleep(800)

  const read = await evalJs(`(() => {
    const panel = document.getElementById('weread-moyu-peek-panel')
    const body = panel ? panel.querySelector('.wm-peek-body') : null
    const plus = panel ? panel.querySelector('.wm-peek-font-plus') : null
    let cfg = {}
    try { cfg = JSON.parse(localStorage.getItem('weread-moyu:config') || '{}') } catch {}
    return { computed: body ? getComputedStyle(body).fontSize : null, cfg: cfg.fontSize, hasPlus: Boolean(plus), panelHidden: panel ? panel.hidden : null }
  })()`)
  console.log('before:', JSON.stringify(read))

  for (let i = 0; i < 3; i += 1) {
    await evalJs(`(() => { const p=document.querySelector('#weread-moyu-peek-panel .wm-peek-font-plus'); if(p) p.click(); })()`)
    await sleep(250)
  }
  await sleep(1500)
  const after = await evalJs(`(() => {
    const panel = document.getElementById('weread-moyu-peek-panel')
    const body = panel ? panel.querySelector('.wm-peek-body') : null
    let cfg = {}
    try { cfg = JSON.parse(localStorage.getItem('weread-moyu:config') || '{}') } catch {}
    return { computed: body ? getComputedStyle(body).fontSize : null, cfg: cfg.fontSize, cssVar: panel ? panel.style.getPropertyValue('--wm-size') : null }
  })()`)
  console.log('after 3x A+:', JSON.stringify(after))

  cdp.close()
} catch (error) {
  console.error('probe failed:', error?.message || error)
} finally {
  chrome.kill()
  await sleep(400)
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}
