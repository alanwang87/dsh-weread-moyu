/**
 * Whole-book cache store unit test (no DSH runtime, no network).
 *
 * Run with Electron's Node (v24):
 *   & "D:\Program Files\deepseekHarmess\DeepSeek Harness.exe" "D:\Alan\插件\tests\cache-smoke.mjs"
 *
 * It drives plugin/lib/cache.js with a mock weread module and asserts the
 * download loop, resume/cancel, account binding, local page serving and delete.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rootDir = mkdtempSync(join(tmpdir(), 'dsh-cache-smoke-'))
let account = 'vid-1'
let delayMs = 5

function mockSlice({ text, pos = 0, maxChars = 120 }) {
  const total = String(text || '').length
  const start = Math.min(Math.max(0, pos), total)
  const end = Math.min(total, start + maxChars)
  const chunk = String(text).slice(start, end)
  return {
    lines: chunk.split(/\n+/).filter(Boolean),
    pos: end,
    hasMore: end < total,
    totalChars: total,
  }
}

const mockWeread = {
  async getChapters() {
    return {
      ok: true,
      book: { title: '测试书', author: '测试作者' },
      chapters: [
        { chapterUid: 1, chapterIdx: 1, title: '第 1 章', wordCount: 120 },
        { chapterUid: 2, chapterIdx: 2, title: '第 2 章', wordCount: 0 },
        { chapterUid: 3, chapterIdx: 3, title: '第 3 章', wordCount: 200 },
      ],
    }
  },
  async getChapterText(cookie, bookId, chapterUid) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (chapterUid === 99) return { ok: false, code: 'CHAPTER_LOCKED', error: 'locked' }
    return {
      ok: true,
      text: `章节${chapterUid}正文\n`.repeat(30),
      preview: false,
      anonymous: false,
      book: { title: '测试书', author: '测试作者' },
      chapter: { title: `第 ${chapterUid} 章` },
    }
  },
  sliceContentPage: mockSlice,
}

const { createCacheStore } = await import('../lib/cache.js')
const store = createCacheStore({
  rootDir,
  getWeread: () => mockWeread,
  getCookie: () => 'wr_vid=1; wr_skey=x',
  getAccountVid: () => account,
  log: () => {},
})

const results = []
async function test(label, fn) {
  try {
    await fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error?.message || String(error) })
  }
}

await test('download writes chapter files and completes', async () => {
  const started = await store.startDownload('book-a')
  assert.equal(started.ok, true)
  assert.equal(started.state, 'running')
  const job = store.jobs.get('book-a')
  await job.promise
  const status = await store.status('book-a')
  assert.equal(status.state, 'done')
  assert.equal(status.complete, true)
  assert.equal(status.total, 3)
  assert.equal(status.cached, 2, 'wordCount=0 chapter should be skipped')
  assert.ok(status.bytes > 0)
  assert.ok(existsSync(join(rootDir, 'book-a', 'meta.json')))
  assert.ok(existsSync(join(rootDir, 'book-a', 'c1.json')))
  const record = JSON.parse(await readFile(join(rootDir, 'book-a', 'c1.json'), 'utf8'))
  assert.ok(record.text.length > 100)
})

await test('cached chapter is served locally with paging', async () => {
  const page = await store.readContent('book-a', 1, 0, 100)
  assert.ok(page, 'expected cache hit')
  assert.equal(page.source, 'cache')
  assert.equal(page.chapterTitle, '第 1 章')
  assert.ok(page.lines.length > 0)
  assert.ok(page.pos > 0)
  const next = await store.readContent('book-a', 1, page.pos, 100)
  assert.ok(next.pos > page.pos || next.hasMore === false)
})

await test('default chapter resolves without chapterUid', async () => {
  const page = await store.readContent('book-a', undefined, 0, 60)
  assert.ok(page)
  assert.equal(page.source, 'cache')
})

await test('cache is bound to the downloading account', async () => {
  account = 'vid-2'
  const page = await store.readContent('book-a', 1, 0, 100)
  assert.equal(page, null)
  const status = await store.status('book-a')
  assert.equal(status.accountBound, false)
  account = 'vid-1'
})

await test('resume skips already cached chapters', async () => {
  const started = await store.startDownload('book-a')
  assert.equal(started.cached, 2)
  await store.jobs.get('book-a').promise
})

await test('list reports cached books', async () => {
  const list = await store.list()
  assert.equal(list.ok, true)
  assert.equal(list.books.length, 1)
  assert.equal(list.books[0].bookId, 'book-a')
  assert.equal(list.books[0].title, '测试书')
  assert.ok(list.books[0].bytes > 0)
})

await test('cancel keeps partial cache and marks not complete', async () => {
  delayMs = 120
  const started = await store.startDownload('book-c')
  assert.equal(started.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 200))
  const cancel = store.cancel('book-c')
  assert.equal(cancel.ok, true)
  await store.jobs.get('book-c').promise
  const status = await store.status('book-c')
  assert.equal(status.state, 'cancelled')
  assert.equal(status.complete, false)
  delayMs = 5
})

await test('delete removes the cache directory', async () => {
  await store.remove('book-a')
  assert.equal(existsSync(join(rootDir, 'book-a')), false)
  assert.equal(await store.readContent('book-a', 1, 0, 100), null)
  const list = await store.list()
  assert.equal(list.books.some((book) => book.bookId === 'book-a'), false)
})

let failed = 0
for (const result of results) {
  if (result.ok) console.log(`PASS  ${result.label}`)
  else {
    failed += 1
    console.log(`FAIL  ${result.label}: ${result.error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
