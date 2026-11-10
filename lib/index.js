/**
 * dsh-weread-moyu — 宿主半（Host half）
 *
 * 职责：
 *   1. 在 DSH Web 服务器上注册 /weread-moyu/api/* 路由（仅 loopback）。
 *   2. 管理微信读书登录态（扫码 / Cookie 导入）并持久化到 $DSH_HOME/weread-moyu/。
 *   3. 把书架、章节、正文读取封装成前端可直接调用的 JSON API。
 *
 * 设计约束：
 *   - 零外部依赖，只用 node: 内建模块。
 *   - 与微信读书的协议细节全部放在 ./weread.js（动态导入，缺失时 API 返回
 *     NOT_READY，而不是让整个插件加载失败）。
 *   - 不在日志里输出 Cookie 或正文。
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createCacheStore } from './cache.js'

export const name = 'weread-moyu'
export const inject = ['webServer']

const VERSION = '0.1.8'
const API_PREFIX = '/weread-moyu/api'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'weread-moyu')
const SESSION_FILE = join(STATE_DIR, 'session.json')
const CACHE_DIR = join(STATE_DIR, 'cache')
const SHELF_TTL_MS = 5 * 60 * 1000
const QR_TTL_MS = 3 * 60 * 1000
const NET_TIMEOUT_MS = 30 * 1000
const BODY_LIMIT = 128 * 1024

// ── 小工具 ────────────────────────────────────────────────────────────────

function log(ctx, level, message, extra) {
  try {
    const logger = ctx.logger?.('weread-moyu')
    if (logger && typeof logger[level] === 'function') {
      if (extra === undefined) logger[level](message)
      else logger[level](message, extra)
    }
  } catch {
    /* logging must never break a request */
  }
}

function send(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function fail(res, status, code, error, extra) {
  send(res, status, { ok: false, code, error: String(error ?? code), ...(extra || {}) })
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address === '::ffff:7f00:1'
  )
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function withTimeout(promise, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} timed out`)), NET_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function writeSessionAtomic(payload) {
  await fs.mkdir(STATE_DIR, { recursive: true })
  const temp = `${SESSION_FILE}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
  await fs.rename(temp, SESSION_FILE)
}

// ── 插件主体 ──────────────────────────────────────────────────────────────

export function apply(ctx) {
  /** @type {{cookie: string, user: any, savedAt: number}} */
  const session = { cookie: '', user: null, savedAt: 0 }
  const shelf = { at: 0, books: [] }
  /** @type {Map<string, {jar: any, createdAt: number, qrDataUrl?: string, expiresAt?: number}>} */
  const qrSessions = new Map()

  let weread = null
  let wereadError = null
  let loading = null

  /** Whole-book cache / offline reading store (see ./cache.js). */
  const cacheStore = createCacheStore({
    rootDir: CACHE_DIR,
    getWeread: () => weread,
    getCookie: () => session.cookie,
    getAccountVid: () => {
      const vid = session.user && session.user.vid
      return vid === undefined || vid === null || vid === '' ? null : String(vid)
    },
    log: (level, message) => log(ctx, level, message),
  })

  async function loadWeread() {
    if (weread) return weread
    if (loading) return loading
    loading = (async () => {
      try {
        const mod = await import('./weread.js')
        if (!mod || typeof mod.createQrSession !== 'function') {
          throw new Error('weread.js loaded but does not export createQrSession')
        }
        weread = mod
        wereadError = null
        return mod
      } catch (error) {
        wereadError = error
        weread = null
        throw error
      } finally {
        loading = null
      }
    })()
    return loading
  }

  /** The weread module may rotate wr_skey during a request; keep the freshest cookie. */
  async function adoptCookie(nextCookie) {
    if (typeof nextCookie !== 'string' || nextCookie.length === 0) return
    if (nextCookie === session.cookie) return
    session.cookie = nextCookie
    session.savedAt = Date.now()
    await persistSession()
  }

  function clearWereadCaches() {
    try {
      if (weread && typeof weread.clearCaches === 'function') weread.clearCaches()
    } catch (error) {
      log(ctx, 'warn', `clearCaches failed: ${error?.message || error}`)
    }
  }

  async function loadSessionFromDisk() {
    try {
      const raw = await fs.readFile(SESSION_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.cookie === 'string' && parsed.cookie.length > 0) {
        session.cookie = parsed.cookie
        session.user = parsed.user ?? null
        session.savedAt = Number(parsed.savedAt) || 0
        log(ctx, 'info', 'loaded persisted weread session')
      }
    } catch (error) {
      if (error.code !== 'ENOENT') log(ctx, 'warn', `cannot read session file: ${error.message}`)
    }
  }

  const ready = loadSessionFromDisk()

  async function persistSession() {
    try {
      await writeSessionAtomic({
        cookie: session.cookie,
        user: session.user,
        savedAt: session.savedAt || Date.now(),
      })
    } catch (error) {
      log(ctx, 'warn', `cannot persist session: ${error.message}`)
    }
  }

  function requireLogin(res) {
    if (session.cookie) return true
    fail(res, 200, 'NOT_LOGGED_IN', '请先登录微信读书（扫码或粘贴 Cookie）')
    return false
  }

  /** Make sure the persisted session carries the account vid used to bind the book cache. */
  async function ensureUserInfo() {
    if (session.user && session.user.vid !== undefined && session.user.vid !== null) return session.user
    if (!session.cookie) return null
    try {
      const mod = await loadWeread()
      const result = await withTimeout(Promise.resolve(mod.validateCookie(session.cookie)), 'validateCookie')
      if (result && result.ok && result.user) {
        session.user = result.user
        if (result.cookie) session.cookie = result.cookie
        await persistSession()
      }
    } catch (error) {
      log(ctx, 'warn', `cannot refresh user info: ${error?.message || error}`)
    }
    return session.user
  }

  async function ensureShelf(force) {
    if (!session.cookie) return { books: [], stale: true }
    if (!force && shelf.at > 0 && Date.now() - shelf.at < SHELF_TTL_MS) return { books: shelf.books }
    const mod = await loadWeread()
    const result = await withTimeout(Promise.resolve(mod.getShelf(session.cookie, { force })), 'getShelf')
    if (result && result.ok === false) {
      if (result.code === 'SESSION_EXPIRED' || result.sessionExpired) {
        log(ctx, 'warn', 'weread session expired')
        return { books: [], stale: true, expired: true }
      }
      throw new Error(result.error || result.code)
    }
    const books = Array.isArray(result?.books) ? result.books : []
    shelf.books = books
    if (result?.user) session.user = result.user
    if (result?.cookie) await adoptCookie(result.cookie)
    shelf.at = Date.now()
    return { books, stale: false }
  }

  async function handleStatus(reqUrl, res) {
    await ready
    const refresh = reqUrl.searchParams.get('refresh') === '1'
    let books = []
    let expired = false
    let shelfError = null
    if (session.cookie) {
      try {
        const result = await ensureShelf(refresh)
        books = result.books ?? []
        expired = Boolean(result.expired)
      } catch (error) {
        shelfError = error.message
        log(ctx, 'warn', `shelf unavailable: ${error.message}`)
      }
    }
    send(res, 200, {
      ok: true,
      version: VERSION,
      loggedIn: Boolean(session.cookie) && !expired,
      sessionExpired: expired,
      shelfError,
      user: expired ? null : session.user,
      books,
      currentBookId: session.user?.currentBookId ?? null,
      hostReady: true,
      wereadReady: Boolean(weread),
      hostError: wereadError ? wereadError.message : null,
    })
  }

  async function handleQrCreate(reqUrl, res) {
    const mod = await loadWeread()
    const result = await withTimeout(Promise.resolve(mod.createQrSession()), 'createQrSession')
    if (!result || result.ok === false || !result.qrDataUrl) {
      fail(res, 502, result?.code || 'QR_FAILED', result?.error || '无法创建微信读书登录二维码（upstream 无响应或协议已变化）')
      return
    }
    const uid = String(result.uid || '')
    if (!uid) {
      fail(res, 502, 'QR_FAILED', '二维码响应缺少 uid')
      return
    }
    qrSessions.set(uid, {
      jar: result.jar ?? null,
      createdAt: Date.now(),
      qrDataUrl: result.qrDataUrl,
      expiresAt: result.expiresAt ?? Date.now() + QR_TTL_MS,
    })
    for (const [key, value] of qrSessions) {
      if (Date.now() - value.createdAt > QR_TTL_MS) qrSessions.delete(key)
    }
    send(res, 200, {
      ok: true,
      uid,
      qrDataUrl: result.qrDataUrl,
      expiresAt: result.expiresAt ?? Date.now() + QR_TTL_MS,
    })
  }

  async function handleQrPoll(reqUrl, res) {
    const mod = await loadWeread()
    const uid = String(reqUrl.searchParams.get('uid') || '')
    const entry = qrSessions.get(uid)
    if (!uid || !entry) {
      fail(res, 200, 'QR_EXPIRED', '二维码会话不存在或已过期，请刷新二维码')
      return
    }
    if (Date.now() - entry.createdAt > QR_TTL_MS) {
      qrSessions.delete(uid)
      send(res, 200, { ok: true, state: 'expired' })
      return
    }
    const result = await withTimeout(Promise.resolve(mod.pollQrSession(uid, entry.jar)), 'pollQrSession')
    if (!result || result.ok === false) {
      send(res, 200, {
        ok: false,
        state: result?.state || 'error',
        code: result?.code || 'QR_POLL_FAILED',
        error: result?.error || '轮询登录状态失败',
      })
      return
    }
    if (result.state === 'confirmed') {
      const cookie = String(result.cookie || '')
      if (cookie) {
        session.cookie = cookie
        session.user = result.user ?? (result.nickname ? { nickname: result.nickname } : null)
        session.savedAt = Date.now()
        shelf.at = 0
        clearWereadCaches()
        await persistSession()
        log(ctx, 'info', 'weread QR login confirmed')
      } else {
        log(ctx, 'warn', 'weread QR poll confirmed without cookie payload')
      }
      qrSessions.delete(uid)
      send(res, 200, { ok: true, state: 'confirmed', user: session.user })
      return
    }
    if (result.state === 'expired' || result.state === 'error') qrSessions.delete(uid)
    send(res, 200, { ok: true, state: result.state, user: result.user ?? null })
  }

  async function handleCookieLogin(req, res) {
    const body = await readBody(req)
    const raw = typeof body.cookie === 'string' ? body.cookie.trim() : ''
    if (!raw) {
      fail(res, 400, 'BAD_REQUEST', '缺少 cookie 字段')
      return
    }
    const cookie = raw.replace(/^cookie\s*:\s*/i, '').replace(/\r?\n+/g, '; ')
    const mod = await loadWeread()
    const result = await withTimeout(Promise.resolve(mod.validateCookie(cookie)), 'validateCookie')
    if (!result || result.ok === false) {
      fail(res, 200, result?.code || 'INVALID_COOKIE', result?.error || 'Cookie 无效或已过期')
      return
    }
    session.cookie = result.cookie || cookie
    session.user = result.user ?? null
    session.savedAt = Date.now()
    shelf.at = 0
    clearWereadCaches()
    await persistSession()
    log(ctx, 'info', 'weread cookie login accepted')
    send(res, 200, { ok: true, user: session.user })
  }

  async function handleLogout(req, res) {
    const had = Boolean(session.cookie)
    session.cookie = ''
    session.user = null
    session.savedAt = 0
    shelf.at = 0
    shelf.books = []
    qrSessions.clear()
    try {
      await fs.rm(SESSION_FILE, { force: true })
    } catch {
      /* ignore */
    }
    log(ctx, 'info', 'weread session cleared')
    clearWereadCaches()
    send(res, 200, { ok: true, hadSession: had })
  }

  async function handleChapters(reqUrl, res, bookId) {
    // 离线优先：未登录（或在线拉取失败）时，已缓存书籍直接用本地 meta 目录
    if (!session.cookie) {
      const offline = await cacheStore.readChapters(bookId, { allowUnbound: true })
      if (offline) {
        send(res, 200, { ok: true, bookId, chapters: offline.chapters, cached: true, offline: true })
        return
      }
      fail(res, 200, 'NOT_LOGGED_IN', '未登录，且该书没有离线缓存')
      return
    }
    const mod = await loadWeread()
    const result = await withTimeout(Promise.resolve(mod.getChapters(session.cookie, bookId)), 'getChapters')
    if (!result || result.ok === false) {
      const offline = await cacheStore.readChapters(bookId, { allowUnbound: true })
      if (offline) {
        send(res, 200, { ok: true, bookId, chapters: offline.chapters, cached: true, offline: true })
        return
      }
      fail(res, 200, result?.code || 'CHAPTERS_FAILED', result?.error || '无法获取章节列表')
      return
    }
    send(res, 200, { ok: true, bookId, chapters: result.chapters ?? result })
    if (result.cookie) await adoptCookie(result.cookie)
  }

  async function handleContent(reqUrl, res) {
    const bookId = reqUrl.searchParams.get('bookId') || ''
    const chapterUid = reqUrl.searchParams.get('chapterUid') || ''
    const pos = Number(reqUrl.searchParams.get('pos') || '0')
    const maxChars = Number(reqUrl.searchParams.get('maxChars') || '0')
    if (!bookId) {
      fail(res, 400, 'BAD_REQUEST', '缺少 bookId')
      return
    }

    // Whole-book cache first: a downloaded book is served from disk — offline, no login needed.
    try {
      const cachedPage = await cacheStore.readContent(
        bookId,
        chapterUid || undefined,
        Number.isFinite(pos) && pos > 0 ? pos : 0,
        Number.isFinite(maxChars) && maxChars > 0 ? maxChars : undefined,
        { allowUnbound: !session.cookie },
      )
      if (cachedPage) {
        send(res, 200, {
          ok: true,
          bookId,
          ...cachedPage,
          title: cachedPage.bookTitle,
          chapter: cachedPage.chapterTitle,
        })
        return
      }
    } catch (error) {
      log(ctx, 'warn', `cache read failed: ${error?.message || error}`)
    }

    if (!requireLogin(res)) return
    const mod = await loadWeread()
    const result = await withTimeout(
      Promise.resolve(
        mod.getContent(session.cookie, {
          bookId,
          chapterUid: chapterUid || undefined,
          pos: Number.isFinite(pos) && pos > 0 ? pos : 0,
          maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : undefined,
        }),
      ),
      'getContent',
    )
    if (!result || result.ok === false) {
      fail(res, 200, result?.code || 'CONTENT_FAILED', result?.error || '无法获取正文')
      return
    }
    send(res, 200, {
      ok: true,
      bookId,
      source: 'online',
      ...result,
      // Compatibility aliases: the protocol layer names these bookTitle/chapterTitle,
      // while the client (and older builds) read title/chapter for the header.
      title: result.bookTitle || result.title,
      chapter: result.chapterTitle || result.chapter,
    })
    if (result.cookie) await adoptCookie(result.cookie)
  }

  // ── 整本缓存 / 离线阅读 ──────────────────────────────────────────────────

  async function handleCacheDownload(req, res) {
    if (!requireLogin(res)) return
    const body = await readBody(req)
    const bookId = String(body.bookId || '').trim()
    if (!bookId) {
      fail(res, 400, 'BAD_REQUEST', '缺少 bookId')
      return
    }
    await ensureUserInfo()
    if (!session.user || session.user.vid === undefined || session.user.vid === null) {
      fail(res, 200, 'NOT_LOGGED_IN', '缺少账号信息，请重新登录后再缓存')
      return
    }
    const result = await cacheStore.startDownload(bookId, { force: body.force === true })
    if (!result.ok) {
      fail(res, 200, result.code || 'CACHE_FAILED', result.error || '无法启动缓存')
      return
    }
    send(res, 200, { ...result, bookId })
  }

  async function handleCacheStatus(reqUrl, res) {
    const bookId = String(reqUrl.searchParams.get('bookId') || reqUrl.searchParams.get('id') || '')
    if (!bookId) {
      fail(res, 400, 'BAD_REQUEST', '缺少 bookId')
      return
    }
    send(res, 200, await cacheStore.status(bookId))
  }

  async function handleCacheCancel(req, res) {
    const body = await readBody(req)
    const bookId = String(body.bookId || '').trim()
    if (!bookId) {
      fail(res, 400, 'BAD_REQUEST', '缺少 bookId')
      return
    }
    send(res, 200, await cacheStore.cancel(bookId))
  }

  async function handleCacheList(reqUrl, res) {
    const list = await cacheStore.list()
    const usage = await cacheStore.usage()
    send(res, 200, { ...list, usage })
  }

  async function handleCacheDelete(req, res) {
    const body = await readBody(req)
    const bookId = String(body.bookId || '').trim()
    if (!bookId) {
      fail(res, 400, 'BAD_REQUEST', '缺少 bookId')
      return
    }
    await cacheStore.remove(bookId)
    send(res, 200, { ok: true, bookId })
  }

  /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
  async function handler(req, res) {
    try {
      if (!isLoopback(req)) {
        fail(res, 403, 'FORBIDDEN', 'weread-moyu API 只接受本机请求')
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith(API_PREFIX)) {
        fail(res, 404, 'NOT_FOUND', 'unknown route')
        return
      }
      const path = url.pathname.slice(API_PREFIX.length) || '/'
      const method = (req.method || 'GET').toUpperCase()

      if (path === '/ping') {
        send(res, 200, {
          ok: true,
          version: VERSION,
          hostReady: true,
          wereadReady: Boolean(weread),
          wereadError: wereadError ? wereadError.message : null,
        })
        return
      }
      if (path === '/status' && method === 'GET') return await handleStatus(url, res)
      if (path === '/qr' && method === 'GET') return await handleQrCreate(url, res)
      if (path === '/qr/poll' && method === 'GET') return await handleQrPoll(url, res)
      if (path === '/login/cookie' && method === 'POST') return await handleCookieLogin(req, res)
      if (path === '/logout' && method === 'POST') return await handleLogout(req, res)
      const chaptersMatch = /^\/books\/([^/]+)\/chapters$/.exec(path)
      if (chaptersMatch && method === 'GET') return await handleChapters(url, res, decodeURIComponent(chaptersMatch[1]))
      if (path === '/content' && method === 'GET') return await handleContent(url, res)
      if (path === '/cache/download' && method === 'POST') return await handleCacheDownload(req, res)
      if (path === '/cache/status' && method === 'GET') return await handleCacheStatus(url, res)
      if (path === '/cache/cancel' && method === 'POST') return await handleCacheCancel(req, res)
      if (path === '/cache/list' && method === 'GET') return await handleCacheList(url, res)
      if (path === '/cache/delete' && method === 'POST') return await handleCacheDelete(req, res)

      fail(res, 404, 'NOT_FOUND', `unknown route: ${method} ${path}`)
    } catch (error) {
      log(ctx, 'warn', `api error: ${error?.message || error}`)
      try {
        const message = error?.message || String(error)
        const notReady = Boolean(wereadError) || /Cannot find module|cannot find package|weread\.js/i.test(message)
        if (notReady) {
          fail(res, 502, 'NOT_READY', `微信读书协议模块尚未就绪：${wereadError?.message || message}`)
        } else {
          fail(res, 500, 'INTERNAL', message)
        }
      } catch {
        /* response already sent */
      }
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
    'weread-moyu: api routes',
  )

  void ready.then(() => loadWeread()).catch((error) => {
    log(ctx, 'warn', `weread module unavailable: ${error?.message || error}`)
  })
}
