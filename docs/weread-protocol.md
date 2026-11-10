# 微信读书 Web 协议（weread.qq.com）

> 本文是 `dsh-weread-moyu` 插件宿主半（`plugin/lib/index.js`）与协议层
> （`plugin/lib/weread.js`）的唯一协议事实来源。
>
> 图例：✅ = 本机实测确认；◐ = 已按页面 JS / 开源实现落地、等真实 cookie 复验；
> ❗ = 已知坑。
>
> 实测环境：2026-10，Windows，Node 24（`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1`），
> 出口直连 `weread.qq.com`（无代理）。

---

## 0. 速查

| 用途 | 方法与路径 | 鉴权 |
|---|---|---|
| 二维码 uid | `GET /api/auth/getLoginUid` | 匿名 |
| 二维码轮询 | `GET /api/auth/getLoginInfo?uid=&otp=` | 匿名（长轮询） |
| 二维码内容 | `https://weread.qq.com/web/confirm?uid=<uid>` | — |
| cookie 续期 | `POST /web/login/renewal` | cookie |
| 用户信息 | `GET /api/userInfo?userVid=<vid>` | cookie（或 `X-Vid`/`X-Skey`） |
| 书架 | `GET /web/shelf/sync?synckey=0&teenmode=0&album=1&onlyBook=0` | cookie |
| 书籍详情 | `GET /web/book/info?bookId=` | cookie |
| 目录（接口） | `POST /web/book/chapterInfos` body `{"bookIds":["<bookId>"]}` | cookie |
| 目录（SSR 降级） | `GET /web/reader/<_e(bookId)>` → `window.__INITIAL_STATE__.reader.chapterInfos` | 匿名 ✅ |
| 正文分片 EPUB | `POST /web/book/chapter/e_0`|`e_1`|`e_3` | cookie |
| 正文分片 TXT | `POST /web/book/chapter/t_0`|`t_1` | cookie |
| 样式分片 | `POST /web/book/chapter/e_2`（`st=1`） | cookie |
| 划线/想法 | `GET /web/book/bookmarklist?bookId=` | cookie |
| 搜索（无需登录） | `GET /api/store/search?keyword=&maxIdx=&count=` | 匿名 ✅ |
| 公众号文章列表 | `GET /web/mp/articles?bookId=MP_WXS_xxx&offset=` | cookie |
| 公众号文章正文 | `GET /web/mp/content?reviewId=` | cookie |

---

## 0.1 实测验收结果（2026-10-28，真实账号）

人类扫码登录后（vid=6293772，昵称「吃土的二师兄」）的端到端结果：

| 项 | 结果 |
|---|---|
| 扫码登录 | `LOGIN_OK`，cookie 写入 `~/.dsh/weread-moyu/session.json`（含 wr_vid/wr_skey/wr_rt/wr_ql/wr_gid/wr_fp） |
| `validateCookie` | `ok:true`，343ms，`bookCount:125`，昵称/头像正常 |
| 书架 | **125 本**；bookId/title/cover 125/125、author 124/125（1 本无作者）、progress 102/125（其余接口未返回）；**没有 chapterCount 字段**（见 §4 注） |
| 目录 | `三体` 走 `/web/book/chapterInfos`，`source:"api"`，109 章，uid/title/level/wordCount/paid 全部齐 |
| 正文（已购章节） | 三体第 120 章（27 无人忏悔）：登录后 **7395 字**、`preview:false`；同一章匿名只有 **192 字** 试读（`preview:true`） |
| 分页 | 登录态连续 6 页、每页 800 字上限：pos 682→1333→1932→2534→3330→3966，`hasMore` 正确，章末 `nextChapterUid=121` 正确 |
| 书末 | 倒数第二章 `hasMore:false, next=194`；最后一章 `next:null, progress:100` |
| 会话过期 | skey+rt 都失效时：`validateCookie → SESSION_EXPIRED`、`getShelf → SESSION_EXPIRED`、`getContent → SESSION_EXPIRED`；完全没 cookie → `NOT_LOGGED_IN` |
| 自动续期 | 只坏 skey、保留 wr_rt 时，读阅读页 SSR 会被服务端**自动换发新 skey**（Set-Cookie），正文仍可读；返回值的 `cookie` 是刷新后的会话，宿主半应覆盖保存 |
| 性能 | 冷启动整章 ~0.4s；命中缓存 1ms；连续翻页平均 ~70ms/页（含跨章） |

---

## 1. 请求头与 UA

所有请求统一带桌面浏览器 UA（正文签名只认 UA 派生值，别随便换）：

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
```

按场景追加：

| 场景 | 额外头 |
|---|---|
| 一般 JSON 接口 | `Accept: application/json, text/plain, */*`、`Referer: https://weread.qq.com/` |
| 登录相关 | `Referer: https://weread.qq.com/r/weread-skills` |
| POST 业务接口 | `Content-Type: application/json;charset=UTF-8`、`Origin: https://weread.qq.com` |
| 阅读页 SSR / 正文分片 | `Referer: https://weread.qq.com/web/reader/<_e(bookId)>` |
| 带 cookie 的 `api/userInfo` | `X-Vid: <wr_vid>`、`X-Skey: <wr_skey>`（cookie 也照发） |

✅ 实测：不带 `Referer` 也能通大部分接口，但带上是网页端的真实形态，风控更友好。
❗ Node 的 `fetch` 不会像浏览器那样自动带 cookie，本模块手工拼 `Cookie` 头。

---

## 2. Cookie

### 2.1 需要的 cookie

| 名字 | 含义 | 说明 |
|---|---|---|
| `wr_vid` | 用户 vid | 登录态必需 |
| `wr_skey` | 会话 token | 登录态必需；会随 `web/login/renewal` 轮换 |
| `wr_rt` | refresh token | 扫码登录时由 `refreshToken` 生成（**URL-encode 后**存入） |
| `wr_ql` | 登录方式标记 | 扫码登录后写 `0` |
| `wr_gid` | 游客 id | 首页 `Set-Cookie` 下发，用于匿名追踪 |
| `wr_fp` | 浏览器指纹（32 位十进制） | **本插件自造**：用于让不同安装/端之间互不顶号（见 §3.4） |

Cookie 头形态（`plugin/lib/weread.js#serializeCookie` 固定顺序输出）：

```
wr_vid=123456789; wr_skey=xxxxxx; wr_rt=yyyyyy; wr_ql=0; wr_gid=290785411; wr_fp=3421345678
```

### 2.2 校验与续期

- 校验：`GET /web/shelf/sync?...` 返回 `books` 即有效。✅
- 无效：`{"errCode":-2010,"errMsg":"用户不存在"}`（完全没登录态）或
  `{"errCode":-2012,"errMsg":"登录超时"}`（vid 在但 skey 失效/过期）。✅
  映射：`-2010 → NOT_LOGGED_IN`，`-2012 → SESSION_EXPIRED`。两种都要让用户重新登录。
- 续期：`POST /web/login/renewal`，body `{"rq":"%2Fweb%2Fbook%2Fread","ql":false}`，
  成功 `{"succ":1}` 并通过 `Set-Cookie` 轮换 `wr_skey`。✅ 实测：真实 cookie 续期成功且续期后的 cookie 可继续校验。
  → 宿主半应把返回值里的 `cookie` 覆盖写回 `session.json`。
  ❗ 失败时**不要**覆盖旧 cookie（避免把还能用的会话写坏）。
- ✅ **自动续期**：即使不主动调 renewal，只要 `wr_rt` 还有效，访问阅读页 SSR 时服务端会
  直接 `Set-Cookie` 一个新的 `wr_skey`（实测：只把 wr_skey 改坏、保留 wr_rt，正文依旧可读，
  且模块返回的 `cookie` 里是新 skey）。宿主半每次拿到带 `cookie` 的返回值都应覆盖保存。
- 只有 `wr_skey` 和 `wr_rt` 同时失效才算真过期（此时返回 `-2012` → `SESSION_EXPIRED`）。
  完全没登录态（或 cookie 里缺字段）是 `-2010` → `NOT_LOGGED_IN`。

---

## 3. 登录

### 3.1 二维码登录（主流程，✅ 已验证到"创建 + 轮询 waiting"）

```
1. GET https://weread.qq.com/          → Set-Cookie: wr_gid=...（预热）
2. GET /r/weread-skills                （网页端二维码登录用的 Referer 页）
3. GET /api/auth/getLoginUid           → {"uid":"60d516b6-5e17-433e-846d-9c97f9299e2b"}
4. 二维码内容 = https://weread.qq.com/web/confirm?uid=<uid>
   → 本模块用内置 QR 编码器渲染成 PNG data URL 交给前端 <img>
5. GET /api/auth/getLoginInfo?uid=<uid>&otp=
   - 长轮询，服务端最长挂 ~55s；未扫码/未确认时返回
     {"succeed":false,"logicCode":"LOGIN_TIMEOUT","canRetry":false}（实测 55.05s 返回）
   - 扫码后若账号需要网页端二次验证：{"succeed":false,"logicCode":"NEED_OTP"}
   - 成功：
     {"succeed":true,"webLoginVid":"<vid>","accessToken":"<skey>",
      "refreshToken":"<rt>","logicCode":"..."}
6. 落 cookie：
   wr_vid = webLoginVid
   wr_skey = accessToken
   wr_ql  = "0"
   wr_rt  = encodeURIComponent(refreshToken)
```

实测记录（匿名可复现部分）：

```
### getLoginUid  status=200  len=46
{"uid":"60d516b6-5e17-433e-846d-9c97f9299e2b"}

### getLoginInfo?uid=<uuid>&otp=  status=200  耗时 55054ms  len=62
{"succeed":false,"logicCode":"LOGIN_TIMEOUT","canRetry":false}
```

### 3.2 二维码编码（不依赖第三方包）

二维码内容是一段 74~75 字节的 ASCII URL，本模块自带：
- `qrEncode(text)`：byte 模式 QR，版本 1–10，EC 等级 L/M/Q/H，8 种掩码按罚分自动选择；
- `qrPngDataUrl(text)`：8-bit 灰度 PNG（zlib 压缩 + 自写 CRC32），`data:image/png;base64,...`。

✅ 验证方式（开发期，未随包发布）：
- 与 npm `qrcode-generator` 逐模块比对：同一内容、同一强制掩码下矩阵完全一致（数据编码、RS 纠错、交错、功能图形都正确）；
- 用独立解码器 `jsQR` 解码输出的 PNG 像素，能读回原文；
- 微信扫码由人工复验（本机无扫码条件）。

二维码当前参数：版本 5、37×37 模块、EC=M、缩放 6px、静默区 4 模块 → 270×270 PNG。

### 3.3 轮询节奏建议

服务端是长轮询，网页端一次请求会挂 60s。插件里：

- 前端 `GET /weread-moyu/api/qr/poll?uid=` → 宿主半调 `pollQrSession(uid, jar, {timeoutMs: 8000})`，
  超时即返回 `state:"waiting"`，前端 1~2s 后再发起下一轮（保证 UI 可取消、不漏状态）。
- 二维码有效期按 5 分钟算（`expiresAt`）；过期由前端点"刷新"重新 `GET /api/qr`。

状态映射（`pollQrSession`）：

| 上游 | 我们返回 |
|---|---|
| 长轮询超时（客户端超时） | `waiting` |
| `logicCode=NEED_OTP` / `OTP_NOT_MATCH` | `scanned` + `needOtp:true` |
| `succeed:true` | `confirmed` + `cookie` + `user` |
| `logicCode=LOGIN_TIMEOUT` | `expired` |
| `OTP_EXPIRED` | `expired` |
| 网络错误 | `waiting`（带 `transientError`），由前端继续轮询 |

❗ 上游没有独立的"已扫码未确认"状态，`scanned` 只表示"手机侧需要输入验证码"。
如需 4 位验证码，调 `pollQrSessionWithOtp(uid, otp, jar)`（宿主半可加一个 `POST /api/qr/otp`）。

### 3.4 ❗ wr_fp：多端登录互相顶号

参考实现在 2026-10-03 的对照实验：不带 `wr_fp` 时，B 登录后 A 立刻变成 `-2012`；
各自带独立 `wr_fp` 后两个会话可共存并各自续期。因此本插件：

- `createQrSession()` 内部生成随机 32 位十进制指纹（`createQrStore().fingerprint`），
  登录全过程作为 `wr_fp` cookie 携带，登录成功后**和会话 cookie 一起持久化**；
- 不要把这个值改成由 UA/账号派生（会造成安装间同号）。

### 3.5 备选登录方式（已实测可用，当前不用）

`wereread` 的另一个扫码入口是微信官方 `snsapi_login`（网页端"快速登录"iframe）：

```
GET https://open.weixin.qq.com/connect/qrconnect
      ?appid=wxd80042f4d6cfc9a6
      &redirect_uri=https%3A%2F%2Fweread.qq.com%2F
      &response_type=code&scope=snsapi_login&state=wr_login
   → 页面里有 https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>
   → 二维码图片：GET https://open.weixin.qq.com/connect/qrcode/<uuid>  （image/jpeg）
   → 轮询：GET https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>&_=<ts>
     返回 window.wx_errcode=408（等待）/404（已扫）/405（确认，含 wx_code）
   → 用 wx_code 调 POST /api/login/wxCode {webCode,isAutoLogout:false,isFromweb:true,state,vid}
```

✅ 实测：qrconnect 页面能解析出 uuid、二维码 JPEG 能取到（46KB）、轮询返回 408。
◐ 未实测：405 之后 `wx_code → /api/login/wxCode` 的落 cookie 细节。
**决策**：主流程用 §3.1（`getLoginUid`），因为它直接返回 `accessToken/webLoginVid`，
不依赖微信 appid 跳转；`qrconnect` 仅作为将来失效时的备胎，记录在此。

---

## 4. 书架

```
GET /web/shelf/sync?synckey=0&teenmode=0&album=1&onlyBook=0
Cookie: wr_vid=...; wr_skey=...
```

返回（截取关键字段，◐ 结构按网页端 store 代码整理）：

```json
{
  "books": [
    {
      "bookId": "695233",
      "title": "三体全集（全三册）",
      "author": "刘慈欣",
      "cover": "https://cdn.weread.qq.com/weread/cover/80/yuewen_695233/t6_yuewen_6952331784884457.jpg",
      "category": "精品小说-科幻小说",
      "format": "epub",
      "readUpdateTime": 1759043478,
      "finishReading": 0,
      "secret": 0,
      "lastChapterIdx": 109,
      "payType": 4097
    }
  ],
  "bookProgress": [
    { "bookId": "695233", "progress": 37, "chapterUid": 88, "chapterOffset": 120, "updateTime": 1759... }
  ],
  "albums": [ { "albumInfo": { "albumId": "...", "name": "...", "cover": "...", "trackCount": 12 } } ],
  "archive": [],
  "synckey": 1759043478
}
```

- `books[]` 的进度在 `bookProgress[]`（按 bookId 关联），`progress` 是整数百分比。
- 未购买/私密书籍（`secret`）仍会出现在书架里，但正文接口可能返回空 → 走 §7 降级。
- `onlyBookid=1` 是网页端用于"单本同步"的参数，本插件不用。
- 章节数不在该接口里（`chapterCount` 缺失）。可用的近似值是 `lastChapterIdx`（网页端自己的章号，含封面/版权等），
  精确章节数需要 `getChapters()` 单独拉一次目录；宿主半建议对"当前书"懒加载目录后缓存。
- 实测 125 本书里 1 本没有 `author`、23 本没有 `progress`（`bookProgress` 里没有对应条目），
  宿主半 UI 需要容忍空值。
- 服务端偶尔会下发脏 cookie `wr_pf=undefined`，`mergeSetCookies` 会把空值/`undefined`/`null` 当删除处理。

错误形态（真实）：

```
匿名 / 假 cookie：{"errCode":-2010,"errMsg":"用户不存在","errLog":"C4G09XX","info":""}
失效 cookie：    {"errCode":-2012,"errMsg":"登录超时",...}
```

---

## 5. 目录

### 5.1 接口（登录后用）

```
POST /web/book/chapterInfos
Content-Type: application/json;charset=UTF-8
Cookie: ...
{"bookIds":["695233"]}
```

返回：`{ data:[ { bookId, format, synckey, book:{...}, updated:[...] } ] }`（也可能是顶层单本对象）。

章节字段：

```json
{
  "chapterUid": 88,
  "chapterIdx": 3,
  "title": "刘慈欣致《三体》系列电子书读者",
  "level": 1,
  "wordCount": 16,
  "paid": 0,
  "price": 0,
  "updateTime": 1740758664,
  "tar": ""            // 有图章节才有：章节资源包（图片），本插件暂不处理
}
```

❗ `wordCount === 0` 的条目是封面/占位，`getContent` 默认跳过。
❗ 网页端会按 `bookInfo.copyrightChapterUids` 过滤版权页（如 `[87,91,132,149]`）；
本插件不过滤（多出的"版权信息"章节无害），若产品上不想要，宿主半自行跳过。

### 5.2 SSR 降级（匿名可用 ✅）

```
GET https://weread.qq.com/web/reader/<_e(bookId)>
```

页面里 `window.__INITIAL_STATE__={...}`（**不是 JSON.parse 能直接吃的**，它后面还跟着别的 script，
本模块用大括号配对扫描截取，见 `extractInitialState()`）。关键字段：

| 路径 | 内容 |
|---|---|
| `reader.bookInfo` | 书籍详情（同 §6.1） |
| `reader.chapterInfos` | 完整目录（实测三体全集 108 章） |
| `reader.currentChapter` | 当前章 |
| `reader.psvts` | **正文分片请求必需**（实测 `657322207ab02af4g0142f2`，每次访问会变） |
| `reader.pclts` | 进度上报用（`/web/book/read`） |
| `reader.progress` | 阅读进度 `{chapterUid, chapterOffset, progress}` |
| `reader.token` | 进度上报 `sg` 签名用 |
| `user` | 登录态下是 `{name, avatar, ...}`；匿名是空壳 |

✅ 实测匿名 SSR 能拿到：`bookInfo.title="三体全集（全三册）"`、108 章目录、`psvts`。
→ 所以"书架为空但想看公开书"也能出内容，作为正文不可用时的目录兜底。

---

## 6. 正文（核心）

### 6.1 流程

```
1. GET /web/reader/<_e(bookId)>k<_e(chapterUid)>     ← 拿该书该章的 SSR state
   关键：reader.psvts（每次访问都会变，必须用新鲜的）
2. 组装分片请求参数（见 §6.2），带 cookie POST：
   EPUB 书： e_0 → e_1 → e_3     （顺序固定，各分片先做 MD5 前缀校验）
   TXT 书：  t_0 → t_1
3. 连起来解码（见 §6.3）→ XHTML / 纯文本
4. 清洗成段落数组（去 script/style/标签、解实体、去空行），
   并去掉开头与本章标题重复的标题行（网页端把「1」「科学边界」渲染成两行 h1）；
5. 按 pos/maxChars 切片返回给前端
```

### 6.2 分片请求体 + 签名

```json
{
  "b": "_e(bookId)",
  "c": "_e(chapterUid)",
  "r": "randomInt(0,9999)^2",
  "ct": "当前 Unix 秒",
  "ps": "<reader.psvts>",
  "pc": "_e(ct)",
  "sc": 1,
  "prevChapter": false,
  "st": 0,
  "s": "<签名>"
}
```

- `sc=1` 才是整章；`sc=0` 只会给一小段预览（可能以 `...` 结尾）。
- `e_2`（样式）用 `st=1`，正文用 `st=0`。
- ❗ `pc` 不能等于 `ps`：若 `_e(ct) === psvts` 就把 `ct` 加 1（本模块已处理）。
- ❗ 签名里布尔必须是 JS 拼写 `false`，不能是 `False`/`False`。

**签名算法**（`wereadSign`）：

```text
query = 按 key 字典序拼 "k=encodeURIComponent(value)"，用 & 连接（无尾部 &）
a = b = 0x15051505
for i from len(query)-1 down to 1 step -2:
    a = (a ^ (charCode(query[i]) << ((len-i) % 30))) & 0x7fffffff
    b = (b ^ (charCode(query[i-1]) << (i % 30))) & 0x7fffffff
s = (a + b).toString(16)   // 小写
```

自检向量（`scripts/weread-probe.mjs selftest`）：

```text
b=c9c321c07293508bc9c79df&c=c81322c012c81e728d9d180&ct=1700000000
&pc=24932c107a21fe80g010f72&prevChapter=false&ps=f2532c207ab02ab5g017f96
&r=12345&sc=1&st=0
→ s = a48396ba          （st=1 → a48396bc）
```

### 6.3 `_e()` 混淆 ID

用于阅读页 URL、`b`、`c`、`pc`：

```text
1. h = md5(字符串)
2. result = h[0:3]
3. 纯数字：按 9 位切块，每块转十六进制；typeFlag='3'
   非数字：整串转 charCode 十六进制；typeFlag='4'
4. result += typeFlag + "2" + h[-2:]
5. 每块：两位十六进制长度 + 块内容，块间用 'g' 连接
6. 不足 20 位用 h 前几位补齐，最后追加 md5(result)[0:3]
```

向量（✅ 与真实阅读页 URL 对照过）：

```text
_e("43208843") = c9c321c07293508bc9c79df
_e("695233")   = ce032b305a9bc1ce0b0dd2a   // 三体全集，URL 实测一致
_e("2")        = c81322c012c81e728d9d180
_e("119")      = 07e323f027707e1cd7dc674
```

### 6.4 分片响应与解码

每个成功分片 = `大写MD5(正文 32 字符) + 混淆正文`。
解码步骤（`decodeContentShards` / `decodeEncodedPayload`）：

```text
1. 校验 MD5 前缀（必须一致；不一致说明请求被拒/结构变了）
2. 剥掉 32 字符前缀，按 e_0+e_1+e_3（或 t_0+t_1）顺序拼接
3. 丢掉拼接串的第 1 个字符
4. 由尾部字符（最多 4 个）的二进制串按 4 进制解析，推出 10 个交换位
5. 逆序还原字符交换
6. Base64-url → Base64（'-'→'+'，'_'→'/'），去掉非 base64 字符并补 '=' 
7. 解出来的字节按 latin1 串做多字节 UTF-8 修复（跨字节边界的字符）
8. → EPUB 书得到 XHTML；TXT 书得到 \r\n 分行的纯文本（行首全角空格缩进）
```

`swapPositions` 的细节（照参考实现，别"优化"）：

```text
len < 4  → []
len < 11 → [0, 2]
否则 n = min(4, floor((len+9)/10))
     tmp = 对最后 n 个字符，各取 str(parseInt(charCode.toString(2), 4)) 拼接
     m = len - n - 2;  step = len(str(m))
     每次从 tmp 取两个 step 长度的十进制数，各自 % m 作为交换位，最多 10 个
```

### 6.5 格式判定（EPUB vs TXT）

先请求 `e_0`：

- 响应以 `{` 开头且含 `"bookId"` → **TXT 书**（`e_*` 只回元数据），改用 `t_0`/`t_1`；
- 响应是 `md5hex...` 字符串 → **EPUB 书**，继续 `e_1`/`e_3`；
- 响应 `{}` 或空 → 登录态无效/签名被拒/psvts 过期（见 §6.6、§6.7）。

也可从阅读页 SSR 的 `reader.bookInfo.format` 预判（`epub` / `txt`），但不总是可靠，
本模块以 `e_0` 的实际响应为准。

✅ 两条路径都已实测跑通：

| 书 | bookId | format | 验证章节 | 结果 |
|---|---|---|---|---|
| 三体全集（全三册） | 695233 | epub | 94「1 科学边界」 | 8101 字 / 139 段，XHTML 解码 |
| 黄帝内经（中华国学经典精粹） | 25445333 | txt | 2「上古天真论篇第一」 | 3144 字，纯文本解码 |

其它 TXT 书样本（可用于回归）：`32212941`（中医许阳，780 章）、`465030`（凡人修仙传）、
`23475205`（都市极品医神）、`225111`（做最好的总裁，11 章，最短）。

### 6.6 未解锁章节：试读 instead of 报错

**实测结论（重要）**：即使是 `sc=1`，对没有权限的章节，服务端不会返回错误，而是返回
一段**以 `...` 结尾的试读**（约 100~300 字），HTTP 200、MD5 校验也正常。
所以"解码成功"不等于"拿到整章"。

识别方式（`fetchChapterOnce` 已实现）：目录里该章 `wordCount > 600`，而解出的正文
长度 < `wordCount * 0.6`，且结尾是 `...` / `…` → 标记 `preview:true`。

- `getContent` 把 `preview` 透传给宿主半，`hasMore:false`、`nextChapterUid` 指向下一章；
- 宿主半策略建议：`preview:true` 时提示"试读"并自动跳到下一章（或换书）；
- 真正返回空分片 `{}` 的情况是**登录态无效**（见 §6.7），不是"没权限"。

### 6.7 匿名可读性（未登录 / 登录态失效时的行为）

实测（2026-10）：

| 请求形态 | 服务端行为 |
|---|---|
| 完全不带 cookie | 免费/试读章节（`maxFreeChapter` 范围内）返回**完整正文**；超出范围返回 `...` 试读 |
| 带**有效** cookie | 账号有权访问的全部章节返回完整正文（含已购/会员） |
| 带**无效** cookie（wr_vid 在、wr_skey 假/过期） | 分片接口直接返回 `{}`（**比不登录还差**） |

因此 `lib/weread.js` 的策略：

1. `getChapterText()` 先用自己的 cookie 试，失败后**自动再试一次完全匿名**；
2. 判定"读到的内容算不算登录态"用 `cookieHasLogin()`（必须同时有 `wr_vid` + `wr_skey`），
   游客 cookie（`wr_gid`）不算；
3. `getContent()` 默认遵守宿主半契约：无登录 cookie → `{ok:false, code:'NOT_LOGGED_IN'}`；
   有登录 cookie 但正文只能匿名读 → `{ok:false, code:'SESSION_EXPIRED', sessionExpired:true}`
   （提示用户重新扫码）；
4. 需要"未登录也能试读"的场景（例如登录面板里的预览）传 `getContent(cookie, {allowAnonymous:true})`，
   此时返回 `anonymous:true` 的内容。

✅ 这条链路让**没有微信账号也能端到端验证解密**：`getChapterText('', '695233', 94)`
拿到《三体》第 1 章全文 8101 字（139 段），`getChapterText('', '25445333', 2)` 拿到
《黄帝内经》TXT 格式第 2 章 3144 字。开发/回归测试都靠这个。

---

## 7. 降级方案（拿不到整章正文时）

按优先级：

1. **匿名/免费章节**（`getChapterText` 自动兜底，✅ 实测可用）
   不登录也能读 `maxFreeChapter` 范围内的完整正文；登录态失效时先退到匿名再谈其它。
   这是"登录不了还能看到书"的第一层保障。
2. **试读段落**（`preview:true`）
   无权限章节会返回 100~300 字的开头 + `...`；宿主半可展示为"试读"，读完自动跳下一章。
3. **划线 / 想法原文摘录**（`GET /web/book/bookmarklist?bookId=`）
   返回 `updated[].markText`（用户自己划过的高亮原文）+ `chapters[]`。
   `getContent` 在该章正文不可用（`{}`）且存在划线时，返回 `degraded:true`，
   `lines` = 该章划线原文（不够整章，但都是真正文句子）。
4. **SSR 阅读页解析**：目录、书名、`psvts` 可匿名拿（§5.2）。
   注意新版阅读器是 canvas/horizon 渲染，SSR HTML **不含章节正文**，
   正文只能走分片接口 —— 所以这一条只用于元数据/目录，不用于正文。
5. **公众号文章**：`bookId` 以 `MP_WXS_` 开头时走 `/web/mp/articles` + `/web/mp/content`，
   正文是完整 HTML（`<div id="js_content">`），无加密。本插件 v0.1 未实现，宿主半可后补。
6. **服务端代理同一 cookie**（最终兜底）：插件在 DSH 侧边栏打开 `weread.qq.com/web/reader/...`，
   由用户已登录的浏览器上下文取文本。这条要求浏览器会话与插件 cookie 同源，
   仅作为产品层面的最后退路，不纳入 `lib/weread.js`。

底线：`getContent` 永远返回"可滚动的一段中文文本"（正文 → 试读 → 划线摘录），
不会返回空数组；真拿不到就返回 `{ok:false, code, error}` 让宿主半提示用户。

---

## 8. 分页（pos / maxChars）设计

- `pos` = 章节纯文本（段落用 `\n` 连接）里的**字符偏移**，不是字节偏移。
- 第一次 `getContent` 不传 `chapterUid` → 取目录里第一个 `wordCount > 0` 且不是
  版权/封面/扉页/目录的章节（`getContent` 内置跳过规则）。
- 返回 `pos` 是本页结束位置；`hasMore:true` 表示本章还有，继续用同一个 `chapterUid + pos` 取下一页。
- `hasMore:false` 时表示本章读完，带 `nextChapterUid`；宿主半用 `chapterUid=nextChapterUid, pos=0` 续读。
- 切片会对齐段落边界（向前找最近的 `\n`），避免半个段落。
- 默认 `maxChars=1200`，上限 4000（宿主半 API 的默认值也按这个走）。
- **在线与离线必须共用同一份切页实现**：`getContent` 内部调用导出的纯函数
  `sliceContentPage({text, pos, maxChars})`；宿主半做整本缓存时把 `getChapterText().text`
  落盘，`/content` 命中缓存后用同一个函数切页，保证两种来源的 `lines/pos/hasMore/totalChars`
  逐字节一致（`scripts/weread-probe.mjs selftest` 有 16 条断言，对同一 text 与参考实现逐字段比对）。
- `progress` = `(章内进度 + 章序号) / 总章数 * 100`，整数百分比，只用于 UI 显示。
- 宿主半不做服务端缓存也没问题：模块内有 LRU（12 章 / 30 分钟）缓存已解密正文，
  同一章连续翻页不会重复请求分片（只有第一次会打 SSR + 分片）。

---

## 9. 已知坑 / 限制

1. **必须用新鲜 `psvts`**：直接拿旧页面的 `psvts` 请求分片会返回 `{}`。每次进新章都要重新拉
   `/web/reader/<bookHash>k<chapterHash>`（模块内缓存 4 分钟）。
2. **`pc != ps`**：极端情况下 `_e(当前秒) == psvts`，要 +1 秒，否则空响应。
3. **登录长轮询**：`getLoginInfo` 会挂 55s，前端轮询接口必须做客户端超时（8s）+ 反复轮询，
   否则一次 HTTP 请求占住 1 分钟，UI 体验极差。
4. **多端顶号**：不带 `wr_fp` 时后登录的会话会把先登录的顶成 `-2012`（§3.4）。
5. **cookie 轮换**：`renewal` / 部分接口会 `Set-Cookie` 新 `wr_skey`，必须覆盖保存；
   失败不要覆盖（防止把坏 cookie 写死）。
6. **TXT 书**：`e_0` 返回 JSON 元数据而不是分片，必须切 `t_0/t_1`。
7. **付费章节**：无权限返回空分片；`sc=0` 的"预览"会以 `...` 结尾，不要当成整章。
8. **限速**：连续大量请求可能触发风控（返回空分片或 HTML 错误页）。拉整章时保持
   每章 1 次 SSR + 2~3 次分片，跨章之间可 sleep 100~200ms；本插件是逐页滚动，压力很小。
9. **`_e` / 签名不要"重构"**：这类混搭位运算（`<< 30`、`& 0x7fffffff`）在 Lua/Python/JS 里
   语义一致，但任何"看起来等价"的简化都会改变结果。
10. **接口会变**：2026-10 网页端已从旧版 `/web/login/getQRCode|getinfo`（现在 404）迁到
    `/api/auth/getLoginUid|getLoginInfo`；`/web/login/getuid` 也已 404。
    所有 URL 都集中在 `lib/weread.js` 顶部/函数内，改起来只改一处。
11. **`window.__INITIAL_STATE__` 不是纯 JSON**：不能正则 `(.*?)</script>` 之外还偷懒用
    `JSON.parse`，必须做括号配对（模块里已实现，且会跳过字符串内的括号）。
12. **运行环境**：系统 node 是 v16（没有全局 fetch/AbortSignal.timeout），必须用
    DSH 自带的 Node 24：`& "D:\Program Files\deepseekHarmess\DeepSeek Harness.exe" script.mjs`
    （已设 `ELECTRON_RUN_AS_NODE=1`）。
    ❗ electron-as-node 在**后台**跑长任务时会因为 stdin 被关闭而立刻退出（实测），
    要用 `cmd /c "\"<exe>\" \"<script>\" ... < NUL"` 启动。

---

## 10. 脚本与自检

```powershell
$exe = "D:\Program Files\deepseekHarmess\DeepSeek Harness.exe"

# 离线自检（哈希/签名/清洗/QR/PNG/cookie）
& $exe "D:\Alan\插件\scripts\weread-probe.mjs" selftest

# 二维码登录（人类扫码；PNG 落在 examples/weread-qr.png，成功后写 session.json）
& $exe "D:\Alan\插件\scripts\weread-login.mjs"

# 端到端
& $exe "D:\Alan\插件\scripts\weread-probe.mjs" all
& $exe "D:\Alan\插件\scripts\weread-probe.mjs" shelf
& $exe "D:\Alan\插件\scripts\weread-probe.mjs" chapters --book 695233

# 无账号也能验证正文解密（匿名读免费章节）
& $exe "D:\Alan\插件\scripts\weread-probe.mjs" content --book 695233 --chapter 94 --max 500
& $exe "D:\Alan\插件\scripts\weread-probe.mjs" content --book 25445333 --chapter 2 --max 500   # TXT 格式书
& $exe "D:\Alan\插件\scripts\weread-probe.mjs" walk --book 695233 --chapter 94 --pages 5 --max 800

# 登录后
& $exe "D:\Alan\插件\scripts\weread-probe.mjs" shelf --session "C:\Users\<user>\.dsh\weread-moyu\session.json"
& $exe "D:\Alan\插件\scripts\weread-probe.mjs" walk --book 695233 --pages 5   # 验证分页/跨章
& $exe "D:\Alan\插件\scripts\weread-probe.mjs" bookmarks --book 695233
```

后台跑长任务（扫码等待）必须用 `cmd /c "... < NUL"`，否则 electron-as-node 会立刻退出：

```powershell
cmd /c "`"$exe`" `"D:\Alan\插件\scripts\weread-login.mjs`" --timeout 1800 < NUL"
```

登录态文件（宿主半与脚本共用同一份）：

```
C:\Users\<user>\.dsh\weread-moyu\session.json
{"cookie":"wr_vid=...; wr_skey=...; ...","user":{...},"savedAt":1234567890123}
```

---

## 11. 模块 API（`plugin/lib/weread.js`）

所有函数**不抛出**网络/协议异常，返回 `{ ok:true, ... }` 或 `{ ok:false, code, error }`。
`cookie` 一律字符串传入；返回值里若带 `cookie` 表示服务端刷新了会话，宿主半应覆盖保存。

| 函数 | 说明 |
|---|---|
| `createQrSession(jar?)` | `{ok, uid, qrText, qrDataUrl, expiresAt, cookie, jar}`；`jar` 需在轮询时传回 |
| `pollQrSession(uid, jar, opts?)` | `{ok, state:'waiting'\|'scanned'\|'confirmed'\|'expired'\|'error', cookie?, user?, jar?}` |
| `pollQrSessionWithOtp(uid, otp, jar)` | 需要 4 位验证码时用 |
| `validateCookie(cookie)` | `{ok, user:{vid,nickname,avatar}, bookCount}` 或 `{ok:false, code:'SESSION_EXPIRED'\|'NOT_LOGGED_IN'}` |
| `renewSession(cookie)` | `{ok, cookie}`（续期后的 cookie）；✅ 实测真实 cookie 续期成功 |
| `clearCaches()` | 清空 SSR/目录/正文/二维码会话缓存；登录、退出、切号后宿主半应调用 |
| `getShelf(cookie, {force})` | `{ok, books:[{bookId,title,author,cover,progress,...}], albums, user, cookie}` |
| `getBookInfo(cookie, bookId)` | `{ok, book}`（走 SSR，匿名也可用） |
| `getChapters(cookie, bookId, {force?})` | `{ok, chapters:[{chapterUid,chapterIdx,title,level,wordCount,paid}], source:'api'\|'ssr', psvts, book}`；内部按 bookId 缓存 10 分钟，`force:true` 可绕过 |
| `getChapterText(cookie, bookId, chapterUid)` | `{ok, text, lines, format, preview, anonymous, book:{bookId,title,author,cover}, chapters:[{chapterUid,chapterIdx,title,level,wordCount,paid}], chapter:{chapterUid,title,...}, chapterIndex, psvts, user, cookie}`（整章解码结果，含 LRU 缓存；宿主「整本缓存」逐章下载用这个） |
| `sliceContentPage({text, pos?, maxChars?})` | **纯函数**离线切页：`{lines, pos, hasMore, totalChars}`，规则与 `getContent` 完全一致（maxChars clamp 120–4000、`lastIndexOf('\n')` 段落对齐、`normalizeLines`）；空 text 返回 `{lines:[],pos:0,hasMore:false,totalChars:0}` |
| `getContent(cookie, {bookId, chapterUid?, pos?, maxChars?, allowAnonymous?})` | 见 §8；返回 `preview`/`anonymous` 标记 |
| `getHighlights(cookie, bookId)` | `{ok, bookmarks:[{chapterUid,markText}], chapters}` |
| `searchBooks(keyword, opts)` | `{ok, books:[{bookId,title,author,cover,rating}]}`（匿名） |
| `wereadE(value)` / `wereadSign(query)` / `formatSortedQuery(obj)` | 协议原语（自检用） |
| `qrEncode` / `qrPngDataUrl` / `decodeContentShards` / `htmlToLines` | 底层工具，测试用 |

`getContent` 成功时的字段：

```js
{
  ok: true,
  bookTitle, bookAuthor, chapterTitle, chapterUid,
  chapterIndex, chapterCount,
  lines: string[],        // 段落数组（可直接滚动渲染）
  pos,                    // 本页结束处的字符偏移，下一页原样传回
  hasMore,                // 本章是否还有下一页
  nextChapterUid,         // 本章读完后的下一章（最后一章为 null）
  totalChars, progress,   // 章节总字数 / 全书百分比（本插件自算，仅 UI 用）
  preview,                // true = 只有试读（无权限章节）
  anonymous,              // true = 是匿名会话读到的（免费章节）
  degraded,               // true = 降级为划线摘录
  cookie                  // 可选：服务端刷新后的 cookie，宿主半应覆盖保存
}
```

失败时（宿主半契约）：

```js
{ ok:false, code:'NOT_LOGGED_IN'|'SESSION_EXPIRED'|'CHAPTER_LOCKED'|'BAD_ARGUMENT'|'NO_CHAPTERS'|'NETWORK'|..., error, sessionExpired?, chapterUid?, nextChapterUid? }
```

`validateCookie` 失败码：`NO_COOKIE`（没传）/ `NOT_LOGGED_IN`（-2010）/ `SESSION_EXPIRED`（-2012）。

❗ **缓存与过期**：已解密正文有 30 分钟内存缓存（按 `bookId:chapterUid`），目录 10 分钟、
阅读页 SSR 4 分钟。因此会话过期后，**已经读过的章节仍会返回 `ok:true`**（避免滚动中断），
未缓存的章节才返回 `SESSION_EXPIRED`。宿主半判断登录态应当始终用 `validateCookie` / `getShelf`，
不要依赖 `getContent` 的返回码。登录态变化（登录/退出/切号）后请调 `clearCaches()`。

---

## 12. 参考实现（只作线索，均以本机实测为准）

- `finlater/weread.koplugin`（KOReader 插件，Lua + Python 验证脚本）：
  `docs/weread-api-reference.md`、`scripts/fetch_weread_epub.py`（正文分片请求/解码）、
  `weread/lib/qr_login.lua`（`getLoginUid/getLoginInfo` + `wr_fp`）、`client.lua`（renewal）。
- 微信读书网页端 JS（`cdn.weread.qq.com/web/wrwebnjlogic/js/*.js` 与
  `cdn.weread.qq.com/web/wrweb-next/_nuxt/*.js`）：登录弹窗、`chapterInfos`、
  `shelf/sync`、`formatObjToSortedQuery`、`generateAppId` 的原始实现。
- 旧的 `/web/login/getQRCode`、`/web/login/getinfo`、`/web/book/chapter/e_0` GET 形式，
  2026-10 已 404 / 变更，网上老教程多半已过时。

---

## 13. 变更记录

- 2026-10-28：
  - 首版。二维码登录（`/api/auth/*`）、书架、目录（接口 + SSR 降级）、
    正文分片解密（EPUB/TXT）、划线降级、分页设计、QR 编码器落地并通过独立解码器验证。
  - 追加实测：**匿名可读免费章节**（`maxFreeChapter` 范围内完整正文），
    **无效 cookie 反而会让分片接口返回 `{}`**（因此实现"失败自动退匿名"）；
    无权限章节在 `sc=1` 下返回以 `...` 结尾的试读 → 增加 `preview` 判定。
  - EPUB（三体 695233 第 1 章 8101 字）与 TXT（黄帝内经 25445333 第 2 章 3144 字）
    两条解码链路均完成端到端实测（无需登录）。
  - 真实账号扫码登录成功后的全链路验收（见 §0.1）：书架 125 本、三体第 120 章登录后
    7395 字（匿名仅 192 字试读）、分页/章末/书末/过期码全部符合契约。
  - 新增 `clearCaches()`；修正 `validateCookie` 的 bookCount 取数；
    跳过正文开头的标题重复行；目录缓存 10 分钟；过滤 `wr_pf=undefined` 脏 cookie。
- 2026-10-28（v0.1.4 整本缓存 / 离线阅读）：
  - 新增纯函数 `sliceContentPage({text, pos, maxChars})`，`getContent` 改为复用它切页，
    保证「在线 / 本地缓存」两种来源翻页语义逐字段一致。
  - `getChapterText` 返回体确认包含宿主落盘所需字段：
    `text`（整章纯文本）/`preview`/`anonymous`/`book.title`/`book.author`/`chapter.title`
    （另有 `lines`/`format`/`book.cover`/`chapters`/`chapterIndex`/`psvts`/`cookie`）。
  - 实测（真实账号 + 真实章节）：`sliceContentPage` 与在线 `getContent` 在
    EPUB《三体》ch94/ch120、TXT《黄帝内经》ch2 上各 7 种分页用例 **21/21 全部一致**；
    selftest 从 28 增至 44 条断言（新增 16 条切页断言，离线不联网）。
