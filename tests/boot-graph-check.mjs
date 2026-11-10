/**
 * Boot-graph verification for a running DSH Web host.
 *
 * Usage (Electron Node v24):
 *   & "D:\Program Files\deepseekHarmess\DeepSeek Harness.exe" "D:\Alan\插件\tests\boot-graph-check.mjs" "<tokenUrl>"
 *
 * Checks:
 *   1. index.html renders and injects window.__DSH_BOOT__
 *   2. the boot graph contains the dsh-weread-moyu client row
 *   3. the exact combo URL for that row returns the hand-written bundle
 *   4. /weread-moyu/api/ping answers from the host half
 */
const tokenUrl = process.argv[2]
if (!tokenUrl) {
  console.error('usage: boot-graph-check.mjs <tokenUrl>')
  process.exit(2)
}

const base = new URL(tokenUrl)
const cookieJar = []

function rememberCookies(response) {
  const setCookie = response.headers.getSetCookie?.() ?? []
  for (const cookie of setCookie) cookieJar.push(cookie.split(';')[0])
}

async function get(path, options = {}) {
  let url = new URL(path, base)
  const headers = { ...(options.headers || {}) }
  for (let hop = 0; hop < 5; hop += 1) {
    if (cookieJar.length > 0) headers.cookie = cookieJar.join('; ')
    const response = await fetch(url, { ...options, headers, redirect: 'manual' })
    rememberCookies(response)
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location'), url)
      continue
    }
    const body = await response.text()
    return { status: response.status, body, url: url.href }
  }
  return { status: 508, body: '', url: url.href }
}

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`)
  } else {
    failures.push({ label, detail })
    console.log(`FAIL  ${label}${detail ? `: ${detail}` : ''}`)
  }
}

// 1. index
const index = await get(base.pathname + base.search)
check('index.html responds 200', index.status === 200, `status ${index.status}`)
const marker = index.body.indexOf('__DSH_BOOT__')
check('__DSH_BOOT__ is injected', marker >= 0)
let graph = null
if (marker >= 0) {
  const start = index.body.indexOf('{', index.body.indexOf('=', marker))
  // The graph is a JSON object literal inside a classic script; find the matching close brace.
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < index.body.length; i += 1) {
    const ch = index.body[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end > start) {
    try {
      graph = JSON.parse(index.body.slice(start, end))
    } catch (error) {
      check('boot graph parses as JSON', false, error.message)
    }
  }
}
check('boot graph parses as JSON', Boolean(graph))

const rows = Array.isArray(graph?.entries) ? graph.entries : []
check('boot graph has client entries', rows.length > 10, `entries: ${rows.length}`)

const ours = rows.find((row) => row.id === 'dsh-weread-moyu')
check('boot graph contains dsh-weread-moyu', Boolean(ours), 'client row missing — client-modules did not scan/enable the package')

if (ours) {
  console.log('      row:', JSON.stringify(ours))
  const combo = await get('/' + ours.url)
  check('combo bundle responds 200', combo.status === 200, `status ${combo.status}`)
  check('combo bundle registers our factory id', combo.body.includes('dsh-weread-moyu'))
  check('combo bundle exposes apply()', combo.body.includes('apply'))
  check('combo bundle is our hand-written client', /weread-moyu/i.test(combo.body))
}

// 4. host half ping
const ping = await get('/weread-moyu/api/ping')
let pingJson = null
try {
  pingJson = JSON.parse(ping.body)
} catch {}
check('host API /ping responds 200', ping.status === 200, `status ${ping.status}`)
check('host API reports ok', pingJson?.ok === true, ping.body.slice(0, 200))
check('weread protocol module loaded', pingJson?.wereadReady === true, pingJson?.wereadError || '')

// Report
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
