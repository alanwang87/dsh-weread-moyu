/**
 * dsh-weread-moyu — 微信读书（weread.qq.com）协议层
 * ---------------------------------------------------------------
 * 零依赖 Node >= 20 纯 ESM 模块，供 DSH 插件宿主半（plugin/lib/index.js）直接 import。
 *
 * 设计约束（与 docs/spec.md 一致）：
 *  - 所有导出函数不抛出网络/协议异常，统一返回 { ok:true, ... } 或 { ok:false, error, code }。
 *  - Cookie 一律以「字符串」参数传入/返回（宿主半负责持久化），本模块不读写任何用户目录。
 *  - 只有二维码登录需要在多次调用之间保留登录前 cookie，用调用方自己持有的 store 对象承载
 *    （见 createQrStore()）；模块内部不缓存跨用户的登录态。
 *
 * 协议要点（详见 docs/weread-protocol.md）：
 *  - 二维码内容其实是 URL：https://weread.qq.com/web/confirm?uid=<uid>
 *    （由本模块用内置 QR 编码器渲染成 PNG data URL，不依赖任何第三方包）
 *  - GET /api/auth/getLoginUid -> { uid }
 *  - GET /api/auth/getLoginInfo?uid=&otp=  长轮询，成功时返回
 *    { succeed:true, accessToken, webLoginVid, refreshToken, ... }
 *    其中 accessToken -> cookie wr_skey，webLoginVid -> cookie wr_vid，refreshToken -> cookie wr_rt
 *  - 书架 GET /web/shelf/sync?synckey=0&teenmode=0&album=1&onlyBook=0
 *  - 目录 POST /web/book/chapterInfos {bookIds:[bookId]}
 *    （未登录时退化为解析阅读页 SSR 的 window.__INITIAL_STATE__.reader.chapterInfos）
 *  - 正文 POST /web/book/chapter/{e_0,e_1,e_3}(EPUB) 或 /{t_0,t_1}(TXT)，
 *    响应 = 32 位大写 MD5 前缀 + 混淆正文；解码见 decodeContentShards()。
 */

import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const VERSION = '0.1.0';
export const BASE = 'https://weread.qq.com';

/** 桌面 Chrome UA。服务端若干接口（尤其正文签名）会按 UA 计算 appId，尽量别改。 */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const QR_EXPIRES_MS = 5 * 60 * 1000; // 微信扫码会话通常 5 分钟
const READER_CACHE_TTL = 4 * 60 * 1000; // 阅读页 SSR（psvts 会过期）缓存 4 分钟
const CHAPTERS_CACHE_TTL = 10 * 60 * 1000; // 书籍目录缓存 10 分钟
const TEXT_CACHE_TTL = 30 * 60 * 1000; // 已解密章节正文缓存 30 分钟
const TEXT_CACHE_MAX = 12;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function md5hex(input) {
  return createHash('md5').update(input).digest('hex');
}

function sha256hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function clampInt(n, min, max) {
  const v = Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : min;
  return Math.min(max, Math.max(min, v));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 微信读书的 `_e()`：网页端用来混淆 bookId / chapterUid / 时间戳。 */
export function wereadE(value) {
  const s = String(value);
  const h = md5hex(s);
  let result = h.slice(0, 3);
  let chunks;
  let typeFlag;
  if (/^\d+$/.test(s)) {
    chunks = [];
    for (let i = 0; i < s.length; i += 9) {
      chunks.push(parseInt(s.slice(i, i + 9), 10).toString(16));
    }
    typeFlag = '3';
  } else {
    let hex = '';
    for (const ch of s) hex += ch.codePointAt(0).toString(16);
    chunks = [hex];
    typeFlag = '4';
  }
  result += typeFlag + '2' + h.slice(-2);
  chunks.forEach((chunk, index) => {
    result += chunk.length.toString(16).padStart(2, '0') + chunk;
    if (index < chunks.length - 1) result += 'g';
  });
  if (result.length < 20) result += h.slice(0, 20 - result.length);
  result += md5hex(result).slice(0, 3);
  return result;
}

/** JS 侧对象的“值字符串化”（签名用）：布尔要写成 true/false，不能是 True/False。 */
function jsValueString(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === null || value === undefined) return 'null';
  return String(value);
}

/** 按 key 字典序拼 `k=encodeURIComponent(v)`，就是网页端 formatObjToSortedQuery。 */
export function formatSortedQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(jsValueString(params[key]))}`)
    .join('&');
}

/** 网页端的请求签名（起始常数 0x15051505，逐 2 字符异或移位）。 */
export function wereadSign(query) {
  let a = 0x15051505;
  let b = 0x15051505;
  const length = query.length;
  for (let i = length - 1; i > 0; i -= 2) {
    a = (a ^ (query.charCodeAt(i) << ((length - i) % 30))) & 0x7fffffff;
    b = (b ^ (query.charCodeAt(i - 1) << (i % 30))) & 0x7fffffff;
  }
  return (a + b).toString(16).toLowerCase();
}

/** 签名参数对象（就地返回带 s 的副本）。 */
export function signParams(params) {
  return { ...params, s: wereadSign(formatSortedQuery(params)) };
}

// ---------------------------------------------------------------------------
// Cookie 工具
// ---------------------------------------------------------------------------

/** "a=1; b=2" -> {a:'1', b:'2'}；也接受已是对象/Map 的输入。 */
export function parseCookie(input) {
  const out = {};
  if (!input) return out;
  if (typeof input === 'object') {
    if (input instanceof Map) {
      for (const [k, v] of input) out[k] = String(v);
      return out;
    }
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined && v !== null) out[k] = String(v);
    }
    return out;
  }
  for (const part of String(input).split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/** {a:'1'} -> "a=1; b=2"；设置 cookie 名固定顺序，便于去重与调试。 */
export function serializeCookie(cookie) {
  const obj = parseCookie(cookie);
  const preferred = ['wr_vid', 'wr_skey', 'wr_rt', 'wr_ql', 'wr_gid', 'wr_fp', 'wr_skey_o', 'wr_ticket'];
  const keys = [];
  for (const k of preferred) if (obj[k] !== undefined) keys.push(k);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) keys.push(k);
  return keys.map((k) => `${k}=${obj[k]}`).join('; ');
}

function cookieHasLogin(obj) {
  return Boolean(obj && obj.wr_vid && obj.wr_skey);
}

/** 把响应里的 Set-Cookie 数组合并进 cookie 对象（同名覆盖）。返回是否有变化。 */
function mergeSetCookies(cookieObj, setCookies) {
  let changed = false;
  if (!Array.isArray(setCookies)) return changed;
  for (const raw of setCookies) {
    if (typeof raw !== 'string' || !raw) continue;
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name || !/^[A-Za-z0-9_.\-]+$/.test(name)) continue;
    // 服务端偶尔会下发 `wr_pf=undefined` 这种脏值；空值/字面量 undefined/null 一律视为删除
    if (value === '' || value === 'undefined' || value === 'null') {
      if (cookieObj[name] !== undefined) {
        delete cookieObj[name];
        changed = true;
      }
      continue;
    }
    if (cookieObj[name] !== value) {
      cookieObj[name] = value;
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// HTTP 封装（永不抛出）
// ---------------------------------------------------------------------------

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

async function httpRequest(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    cookie,
    referer,
    timeoutMs = 20000,
    wantHtml = false,
    keepRaw = false,
  } = opts;

  const h = {
    'User-Agent': DESKTOP_UA,
    Accept: wantHtml ? HTML_ACCEPT : 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: referer || BASE + '/',
    ...headers,
  };
  const cookieStr = serializeCookie(cookie);
  if (cookieStr) h.Cookie = cookieStr;

  let payload;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') {
      payload = body;
      if (!h['Content-Type']) h['Content-Type'] = 'text/plain;charset=UTF-8';
    } else {
      payload = JSON.stringify(body);
      if (!h['Content-Type']) h['Content-Type'] = 'application/json;charset=UTF-8';
    }
    if (method !== 'GET' && !h.Origin) h.Origin = BASE;
  }

  try {
    const res = await fetch(url, {
      method,
      headers: h,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    const text = await res.text();
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json') || (keepRaw && !wantHtml)) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    } else if (!wantHtml) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { ok: true, status: res.status, text, data, setCookies, contentType: ct };
  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      status: 0,
      error: isTimeout ? `请求超时（${timeoutMs}ms）` : `网络错误：${(err && err.message) || err}`,
      code: isTimeout ? 'TIMEOUT' : 'NETWORK',
      setCookies: [],
    };
  }
}

/** weread 业务错误（errCode）转成统一返回。 */
function apiFailure(data, httpResult, extra = {}) {
  if (data && typeof data.errCode === 'number') {
    const map = {
      [-2010]: ['NOT_LOGGED_IN', '登录态无效或已失效（用户不存在）'],
      [-2012]: ['SESSION_EXPIRED', '登录超时，需要重新登录或续期 cookie'],
    };
    const [code, msg] = map[data.errCode] || ['API_ERROR', data.errMsg || '接口返回错误'];
    return { ok: false, code, error: `${msg}（errCode=${data.errCode}）`, errCode: data.errCode, ...extra };
  }
  if (httpResult && httpResult.status >= 400) {
    return {
      ok: false,
      code: 'HTTP_' + httpResult.status,
      error: `接口返回 HTTP ${httpResult.status}`,
      ...extra,
    };
  }
  return { ok: false, code: 'BAD_RESPONSE', error: '接口返回内容无法解析', ...extra };
}

// ---------------------------------------------------------------------------
// 二维码编码器（byte 模式，version 1..10，EC L/M/Q/H）+ PNG 渲染
// 参考 ISO/IEC 18004；输出与主流实现逐模块一致（见 scripts/weread-probe.mjs selftest）。
// ---------------------------------------------------------------------------

const QR_RS_BLOCKS = [
  { L: [[1, 26, 19]], M: [[1, 26, 16]], Q: [[1, 26, 13]], H: [[1, 26, 9]] },
  { L: [[1, 44, 34]], M: [[1, 44, 28]], Q: [[1, 44, 22]], H: [[1, 44, 16]] },
  { L: [[1, 70, 55]], M: [[1, 70, 44]], Q: [[2, 35, 17]], H: [[2, 35, 13]] },
  { L: [[1, 100, 80]], M: [[2, 50, 32]], Q: [[2, 50, 24]], H: [[4, 25, 9]] },
  { L: [[1, 134, 108]], M: [[2, 67, 43]], Q: [[2, 33, 15], [2, 34, 16]], H: [[2, 33, 11], [2, 34, 12]] },
  { L: [[2, 86, 68]], M: [[4, 43, 27]], Q: [[4, 43, 19]], H: [[4, 43, 15]] },
  { L: [[2, 98, 78]], M: [[4, 49, 31]], Q: [[2, 32, 14], [4, 33, 15]], H: [[4, 39, 13], [1, 40, 14]] },
  {
    L: [[2, 121, 97]],
    M: [[2, 60, 38], [2, 61, 39]],
    Q: [[4, 40, 18], [2, 41, 19]],
    H: [[4, 40, 14], [2, 41, 15]],
  },
  {
    L: [[2, 146, 116]],
    M: [[3, 58, 36], [2, 59, 37]],
    Q: [[4, 36, 16], [4, 37, 17]],
    H: [[4, 36, 12], [4, 37, 13]],
  },
  {
    L: [[2, 86, 68], [2, 87, 69]],
    M: [[4, 69, 43], [1, 70, 44]],
    Q: [[6, 43, 19], [2, 44, 20]],
    H: [[6, 43, 15], [2, 44, 16]],
  },
];

const QR_ALIGN = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const QR_EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(ecCount) {
  let poly = [1];
  for (let i = 0; i < ecCount; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecCount; i += 1) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

function qrBlockSpec(version, ecLevel) {
  return QR_RS_BLOCKS[version - 1][ecLevel];
}

function qrDataCodewords(version, ecLevel) {
  return qrBlockSpec(version, ecLevel).reduce((sum, [count, , data]) => sum + count * data, 0);
}

function qrChooseVersion(byteLength, ecLevel) {
  for (let v = 1; v <= 10; v += 1) {
    const lenBits = v < 10 ? 8 : 16;
    if (4 + lenBits + byteLength * 8 <= qrDataCodewords(v, ecLevel) * 8) return v;
  }
  return 0;
}

function bchDigit(data) {
  let digit = 0;
  let v = data;
  while (v !== 0) {
    digit += 1;
    v >>>= 1;
  }
  return digit;
}

function bchTypeInfo(data) {
  const G15 = 0x537; // 0b10100110111
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ 0x5412;
}

function bchTypeNumber(data) {
  const G18 = 0x1f25; // 0b1111100100101
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

function qrMaskFn(mask, r, c) {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function qrBuildBase(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = Boolean(dark);
    fn[r][c] = true;
  };

  const placeFinder = (r, c) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const dark =
          (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
          (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
        set(r + dr, c + dc, dark);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(size - 7, 0);
  placeFinder(0, size - 7);

  // timing
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // alignment
  const pos = QR_ALIGN[version - 1];
  for (const r of pos) {
    for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          set(r + dr, c + dc, dark);
        }
      }
    }
  }

  // reserve format info areas（先占位，最后写真实值）
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) set(8, i, false);
    if (i !== 6) set(i, 8, false);
  }
  set(8, 8, false);
  set(size - 8, 8, true); // dark module
  for (let i = 0; i < 8; i += 1) set(8, size - 1 - i, false);

  return { size, modules, fn, set };
}

function qrWriteFormat(g, ecLevel, mask) {
  const data = (QR_EC_BITS[ecLevel] << 3) | mask;
  const bits = bchTypeInfo(data);
  const { size, set } = g;
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 6) set(i, 8, dark);
    else if (i < 8) set(i + 1, 8, dark);
    else set(size - 15 + i, 8, dark);
  }
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 8) set(8, size - 1 - i, dark);
    else if (i < 9) set(8, 15 - i - 1 + 1, dark);
    else set(8, 15 - i - 1, dark);
  }
  set(size - 8, 8, true);
}

function qrWriteVersion(g, version) {
  if (version < 7) return;
  const bits = bchTypeNumber(version);
  const { size, set } = g;
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    set(Math.floor(i / 3), (i % 3) + size - 8 - 3, dark);
    set((i % 3) + size - 8 - 3, Math.floor(i / 3), dark);
  }
}

function qrPlaceData(g, codewords, mask) {
  const { size, modules, fn } = g;
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let k = 0; k < size; k += 1) {
      const row = upward ? size - 1 - k : k;
      for (let c = 0; c < 2; c += 1) {
        const cc = col - c;
        if (fn[row][cc]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
          bitIndex += 1;
        }
        modules[row][cc] = Boolean(bit ^ (qrMaskFn(mask, row, cc) ? 1 : 0));
      }
    }
    upward = !upward;
  }
}

function qrPenalty(modules) {
  const size = modules.length;
  let penalty = 0;

  // rule 1: 连续同色
  for (let r = 0; r < size; r += 1) {
    let run = 1;
    for (let c = 1; c < size; c += 1) {
      if (modules[r][c] === modules[r][c - 1]) run += 1;
      else {
        if (run >= 5) penalty += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) penalty += 3 + (run - 5);
  }
  for (let c = 0; c < size; c += 1) {
    let run = 1;
    for (let r = 1; r < size; r += 1) {
      if (modules[r][c] === modules[r - 1][c]) run += 1;
      else {
        if (run >= 5) penalty += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) penalty += 3 + (run - 5);
  }

  // rule 2: 2x2 同色块
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) penalty += 3;
    }
  }

  // rule 3: 1:1:3:1:1 模式
  const pattern1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pattern2 = [false, false, false, false, true, false, true, true, true, false, true];
  const runPatterns = (arr) => {
    for (let i = 0; i + 11 <= arr.length; i += 1) {
      let m1 = true;
      let m2 = true;
      for (let j = 0; j < 11; j += 1) {
        if (arr[i + j] !== pattern1[j]) m1 = false;
        if (arr[i + j] !== pattern2[j]) m2 = false;
      }
      if (m1) penalty += 40;
      if (m2) penalty += 40;
    }
  };
  for (let r = 0; r < size; r += 1) runPatterns(modules[r]);
  for (let c = 0; c < size; c += 1) runPatterns(modules.map((row) => row[c]));

  // rule 4: 黑白比例
  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (modules[r][c]) dark += 1;
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return penalty;
}

/**
 * 生成 QR 模块矩阵。
 * @param {string} text 二维码内容
 * @param {{version?:number, ecLevel?:'L'|'M'|'Q'|'H', mask?:number}} [opts]
 * @returns {{size:number, modules:boolean[][], version:number, ecLevel:string, mask:number}}
 */
export function qrEncode(text, opts = {}) {
  const ecLevel = opts.ecLevel || 'M';
  const bytes = Buffer.from(String(text), 'utf8');
  const version = opts.version || qrChooseVersion(bytes.length, ecLevel);
  if (!version) return null;

  const spec = qrBlockSpec(version, ecLevel);
  const dataCodewords = qrDataCodewords(version, ecLevel);

  // --- 比特流
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCodewords * 8;
  push(0, Math.min(4, Math.max(0, capacityBits - bits.length)));
  while (bits.length % 8 !== 0) bits.push(0);
  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    dataBytes.push(value);
  }
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (dataBytes.length < dataCodewords) {
    dataBytes.push(padBytes[padIndex % 2]);
    padIndex += 1;
  }

  // --- 分块 + RS 纠错 + 交错
  const blocks = [];
  let offset = 0;
  for (const [count, total, dataCount] of spec) {
    for (let i = 0; i < count; i += 1) {
      const data = dataBytes.slice(offset, offset + dataCount);
      offset += dataCount;
      blocks.push({ data, ec: rsEncode(data, total - dataCount) });
    }
  }
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  const maxEc = Math.max(...blocks.map((b) => b.ec.length));
  const codewords = [];
  for (let i = 0; i < maxData; i += 1) for (const b of blocks) if (i < b.data.length) codewords.push(b.data[i]);
  for (let i = 0; i < maxEc; i += 1) for (const b of blocks) if (i < b.ec.length) codewords.push(b.ec[i]);

  // --- 依次尝试 8 种掩码，取罚分最低者
  const build = (mask) => {
    const g = qrBuildBase(version);
    qrWriteVersion(g, version);
    qrWriteFormat(g, ecLevel, mask);
    qrPlaceData(g, codewords, mask);
    return g;
  };

  let chosenMask = 0;
  let chosen = null;
  if (Number.isInteger(opts.mask)) {
    chosenMask = opts.mask;
    chosen = build(chosenMask);
  } else {
    let best = Infinity;
    for (let mask = 0; mask < 8; mask += 1) {
      const g = build(mask);
      const p = qrPenalty(g.modules);
      if (p < best) {
        best = p;
        chosenMask = mask;
        chosen = g;
      }
    }
  }

  return {
    size: chosen.size,
    modules: chosen.modules.map((row) => row.map(Boolean)),
    version,
    ecLevel,
    mask: chosenMask,
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把 QR 矩阵渲染成 PNG 的 data URL（可直接给前端 <img src>）。 */
export function qrPngDataUrl(text, opts = {}) {
  const qr = qrEncode(text, opts);
  if (!qr) throw new Error('内容过长，无法编码为 QR（版本上限 10）');
  const scale = opts.scale || 6;
  const quiet = opts.quiet === undefined ? 4 : opts.quiet;
  const dim = (qr.size + quiet * 2) * scale;
  const raw = Buffer.alloc(dim * (dim + 1));
  for (let y = 0; y < dim; y += 1) {
    const rowStart = y * (dim + 1);
    raw[rowStart] = 0; // filter type 0
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < dim; x += 1) {
      const mx = Math.floor(x / scale) - quiet;
      const dark = my >= 0 && mx >= 0 && my < qr.size && mx < qr.size ? qr.modules[my][mx] : false;
      raw[rowStart + 1 + x] = dark ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

// ---------------------------------------------------------------------------
// 登录：二维码会话 / Cookie 校验 / 续期
// ---------------------------------------------------------------------------

/** 二维码登录会话所需的临时状态（宿主半需在多次 HTTP 请求之间保存它）。 */
export function createQrStore(extra = {}) {
  return {
    // 微信读书用 wr_fp 区分不同浏览器/安装，缺失时多端登录容易互相顶掉（-2012）
    fingerprint: String(randInt(0, 4294967295)),
    cookies: {},
    createdAt: Date.now(),
    uid: null,
    ...extra,
  };
}

// uid -> store 的兜底索引：宿主半如果忘了把 createQrSession 返回的 jar 传回 pollQrSession，
// 也不会因为 wr_fp / 预热 cookie 丢失而导致登录态异常。传 jar 仍然优先。
const qrSessionCache = new Map();

function cacheQrSession(uid, store) {
  if (!uid) return;
  if (qrSessionCache.size >= 8) qrSessionCache.delete(qrSessionCache.keys().next().value);
  qrSessionCache.set(uid, store);
}

function dropQrSession(uid) {
  if (uid) qrSessionCache.delete(uid);
}

/**
 * 兼容三种“登录过程中的临时 cookie 载体”：
 *  - createQrStore() 返回的对象（推荐，宿主半可直接 JSON 序列化后存内存）
 *  - 裸 cookie 字符串
 *  - {cookies:{...}} 形式的普通对象
 */
function ensureStore(store) {
  if (typeof store === 'string') {
    return { fingerprint: String(randInt(0, 4294967295)), cookies: parseCookie(store), createdAt: Date.now() };
  }
  if (!store || typeof store !== 'object') return createQrStore();
  if (!store.cookies) store.cookies = {};
  if (!store.fingerprint) store.fingerprint = String(randInt(0, 4294967295));
  if (!store.createdAt) store.createdAt = Date.now();
  return store;
}

async function fetchUserInfo(cookie) {
  const ck = parseCookie(cookie);
  const res = await httpRequest(`${BASE}/api/userInfo?userVid=${encodeURIComponent(ck.wr_vid || '')}`, {
    cookie: ck,
    referer: BASE + '/r/weread-skills',
    headers: {
      'X-Vid': ck.wr_vid || '',
      'X-Skey': ck.wr_skey || '',
    },
  });
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const d = res.data;
  const name = d.name || (d.user && d.user.name) || d.nickname || '';
  const vid = String(d.vid || (d.user && d.user.vid) || ck.wr_vid || '');
  const avatar = d.avatar || (d.user && d.user.avatar) || '';
  if (!name && !avatar) return null;
  return { vid, nickname: name || '微信读书用户', avatar };
}

/**
 * 创建二维码登录会话。
 * @param {object|string} [jar] 可省略；轮询时必须传回返回值里的 jar（或其中 cookie）
 * @returns {Promise<{ok:true, uid:string, qrDataUrl:string, qrText:string, expiresAt:number,
 *                    cookie:string, jar:{fingerprint,cookies,createdAt,uid}}
 *                 | {ok:false, code:string, error:string}>}
 */
export async function createQrSession(jar) {
  const st = ensureStore(jar);
  st.createdAt = Date.now();
  st.cookies = { wr_fp: st.fingerprint };

  // 预热：访问首页 / 登录页拿 wr_gid 等服务端 cookie（服务端会 Set-Cookie）。
  // 首页会发 wr_gid，/r/weread-skills 是网页端二维码登录用的 Referer 页面。
  for (const seedPath of ['/', '/r/weread-skills']) {
    const seed = await httpRequest(`${BASE}${seedPath}`, {
      cookie: st.cookies,
      wantHtml: true,
      referer: BASE + '/',
    });
    mergeSetCookies(st.cookies, seed.setCookies);
  }

  const res = await httpRequest(`${BASE}/api/auth/getLoginUid`, {
    cookie: st.cookies,
    referer: BASE + '/r/weread-skills',
  });
  mergeSetCookies(st.cookies, res.setCookies);
  if (!res.ok) return { ok: false, code: res.code || 'NETWORK', error: res.error };
  const uid = res.data && typeof res.data.uid === 'string' ? res.data.uid : '';
  if (!uid) {
    return {
      ok: false,
      code: 'QR_UID_FAILED',
      error: '未能从 /api/auth/getLoginUid 获取登录 uid',
      raw: res.text ? res.text.slice(0, 300) : '',
    };
  }

  st.uid = uid;
  cacheQrSession(uid, st);
  const qrText = `${BASE}/web/confirm?uid=${encodeURIComponent(uid)}`;
  let qrDataUrl;
  try {
    qrDataUrl = qrPngDataUrl(qrText);
  } catch (err) {
    return { ok: false, code: 'QR_RENDER_FAILED', error: String(err && err.message) };
  }

  return {
    ok: true,
    uid,
    qrText,
    qrDataUrl,
    expiresAt: st.createdAt + QR_EXPIRES_MS,
    cookie: serializeCookie(st.cookies),
    jar: st,
  };
}

function resolvePollStore(uid, jar) {
  if (jar !== undefined && jar !== null && jar !== '') {
    const st = ensureStore(jar);
    cacheQrSession(uid, st);
    return st;
  }
  const cached = uid ? qrSessionCache.get(uid) : null;
  const st = ensureStore(cached || createQrStore());
  cacheQrSession(uid, st);
  return st;
}

/**
 * 轮询二维码登录状态。
 * state: waiting（未扫/未确认）| scanned（手机端 4 位验证码，见 needOtp）| confirmed | expired | error
 * @param {string} uid createQrSession 返回的 uid
 * @param {object|string} jar createQrSession 返回的 jar（可省略，模块内有按 uid 的兜底缓存）
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, state:string, cookie?:string, jar?:object, user?:object,
 *                    needOtp?:boolean, error?:string, code?:string}>}
 */
export async function pollQrSession(uid, jar, opts = {}) {
  const st = resolvePollStore(uid, jar);
  if (!uid) return { ok: false, state: 'error', code: 'BAD_UID', error: '缺少二维码 uid' };
  const startedAt = st.createdAt || Date.now();
  if (Date.now() - startedAt > QR_EXPIRES_MS) {
    dropQrSession(uid);
    return { ok: true, state: 'expired', jar: st, error: '二维码已过期，请点击刷新' };
  }

  // 注意：服务端是长轮询，正常情况下会挂住直到状态变化；我们主动限制在 ~8s，
  // 超时就当作 waiting 让宿主半/前端继续轮询，避免一次请求占住 55 秒。
  const timeoutMs = opts.timeoutMs || 8000;
  const pollStart = Date.now();
  const url = `${BASE}/api/auth/getLoginInfo?uid=${encodeURIComponent(uid)}&otp=`;
  const res = await httpRequest(url, {
    cookie: st.cookies,
    referer: BASE + '/r/weread-skills',
    timeoutMs,
  });
  mergeSetCookies(st.cookies, res.setCookies);

  if (!res.ok) {
    const elapsed = Date.now() - pollStart;
    if (res.code === 'TIMEOUT' && elapsed >= timeoutMs - 500) {
      return { ok: true, state: 'waiting', cookie: serializeCookie(st.cookies), jar: st };
    }
    // 网络抖动当作 waiting 由宿主半重试，其它错误如实上报
    return { ok: true, state: 'waiting', transientError: res.error, cookie: serializeCookie(st.cookies), jar: st };
  }

  const data = res.data || {};
  if (data.succeed === true) {
    const webLoginVid = String(data.webLoginVid || '');
    const accessToken = String(data.accessToken || '');
    const refreshToken = String(data.refreshToken || '');
    if (!webLoginVid || !accessToken) {
      return {
        ok: false,
        state: 'error',
        code: 'BAD_LOGIN_RESULT',
        error: '登录成功但缺少 webLoginVid/accessToken',
        jar: st,
      };
    }
    // 一次扫码登录视为完整账号切换：基于本次会话 cookie 重建，避免旧账号残留
    const fresh = { ...st.cookies };
    fresh.wr_vid = webLoginVid;
    fresh.wr_skey = accessToken;
    fresh.wr_ql = '0';
    if (refreshToken) fresh.wr_rt = encodeURIComponent(refreshToken);
    const cookieStr = serializeCookie(fresh);
    st.cookies = fresh;
    const user = (await fetchUserInfo(cookieStr)) || { vid: webLoginVid, nickname: '微信读书用户', avatar: '' };
    dropQrSession(uid);
    return { ok: true, state: 'confirmed', cookie: cookieStr, user, refreshToken, jar: st };
  }

  const logicCode = String(data.logicCode || '');
  if (logicCode === 'NEED_OTP') {
    return {
      ok: true,
      state: 'scanned',
      needOtp: true,
      cookie: serializeCookie(st.cookies),
      jar: st,
      error: '手机端需要输入 4 位验证码（可用 pollQrSessionWithOtp 完成验证）',
    };
  }
  if (logicCode === 'LOGIN_TIMEOUT') {
    dropQrSession(uid);
    return {
      ok: true,
      state: 'expired',
      cookie: serializeCookie(st.cookies),
      jar: st,
      error: '二维码已过期或登录超时',
    };
  }
  if (logicCode === 'OTP_EXPIRED') {
    dropQrSession(uid);
    return { ok: true, state: 'expired', jar: st, error: '验证码已过期' };
  }
  if (logicCode === 'OTP_NOT_MATCH') {
    return { ok: true, state: 'scanned', needOtp: true, jar: st, error: '验证码错误' };
  }
  return { ok: true, state: 'waiting', cookie: serializeCookie(st.cookies), jar: st, logicCode };
}

/** 需要手机 4 位验证码时，用 otp 再轮询一次。 */
export async function pollQrSessionWithOtp(uid, otp, jar, opts = {}) {
  const st = resolvePollStore(uid, jar);
  if (!uid) return { ok: false, state: 'error', code: 'BAD_UID', error: '缺少二维码 uid', jar: st };
  if (!/^\d{4}$/.test(String(otp || ''))) {
    return { ok: false, state: 'scanned', needOtp: true, jar: st, error: '验证码必须是 4 位数字' };
  }
  const url = `${BASE}/api/auth/getLoginInfo?uid=${encodeURIComponent(uid)}&otp=${encodeURIComponent(otp)}`;
  const timeoutMs = opts.timeoutMs || 15000;
  const res = await httpRequest(url, {
    cookie: st.cookies,
    referer: BASE + '/r/weread-skills',
    timeoutMs,
  });
  mergeSetCookies(st.cookies, res.setCookies);
  if (!res.ok) return { ok: true, state: 'scanned', needOtp: true, jar: st, transientError: res.error };
  const data = res.data || {};
  if (data.succeed === true) {
    const fresh = { ...st.cookies };
    fresh.wr_vid = String(data.webLoginVid || '');
    fresh.wr_skey = String(data.accessToken || '');
    fresh.wr_ql = '0';
    if (data.refreshToken) fresh.wr_rt = encodeURIComponent(String(data.refreshToken));
    st.cookies = fresh;
    const cookieStr = serializeCookie(fresh);
    const user = (await fetchUserInfo(cookieStr)) || { vid: fresh.wr_vid, nickname: '微信读书用户', avatar: '' };
    return { ok: true, state: 'confirmed', cookie: cookieStr, user, jar: st };
  }
  const logicCode = String(data.logicCode || '');
  if (logicCode === 'OTP_EXPIRED') return { ok: true, state: 'expired', jar: st, error: '验证码已过期' };
  return { ok: true, state: 'scanned', needOtp: true, jar: st, error: logicCode || '验证码未通过' };
}

/**
 * 校验 Cookie 是否有效。
 * @param {string} cookie "wr_vid=...; wr_skey=...; wr_rt=..."
 * @returns {Promise<{ok:boolean, user?:{vid,nickname,avatar}, bookCount?:number, cookie?:string, code?:string, error?:string}>}
 */
export async function validateCookie(cookie) {
  const ck = parseCookie(cookie);
  if (!cookieHasLogin(ck)) {
    return { ok: false, code: 'NO_COOKIE', error: 'Cookie 中缺少 wr_vid / wr_skey' };
  }

  let latestCookie = serializeCookie(ck);
  // 1) 用书架接口验证（最贴近真实使用场景）
  const shelf = await getShelfRaw(latestCookie);
  if (shelf.setCookies) {
    const merged = { ...ck };
    mergeSetCookies(merged, shelf.setCookies);
    latestCookie = serializeCookie(merged);
  }
  if (!shelf.ok) {
    return { ok: false, code: shelf.code, error: shelf.error, cookie: latestCookie };
  }

  // 2) 拿昵称/头像
  let user = null;
  const ui = await httpRequest(`${BASE}/api/userInfo?userVid=${encodeURIComponent(ck.wr_vid)}`, {
    cookie: latestCookie,
    referer: BASE + '/r/weread-skills',
    headers: { 'X-Vid': ck.wr_vid, 'X-Skey': ck.wr_skey },
  });
  if (ui.ok && ui.data && typeof ui.data === 'object') {
    const d = ui.data;
    user = {
      vid: String(d.vid || ck.wr_vid),
      nickname: d.name || '微信读书用户',
      avatar: d.avatar || '',
    };
  }
  if (!user) user = { vid: ck.wr_vid, nickname: '微信读书用户', avatar: '' };

  return {
    ok: true,
    user,
    bookCount: Array.isArray(shelf.data && shelf.data.books) ? shelf.data.books.length : 0,
    cookie: latestCookie,
    sessionExpired: false,
  };
}

/** POST /web/login/renewal —— cookie 续期（返回新 cookie 字符串时请宿主半覆盖保存）。 */
export async function renewSession(cookie) {
  const ck = parseCookie(cookie);
  if (!cookieHasLogin(ck)) return { ok: false, code: 'NO_COOKIE', error: 'Cookie 中缺少 wr_vid / wr_skey' };
  const res = await httpRequest(`${BASE}/web/login/renewal`, {
    method: 'POST',
    cookie: ck,
    body: { rq: '%2Fweb%2Fbook%2Fread', ql: false },
    referer: BASE + '/',
  });
  if (!res.ok) return { ok: false, code: res.code || 'NETWORK', error: res.error };
  const merged = { ...ck };
  const changed = mergeSetCookies(merged, res.setCookies);
  const succ = res.data && (res.data.succ === 1 || res.data.succ === true || res.data.succ === '1');
  if (!succ) {
    return {
      ok: false,
      code: 'RENEW_FAILED',
      error: 'cookie 续期失败（会话已过期，需要重新扫码登录）',
      cookie: changed ? serializeCookie(merged) : undefined,
    };
  }
  return { ok: true, cookie: serializeCookie(merged) };
}

// ---------------------------------------------------------------------------
// 书架 / 书籍信息 / 目录
// ---------------------------------------------------------------------------

const SHELF_QUERY = { synckey: 0, teenmode: 0, album: 1, onlyBook: 0 };

async function getShelfRaw(cookie) {
  const qs = Object.entries(SHELF_QUERY)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const res = await httpRequest(`${BASE}/web/shelf/sync?${qs}`, { cookie });
  if (!res.ok) return { ok: false, code: res.code || 'NETWORK', error: res.error, setCookies: res.setCookies };
  const data = res.data;
  if (!data || typeof data !== 'object') {
    return { ok: false, code: 'BAD_RESPONSE', error: '书架接口返回非 JSON', setCookies: res.setCookies };
  }
  if (typeof data.errCode === 'number' && data.errCode !== 0) {
    return { ...apiFailure(data, res), setCookies: res.setCookies };
  }
  return { ok: true, data, setCookies: res.setCookies };
}

/**
 * 书架列表。
 * @param {string} cookie
 * @param {{force?:boolean}} [opts] force=true 时不使用任何缓存（当前实现始终直连，保留参数兼容宿主半）
 * @returns {Promise<{ok:true, books:Array, albums:Array, user?:object, synckey?:number, cookie?:string}
 *                 | {ok:false, code:string, error:string, sessionExpired?:boolean, cookie?:string}>}
 */
export async function getShelf(cookie, opts = {}) {
  const ck = parseCookie(cookie);
  if (!cookieHasLogin(ck)) {
    return { ok: false, code: 'NOT_LOGGED_IN', error: '未登录：缺少 wr_vid / wr_skey' };
  }
  void opts.force;

  const raw = await getShelfRaw(cookie);
  const merged = { ...ck };
  const changed = mergeSetCookies(merged, raw.setCookies);
  const cookieOut = changed ? serializeCookie(merged) : serializeCookie(merged);
  if (!raw.ok) {
    const expired = raw.code === 'NOT_LOGGED_IN' || raw.code === 'SESSION_EXPIRED';
    return {
      ok: false,
      code: expired ? 'SESSION_EXPIRED' : raw.code,
      error: raw.error,
      sessionExpired: expired,
      cookie: cookieOut,
    };
  }

  const data = raw.data;
  const progressMap = new Map();
  for (const p of data.bookProgress || []) {
    if (p && p.bookId) progressMap.set(String(p.bookId), p);
  }
  const rawBooks = Array.isArray(data.books) ? data.books : [];
  const books = rawBooks
    .filter((b) => b && b.bookId)
    .map((b) => {
      const prog = progressMap.get(String(b.bookId));
      return {
        bookId: String(b.bookId),
        title: b.title || '',
        author: b.author || '',
        cover: b.cover || '',
        category: b.category || '',
        format: b.format || '',
        readUpdateTime: b.readUpdateTime || 0,
        finishReading: b.finishReading || 0,
        secret: b.secret || 0,
        lastChapterIdx: b.lastChapterIdx || 0,
        progress: prog && typeof prog.progress === 'number' ? prog.progress : undefined,
        chapterUid: prog && prog.chapterUid ? prog.chapterUid : undefined,
        chapterOffset: prog && prog.chapterOffset !== undefined ? prog.chapterOffset : undefined,
      };
    });

  const albums = (Array.isArray(data.albums) ? data.albums : [])
    .map((a) => a && a.albumInfo)
    .filter(Boolean)
    .map((a) => ({
      albumId: String(a.albumId || ''),
      name: a.name || '',
      authorName: a.authorName || '',
      cover: a.cover || '',
      trackCount: a.trackCount || 0,
    }));

  // 昵称/头像（失败不影响书架返回）
  let user = data.user
    ? { vid: String(data.user.vid || ck.wr_vid), nickname: data.user.name || '微信读书用户', avatar: data.user.avatar || '' }
    : null;
  if (!user) {
    try {
      user = await fetchUserInfo(cookieOut);
    } catch {
      user = null;
    }
  }
  if (!user) user = { vid: ck.wr_vid, nickname: '微信读书用户', avatar: '' };

  return {
    ok: true,
    books,
    albums,
    user,
    synckey: data.synckey,
    cookie: cookieOut,
  };
}

/**
 * 搜索书籍（匿名可用，/api/store/search）。书架里没有的书可以用它找 bookId。
 * @returns {Promise<{ok:true, books:Array<{bookId,title,author,cover,readingCount,rating}>}>}
 */
export async function searchBooks(keyword, opts = {}) {
  if (!keyword || !String(keyword).trim()) return { ok: false, code: 'BAD_ARGUMENT', error: '缺少搜索关键词' };
  const count = clampInt(opts.count || 10, 1, 50);
  const maxIdx = clampInt(opts.maxIdx || 0, 0, 1000);
  const qs = `keyword=${encodeURIComponent(String(keyword).trim())}&maxIdx=${maxIdx}&count=${count}`;
  const res = await httpRequest(`${BASE}/api/store/search?${qs}`, { cookie: opts.cookie });
  if (!res.ok) return { ok: false, code: res.code || 'NETWORK', error: res.error };
  const data = res.data;
  if (!data || !Array.isArray(data.results)) {
    return { ok: false, code: 'BAD_RESPONSE', error: '搜索接口返回异常' };
  }
  const books = [];
  for (const group of data.results) {
    for (const item of group.books || []) {
      const info = item && item.bookInfo;
      if (!info || !info.bookId) continue;
      books.push({
        bookId: String(info.bookId),
        title: info.title || '',
        author: info.author || '',
        cover: info.cover || '',
        category: info.category || '',
        rating: typeof item.newRating === 'number' ? item.newRating : info.newRating,
        readingCount: item.readingCount || 0,
        readerLink: info.readerLink || '',
      });
    }
  }
  return { ok: true, books, hasMore: Boolean(data.hasMore), sid: data.sid };
}

/** 从阅读页 SSR 的 window.__INITIAL_STATE__ 中抽 JSON（大括号配对，避免正则截断）。 */
function extractInitialState(html) {
  const marker = 'window.__INITIAL_STATE__=';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  // 跳过空白
  while (i < html.length && /\s/.test(html[i])) i += 1;
  if (html[i] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let p = i; p < html.length; p += 1) {
    const ch = html[p];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(i, p + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 拉阅读页 SSR（同时充当目录/正文的 psvts 来源）。匿名也可用。
 * @returns {Promise<{ok:true, reader:object, user?:object, html?:string}>}
 */
async function getReaderState(cookie, bookId, chapterUid) {
  const bookHash = wereadE(bookId);
  const url = chapterUid
    ? `${BASE}/web/reader/${bookHash}k${wereadE(chapterUid)}`
    : `${BASE}/web/reader/${bookHash}`;
  const res = await httpRequest(url, {
    cookie,
    wantHtml: true,
    referer: `${BASE}/web/reader/${bookHash}`,
    timeoutMs: 25000,
  });
  if (!res.ok) return { ok: false, code: res.code || 'NETWORK', error: res.error };
  const state = extractInitialState(res.text);
  if (!state) {
    return {
      ok: false,
      code: 'SSR_PARSE_FAILED',
      error: '阅读页未包含 window.__INITIAL_STATE__（页面结构可能已变化）',
    };
  }
  const reader = state.reader || {};
  if (!reader.bookInfo || !reader.chapterInfos) {
    return { ok: false, code: 'SSR_STATE_INCOMPLETE', error: '阅读页 SSR 数据缺少 chapterInfos/bookInfo' };
  }
  return { ok: true, reader, user: state.user || null, setCookies: res.setCookies, cookie };
}

const readerCache = new Map();
const chaptersCache = new Map();

async function getReaderStateCached(cookie, bookId, chapterUid) {
  const key = `${bookId}:${chapterUid || 0}`;
  const hit = readerCache.get(key);
  if (hit && Date.now() - hit.at < READER_CACHE_TTL) return hit.value;
  const value = await getReaderState(cookie, bookId, chapterUid);
  if (value.ok) {
    if (readerCache.size > 24) readerCache.clear();
    readerCache.set(key, { at: Date.now(), value });
  }
  return value;
}

function normalizeChapters(bookId, payload) {
  const candidates = [];
  if (Array.isArray(payload)) candidates.push(...payload);
  else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.data)) candidates.push(...payload.data);
    else if (Array.isArray(payload.books)) candidates.push(...payload.books);
    else candidates.push(payload);
  }
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const itemBookId = String(item.bookId || (item.book && item.book.bookId) || '');
    if (itemBookId && itemBookId !== String(bookId)) continue;
    const list = item.updated || item.chapterInfos || item.chapters;
    if (Array.isArray(list)) {
      const chapters = list
        .filter((c) => c && c.chapterUid !== undefined && c.chapterUid !== null)
        .map((c) => ({
          chapterUid: Number(c.chapterUid),
          chapterIdx: c.chapterIdx,
          title: c.title || '',
          level: c.level || 1,
          wordCount: c.wordCount || 0,
          paid: c.paid || 0,
          price: c.price || 0,
          updateTime: c.updateTime || 0,
          tar: c.tar || '',
        }));
      return {
        book: item.book || null,
        format: item.format || '',
        synckey: item.synckey,
        chapters,
        copyrightChapterUids: (item.book && item.book.copyrightChapterUids) || [],
      };
    }
  }
  return null;
}

/**
 * 书籍目录（章节列表）。
 * 优先 /web/book/chapterInfos（需要登录），失败时退化为阅读页 SSR 目录（匿名可用）。
 * 结果按 bookId 缓存 10 分钟（翻页时不会重复拉目录）。
 * @returns {Promise<{ok:true, chapters:Array, book:object, source:'api'|'ssr', psvts?:string, cookie?:string}>}
 */
export async function getChapters(cookie, bookId, opts = {}) {
  if (!bookId) return { ok: false, code: 'BAD_ARGUMENT', error: '缺少 bookId' };
  const cacheKey = String(bookId);
  if (!opts.force) {
    const hit = chaptersCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CHAPTERS_CACHE_TTL) return hit.value;
  }
  const ck = parseCookie(cookie);

  if (cookieHasLogin(ck)) {
    const res = await httpRequest(`${BASE}/web/book/chapterInfos`, {
      method: 'POST',
      cookie: ck,
      body: { bookIds: [String(bookId)] },
      referer: `${BASE}/web/reader/${wereadE(bookId)}`,
    });
    const merged = { ...ck };
    mergeSetCookies(merged, res.setCookies);
    if (res.ok) {
      const norm = normalizeChapters(bookId, res.data);
      if (norm && norm.chapters.length) {
        const state = await getReaderStateCached(serializeCookie(merged), bookId).catch(() => null);
        const value = {
          ok: true,
          chapters: norm.chapters,
          book: norm.book || (state && state.ok ? state.reader.bookInfo : {}),
          format: norm.format,
          synckey: norm.synckey,
          copyrightChapterUids: norm.copyrightChapterUids,
          psvts: state && state.ok ? state.reader.psvts : undefined,
          source: 'api',
          cookie: serializeCookie(merged),
        };
        if (chaptersCache.size > 16) chaptersCache.clear();
        chaptersCache.set(cacheKey, { at: Date.now(), value });
        return value;
      }
    }
  }

  // 退化：阅读页 SSR（匿名也能拿到完整目录）
  const state = await getReaderStateCached(cookie, bookId);
  if (!state.ok) {
    return {
      ok: false,
      code: state.code || 'SSR_PARSE_FAILED',
      error: state.error || '获取目录失败（接口与 SSR 都不可用）',
    };
  }
  const reader = state.reader;
  const chapters = (reader.chapterInfos || [])
    .filter((c) => c && c.chapterUid !== undefined)
    .map((c) => ({
      chapterUid: Number(c.chapterUid),
      chapterIdx: c.chapterIdx,
      title: c.title || '',
      level: c.level || 1,
      wordCount: c.wordCount || 0,
      paid: c.paid || 0,
      price: c.price || 0,
      updateTime: c.updateTime || 0,
    }));
  const value = {
    ok: true,
    chapters,
    book: reader.bookInfo,
    format: reader.bookInfo && reader.bookInfo.format,
    copyrightChapterUids: (reader.bookInfo && reader.bookInfo.copyrightChapterUids) || [],
    psvts: reader.psvts,
    source: 'ssr',
    cookie: state.cookie,
  };
  if (chaptersCache.size > 16) chaptersCache.clear();
  chaptersCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** 书籍详情（匿名可用：走阅读页 SSR 的 bookInfo）。 */
export async function getBookInfo(cookie, bookId) {
  if (!bookId) return { ok: false, code: 'BAD_ARGUMENT', error: '缺少 bookId' };
  const state = await getReaderStateCached(cookie, bookId);
  if (!state.ok) return { ok: false, code: state.code, error: state.error };
  const info = state.reader.bookInfo || {};
  return {
    ok: true,
    book: {
      bookId: String(info.bookId || bookId),
      title: info.title || '',
      author: info.author || '',
      cover: info.cover || '',
      intro: info.intro || '',
      category: info.category || '',
      format: info.format || '',
      payType: info.payType,
      finished: info.finished,
      maxFreeChapter: info.maxFreeChapter,
      lastChapterIdx: info.lastChapterIdx,
      wordCount: info.wordCount,
      chapterCount: (state.reader.chapterInfos || []).length,
    },
  };
}

// ---------------------------------------------------------------------------
// 正文：请求分片 -> MD5 校验 -> 反混淆 -> UTF-8 修复 -> 纯文本
// ---------------------------------------------------------------------------

function checkedBody(responseText) {
  if (typeof responseText !== 'string' || responseText.length <= 32) return '';
  const expected = responseText.slice(0, 32);
  const body = responseText.slice(32);
  const actual = md5hex(body).toUpperCase();
  if (actual !== expected) return '';
  return body;
}

/** 混淆正文的交换位还原：位置由尾部字符的二进制串按 4 进制解析得到。 */
function swapPositions(encoded) {
  const length = encoded.length;
  if (length < 4) return [];
  if (length < 11) return [0, 2];
  const n = Math.min(4, Math.floor((length + 9) / 10));
  let tmp = '';
  for (let i = length - 1; i > length - 1 - n; i -= 1) {
    tmp += String(parseInt(encoded.charCodeAt(i).toString(2), 4));
  }
  const result = [];
  const m = length - n - 2;
  if (m <= 0) return [];
  const step = String(m).length;
  let i = 0;
  while (result.length < 10 && i + step < tmp.length) {
    result.push(parseInt(tmp.slice(i, i + step), 10) % m);
    result.push(parseInt(tmp.slice(i + 1, i + 1 + step), 10) % m);
    i += step;
  }
  return result;
}

function reverseSwaps(encoded, positions) {
  const chars = encoded.split('');
  for (let i = positions.length - 1; i >= 0; i -= 2) {
    const left0 = positions[i];
    const right0 = i - 1 >= 0 ? positions[i - 1] : positions[positions.length - 1];
    for (const k of [1, 0]) {
      const left = left0 + k;
      const right = right0 + k;
      if (left < 0 || right < 0 || left >= chars.length || right >= chars.length) continue;
      const tmp = chars[left];
      chars[left] = chars[right];
      chars[right] = tmp;
    }
  }
  return chars.join('');
}

/** 把「按 latin1 解读的 UTF-8 字节串」修复成正常字符串（服务端正文里混有跨字节边界）。 */
function repairUtf8(binaryText) {
  const out = [];
  let i = 0;
  while (i < binaryText.length) {
    const b0 = binaryText.charCodeAt(i);
    if (b0 >= 0xc0 && b0 <= 0xdf && i + 1 < binaryText.length) {
      const b1 = binaryText.charCodeAt(i + 1);
      if (b1 >= 0x80 && b1 <= 0xbf) {
        out.push(String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f)));
        i += 2;
        continue;
      }
    }
    if (b0 >= 0xe0 && b0 <= 0xef && i + 2 < binaryText.length) {
      const b1 = binaryText.charCodeAt(i + 1);
      const b2 = binaryText.charCodeAt(i + 2);
      if (b1 >= 0x80 && b1 <= 0xbf && b2 >= 0x80 && b2 <= 0xbf) {
        out.push(String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f)));
        i += 3;
        continue;
      }
    }
    if (b0 >= 0xf0 && b0 <= 0xf7 && i + 3 < binaryText.length) {
      const b1 = binaryText.charCodeAt(i + 1);
      const b2 = binaryText.charCodeAt(i + 2);
      const b3 = binaryText.charCodeAt(i + 3);
      if (b1 >= 0x80 && b1 <= 0xbf && b2 >= 0x80 && b2 <= 0xbf && b3 >= 0x80 && b3 <= 0xbf) {
        const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        out.push(String.fromCodePoint(cp));
        i += 4;
        continue;
      }
    }
    out.push(binaryText[i]);
    i += 1;
  }
  return out.join('');
}

/** 解码单个混淆 payload（已去掉 MD5 前缀的拼接串）。 */
function decodeEncodedPayload(encodedPayload) {
  if (!encodedPayload) return '';
  let payload = encodedPayload.slice(1); // 丢弃首字符
  const reordered = reverseSwaps(payload, swapPositions(payload));
  const b64 = reordered.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = Buffer.from(b64 + padding, 'base64').toString('latin1');
  return repairUtf8(binary);
}

/**
 * 解码 EPUB 正文分片（e_0 + e_1 + e_3，各自先做 MD5 前缀校验）。
 * 单测/探针会用到，故导出。
 */
export function decodeContentShards(e0, e1, e3) {
  const payload = checkedBody(e0) + checkedBody(e1) + checkedBody(e3);
  return decodeEncodedPayload(payload);
}

/** 解码 EPUB 样式分片 e_2（st=1）。 */
export function decodeStyleShard(e2) {
  return decodeEncodedPayload(checkedBody(e2));
}

/** 解码 TXT 正文分片（t_0 + t_1）。 */
export function decodeTxtShards(t0, t1) {
  const payload = checkedBody(t0) + checkedBody(t1);
  return decodeEncodedPayload(payload);
}

function makeContentParams(bookId, chapterUid, psvts, opts = {}) {
  const style = Boolean(opts.style);
  let ct = nowSec();
  if (wereadE(String(ct)) === String(psvts || '')) ct += 1; // 网页端要求 pc != ps
  const params = {
    b: wereadE(bookId),
    c: wereadE(chapterUid),
    r: String(randInt(0, 9999) ** 2),
    ct: String(ct),
    ps: String(psvts || ''),
    pc: wereadE(String(ct)),
    sc: opts.sc === undefined ? 1 : opts.sc,
    prevChapter: false,
    st: style ? 1 : 0,
  };
  return signParams(params);
}

async function postShard(cookie, bookId, shard, params) {
  const res = await httpRequest(`${BASE}/web/book/chapter/${shard}`, {
    method: 'POST',
    cookie,
    body: params,
    referer: `${BASE}/web/reader/${wereadE(bookId)}`,
    timeoutMs: 25000,
  });
  return res;
}

/** 把 XHTML 正文清洗成「段落数组」（保留中文正文，去掉标签/脚本/样式）。 */
export function htmlToLines(source) {
  if (!source) return [];
  let text = String(source);
  text = text.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  text = text.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  text = text.replace(/<\s*\/\s*(p|div|h[1-6]|li|tr|section|article|blockquote|pre)\s*>/gi, '\n');
  text = text.replace(/<\s*(p|div|h[1-6]|li|tr|section|article|blockquote|pre)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  return normalizeLines(text);
}

const NAMED_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×',
  copy: '©',
  reg: '®',
  deg: '°',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  bull: '•',
};

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]{1,10});/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
    });
}

function normalizeLines(text) {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/[\u00a0\u3000\t]/g, ' ')
        .replace(/[ \u00a0]+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0);
  return lines;
}

/** 单页最多返回的字符数上限（`getContent` 与 `sliceContentPage` 共用）。 */
const PAGE_MAX_CHARS_LIMIT = 4000;
/** 单页最少字符数（防止宿主半传 0/负数导致空页死循环）。 */
const PAGE_MIN_CHARS = 120;
/** 单页默认字符数。 */
const PAGE_DEFAULT_CHARS = 1200;

/** 与 `getContent` 完全一致的切页规则，抽成纯函数给「整本缓存 / 离线阅读」复用。 */
function computeContentPage(textValue, posValue, maxCharsValue) {
  const total = textValue.length;
  if (!total) return { lines: [], pos: 0, hasMore: false, totalChars: 0 };
  const pos = Math.max(0, Math.trunc(Number(posValue) || 0));
  const maxChars = clampInt(maxCharsValue || PAGE_DEFAULT_CHARS, PAGE_MIN_CHARS, PAGE_MAX_CHARS_LIMIT);
  const start = Math.min(pos, total);
  let end = Math.min(total, start + maxChars);
  // 尽量在段落边界截断，避免一页从半句话开始
  if (end < total) {
    const nl = textValue.lastIndexOf('\n', end);
    if (nl > start) end = nl;
  }
  return {
    lines: normalizeLines(textValue.slice(start, end)),
    pos: end,
    hasMore: end < total,
    totalChars: total,
  };
}

/**
 * 用已缓存的整章纯文本切出与 `getContent` 完全一致的一页。
 * 纯函数：不访问网络、不依赖 cookie、无副作用。
 *
 * @param {{text:string, pos?:number, maxChars?:number}} opts
 *   - `text`：整章纯文本（段落用 `\n` 连接，即 `getChapterText().text`）
 *   - `pos`：已消耗字符偏移，默认 0；超过长度时返回空页
 *   - `maxChars`：单页字符数，默认 1200，clamp 到 120–4000
 * @returns {{lines:string[], pos:number, hasMore:boolean, totalChars:number}}
 *   - `lines`：本页段落数组（已做 trim / 去空行，与在线完全一致）
 *   - `pos`：本页结束位置，下次原样传回
 *   - `hasMore`：本章是否还有下一页
 *   - `totalChars`：整章总字符数
 */
export function sliceContentPage(opts = {}) {
  const text = typeof opts.text === 'string' ? opts.text : opts.text == null ? '' : String(opts.text);
  return computeContentPage(text, opts.pos, opts.maxChars);
}

const textCache = new Map();

function cacheGet(key) {
  const hit = textCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TEXT_CACHE_TTL) {
    textCache.delete(key);
    return null;
  }
  if (textCache.size > TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value);
  return hit.value;
}

function cacheSet(key, value) {
  if (textCache.size > TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value);
  textCache.set(key, { at: Date.now(), value });
}

/**
 * 单次尝试：拉当前章 SSR（psvts）-> 请求分片 -> 解码。
 * @returns {Promise<{ok:true, value:object, cookie:string}|{ok:false, error:object}>}
 */
async function fetchChapterOnce(cookie, bookId, chapterUid) {
  const state = await getReaderState(cookie, bookId, chapterUid);
  if (!state.ok) return { ok: false, error: { ok: false, code: state.code, error: state.error } };

  // SSR 可能刷新 cookie（wr_skey 轮换 / 失效时清 cookie），沿用最新的
  let latestCookie = cookie;
  const merged = parseCookie(cookie);
  if (mergeSetCookies(merged, state.setCookies)) latestCookie = serializeCookie(merged);

  const reader = state.reader;
  const psvts = reader.psvts ? String(reader.psvts) : '';
  if (!psvts) return { ok: false, error: { ok: false, code: 'NO_PSVTS', error: '阅读页没有 psvts，无法请求正文' } };

  const base = makeContentParams(bookId, chapterUid, psvts, { sc: 1 });
  const e0 = await postShard(latestCookie, bookId, 'e_0', base);
  if (!e0.ok) return { ok: false, error: { ok: false, code: e0.code || 'NETWORK', error: e0.error } };

  let lines = [];
  let format = 'epub';
  const e0Raw = e0.text || '';

  if (e0Raw.trim().startsWith('{')) {
    // EPUB 接口返回 JSON => TXT 格式书籍（或错误/无权限）
    let parsed = null;
    try {
      parsed = JSON.parse(e0Raw);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.bookId) {
      format = 'txt';
      const [t0, t1] = await Promise.all([
        postShard(latestCookie, bookId, 't_0', base),
        postShard(latestCookie, bookId, 't_1', base),
      ]);
      const decoded = decodeTxtShards(t0.ok ? t0.text : '', t1.ok ? t1.text : '');
      lines = normalizeLines(decoded);
    } else if (parsed && typeof parsed.errCode === 'number' && parsed.errCode !== 0) {
      return { ok: false, error: apiFailure(parsed, e0) };
    }
  } else {
    const [e1, e3] = await Promise.all([
      postShard(latestCookie, bookId, 'e_1', base),
      postShard(latestCookie, bookId, 'e_3', base),
    ]);
    const xhtml = decodeContentShards(e0Raw, e1.ok ? e1.text : '', e3.ok ? e3.text : '');
    lines = htmlToLines(xhtml);
    if (!lines.length && xhtml.trim()) {
      // 极少数书籍正文不是 XHTML，兜底按纯文本处理
      lines = normalizeLines(xhtml);
    }
  }

  if (!lines.length) {
    return {
      ok: false,
      error: {
        ok: false,
        code: 'CHAPTER_LOCKED',
        error: '正文为空：可能该章未购买/未解锁（未登录只能读免费章节），或分片签名被拒',
        psvts,
      },
    };
  }

  const book = reader.bookInfo || {};
  const chapters = (reader.chapterInfos || []).map((c) => ({
    chapterUid: Number(c.chapterUid),
    chapterIdx: c.chapterIdx,
    title: c.title || '',
    level: c.level || 1,
    wordCount: c.wordCount || 0,
    paid: c.paid || 0,
  }));
  const chapterIdx = chapters.findIndex((c) => c.chapterUid === Number(chapterUid));
  const meta = chapters[chapterIdx];

  // 正文首部通常会把「1」「科学边界」这类标题拆成独立行渲染；若开头若干行恰好
  // 拼出本章标题，就去掉这些行，避免正文第一屏出现孤零零的 "1"。
  if (meta && meta.title && lines.length > 1) {
    const want = String(meta.title).replace(/\s+/g, '');
    let prefix = '';
    let drop = 0;
    while (drop < 3 && drop < lines.length && prefix.length < want.length) {
      const cand = lines[drop].replace(/\s+/g, '');
      if (!cand) break;
      if (!want.startsWith(prefix + cand)) break;
      prefix += cand;
      drop += 1;
      if (prefix === want) break;
    }
    if (prefix && prefix === want && drop > 0 && drop < lines.length) {
      lines = lines.slice(drop);
    }
  }

  const text = lines.join('\n');

  // 无权限章节在 sc=1 下仍可能返回一段以 "..." 结尾的试读，长度远小于 wordCount。
  // 标记出来让宿主半决定是跳过还是当作试读展示。
  let preview = false;
  const wordCount = meta && meta.wordCount ? meta.wordCount : 0;
  if (wordCount > 600 && text.length < wordCount * 0.6) {
    const tail = text.trimEnd().slice(-12);
    if (/\.{2,}$/.test(tail) || tail.endsWith('…')) preview = true;
  }

  const value = {
    ok: true,
    lines,
    text,
    format,
    preview,
    book: {
      bookId: String(book.bookId || bookId),
      title: book.title || '',
      author: book.author || '',
      cover: book.cover || '',
    },
    chapters,
    chapter: meta || {
      chapterUid: Number(chapterUid),
      title: (reader.currentChapter && reader.currentChapter.title) || '',
      chapterIdx: -1,
    },
    chapterIndex: chapterIdx,
    psvts,
    user: state.user,
    cookie: latestCookie,
  };
  return { ok: true, value, cookie: latestCookie };
}

/**
 * 拉取并解密整章正文。
 *
 * 登录态说明（重要）：
 *  - 带**有效** cookie：可以读账号有权访问的全部章节（含已购/会员章节）。
 *  - 完全不带 cookie（或 cookie 为空）：能读 `bookInfo.maxFreeChapter` 范围内的免费/试读章节。
 *  - 带**无效** cookie：服务端会直接返回 `{}`，比不登录还差 —— 所以本函数在失败时
 *    会自动再试一次"完全匿名"。
 *
 * @returns {Promise<{ok:true, lines:string[], text:string, format:'epub'|'txt', book:object,
 *                    chapters:Array, chapter:object, chapterIndex:number, psvts:string,
 *                    user?:object, cookie?:string}
 *                 | {ok:false, code:string, error:string}>}
 */
export async function getChapterText(cookie, bookId, chapterUid) {
  if (!bookId || !chapterUid) return { ok: false, code: 'BAD_ARGUMENT', error: '缺少 bookId / chapterUid' };

  const cacheKey = `${bookId}:${chapterUid}`;
  const anonCacheKey = `${cacheKey}:anon`;
  // 只有"带登录态读到"的结果才能命中通用缓存；匿名结果只用于匿名/失效会话兜底
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const initialCookie = serializeCookie(parseCookie(cookie));
  const candidates = [];
  if (initialCookie) candidates.push(initialCookie);
  candidates.push(''); // 免费章节匿名可读

  let lastError = null;
  for (const candidate of candidates) {
    if (!candidate) {
      const cachedAnon = cacheGet(anonCacheKey);
      if (cachedAnon) return cachedAnon;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await fetchChapterOnce(candidate, bookId, chapterUid);
      if (res.ok) {
        // 只有真正带登录态（wr_vid+wr_skey）才算 auth；服务端清空登录态/仅剩游客 cookie 都算匿名
        const anonymous = !cookieHasLogin(parseCookie(res.cookie || ''));
        const value = { ...res.value, anonymous };
        if (res.cookie) value.cookie = res.cookie;
        cacheSet(anonymous ? anonCacheKey : cacheKey, value);
        return value;
      }
      lastError = res.error;
      const retryable = ['CHAPTER_LOCKED', 'NO_PSVTS', 'TIMEOUT', 'NETWORK', 'CONTENT_UNAVAILABLE'].includes(
        res.error && res.error.code,
      );
      if (!retryable) break;
    }
  }

  return lastError || { ok: false, code: 'CONTENT_UNAVAILABLE', error: '正文获取失败' };
}

/** 书籍划线/想法摘录（正文拿不到时的降级内容源）。 */
export async function getHighlights(cookie, bookId) {
  if (!bookId) return { ok: false, code: 'BAD_ARGUMENT', error: '缺少 bookId' };
  const ck = parseCookie(cookie);
  if (!cookieHasLogin(ck)) return { ok: false, code: 'NO_COOKIE', error: '未登录：缺少 wr_vid / wr_skey' };
  const res = await httpRequest(`${BASE}/web/book/bookmarklist?bookId=${encodeURIComponent(bookId)}`, {
    cookie: ck,
    referer: `${BASE}/web/reader/${wereadE(bookId)}`,
  });
  if (!res.ok) return { ok: false, code: res.code || 'NETWORK', error: res.error };
  const data = res.data || {};
  if (typeof data.errCode === 'number' && data.errCode !== 0) return apiFailure(data, res);
  const list = Array.isArray(data.updated) ? data.updated : [];
  const bookmarks = list
    .filter((b) => b && b.markText)
    .map((b) => ({
      bookmarkId: b.bookmarkId || '',
      chapterUid: Number(b.chapterUid),
      markText: b.markText || '',
      createTime: b.createTime || 0,
      type: b.type,
      range: b.range || '',
    }));
  const chapters = (Array.isArray(data.chapters) ? data.chapters : []).map((c) => ({
    chapterUid: Number(c.chapterUid),
    title: c.title || '',
  }));
  return { ok: true, bookmarks, chapters, book: data.book };
}

/**
 * 清空所有内存缓存（阅读页 SSR / 目录 / 已解密正文）。
 * 宿主半在登录、退出登录、切换账号后应调用，避免把上一个账号/过期会话的缓存内容带出来。
 */
export function clearCaches() {
  readerCache.clear();
  chaptersCache.clear();
  textCache.clear();
  qrSessionCache.clear();
}

/**
 * 取一段可滚动阅读的正文（宿主半的唯一正文入口）。
 *
 * @param {string} cookie
 * @param {object} opts
 * @param {string} opts.bookId
 * @param {number} opts.chapterUid  不传则取目录里第一段可读章节
 * @param {number} [opts.pos=0]     章节内字符偏移（上一页返回值，可任意位置继续）
 * @param {number} [opts.maxChars=1200] 单次返回的最大字符数（上限 4000）
 * @returns {Promise<{
 *   ok:true, bookTitle:string, chapterTitle:string, chapterUid:number,
 *   lines:string[], pos:number, hasMore:boolean, nextChapterUid:number|null,
 *   progress:number, chapterIndex:number, chapterCount:number,
 *   degraded?:boolean, cookie?:string
 * } | {ok:false, code:string, error:string, chapterUid?:number, nextChapterUid?:number|null, cookie?:string}>}
 */
export async function getContent(cookie, opts = {}) {
  const { bookId } = opts;
  if (!bookId) return { ok: false, code: 'BAD_ARGUMENT', error: '缺少 bookId' };
  const ck = parseCookie(cookie);
  const hasLoginCookie = cookieHasLogin(ck);
  // 默认遵守契约：未登录直接 NOT_LOGGED_IN；置 allowAnonymous=true 时允许读免费/试读章节
  const allowAnonymous = opts.allowAnonymous === true;
  if (!hasLoginCookie && !allowAnonymous) {
    return { ok: false, code: 'NOT_LOGGED_IN', error: '未登录：请先扫码或粘贴 Cookie', sessionExpired: false };
  }
  const pos = Math.max(0, Math.trunc(Number(opts.pos) || 0));
  const maxChars = clampInt(opts.maxChars || 1200, 120, 4000);

  // 目录（决定默认章节、下一章、进度）
  const chaptersRes = await getChapters(hasLoginCookie ? cookie : '', bookId);
  if (!chaptersRes.ok) {
    const expired = chaptersRes.code === 'NOT_LOGGED_IN' || chaptersRes.code === 'SESSION_EXPIRED';
    return {
      ...chaptersRes,
      code: expired ? 'SESSION_EXPIRED' : chaptersRes.code,
      sessionExpired: expired,
    };
  }
  const chapters = chaptersRes.chapters;
  if (!chapters.length) return { ok: false, code: 'NO_CHAPTERS', error: '该书没有可读章节' };

  let chapterIndex = 0;
  if (opts.chapterUid !== undefined && opts.chapterUid !== null) {
    chapterIndex = chapters.findIndex((c) => c.chapterUid === Number(opts.chapterUid));
    if (chapterIndex < 0) chapterIndex = 0;
  } else {
    // 默认从第一段有正文的章节开始：跳过 wordCount=0 的占位项，以及版权/封面这类"非正文"章
    const skipTitles = /^(版权信息|版权页|封面|扉页|目录|书名页|出版信息|插页)$/;
    let idx = chapters.findIndex((c) => c.wordCount > 0 && !skipTitles.test(String(c.title || '').trim()));
    if (idx < 0) idx = chapters.findIndex((c) => c.wordCount > 0);
    chapterIndex = idx >= 0 ? idx : 0;
  }

  const chapter = chapters[chapterIndex];
  const nextChapterUid = chapterIndex + 1 < chapters.length ? chapters[chapterIndex + 1].chapterUid : null;

  let chapterText = await getChapterText(cookie, bookId, chapter.chapterUid);

  // 有登录 cookie 但正文只能匿名读到（免费章节）=> 说明 cookie 已失效，按契约报 SESSION_EXPIRED
  if (chapterText.ok && chapterText.anonymous && hasLoginCookie && !allowAnonymous) {
    return {
      ok: false,
      code: 'SESSION_EXPIRED',
      error: '登录态已失效：当前只能读取免费章节，请重新扫码或粘贴 Cookie',
      sessionExpired: true,
      chapterUid: chapter.chapterUid,
      nextChapterUid,
      chapterIndex,
    };
  }

  if (!chapterText.ok) {
    // 降级 1：划线/想法原文摘录（pos 语义保持"字符偏移"，与正文模式一致）
    if (chapterText.code === 'CHAPTER_LOCKED' || chapterText.code === 'CONTENT_UNAVAILABLE') {
      const hl = await getHighlights(cookie, bookId);
      if (hl.ok && hl.bookmarks.length) {
        const sameChapter = hl.bookmarks.filter((b) => b.chapterUid === chapter.chapterUid);
        const pool = sameChapter.length ? sameChapter : hl.bookmarks;
        const marks = pool.map((b) => b.markText).filter(Boolean);
        if (marks.length) {
          const quoteText = marks.join('\n');
          const quoteTotal = quoteText.length;
          const qStart = Math.min(pos, quoteTotal);
          let qEnd = Math.min(quoteTotal, qStart + maxChars);
          if (qEnd < quoteTotal) {
            const nl = quoteText.lastIndexOf('\n', qEnd);
            if (nl > qStart) qEnd = nl;
          }
          return {
            ok: true,
            degraded: true,
            degradedReason: '正文接口不可用，已降级为划线/想法原文摘录',
            bookTitle: chapter.title || '',
            chapterTitle: chapter.title || '划线摘录',
            chapterUid: chapter.chapterUid,
            chapterIndex,
            chapterCount: chapters.length,
            lines: normalizeLines(quoteText.slice(qStart, qEnd)),
            pos: qEnd,
            hasMore: qEnd < quoteTotal,
            nextChapterUid,
            totalChars: quoteTotal,
            progress: Math.max(0, Math.min(100, Math.round(((chapterIndex + qEnd / (quoteTotal || 1)) / chapters.length) * 100))),
            cookie: chapterText.cookie,
          };
        }
      }
    }
    return {
      ok: false,
      code: chapterText.code,
      error: chapterText.error,
      chapterUid: chapter.chapterUid,
      nextChapterUid,
      chapterIndex,
      cookie: chapterText.cookie,
    };
  }

  // 与「整本缓存/离线阅读」共用同一套切页规则，保证缓存与在线两种来源翻页行为一致
  const fullText = chapterText.text || '';
  const page = computeContentPage(fullText, pos, maxChars);
  const total = page.totalChars;
  const frac = total > 0 ? page.pos / total : 1;
  const progress = Math.max(0, Math.min(100, Math.round(((chapterIndex + frac) / chapters.length) * 100)));

  return {
    ok: true,
    bookTitle: chapterText.book.title,
    bookAuthor: chapterText.book.author,
    chapterTitle: chapterText.chapter.title || chapter.title || '',
    chapterUid: chapter.chapterUid,
    chapterIndex,
    chapterCount: chapters.length,
    lines: page.lines,
    pos: page.pos,
    hasMore: page.hasMore,
    nextChapterUid,
    totalChars: total,
    progress,
    anonymous: Boolean(chapterText.anonymous),
    preview: Boolean(chapterText.preview),
    cookie: chapterText.cookie || chaptersRes.cookie,
  };
}

// ---------------------------------------------------------------------------
// 供探针/自检使用的内部导出（不属于稳定 API，宿主半请勿依赖）
// ---------------------------------------------------------------------------
export const __internal = {
  httpRequest,
  getReaderState,
  getReaderStateCached,
  extractInitialState,
  makeContentParams,
  checkedBody,
  swapPositions,
  reverseSwaps,
  repairUtf8,
  decodeEncodedPayload,
  htmlToLines,
  normalizeLines,
  md5hex,
  sha256hex,
  getShelfRaw,
  postShard,
  crc32,
};

export default {
  VERSION,
  BASE,
  DESKTOP_UA,
  createQrStore,
  createQrSession,
  pollQrSession,
  pollQrSessionWithOtp,
  validateCookie,
  renewSession,
  getShelf,
  getBookInfo,
  getChapters,
  getContent,
  getChapterText,
  getHighlights,
  searchBooks,
  clearCaches,
  sliceContentPage,
  wereadE,
  wereadSign,
  formatSortedQuery,
  signParams,
  parseCookie,
  serializeCookie,
  qrEncode,
  qrPngDataUrl,
  decodeContentShards,
  decodeStyleShard,
  decodeTxtShards,
  htmlToLines,
};
