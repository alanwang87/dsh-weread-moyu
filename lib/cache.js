/**
 * dsh-weread-moyu — 整本缓存 / 离线阅读存储层（宿主半）
 *
 * 把微信读书的章节正文落到
 *   $DSH_HOME/weread-moyu/cache/<bookId>/meta.json
 *   $DSH_HOME/weread-moyu/cache/<bookId>/c<chapterUid>.json
 * 之后 /content 命中缓存时不再访问上游。
 *
 * 设计约束：
 *   - 只由宿主半调用；不持有 cookie（cookie 由 index.js 通过回调传入）。
 *   - 原子写（临时文件 + rename），meta 每 10 章或结束时保存。
 *   - 缓存绑定下载时的账号 vid；当前账号不同则视为未命中，避免串号读到别人的书。
 *   - 后台任务在内存 job map 里；进程重启后未完成任务按 idle 处理，已下载章节保留。
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

export const LIMITS = {
  maxBookChars: 20_000_000,
  maxCacheBytes: 500 * 1024 * 1024,
  chapterDelayMs: 160,
  maxConsecutiveNetworkErrors: 3,
  saveMetaEvery: 10,
}

const SKIP_TITLES = /^(版权信息|版权页|封面|扉页|目录|书名页|出版信息|插页)$/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @returns {Buffer} */
function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

/**
 * @param {{
 *   rootDir: string,
 *   getWeread: () => any,
 *   getCookie: () => string,
 *   getAccountVid: () => string | null,
 *   log: (level: string, message: string) => void,
 * }} options
 */
export function createCacheStore(options) {
  const { rootDir, getWeread, getCookie, getAccountVid, log } = options
  /** @type {Map<string, any>} */
  const jobs = new Map()

  const bookDir = (bookId) => join(rootDir, String(bookId))
  const metaPath = (bookId) => join(bookDir(bookId), 'meta.json')
  const chapterPath = (bookId, chapterUid) => join(bookDir(bookId), `c${String(chapterUid)}.json`)

  async function readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      log('warn', `cache: cannot read ${file}: ${error.message}`)
      return null
    }
  }

  async function writeJsonAtomic(file, value) {
    const dir = dirname(file)
    await fs.mkdir(dir, { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temp, JSON.stringify(value))
    await fs.rename(temp, file)
  }

  async function loadMeta(bookId) {
    return readJson(metaPath(bookId))
  }

  async function saveMeta(meta) {
    meta.updatedAt = Date.now()
    await writeJsonAtomic(metaPath(meta.bookId), meta)
  }

  function accountBound(meta) {
    const vid = getAccountVid()
    return Boolean(vid) && String(meta.accountVid) === String(vid)
  }

  async function dirBytes(bookId) {
    const dir = bookDir(bookId)
    let total = 0
    let entries = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      return 0
    }
    for (const name of entries) {
      try {
        const stat = await fs.stat(join(dir, name))
        if (stat.isFile()) total += stat.size
      } catch {
        /* ignore */
      }
    }
    return total
  }

  async function totalCacheBytes() {
    let names = []
    try {
      names = await fs.readdir(rootDir)
    } catch {
      return 0
    }
    let total = 0
    for (const name of names) total += await dirBytes(name)
    return total
  }

  async function removeBook(bookId) {
    const job = jobs.get(bookId)
    if (job && job.state === 'running') {
      job.abort = true
      try {
        await job.promise
      } catch {
        /* ignore */
      }
    }
    jobs.delete(bookId)
    await fs.rm(bookDir(bookId), { recursive: true, force: true })
  }

  function publicStatus(bookId, meta) {
    const job = jobs.get(bookId)
    const cachedCount = meta ? meta.chapters.filter((chapter) => chapter.cached).length : 0
    return {
      ok: true,
      bookId,
      state: job ? job.state : meta && meta.complete ? 'done' : 'idle',
      total: job ? job.total : meta ? meta.chapters.length : 0,
      cached: job ? job.cached.size : cachedCount,
      chars: job ? job.chars : meta ? meta.totalChars || 0 : 0,
      bytes: job ? job.bytes : meta ? meta.totalBytes || 0 : 0,
      complete: Boolean(meta && meta.complete),
      currentChapter: job ? job.currentChapter : null,
      startedAt: job ? job.startedAt : 0,
      finishedAt: job ? job.finishedAt : meta ? meta.updatedAt || 0 : 0,
      error: job ? job.error : null,
      accountBound: meta ? accountBound(meta) : false,
      meta: meta
        ? {
            title: meta.title || '',
            author: meta.author || '',
            chars: meta.totalChars || 0,
            bytes: meta.totalBytes || 0,
            updatedAt: meta.updatedAt || 0,
            complete: Boolean(meta.complete),
          }
        : null,
    }
  }

  async function status(bookId) {
    return publicStatus(bookId, await loadMeta(bookId))
  }

  async function list() {
    let names = []
    try {
      names = await fs.readdir(rootDir, { withFileTypes: true })
    } catch {
      return { ok: true, books: [] }
    }
    const books = []
    for (const entry of names) {
      if (!entry.isDirectory()) continue
      const meta = await loadMeta(entry.name)
      if (!meta) continue
      books.push({
        bookId: meta.bookId,
        title: meta.title || '',
        author: meta.author || '',
        chapters: meta.chapters.filter((chapter) => chapter.cached).length,
        total: meta.chapters.length,
        chars: meta.totalChars || 0,
        bytes: meta.totalBytes || 0,
        complete: Boolean(meta.complete),
        updatedAt: meta.updatedAt || 0,
        accountBound: accountBound(meta),
      })
    }
    books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return { ok: true, books }
  }

  function cancel(bookId) {
    const job = jobs.get(bookId)
    if (!job || job.state !== 'running') return { ok: true, state: job ? job.state : 'idle' }
    job.abort = true
    return { ok: true, state: 'cancelling' }
  }

  async function runDownload(job, meta, weread, cookie) {
    let consecutiveErrors = 0
    try {
      for (const chapter of meta.chapters) {
        if (job.abort) {
          job.state = 'cancelled'
          break
        }
        if (!chapter.wordCount) continue
        if (job.cached.has(chapter.chapterUid)) continue
        if (job.chars + chapter.wordCount > LIMITS.maxBookChars || job.bytes > LIMITS.maxCacheBytes) {
          job.state = 'error'
          job.error = '缓存超出上限（单本 2000 万字 / 总目录 500MB）'
          break
        }
        job.currentChapter = {
          chapterUid: chapter.chapterUid,
          chapterIdx: chapter.chapterIdx,
          title: chapter.title,
        }
        const result = await weread.getChapterText(cookie, meta.bookId, chapter.chapterUid)
        if (!result || result.ok === false) {
          const code = result && result.code
          if (code === 'SESSION_EXPIRED' || code === 'NOT_LOGGED_IN') {
            job.state = 'error'
            job.error = '登录态已失效，已缓存部分保留'
            break
          }
          if (code === 'CHAPTER_LOCKED' || code === 'CONTENT_UNAVAILABLE') {
            chapter.locked = true
            continue
          }
          consecutiveErrors += 1
          if (consecutiveErrors >= LIMITS.maxConsecutiveNetworkErrors) {
            job.state = 'error'
            job.error = (result && (result.error || result.code)) || '连续网络错误，已停止'
            break
          }
          await sleep(500)
          continue
        }
        consecutiveErrors = 0
        const text = String(result.text || '')
        const record = {
          chapterUid: chapter.chapterUid,
          chapterIdx: chapter.chapterIdx,
          title: chapter.title,
          text,
          preview: Boolean(result.preview),
          anonymous: Boolean(result.anonymous),
          chars: text.length,
          fetchedAt: Date.now(),
        }
        await writeJsonAtomic(chapterPath(meta.bookId, chapter.chapterUid), record)
        chapter.cached = true
        chapter.preview = record.preview
        chapter.chars = text.length
        job.cached.add(chapter.chapterUid)
        job.chars += text.length
        job.bytes += byteLength(record)
        if (job.cached.size % LIMITS.saveMetaEvery === 0) {
          meta.totalChars = job.chars
          meta.totalBytes = job.bytes
          await saveMeta(meta)
        }
        await sleep(LIMITS.chapterDelayMs)
      }
      if (job.state === 'running') job.state = 'done'
    } catch (error) {
      job.state = 'error'
      job.error = `缓存任务异常：${error && error.message ? error.message : String(error)}`
      log('warn', `cache: download ${meta.bookId} failed: ${job.error}`)
    } finally {
      meta.totalChars = job.chars
      meta.totalBytes = job.bytes
      meta.complete = job.state === 'done'
      try {
        await saveMeta(meta)
      } catch (error) {
        log('warn', `cache: cannot save meta for ${meta.bookId}: ${error.message}`)
      }
      job.finishedAt = Date.now()
      job.currentChapter = null
    }
  }

  async function startDownload(bookId, { force = false } = {}) {
    const weread = getWeread()
    if (!weread || typeof weread.getChapters !== 'function') {
      return { ok: false, code: 'NOT_READY', error: '微信读书协议模块尚未就绪' }
    }
    const cookie = getCookie()
    if (!cookie) return { ok: false, code: 'NOT_LOGGED_IN', error: '请先登录微信读书' }
    const existing = jobs.get(bookId)
    if (existing && existing.state === 'running') {
      return { ok: true, state: 'running', total: existing.total, cached: existing.cached.size }
    }
    const vid = getAccountVid()
    if (!vid) return { ok: false, code: 'NOT_LOGGED_IN', error: '缺少账号信息，请重新登录' }

    const chaptersRes = await weread.getChapters(cookie, bookId)
    if (!chaptersRes || chaptersRes.ok === false) {
      return { ok: false, code: (chaptersRes && chaptersRes.code) || 'CHAPTERS_FAILED', error: (chaptersRes && chaptersRes.error) || '无法获取目录' }
    }
    if (force) await removeBook(bookId)

    let meta = await loadMeta(bookId)
    if (!meta || String(meta.accountVid) !== String(vid)) {
      meta = {
        version: 1,
        bookId: String(bookId),
        title: (chaptersRes.book && chaptersRes.book.title) || '',
        author: (chaptersRes.book && chaptersRes.book.author) || '',
        accountVid: String(vid),
        chapters: [],
        totalChars: 0,
        totalBytes: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        complete: false,
      }
    }
    const known = new Map((meta.chapters || []).map((chapter) => [String(chapter.chapterUid), chapter]))
    meta.chapters = (chaptersRes.chapters || []).map((chapter) => {
      const previous = known.get(String(chapter.chapterUid))
      return {
        chapterUid: chapter.chapterUid,
        chapterIdx: chapter.chapterIdx,
        title: chapter.title,
        wordCount: chapter.wordCount || 0,
        level: chapter.level,
        cached: Boolean(previous && previous.cached),
        preview: Boolean(previous && previous.preview),
        chars: (previous && previous.chars) || 0,
        locked: Boolean(previous && previous.locked),
      }
    })
    meta.title = (chaptersRes.book && chaptersRes.book.title) || meta.title
    meta.author = (chaptersRes.book && chaptersRes.book.author) || meta.author
    meta.complete = false
    await saveMeta(meta)

    const cachedSet = new Set(meta.chapters.filter((chapter) => chapter.cached).map((chapter) => chapter.chapterUid))
    const job = {
      bookId: String(bookId),
      state: 'running',
      total: meta.chapters.length,
      cached: cachedSet,
      chars: Number(meta.totalChars) || 0,
      bytes: Number(meta.totalBytes) || 0,
      currentChapter: null,
      startedAt: Date.now(),
      finishedAt: 0,
      error: null,
      abort: false,
      promise: null,
    }
    jobs.set(String(bookId), job)
    log('info', `cache: download started for ${meta.title || bookId} (${meta.chapters.length} chapters, ${cachedSet.size} already cached)`)
    job.promise = runDownload(job, meta, weread, cookie)
    return { ok: true, state: 'running', total: job.total, cached: cachedSet.size }
  }

  /**
   * Read one page from the local cache. Returns null when the cache cannot serve
   * this request (no meta, different account, chapter not cached, module missing).
   */
  async function readContent(bookId, chapterUid, pos, maxChars, opts = {}) {
    const meta = await loadMeta(bookId)
    if (!meta) return null
    // 缓存绑定下载时的账号：当前登录的是其他账号时拒绝；未登录（离线阅读）允许
    if (accountBound(meta) === false && opts.allowUnbound !== true) return null
    const weread = getWeread()
    if (!weread || typeof weread.sliceContentPage !== 'function') return null

    let index = -1
    if (chapterUid !== undefined && chapterUid !== null && chapterUid !== '') {
      index = meta.chapters.findIndex((chapter) => String(chapter.chapterUid) === String(chapterUid))
    } else {
      index = meta.chapters.findIndex(
        (chapter) => chapter.cached && chapter.wordCount > 0 && !SKIP_TITLES.test(String(chapter.title || '').trim()),
      )
      if (index < 0) index = meta.chapters.findIndex((chapter) => chapter.cached)
    }
    if (index < 0) return null
    const chapter = meta.chapters[index]
    const cached = await readJson(chapterPath(bookId, chapter.chapterUid))
    if (!cached || typeof cached.text !== 'string') return null

    const page = weread.sliceContentPage({ text: cached.text, pos, maxChars })
    const nextChapter = index + 1 < meta.chapters.length ? meta.chapters[index + 1] : null
    const frac = page.totalChars > 0 ? page.pos / page.totalChars : 1
    const progress = Math.max(
      0,
      Math.min(100, Math.round(((index + frac) / meta.chapters.length) * 100)),
    )
    return {
      ok: true,
      source: 'cache',
      cached: true,
      bookTitle: meta.title || '',
      bookAuthor: meta.author || '',
      chapterTitle: chapter.title || '',
      chapterUid: chapter.chapterUid,
      chapterIndex: index,
      chapterCount: meta.chapters.length,
      lines: page.lines,
      pos: page.pos,
      hasMore: page.hasMore,
      nextChapterUid: nextChapter ? nextChapter.chapterUid : null,
      totalChars: page.totalChars,
      progress,
      preview: Boolean(cached.preview),
      anonymous: false,
    }
  }

  /** 离线章节目录（免登录）：meta 存在且账号允许即可用 */
  async function readChapters(bookId, opts = {}) {
    const meta = await loadMeta(bookId)
    if (!meta) return null
    if (accountBound(meta) === false && opts.allowUnbound !== true) return null
    return {
      ok: true,
      bookId: meta.bookId,
      book: { title: meta.title || '', author: meta.author || '' },
      chapters: meta.chapters.map((chapter) => ({
        chapterUid: chapter.chapterUid,
        chapterIdx: chapter.chapterIdx,
        title: chapter.title,
        level: chapter.level,
        wordCount: chapter.wordCount,
        cached: Boolean(chapter.cached),
        preview: Boolean(chapter.preview),
      })),
      offline: true,
    }
  }

  async function usage(bookId) {
    const total = await totalCacheBytes()
    return { totalBytes: total, limitBytes: LIMITS.maxCacheBytes, bookBytes: bookId ? await dirBytes(bookId) : 0 }
  }

  return {
    startDownload,
    status,
    list,
    cancel,
    remove: removeBook,
    readContent,
    readChapters,
    usage,
    limits: LIMITS,
    /** @internal test seam */
    jobs,
  }
}
