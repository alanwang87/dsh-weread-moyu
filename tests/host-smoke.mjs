/**
 * Host-half smoke test 鈥?no DSH runtime required.
 *
 * Run with Electron's Node (v24):
 *   & "D:\Program Files\deepseekHarmess\DeepSeek Harness.exe" "D:\Alan\鎻掍欢\tests\host-smoke.mjs"
 *
 * It imports plugin/lib/index.js, applies it to a fake cordis context whose
 * webServer records the registered route, then drives the handler with fake
 * req/res objects and asserts the JSON contract from docs/spec.md.
 */
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate from the real ~/.dsh session: the host half resolves its state dir at
// module load, so point DSH_HOME at a fresh temp directory before importing it.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-weread-smoke-'))
const { apply, inject, name } = await import('../lib/index.js')

const registered = []
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  effect(factory) {
    const disposer = factory()
    if (typeof disposer !== 'function') throw new Error('effect factory must return a disposer')
  },
  webServer: {
    register(route) {
      registered.push(route)
      return () => {}
    },
  },
}

assert.equal(name, 'weread-moyu')
assert.deepEqual(inject, ['webServer'])
apply(ctx)
assert.equal(registered.length, 1)
const route = registered[0]
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/weread-moyu/api')
assert.equal(typeof route.handler, 'function')

function makeReq(method, url, body, remoteAddress = '127.0.0.1') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.socket = { remoteAddress }
  return req
}

function makeRes() {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(chunk) {
      out.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

async function call(method, url, body, remoteAddress) {
  const res = makeRes()
  await route.handler(makeReq(method, url, body, remoteAddress), res)
  let json = null
  try {
    json = JSON.parse(res.out.body)
  } catch {
    /* leave null */
  }
  return { status: res.out.status, headers: res.out.headers, json, raw: res.out.body }
}

const results = []
async function test(label, fn) {
  try {
    await fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error.message })
  }
}

await test('ping', async () => {
  const r = await call('GET', '/weread-moyu/api/ping')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.version, '0.1.8')
  assert.equal(r.json.hostReady, true)
})

await test('status without login reports NOT_LOGGED_IN-ish shape', async () => {
  const r = await call('GET', '/weread-moyu/api/status')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.loggedIn, false)
  assert.deepEqual(r.json.books, [])
})

await test('non-loopback request is rejected', async () => {
  const r = await call('GET', '/weread-moyu/api/ping', undefined, '192.168.1.20')
  assert.equal(r.status, 403)
  assert.equal(r.json.code, 'FORBIDDEN')
})

await test('unknown route is 404', async () => {
  const r = await call('GET', '/weread-moyu/api/nope')
  assert.equal(r.status, 404)
  assert.equal(r.json.code, 'NOT_FOUND')
})

await test('content without login reports NOT_LOGGED_IN', async () => {
  const r = await call('GET', '/weread-moyu/api/content?bookId=1')
  assert.equal(r.status, 200)
  assert.equal(r.json.code, 'NOT_LOGGED_IN')
})

await test('cookie login with empty body is 400', async () => {
  const r = await call('POST', '/weread-moyu/api/login/cookie', {})
  assert.equal(r.status, 400)
  assert.equal(r.json.code, 'BAD_REQUEST')
})

await test('qr creation succeeds (or reports NOT_READY before weread.js exists)', async () => {
  const r = await call('GET', '/weread-moyu/api/qr')
  if (r.status === 502) {
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'NOT_READY')
    assert.equal(typeof r.json.error, 'string')
    return
  }
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(typeof r.json.uid, 'string')
  assert.ok(r.json.qrDataUrl.startsWith('data:image/') || r.json.qrDataUrl.startsWith('http'), 'qrDataUrl should be an image data URL or URL')
  assert.ok(r.json.expiresAt > Date.now(), 'expiresAt should be in the future')
})

await test('logout is idempotent', async () => {
  const r = await call('POST', '/weread-moyu/api/logout', {})
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
})

let failed = 0
for (const r of results) {
  if (r.ok) console.log(`PASS  ${r.label}`)
  else {
    failed++
    console.log(`FAIL  ${r.label}: ${r.error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
