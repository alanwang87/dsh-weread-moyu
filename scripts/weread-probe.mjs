#!/usr/bin/env node
/**
 * 微信读书协议探针 / 自检脚本
 * ---------------------------------------------------------------
 * 用途：
 *   - selftest：离线自检（_e 哈希、请求签名、清洗、QR 编码器、cookie 解析）
 *   - shelf / book / chapters / content / walk / bookmarks / search：端到端实测
 *   - qr：创建二维码（不轮询）
 *
 * 运行方式（系统 node 是 v16，用 DSH 自带的 Node 24 / electron-as-node）：
 *   $exe = "D:\Program Files\deepseekHarmess\DeepSeek Harness.exe"
 *   & $exe "D:\Alan\插件\scripts\weread-probe.mjs" selftest
 *   & $exe "D:\Alan\插件\scripts\weread-probe.mjs" all            # 自动读 session.json
 *   & $exe "D:\Alan\插件\scripts\weread-probe.mjs" content --book 695233 --chapter 88 --max 500
 *   & $exe "D:\Alan\插件\scripts\weread-probe.mjs" shelf --cookie "wr_vid=...; wr_skey=...; wr_rt=..."
 *
 * Cookie 来源优先级： --cookie > --session <path> > ~/.dsh/weread-moyu/session.json
 * 所有子命令都支持 --json（原样打印 JSON，便于程序处理）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MODULE_URL = pathToFileURL(join(ROOT, 'plugin', 'lib', 'weread.js')).href;
const DEFAULT_SESSION = join(homedir(), '.dsh', 'weread-moyu', 'session.json');

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const command = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'all').toLowerCase();

function argValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}
const flag = (name) => argv.includes(name);
const JSON_OUT = flag('--json');

const cli = {
  cookie: argValue('--cookie', ''),
  sessionPath: resolve(argValue('--session', DEFAULT_SESSION)),
  book: argValue('--book', ''),
  chapter: argValue('--chapter', ''),
  pos: Number(argValue('--pos', '0')) || 0,
  max: Number(argValue('--max', '600')) || 600,
  pages: Number(argValue('--pages', '3')) || 3,
  keyword: argValue('--keyword', ''),
  out: resolve(argValue('--out', join(ROOT, 'examples', 'weread-qr.png'))),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const preview = (text, n = 200) => {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
};

function loadSession() {
  const path = cli.sessionPath;
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || !data.cookie) return null;
    return { ...data, _path: path };
  } catch {
    return null;
  }
}

function resolveCookie() {
  if (cli.cookie) return { cookie: cli.cookie, source: '--cookie' };
  const session = loadSession();
  if (session) return { cookie: session.cookie, source: session._path, user: session.user };
  return { cookie: '', source: null };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// selftest：离线自检
// ---------------------------------------------------------------------------
async function selftest() {
  const mod = await import(MODULE_URL);
  const results = [];
  const check = (label, actual, expected) => {
    const pass = String(actual) === String(expected);
    results.push({ label, pass, actual, expected: pass ? undefined : expected });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${pass ? '' : ` (got=${actual} want=${expected})`}`);
  };

  console.log('--- 1. _e() 哈希向量');
  check('_e(43208843)', mod.wereadE('43208843'), 'c9c321c07293508bc9c79df');
  check("_e('2')", mod.wereadE('2'), 'c81322c012c81e728d9d180');
  check("_e('119')", mod.wereadE('119'), '07e323f027707e1cd7dc674');
  check('_e(695233) 与真实阅读页 URL 一致', mod.wereadE('695233'), 'ce032b305a9bc1ce0b0dd2a');

  console.log('\n--- 2. 请求签名向量（对照参考实现）');
  const params = {
    b: mod.wereadE('43208843'),
    c: mod.wereadE('2'),
    r: '12345',
    ct: '1700000000',
    ps: 'f2532c207ab02ab5g017f96',
    pc: mod.wereadE('1700000000'),
    sc: 1,
    prevChapter: false,
    st: 0,
  };
  check(
    'formatSortedQuery 顺序/布尔',
    mod.formatSortedQuery(params),
    'b=c9c321c07293508bc9c79df&c=c81322c012c81e728d9d180&ct=1700000000&pc=24932c107a21fe80g010f72&prevChapter=false&ps=f2532c207ab02ab5g017f96&r=12345&sc=1&st=0',
  );
  check('wereadSign(st=0)', mod.signParams(params).s, 'a48396ba');
  check('wereadSign(st=1)', mod.signParams({ ...params, st: 1 }).s, 'a48396bc');

  console.log('\n--- 3. Cookie 工具');
  const parsed = mod.parseCookie('wr_vid=abc; wr_skey=xyz==; wr_rt=a%2Fb');
  check('parseCookie 个数', Object.keys(parsed).length, 3);
  check('parseCookie 带 = 的值', parsed.wr_skey, 'xyz==');
  check('serializeCookie 顺序', mod.serializeCookie(parsed), 'wr_vid=abc; wr_skey=xyz==; wr_rt=a%2Fb');

  console.log('\n--- 4. 正文清洗');
  const lines = mod.htmlToLines(
    '<html><head><style>.x{color:red}</style></head><body><h1>第一章</h1><p>他推开门，&nbsp;看见满天星斗。</p><p>&#x4E2D;&#25991; &amp; entity</p><script>alert(1)</script></body></html>',
  );
  check('htmlToLines 段落数', lines.length, 3);
  check('htmlToLines 第一段', lines[0], '第一章');
  check('htmlToLines 去实体', lines[2], '中文 & entity');

  console.log('\n--- 5. UTF-8 修复');
  const utf8BytesAsLatin1 = Buffer.from('微信读书正文 test', 'utf8').toString('latin1');
  check('repairUtf8', mod.__internal.repairUtf8(utf8BytesAsLatin1), '微信读书正文 test');

  console.log('\n--- 6. 分片 MD5 前缀校验');
  const body = 'AAAAconfusedbodyBBBB';
  const good = mod.__internal.md5hex(body).toUpperCase() + body;
  check('checkedBody 正常', mod.__internal.checkedBody(good), body);
  check('checkedBody 校验失败返回空', mod.__internal.checkedBody('0'.repeat(32) + body), '');

  console.log('\n--- 7. 交换位算法（确定性/边界）');
  const sample = 'x' + 'aB3_-'.repeat(40);
  const positions = mod.__internal.swapPositions(sample);
  check('swapPositions 非空且数量为偶数', positions.length > 0 && positions.length % 2 === 0, true);
  const swapped = mod.__internal.reverseSwaps(sample, positions);
  const swappedBack = mod.__internal.reverseSwaps(swapped, positions);
  check('reverseSwaps 同位置二次交换还原', swappedBack, sample);
  check('reverseSwaps 长度不变', swapped.length, sample.length);

  console.log('\n--- 8. QR 编码器 / PNG');
  const qrText = 'https://weread.qq.com/web/confirm?uid=60d516b6-5e17-433e-846d-9c97f9299e2b';
  const qr = mod.qrEncode(qrText, { ecLevel: 'M' });
  check('QR 版本', qr.version, 5);
  check('QR 尺寸', qr.size, 37);
  check('QR 三个定位图案角落为黑', qr.modules[0][0] && qr.modules[0][36] && qr.modules[36][0], true);
  const dataUrl = mod.qrPngDataUrl(qrText, { scale: 6 });
  check('PNG data URL 前缀', dataUrl.startsWith('data:image/png;base64,'), true);
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  check('PNG 签名', png.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  const pngInfo = (() => {
    let off = 8;
    let width = 0;
    let height = 0;
    const idat = [];
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.slice(off + 4, off + 8).toString('ascii');
      if (type === 'IHDR') {
        width = png.readUInt32BE(off + 8);
        height = png.readUInt32BE(off + 12);
      } else if (type === 'IDAT') idat.push(png.slice(off + 8, off + 8 + len));
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    return { width, height, raw };
  })();
  check('PNG 尺寸(37+8)*6', `${pngInfo.width}x${pngInfo.height}`, '270x270');
  check('PNG 静默区为白', pngInfo.raw[1], 255);
  check('PNG 首行定位图案起点为黑', pngInfo.raw[(4 * 6 + 1) * 271 + 4 * 6 + 1], 0);

  console.log('\n--- 9. sliceContentPage 与 getContent 切页语义一致');

  // 独立的"参考实现"：等价于 getContent 的切页规则（不引用模块内部函数），
  // 用来证明 sliceContentPage（供整本缓存/离线阅读使用）与在线翻页完全一致。
  const refClampInt = (n, min, max) => {
    const v = Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : min;
    return Math.min(max, Math.max(min, v));
  };
  const refNormalize = (value) =>
    String(value)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[\u00a0\u3000\t]/g, ' ').replace(/[ \u00a0]+/g, ' ').trim())
      .filter((line) => line.length > 0);
  const refSlice = ({ text, pos, maxChars }) => {
    const total = text.length;
    if (!total) return { lines: [], pos: 0, hasMore: false, totalChars: 0 };
    const p = Math.max(0, Math.trunc(Number(pos) || 0));
    const mc = refClampInt(maxChars || 1200, 120, 4000);
    const start = Math.min(p, total);
    let end = Math.min(total, start + mc);
    if (end < total) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start) end = nl;
    }
    return { lines: refNormalize(text.slice(start, end)), pos: end, hasMore: end < total, totalChars: total };
  };

  const paraText = Array.from({ length: 20 }, (_, i) => `第${i + 1}段：` + '测试正文'.repeat(((i * 7) % 23) + 2)).join('\n');
  const flatText = 'abc微信读书'.repeat(700);
  const sliceCases = [
    ['首屏（maxChars 默认）', { text: paraText }],
    ['中间页 pos=500', { text: paraText, pos: 500 }],
    ['末页 pos=len-30', { text: paraText, pos: paraText.length - 30 }],
    ['pos 超过长度', { text: paraText, pos: paraText.length + 999 }],
    ['maxChars 低于下限(10)', { text: paraText, maxChars: 10 }],
    ['maxChars 高于上限(999999)', { text: paraText, maxChars: 999999 }],
    ['maxChars=0 走默认 1200', { text: paraText, maxChars: 0 }],
    ['pos 负数', { text: paraText, pos: -500 }],
    ['无换行长文本 pos=1234', { text: flatText, pos: 1234, maxChars: 800 }],
    ['pos 落在段落中间', { text: paraText, pos: 333, maxChars: 300 }],
    ['空文本', { text: '', pos: 10, maxChars: 500 }],
    ['undefined 参数', { text: paraText, pos: undefined, maxChars: undefined }],
  ];
  for (const [label, opts] of sliceCases) {
    const got = mod.sliceContentPage(opts);
    const want = refSlice({ text: '', pos: 0, maxChars: undefined, ...opts });
    const pass = JSON.stringify(got) === JSON.stringify(want);
    results.push({ label: `sliceContentPage ${label}`, pass, actual: got, expected: pass ? undefined : want });
    console.log(`${pass ? 'PASS' : 'FAIL'} sliceContentPage ${label}${pass ? '' : '（与参考实现不一致）'}`);
  }
  check(
    'sliceContentPage 空文本固定结构',
    JSON.stringify(mod.sliceContentPage({ text: '' })),
    JSON.stringify({ lines: [], pos: 0, hasMore: false, totalChars: 0 }),
  );
  check('sliceContentPage 纯函数（同参数两次结果一致）', JSON.stringify(mod.sliceContentPage({ text: paraText, pos: 400, maxChars: 300 })), JSON.stringify(mod.sliceContentPage({ text: paraText, pos: 400, maxChars: 300 })));

  // 连续翻页应不重不漏地读完整章
  {
    let cursor = 0;
    let pageCount = 0;
    const collected = [];
    for (;;) {
      const page = mod.sliceContentPage({ text: paraText, pos: cursor, maxChars: 200 });
      pageCount += 1;
      collected.push(...page.lines);
      if (!page.hasMore || page.pos <= cursor) break;
      cursor = page.pos;
      if (pageCount > 500) break;
    }
    check('sliceContentPage 连续翻页覆盖全文', JSON.stringify(collected) === JSON.stringify(refNormalize(paraText)), true);
    check('sliceContentPage 连续翻页能终止', pageCount > 1 && pageCount < 500, true);
  }

  console.log('\n--- 10. 登录态');
  const session = loadSession();
  if (session) {
    console.log(`FOUND session: ${session._path} (savedAt=${new Date(session.savedAt).toISOString()})`);
    const cookieObj = mod.parseCookie(session.cookie);
    check('session 含 wr_vid/wr_skey', Boolean(cookieObj.wr_vid && cookieObj.wr_skey), true);
  } else {
    console.log(`NO_SESSION 未找到登录态文件：${cli.sessionPath}`);
    console.log('  先运行 scripts/weread-login.mjs 扫码，或用 --cookie 传入');
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== selftest: ${results.length - failed.length}/${results.length} 通过`);
  if (JSON_OUT) printJson({ ok: failed.length === 0, results });
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------
async function cmdQr() {
  const mod = await import(MODULE_URL);
  const qr = await mod.createQrSession();
  if (!qr.ok) {
    console.log('QR_FAILED', qr.code, qr.error);
    return 1;
  }
  const png = Buffer.from(qr.qrDataUrl.split(',')[1], 'base64');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dirname(cli.out), { recursive: true });
  writeFileSync(cli.out, png);
  const out = { ok: true, uid: qr.uid, qrText: qr.qrText, expiresAt: qr.expiresAt, pngPath: cli.out, pngBytes: png.length };
  if (JSON_OUT) printJson(out);
  else {
    console.log(`QR_PNG ${cli.out} (${png.length} bytes)`);
    console.log(`QR_UID ${qr.uid}`);
    console.log(`QR_CONTENT ${qr.qrText}`);
    console.log(`QR_EXPIRES ${new Date(qr.expiresAt).toISOString()}`);
    console.log('（用微信扫码；随后用 weread-login.mjs 完成登录并落 cookie）');
  }
  return 0;
}

async function cmdShelf() {
  const mod = await import(MODULE_URL);
  const { cookie, source } = resolveCookie();
  if (!cookie) {
    console.log('NO_COOKIE 需要 --cookie 或先跑脚本 weread-login.mjs');
    return 2;
  }
  console.log(`cookie 来源: ${source}`);
  const check = await mod.validateCookie(cookie);
  console.log(`validateCookie: ok=${check.ok} code=${check.code || '-'} user=${JSON.stringify(check.user || null)}`);
  const shelf = await mod.getShelf(cookie, { force: true });
  if (JSON_OUT) return printJson(shelf), shelf.ok ? 0 : 1;
  if (!shelf.ok) {
    console.log('SHELF_FAILED', shelf.code, shelf.error);
    return 1;
  }
  console.log(`user: ${JSON.stringify(shelf.user)}`);
  console.log(`books: ${shelf.books.length}  albums: ${shelf.albums.length}`);
  for (const b of shelf.books.slice(0, 12)) {
    console.log(`  ${b.bookId}\t${b.title}\t${b.author}\tprogress=${b.progress ?? '-'}`);
  }
  if (shelf.books.length > 12) console.log(`  ... 其余 ${shelf.books.length - 12} 本省略`);
  return 0;
}

async function pickBookId(mod, cookie) {
  if (cli.book) return cli.book;
  const shelf = await mod.getShelf(cookie, { force: true });
  if (shelf.ok && shelf.books.length) {
    const withProgress = shelf.books.find((b) => typeof b.progress === 'number' && b.progress > 0) || shelf.books[0];
    console.log(`[未指定 --book，使用书架第一本：${withProgress.bookId} ${withProgress.title}]`);
    return withProgress.bookId;
  }
  // 未登录兜底：用匿名可访问的公开书（三体全集）验证 SSR 目录
  console.log('[未指定 --book 且书架不可用，使用公开书 695233（三体全集）验证 SSR 目录]');
  return '695233';
}

async function cmdChapters() {
  const mod = await import(MODULE_URL);
  const { cookie, source } = resolveCookie();
  const bookId = await pickBookId(mod, cookie);
  console.log(`bookId=${bookId} cookie来源=${source || '无（匿名 SSR）'}`);
  const res = await mod.getChapters(cookie, bookId);
  if (JSON_OUT) return printJson(res), res.ok ? 0 : 1;
  if (!res.ok) {
    console.log('CHAPTERS_FAILED', res.code, res.error);
    return 1;
  }
  console.log(`source=${res.source} book=${res.book && res.book.title} chapters=${res.chapters.length} psvts=${res.psvts || '-'}`);
  for (const c of res.chapters.slice(0, 15)) {
    console.log(`  ${c.chapterUid}\t idx=${c.chapterIdx}\tL${c.level}\t${c.wordCount}字\t${c.title}`);
  }
  if (res.chapters.length > 15) console.log(`  ... 其余 ${res.chapters.length - 15} 章省略`);
  return 0;
}

async function cmdContent() {
  const mod = await import(MODULE_URL);
  const { cookie, source } = resolveCookie();
  const allowAnonymous = !cookie;
  if (!cookie) console.log('NO_LOGIN 以匿名方式读取免费/试读章节（用 --cookie 或先跑 weread-login.mjs 可读全部已购章节）');
  const bookId = await pickBookId(mod, cookie);
  const opts = { bookId, pos: cli.pos, maxChars: cli.max, allowAnonymous };
  if (cli.chapter) opts.chapterUid = Number(cli.chapter);
  console.log(`bookId=${bookId} chapter=${cli.chapter || '(自动)'} pos=${cli.pos} maxChars=${cli.max} cookie来源=${source || '匿名'}`);
  const res = await mod.getContent(cookie, opts);
  if (JSON_OUT) return printJson(res), res.ok ? 0 : 1;
  if (!res.ok) {
    console.log('CONTENT_FAILED', res.code, res.error);
    return 1;
  }
  console.log(
    `book=${res.bookTitle} chapter=${res.chapterTitle} uid=${res.chapterUid} idx=${res.chapterIndex + 1}/${res.chapterCount} progress=${res.progress}% hasMore=${res.hasMore} next=${res.nextChapterUid} totalChars=${res.totalChars} preview=${res.preview || false} anonymous=${res.anonymous || false} degraded=${res.degraded || false}`,
  );
  console.log(`pos=${res.pos} 首段预览: ${preview(res.lines.join(''), 200)}`);
  console.log(`lines=${res.lines.length}`);
  if (res.lines.length) {
    console.log(`  第一行: ${preview(res.lines[0], 80)}`);
    console.log(`  最后行: ${preview(res.lines[res.lines.length - 1], 80)}`);
  }
  return 0;
}

async function cmdWalk() {
  const mod = await import(MODULE_URL);
  const { cookie } = resolveCookie();
  const allowAnonymous = !cookie;
  if (!cookie) console.log('NO_LOGIN 以匿名方式连续翻页（只能读免费章节）');
  const bookId = await pickBookId(mod, cookie);
  let chapterUid = cli.chapter ? Number(cli.chapter) : undefined;
  let pos = cli.pos;
  let totalChars = 0;
  for (let page = 1; page <= cli.pages; page += 1) {
    const res = await mod.getContent(cookie, { bookId, chapterUid, pos, maxChars: cli.max, allowAnonymous });
    if (!res.ok) {
      console.log(`PAGE ${page} FAILED`, res.code, res.error, 'nextChapterUid=', res.nextChapterUid);
      return 1;
    }
    totalChars += res.lines.join('').length;
    console.log(
      `PAGE ${page}: chapter=${res.chapterTitle} pos=${res.pos} lines=${res.lines.length} chars=${res.lines.join('').length} hasMore=${res.hasMore} next=${res.nextChapterUid} progress=${res.progress}% preview=${res.preview || false}`,
    );
    console.log(`  ${preview(res.lines.join(''), 160)}`);
    if (res.hasMore) {
      pos = res.pos;
      chapterUid = res.chapterUid;
    } else if (res.nextChapterUid) {
      // 跨章继续，验证「读到底自动进入下一章」
      chapterUid = res.nextChapterUid;
      pos = 0;
    } else {
      console.log('BOOK_END', `共读取约 ${totalChars} 字`);
      return 0;
    }
    await sleep(120); // 轻微限速，避免触发风控
  }
  console.log(`WALK_OK 共读取约 ${totalChars} 字`);
  return 0;
}

async function cmdBook() {
  const mod = await import(MODULE_URL);
  const { cookie } = resolveCookie();
  const bookId = await pickBookId(mod, cookie);
  const res = await mod.getBookInfo(cookie, bookId);
  if (JSON_OUT) return printJson(res), res.ok ? 0 : 1;
  if (!res.ok) {
    console.log('BOOK_INFO_FAILED', res.code, res.error);
    return 1;
  }
  console.log(JSON.stringify(res.book, null, 2));
  return 0;
}

async function cmdBookmarks() {
  const mod = await import(MODULE_URL);
  const { cookie } = resolveCookie();
  if (!cookie) {
    console.log('NO_COOKIE 需要登录态');
    return 2;
  }
  const bookId = await pickBookId(mod, cookie);
  const res = await mod.getHighlights(cookie, bookId);
  if (JSON_OUT) return printJson(res), res.ok ? 0 : 1;
  if (!res.ok) {
    console.log('BOOKMARKS_FAILED', res.code, res.error);
    return 1;
  }
  console.log(`bookmarks=${res.bookmarks.length} chapters=${res.chapters.length}`);
  for (const b of res.bookmarks.slice(0, 10)) console.log(`  [${b.chapterUid}] ${preview(b.markText, 100)}`);
  return 0;
}

async function cmdSearch() {
  const mod = await import(MODULE_URL);
  const keyword = cli.keyword || cli.book || '三体';
  const res = await mod.searchBooks(keyword, { count: 10 });
  if (JSON_OUT) return printJson(res), res.ok ? 0 : 1;
  if (!res.ok) {
    console.log('SEARCH_FAILED', res.code, res.error);
    return 1;
  }
  console.log(`keyword=${keyword} books=${res.books.length}`);
  for (const b of res.books) console.log(`  ${b.bookId}\t${b.title}\t${b.author}\t评分=${b.rating ?? '-'}`);
  return 0;
}

async function cmdAll() {
  console.log('========== 1) selftest ==========');
  const selfCode = await selftest();
  console.log('\n========== 2) 匿名可达性（SSR 目录） ==========');
  const mod = await import(MODULE_URL);
  const { cookie, source } = resolveCookie();
  const publicBook = cli.book || '695233';
  const chapters = await mod.getChapters(cookie, publicBook);
  if (chapters.ok) {
    console.log(`book=${chapters.book && chapters.book.title} chapters=${chapters.chapters.length} source=${chapters.source} psvts=${chapters.psvts || '-'}`);
    console.log(`  前三章: ${chapters.chapters.slice(0, 3).map((c) => c.title).join(' / ')}`);
  } else {
    console.log('CHAPTERS_FAILED', chapters.code, chapters.error);
  }

  if (!cookie) {
    console.log('\n========== 3) 登录态 ==========');
    console.log('NO_SESSION：登录相关与正文实测跳过（先运行 scripts/weread-login.mjs 扫码）');
    return selfCode;
  }
  console.log(`\n========== 3) 登录态（${source}） ==========`);
  const shelf = await mod.getShelf(cookie, { force: true });
  let code = selfCode;
  if (shelf.ok) {
    console.log(`user=${JSON.stringify(shelf.user)} books=${shelf.books.length}`);
    for (const b of shelf.books.slice(0, 5)) console.log(`  ${b.bookId}\t${b.title}\tprogress=${b.progress ?? '-'}`);
  } else {
    console.log('SHELF_FAILED', shelf.code, shelf.error);
    code = 1;
  }
  if (shelf.ok && shelf.books.length) {
    const bookId = cli.book || shelf.books[0].bookId;
    console.log(`\n========== 4) 正文实测（bookId=${bookId}） ==========`);
    const content = await mod.getContent(cookie, { bookId, maxChars: cli.max });
    if (content.ok) {
      console.log(
        `chapter=${content.chapterTitle} progress=${content.progress}% hasMore=${content.hasMore} next=${content.nextChapterUid} degraded=${content.degraded || false}`,
      );
      console.log(`预览: ${preview(content.lines.join(''), 200)}`);
    } else {
      console.log('CONTENT_FAILED', content.code, content.error);
      code = 1;
    }
  }
  return code;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const COMMANDS = {
  selftest,
  qr: cmdQr,
  shelf: cmdShelf,
  chapters: cmdChapters,
  content: cmdContent,
  walk: cmdWalk,
  book: cmdBook,
  bookmarks: cmdBookmarks,
  search: cmdSearch,
  all: cmdAll,
  help: async () => {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).join('\n'));
    return 0;
  },
};

const runner = COMMANDS[command];
if (!runner) {
  console.error(`未知子命令: ${command}`);
  console.error(`可用: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(64);
}

runner()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
    process.exit(1);
  });
