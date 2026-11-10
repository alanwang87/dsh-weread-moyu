# DSH 微信读书摸鱼背景插件 — 构建契约（Lead 维护）

> 本文件是团队协作的唯一事实来源。客户端半、宿主半、微信读书协议三块可以并行开发，
> 但必须遵守这里定义的接口与文件边界。

## 目标

在 DeepSeek Harness（DSH）Web GUI 里安装一个插件，实现：

1. **登录微信读书**：扫码登录（优先）或粘贴 Cookie 登录，登录态持久化。
2. **把读书内容当背景**：书页正文以低对比度、可调速滚动的文字层铺在 DSH 界面背后，
   聊天界面半透明浮在上面，看起来像编辑器/文档工作区，用于上班摸鱼。
3. **可隐藏**：一个极不显眼的控制入口；随时一键关闭背景、调透明度/字号/速度、
   切换书籍与章节。

## 插件包

- 包名：`dsh-weread-moyu`，版本 `0.1.0`，`type: module`，纯 ESM。
- 目录：`D:\Alan\插件`（仓库根即插件包根）
- `package.json` 关键字段：
  ```json
  {
    "name": "dsh-weread-moyu",
    "version": "0.1.0",
    "type": "module",
    "main": "lib/index.js",
    "exports": {
      ".": "./lib/index.js",
      "./client": "./client/client.js",
      "./cordis.patch.yml": "./cordis.patch.yml",
      "./package.json": "./package.json"
    },
    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },
      "client": { "platform": "web", "inject": [] }
    }
  }
  ```
- `cordis.patch.yml`：
  ```yaml
  - insert:
      - id: weread-moyu
        name: 'dsh-weread-moyu'
  ```

## 宿主半（Lead 负责：plugin/lib/index.js）

Cordis 插件，导出 `name`、`apply(ctx, config)`。职责：

1. 用 `ctx.webServer` 注册只允许 loopback 的 HTTP 路由（前缀 `/weread-moyu/api`）。
2. 微信读书登录态（Cookie）持久化到 `~/.dsh/weread-moyu/session.json`。
3. 聚合微信读书读取逻辑（`lib/weread.cjs` 或 `.js`，Node 侧 fetch）。
4. 暴露 JSON API 给客户端半（见下）。

### API（客户端半只依赖这些）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/weread-moyu/api/status` | `{ loggedIn, user:{vid,nickname}, books:[{bookId,title,author,cover,progress,chapterCount}], currentBookId, sessionExpired }` |
| GET | `/weread-moyu/api/qr` | 创建登录二维码：`{ ok, uid, qrDataUrl, expiresAt }` 或 `{ ok:false, error }` |
| GET | `/weread-moyu/api/qr/poll?uid=` | `{ state: "waiting"\|"scanned"\|"confirmed"\|"expired"\|"error", nickname? }` |
| POST | `/weread-moyu/api/login/cookie` | body `{ cookie: "wr_vid=...; wr_skey=...;" }`，校验并保存 |
| POST | `/weread-moyu/api/logout` | 清空登录态 |
| GET | `/weread-moyu/api/books/:bookId/chapters` | `{ chapters:[{chapterUid,title,level,wordCount}] }` |
| GET | `/weread-moyu/api/content?bookId=&chapterUid=&pos=` | `{ title, chapterTitle, lines:[...], pos, progress, hasMore, nextChapterUid }` |
| GET | `/weread-moyu/api/ping` | `{ ok:true, version:"0.1.0" }` 供安装验证用 |

- 全部响应 `content-type: application/json; charset=utf-8`，附带 `cache-control: no-store`。
- 路由未登录时返回 `{ ok:false, code:"NOT_LOGGED_IN" }` 而不是 500。
- 服务端不记录 Cookie/正文日志。

## 客户端半（Teammate A 负责：plugin/client/client.js）

手写 DSH 客户端 bundle，不引入构建工具，格式必须是：

```js
window.__ModuleLoader__.load({
  id: "dsh-weread-moyu",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // ... 纯 DOM 实现，不 require 任何包（可 require("react") 但不要求）
    exports.name = "weread-moyu"
    exports.apply = function apply(ctx) { ... }
    return module.exports
  }
});
```

### 视觉要求（核心验收）

- 在 `document.body` 下插入一个 `position:fixed; inset:0; z-index:0; pointer-events:none` 的
  背景层 `#weread-moyu-layer`，内嵌阅读文字列（宽约 62ch，居中偏左/居中，字号 15-18px，
  行高 1.9，颜色 `var(--dsw-alias-label-secondary, #8a8f98)`，整体 `opacity: 0.16` 左右）。
- 让 DSH 外壳背景变透明/半透明：向 `<head>` 注入 `<style id="weread-moyu-style">`，
  覆盖 `--dsw-alias-bg-base` 等背景 token 为 `rgba(...)`，并给 `html, body, #root` 相关
  容器设置 `background: transparent !important`（用 `:where()` 降低选择器权重也可以）。
  具体 class 选择器由 A 在 `examples/client-harness/` 里实验确定，并用真实 DSH CSS 变量兜底。
- 控制入口：右下角一个 14x14px、透明度 0.25 的小圆点，鼠标悬停才变明显；点击打开
  `#weread-moyu-panel` 面板（固定定位，宽 360px），包含：
  - 登录区：二维码 `<img>`（`/weread-moyu/api/qr` + 轮询）、Cookie 粘贴输入框、退出登录；
  - 书籍列表（选中当前书）、章节列表；
  - 滑块：透明度、字号、滚动速度；开关：启用背景、点击穿透；
  - 状态行：当前书名/章节/进度。
- 内容自动滚动：每 N 毫秒向上移动 1px（速度滑块 0–3 档，0 表示暂停）；读到底自动
  请求下一页/下一章并继续。
- 所有配置存 `localStorage["weread-moyu:config"]`（JSON），刷新后保留。
- 背景层必须 `pointer-events:none`，不能影响聊天交互；面板关闭时也不拦截点击。
- `apply(ctx)` 里用 `ctx.effect(() => () => cleanup)` 注册清理函数（若存在），否则用
  `window.addEventListener("beforeunload")` 兜底，卸载时移除 DOM 与 style。
- 首次安装后用 `GET /weread-moyu/api/ping` 判断宿主半是否就绪，未就绪时面板显示提示。
- 客户端应用 `fetch` 使用相对路径，不硬编码端口。

## 安装与验证（Lead 负责）

- 安装命令（Desktop 自带 CLI）：
  `dsh plugin --profile desktop add "file:D:\Alan\插件"`，然后确保 profile 的
  `package.json` 中 `dsh.profile.bundles` 含 `dsh-weread-moyu`。
- 验证：
  1. `GET http://127.0.0.1:<port>/plugins/dsh-weread-moyu/client.js` 返回 bundle（或
     通过 boot graph 确认注册）；
  2. `GET /weread-moyu/api/ping` 返回 `{ok:true}`；
  3. 真实 GUI 中打开面板、登录、背景文字出现（截图或 DOM 断言）。

## 文件写入边界（避免并行冲突）

| 角色 | 独占写入 |
|---|---|
| Teammate A | `plugin/client/**`、`examples/**`、`docs/client-plugin-contract.md` |
| Teammate B | `plugin/lib/weread.js`、`scripts/**`、`docs/weread-protocol.md` |
| Lead | `package.json`、`cordis.patch.yml`、`lib/index.js`、`docs/spec.md`、根 `README.md`、`install.ps1`、`tests/**` |

公共接口变化必须先改本文件。

## 实现状态与验证记录（2026-10-28）

### 安装机制（实测结论）

- `dsh plugin --profile desktop add "file:...\plugin"` 会 **同时** 完成：把包写入
  profile `node_modules`、把 `dsh-weread-moyu` 追加进 `dsh.profile.bundles`。
- file: 依赖在 profile 中是**硬链接副本**，pnpm 认为“unchanged”时不会重拷 -> 改完插件
  源码要重新同步。`install.ps1` 因此在 `add` 之后手动刷新
  `lib/`、`client/`、`package.json`，保证 profile 拿到最新文件。
- **客户端 bundle 只在 Host 启动时进入 boot graph**；运行中改 client.js 不会生效，
  必须重启 DeepSeek Harness（桌面版宿主进程随应用退出/启动）。
- Host 半（lib/index.js）在安装后可以随 profile 配置热加载，但已加载的 ESM 模块
  不会因文件变化重新求值；因此最终交付同样以“重启一次”为准。

### 已验证（真实环境）

| 项 | 结果 |
|---|---|
| boot graph 含 `dsh-weread-moyu` 行 | ✅ `/plugins/??dsh-weread-moyu/client.js&rev=...` |
| bundle 正确服务并注册 factory | ✅ `tests/boot-graph-check.mjs` |
| 真实 GUI 背景层/面板/点击穿透 | ✅ 无头 Edge DOM 断言 + 截图 `examples/live-*.png` |
| 宿主 API（ping/status/qr/books/chapters/content） | ✅ `tests/host-smoke.mjs` 8/8 |
| 扫码登录 | ✅ 人类微信扫码，`~/.dsh/weread-moyu/session.json` 落盘（cookieLen=113） |
| 书架 | ✅ 125 本，含 title/author/cover/progress |
| 章节 | ✅ 平凡的世界 175 章（含封面/版权页等非正文项） |
| 正文解密/分页 | ✅ 登录态《平凡的世界》第一章 2931 字、pos 递增、hasMore 正确；匿名也能读免费章节（三体第 1 章 8101 字） |
| 非正文页垃圾（封面页返回 XML） | 由客户端章节过滤 + 内容兜底跳过（见 client.js `JUNK_CHAPTER_RE`） |
| peek「看清当前页」按钮/浮层 | ✅ v0.1.2：`#weread-moyu-peek` + `#weread-moyu-peek-panel`，真实 GUI 断言通过（打开、正文>80字、书名=《择日飞升》、下一页内容前进、Esc 关闭），截图 `examples/live-peek-peek.png` |
| 内容 API 书名/章节字段 | ✅ `/content` 同时返回 `bookTitle/chapterTitle` 与兼容别名 `title/chapter`，peek 标题不再显示成「微信读书」 |
| 章节目录章号 + 跳章（v0.1.3） | ✅ 真实 GUI 断言：章节行匹配「第 N 章」、头部「共 1060 章」、`#wm-jump-input` 跳到第 500 章后状态行/peek 均显示「第 500 章」；截图 `examples/live-chapters-chapters.png` |
| 整本缓存 / 离线阅读（v0.1.4） | ✅ 真实宿主把《浮生六记》20 章整本缓存完成（99,913 字 / 300 KB / 约 20 秒）；`/content` 命中本地缓存 `source:"cache"`，实测 12ms（在线约数百 ms），章节列表/peek 均显示「本地缓存」；缓存行显示「已缓存 · 294 KB + 清除缓存」；缓存单元测试 8/8；真实 GUI 断言全过，截图 `examples/live-cache-cache.png` |
| peek 连续滚动阅读器 + 字号/缩放（v0.1.5） | ✅ 真实 GUI 断言：peek 正文 computed font-size == cfg.fontSize、A+ 变大并持久化、浮层为连续滚动容器且滚到底自动续载（无重复段落）、拖拽手柄放大窗口且 peekWidth 持久化；harness 136/91/136 全过，截图 `examples/live-v015-peek15.png` |
| peek 上一章/下一章按钮（v0.1.6） | ✅ 真实 GUI 断言：`上一章`/`下一章` 按钮加载相邻章节（自动跳过非正文页，首/末章轻提示）；harness 138/93/138 全过 |
| peek 底部无缝跨章（v0.1.7） | ✅ wheel/触摸/渲染后三路贴近底部补载（带 4s 活跃门控防无限预载）；真实 GUI 断言：滚到底自动加载、wheel 兜底不回退；harness 138/93/138 全过，两轮 0 FAIL |
| 离线免登录阅读 + 续读位置（v0.1.8） | ✅ 隔离 DSH_HOME 实测：登录→缓存整本→登出后，`/content`、`/chapters` 免登录返回本地数据（source=cache / offline=true），书架显示「离线缓存（免登录可读）」分组并可选中阅读（非 demo）；跳到第 5 章→刷新页面后自动恢复第 5 章 + 本地缓存；浏览器断言 8/8 全过 |

### 待办

- 每次改客户端 bundle 后都必须重启 Desktop 应用才能生效（v0.1.2 peek、v0.1.3 章号/跳章、v0.1.4 整本缓存、v0.1.5 滚动阅读器、v0.1.6 上一章/下一章、v0.1.7 底部无缝跨章、v0.1.8 离线免登录同样如此）。
- 若上游接口变化，按 `docs/weread-protocol.md` 修复。
- 断网场景未做真机断网演练；`source:"cache"` 路径在代码上不调用上游，后续可补网络隔离测试。

### 更新历史

- v0.1.8（2026-10-29）：已缓存书籍免登录可读——/content、/chapters 在未登录时直接返回
  本地缓存数据（账号绑定仅防串号：登录其他账号时不读上一账号的缓存）；客户端未登录时
  书架显示「离线缓存」分组、打开自动续读上次位置；离线模式下隐藏「缓存整本/继续缓存」下载按钮。
- v0.1.7（2026-10-29）：peek 底部无缝跨章——wheel/touchmove/渲染后三路贴近底部即补载
  （此前滚轮在绝对底部不产生 scroll 事件导致卡章尾），带 4 秒活跃门控防无限预载。
- v0.1.6（2026-10-29）：peek 浮层底部新增「上一章 / 下一章」按钮（跳过非正文页，首/末章轻提示，
  与连续滚动阅读共存）。
- v0.1.5（2026-10-28）：peek 浮层重构为**连续滚动阅读器**——完整镜像背景层已加载内容（滚动到底
  自动续载下一页/下一章，消除翻页式窗口的重复段落问题），关闭时背景层同步到浮层当前阅读位置；
  头部 A-/A+ 字号快捷键与设置滑块联动；左下角拖拽缩放手柄（peekWidth/peekHeight 持久化，双击恢复默认）。
- v0.1.4（2026-10-28）：整本缓存 / 离线阅读。宿主把整本章节正文缓存到
  `$DSH_HOME/weread-moyu/cache/<bookId>/`（账号绑定、原子写、断点续传、取消/清除、
  单本 2000 万字与目录 500MB 上限）；`/content` 命中缓存直接读本地（12ms vs 在线数百 ms）。
  客户端新增「离线缓存」行（缓存整本 / 进度 / 取消 / 继续 / 清除）与「本地缓存」来源标识。
- v0.1.3（2026-10-28）：章节目录完整显示「第 N 章」（用宿主返回的 `chapterIdx`）+「共 N 章」+
  「跳到第 N 章」输入框；打开目录自动滚动到当前章；peek/状态行/内容来源都带章号。
- v0.1.2（2026-10-28）：新增 peek「看清当前页」按钮与浮层（打开冻结滚动、上一页/下一页、Esc 关闭）；
  `/content` 增加 `title/chapter` 兼容别名修正书名显示。
- v0.1.1：扫码登录、书架/章节/正文、背景层与控制面板、cookie 轮换与缓存清理。

---

## v0.1.4 整本缓存 / 离线阅读契约（Lead 维护）

### 目标

点一次「缓存整本」后，把该书所有可读章节正文落到本地；之后阅读 `/content` 命中本地缓存，
不再向微信读书发请求（重启应用、断网也能读已缓存章节）。缓存必须可查看大小、可取消、可清除。

### 磁盘布局（宿主半负责，唯一写正文的地方）

```
$DSH_HOME/weread-moyu/cache/
└─ <bookId>/
   ├─ meta.json        # 索引：书名/作者/章节列表/cached 标记/统计/accountVid/complete/updatedAt
   └─ c<chapterUid>.json  # 单章：{chapterUid, chapterIdx, title, text, preview, anonymous, chars, fetchedAt}
```

- 原子写：临时文件 + rename（同 `session.json` 的做法）；meta 每 10 章或结束时重写一次。
- `meta.accountVid` 记录下载时的账号 vid；`/content` 命中缓存前必须校验它与当前登录账号一致，
  不一致按未命中处理（避免 A 账号读到 B 账号缓存）。
- 只缓存正文与元数据；cookie / QR / 账号信息不进 cache 目录。

### 宿主 API（客户端只用这些）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/weread-moyu/api/cache/download` | body `{bookId, force?}` -> `{ok:true, state:"running", total, cached}`；重复调用是幂等的（已在跑直接返回状态） |
| GET | `/weread-moyu/api/cache/status?bookId=` | `{ok, bookId, state:"idle"\|"running"\|"done"\|"error"\|"cancelled", total, cached, chars, bytes, complete, currentChapter, startedAt, finishedAt, error, meta:{title, author, chars, bytes, updatedAt, complete}}` |
| POST | `/weread-moyu/api/cache/cancel` | body `{bookId}` -> `{ok, state:"cancelled"}`，保留已下载部分 |
| GET | `/weread-moyu/api/cache/list` | `{ok, books:[{bookId,title,chapters,total,chars,bytes,complete,updatedAt}]}` |
| POST | `/weread-moyu/api/cache/delete` | body `{bookId}` -> `{ok}`，删除该书缓存目录 |
| GET | `/weread-moyu/api/content?...` | 命中缓存时响应带 `source:"cache"`（且不访问上游）；未命中 `source:"online"` |

### 下载规则

- 必须已登录（`requireLogin`）；否则 `NOT_LOGGED_IN`。
- 章节列表来自 `weread.getChapters`；逐章调用 `weread.getChapterText`（内部已解密），
  每章之间 sleep 120–200ms，单章失败重试 1 次。
- 跳过 `wordCount === 0` 的占位章；`preview:true`（未解锁试读）也缓存但标 `preview`。
- 章节失败分类：`CHAPTER_LOCKED`/`CONTENT_UNAVAILABLE` 记录并继续；`SESSION_EXPIRED` 立即停止
  （state=error，保留已下载部分）；网络错误最多连续 3 次后停止。
- 单本上限 20,000,000 字符；缓存目录总量上限 500 MB；超限返回 `CACHE_LIMIT` 并不再写入。
- 取消：置取消标记，当前章节结束后停止，state=cancelled，complete=false。
- 下载是后台异步任务（宿主内存里的 job map，不阻塞 HTTP 请求）；进程重启后未完成任务按 idle 处理，
  已下载章节文件保留，再次点「继续缓存」会跳过已缓存章节。

### weread.js 需新增（Teammate B）

```js
/**
 * 用已缓存的整章文本切出与 getContent 完全一致的一页。
 * @param {{text:string, pos?:number, maxChars?:number}} opts
 * @returns {{lines:string[], pos:number, hasMore:boolean, totalChars:number}}
 */
export function sliceContentPage(opts)
```

- 必须复用 `getContent` 现在的切页语义（`lastIndexOf('\n')`、`normalizeLines`、`maxChars` clamp 120–4000），
  这样客户端翻页/续章在缓存与在线两种来源下行为一致；补 `selftest` 断言（同一 text 用 `getContent`
  与 `sliceContentPage` 切出的 lines/pos/hasMore 一致）。

### 客户端需新增（Teammate A）

- 书籍选中后显示缓存行（未缓存/缓存中/已完成/部分/错误）：
  - 未缓存：`缓存整本（约 X 字）` 按钮；
  - 缓存中：`缓存中 123/1060 · 32%` + `取消`，每 1.5s 轮询 status，完成后自动变已缓存；
  - 已缓存：`已缓存 · 12.3 MB` + `清除缓存`；部分缓存显示 `继续缓存`；
  - 未登录/演示模式：隐藏缓存控件。
- `/content` 响应带 `source` 时，状态行/内容来源显示 `本地缓存` 或 `在线`。
- 缓存控件保持在章节区附近、风格与现有一致，不新增常驻大块 UI。
- dispose 时清理轮询定时器；切换书籍时切换/停止轮询。

### 验证

- `tests/cache-smoke.mjs`：宿主 API 契约（未登录 400/NOT_LOGGED_IN、下载小样本、status 进度、取消、
  `/content` 命中 `source:"cache"` 且二次请求更快、delete 清理）。
- `tests/browser-verify.mjs`：点「缓存整本」→ 进度出现 → 取消/完成 → 缓存标识出现 → 截图
  `examples/live-cache.png`。
- 真实 GUI 里对一本小书跑完整缓存，重启应用后确认仍能离线读（下一轮验证）。



