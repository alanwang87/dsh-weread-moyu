#!/usr/bin/env node
/**
 * 微信读书扫码登录（给人类用的一次性脚本）
 * ---------------------------------------------------------------
 * 运行后：
 *   1. 生成登录二维码 PNG 到  examples/weread-qr.png
 *   2. 在 stdout 打印图片绝对路径（用图片查看器/浏览器打开后用微信扫码）
 *   3. 长轮询登录结果；二维码过期会自动换一张（重写同一个 PNG 文件）
 *   4. 登录成功后把 cookie 落盘到  ~/.dsh/weread-moyu/session.json
 *      格式： {"cookie":"...","user":{...},"savedAt":<ms>}
 *      并打印  LOGIN_OK
 *
 * 运行方式（系统 node 是 v16，太旧，用 DSH 自带的 Node 24 / electron-as-node）：
 *   $exe = "D:\Program Files\deepseekHarmess\DeepSeek Harness.exe"
 *   & $exe "D:\Alan\插件\scripts\weread-login.mjs"
 *
 * 可选参数：
 *   --out <png 路径>     二维码 PNG 输出路径（默认 <项目根>/examples/weread-qr.png）
 *   --session <json 路径> 登录态输出路径（默认 ~/.dsh/weread-moyu/session.json）
 *   --attempts <n>       二维码过期后最多重新生成几次（默认 3）
 *   --timeout <秒>       整体超时（默认 600）
 *   --cookie-only        只创建二维码并落 PNG 后退出（不轮询）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MODULE_URL = pathToFileURL(join(ROOT, 'plugin', 'lib', 'weread.js')).href;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}
function argFlag(name) {
  return argv.includes(name);
}

const OUT_PNG = resolve(argValue('--out', join(ROOT, 'examples', 'weread-qr.png')));
const SESSION_PATH = resolve(argValue('--session', join(homedir(), '.dsh', 'weread-moyu', 'session.json')));
const MAX_ATTEMPTS = Math.max(1, Number(argValue('--attempts', '3')) || 3);
const OVERALL_TIMEOUT_MS = Math.max(30, Number(argValue('--timeout', '600')) || 600) * 1000;
const COOKIE_ONLY = argFlag('--cookie-only');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function savePngFromDataUrl(dataUrl, filePath) {
  const comma = dataUrl.indexOf(',');
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buf);
  return buf.length;
}

function saveSession(cookie, user) {
  const payload = {
    cookie,
    user: user || null,
    savedAt: Date.now(),
  };
  mkdirSync(dirname(SESSION_PATH), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function cleanupText(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : s;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const main = async () => {
  const mod = await import(MODULE_URL);
  const { createQrSession, pollQrSession, pollQrSessionWithOtp, validateCookie, getShelf } = mod;

  log('[weread-login] 模块已加载：', MODULE_URL);
  log('[weread-login] 二维码 PNG：', OUT_PNG);
  log('[weread-login] 登录态落盘：', SESSION_PATH);

  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  let otpReader = null;
  // 兜底：一旦拿到登录成功的 cookie，先记在这里；即使后续任何代码抛错也要落盘
  let pendingSession = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (Date.now() > deadline) {
      log('LOGIN_TIMEOUT 超过整体超时时间');
      return 1;
    }

    const qr = await createQrSession();
    if (!qr.ok) {
      log('QR_FAILED', qr.code, cleanupText(qr.error));
      return 1;
    }
    const pngBytes = savePngFromDataUrl(qr.qrDataUrl, OUT_PNG);
    log('');
    log(`QR_PNG ${OUT_PNG} (${pngBytes} bytes, attempt ${attempt}/${MAX_ATTEMPTS})`);
    log(`QR_UID ${qr.uid}`);
    log(`QR_CONTENT ${qr.qrText}`);
    log(`QR_EXPIRES ${new Date(qr.expiresAt).toISOString()}`);
    log('');
    log('>>> 请用手机微信扫描上面这张 PNG（或浏览器打开该文件）。');
    log('>>> 手机上确认登录后，本脚本会自动保存 cookie 并打印 LOGIN_OK。');
    log('');

    if (COOKIE_ONLY) {
      log('COOKIE_ONLY 已生成二维码，未轮询');
      return 0;
    }

    let jar = qr.jar;
    let expired = false;
    let confirmed = null;

    while (Date.now() < qr.expiresAt && Date.now() < deadline) {
      // 25s 一次长轮询；服务端通常挂起到状态变化
      let res;
      try {
        res = await pollQrSession(qr.uid, jar, { timeoutMs: 25000 });
      } catch (err) {
        // 轮询层异常不能拖垮整个登录流程
        log('POLL_WARN', cleanupText(err && err.message));
        await sleep(1500);
        continue;
      }
      jar = res.jar || jar;

      if (res.state === 'confirmed' && res.cookie) {
        confirmed = res;
        pendingSession = globalThis.__wereadPendingSession = { cookie: res.cookie, user: res.user || null };
        break;
      }
      if (res.state === 'expired') {
        log('QR_EXPIRED 二维码过期，准备刷新');
        expired = true;
        break;
      }
      if (res.state === 'scanned' && res.needOtp) {
        // 少数账号扫码后需要在网页端输入手机上的 4 位验证码
        if (!otpReader && process.stdin.isTTY) {
          otpReader = createInterface({ input: process.stdin, output: process.stdout });
        }
        if (otpReader) {
          const code = (await otpReader.question('请输入手机上的 4 位验证码：')).trim();
          const otpRes = await pollQrSessionWithOtp(qr.uid, code, jar, { timeoutMs: 15000 });
          jar = otpRes.jar || jar;
          if (otpRes.state === 'confirmed' && otpRes.cookie) {
            confirmed = otpRes;
            pendingSession = globalThis.__wereadPendingSession = { cookie: otpRes.cookie, user: otpRes.user || null };
            break;
          }
          log('OTP_NOT_OK', cleanupText(otpRes.error || otpRes.state));
        } else {
          log('OTP_REQUIRED 该账号需要 4 位验证码，但当前不是交互终端；请在 TTY 中重新运行本脚本。');
          return 2;
        }
      }
      // waiting / 瞬时网络错误：继续轮询
      await sleep(800);
    }

    if (confirmed) {
      // ⚠️ 先落盘再校验：校验只是锦上添花，绝不能因为校验抛错丢掉刚拿到的登录态
      const fallbackUser = confirmed.user || null;
      saveSession(confirmed.cookie, fallbackUser);
      log('');
      log('SESSION_SAVED', SESSION_PATH);
      let check = null;
      try {
        check = await validateCookie(confirmed.cookie);
      } catch (err) {
        log('COOKIE_CHECK_WARN', 'validateCookie threw:', cleanupText(err && err.message));
      }
      if (check && check.ok) {
        saveSession(check.cookie || confirmed.cookie, check.user || fallbackUser);
        log('USER', JSON.stringify(check.user || fallbackUser));
        log('SHELF_BOOKS', check.bookCount);
      } else if (check && !check.ok) {
        log('COOKIE_CHECK_WARN', check.code, cleanupText(check.error));
      }
      log('LOGIN_OK');
      log('SESSION', SESSION_PATH);
      if (otpReader) {
        otpReader.close();
        otpReader = null;
      }
      return 0;
    }

    if (!expired && Date.now() >= deadline) {
      log('LOGIN_TIMEOUT 轮询超时');
      return 1;
    }
  }

  if (otpReader) otpReader.close();
  log('QR_FAILED 所有二维码都已过期，请重新运行本脚本');
  return 2;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('UNEXPECTED_ERROR', err && err.stack ? err.stack : err);
    // 极端兜底：已经拿到登录 cookie 却在中途抛错时，仍然把登录态写进 session.json
    try {
      const st = globalThis.__wereadPendingSession;
      if (st && st.cookie) {
        saveSession(st.cookie, st.user || null);
        console.error('SESSION_SAVED_FALLBACK', SESSION_PATH);
        console.error('LOGIN_OK');
      }
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
