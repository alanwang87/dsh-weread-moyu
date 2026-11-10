# DSH 客户端插件契约笔记（dsh-weread-moyu 实测结论）

> 维护者：client-dev。适用范围：DSH Web GUI 客户端插件（browser bundle 半）。
> 验证环境：DSH 0.2.1-rc.2 前端包（`@deepseek-ai/dsh-client-modules` / `dsh-client-ui-theme`
> / `dsh-client-ui-layout` 解包源码）+ 真实 Desktop GUI（宿主半 v0.1.1）live 截图验证。
> 本文是“我们实际验证过、能工作”的结论，不是官方文档的复述；改客户端 bundle 前先读这里。

## 1. Bundle 格式与加载生命周期（已验证）

DSH 客户端插件**不需要构建工具**，就是一个普通脚本，向全局队列注册一个懒加载 CJS 工厂：

```js
window.__ModuleLoader__.load({
  id: "dsh-weread-moyu",          // 必须 = package.json 的包名（不是子路径）
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    exports.name = "weread-moyu"; // cordis 插件名，可省略
    exports.inject = [];          // cordis 客户端服务依赖，空数组表示不依赖
    exports.apply = function apply(ctx) { /* 挂载 UI */ };
    return module.exports;        // 工厂必须同步返回 exports
  }
});
```

要点：

1. **`id` 必须正好等于包名**（`dsh-weread-moyu`）。宿主从 `package.json` 的
   `dsh.client` + `exports["./client"]` 发现并服务 bundle；`<id>/client` 与裸 id 解析到同一份 exports。
2. `load()` 只是把 `{id, factory}` 推进队列（facade），真正的物化发生在 loader 导入该模块时：
   `factory(require)` 执行一次并**记忆化**，之后模块体副作用（注入 CSS、建 DOM）不会再跑。
   HMR 换版本时会重新物化，所以 `apply()` 必须能安全重复执行（先清旧实例）。
3. 工厂里可以 `require("react")`、`require("react/jsx-runtime")` 等**平台模块表**里的包，但
   `require` 只能同步解析平台表 / 已注册模块 / boot graph 行；**不能用相对路径同步 require 另一个
   `client*.js`**（entry 与 chunk 都必须自包含）。`require.async()` 才会拉 compiler 生成的包内 chunk。
   我们没有依赖，纯 DOM，因此 `dsh.client.external` 留空即可。
4. 宿主通过 `/plugins/<包名>/client.js?rev=<mtime/size 派生>` 服务 bundle；应用 combo 脚本在 boot 时
   注册工厂。`dsh.client` 里可选的 `immediately: true` 只影响**预取**（boot 时 early preload），
   不影响该插件是否被作为 cordis 插件挂载；对本插件建议加上以让背景层更早出现（可选，非必需）。
5. 真实 GUI 中改 bundle 后**必须重启 DSH 或等 HMR 重新物化**才会生效；不要试图热改运行中的进程。

## 2. `apply(ctx)` 的客户端上下文与清理

- `exports.apply(ctx)` 拿到的 `ctx` 是 cordis 客户端上下文。实测可用（但本插件不强依赖）：
  `ctx.effect(fn)`、`ctx.on(event, fn)`、`ctx.slots`、`ctx.locale`、`ctx.theme`、`ctx.modules`。
- 清理必须用 `ctx.effect(() => () => cleanup)` 的返回清理器语义：

  ```js
  ctx.effect(function () { return function () { dispose(); }; });
  ```

  没有 `ctx.effect` 时（纯脚本加载、测试 harness）用 `window.addEventListener("beforeunload", ...)` 兜底。
- **重复 apply / HMR**：在 `apply` 开头先调用上一次实例存在 `window.__wereadMoyuDispose` 上的清理函数，
  再建新实例；`mount()` 里也检查同 id 的残留 DOM 先删掉。
- 清理清单（缺一项都会在 HMR 后叠加 DOM / 计时器 / 监听器）：
  - `requestAnimationFrame` 循环、所有 `setTimeout/setInterval`（滚动看门狗、重试退避、扫码轮询、toast、debounce 保存）；
  - `MutationObserver`（body 主题属性观察、`#root` 子树观察）、`window resize`、`document pointerdown/keydown` 捕获监听；
  - 面板/圆点/背景层/style 节点、`<html>` 上的一次性状态 class、兜底扫描写入的 inline `background-color`；
  - localStorage 最后一次写入（`dispose()` 同步 flush）。

## 3. 注入样式与透明化策略（核心）

客户端只保证一件事：**`<style id="weread-moyu-style">` 追加在 `<head>` 末尾**，之后
`document.body` 下挂 4 个节点：

| 节点 | 定位 | 关键样式 |
|---|---|---|
| `#weread-moyu-layer` | 背景阅读层 | `position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden`，作为 `body` 第一个子元素 |
| `#weread-moyu-dot` | 控制圆点 | `position:fixed; right:14px; bottom:14px; 14x14px; opacity:.25`，z-index ≥ 2e9 |
| `#weread-moyu-panel` | 控制面板 | `position:fixed; right:14px; bottom:38px; width:360px`，z-index ≥ 2e9，`hidden` 时 `display:none` |
| `<style>` | 样式 | 全部类名以 `wm-` 前缀，避免与 DSH CSS Modules 哈希名冲突 |

### 3.1 DSH 主题 token

- 主题 CSS 由 `@deepseek-ai/dsh-client-ui-theme` 的 client bundle 注入，token **定义在 `body` 上**，
  深色主题在 `body[data-ds-dark-theme]` 上重新映射语义别名（`--dsw-static-*` 是绝对色板，
  `--dsw-alias-*` 是语义层）。

  | token | 浅色 | 深色 |
  |---|---|---|
  | `--dsw-alias-bg-base` | `#fff` | `#151517` |
  | `--dsw-alias-bg-layer-1/2/3` | `#fff` | `#232324 / #2c2c2e / #353638` |
  | `--dsw-alias-label-primary/secondary/tertiary` | `#0f1115 / #61666b / #81858c` | `#f9fafb / #cfd3d6 / #adb2b8` |
  | `--dsw-alias-border-l1/l2/l3` | `#0000000a / 1a / 1f` | `#ffffff0f / 1f / 29` |
  | `--dsw-specific-sidebar-fill` | `#f9fafb` | `#1b1b1c` |
  | `--dsw-specific-bubble` / `input-major` | `#eff6fe` / `#fff` | `#2c2c2e / #2c2c2e` |

- **覆盖 token 必须写在 `body`（或 `body[data-ds-dark-theme]`）并加 `!important`**，因为主题选择器就是
  `body{...}` / `body[data-ds-dark-theme]{...}`；写到 `:root` 不会赢过 body 自身的声明。
- 深色下把背景类 token 换成半透明玻璃（文字层透出来）：`bg-base → rgba(21,22,26,.58)`、
  `layer-1..3` 依次 .72/.78/.82、`sidebar-fill → rgba(20,21,25,.52)`；浅色对应白色系半透明。
  气泡/输入框类 token 保持较高不透明度，避免聊天正文被背景字干扰。
- `html, body, #root { background: transparent !important; }`，同时给 `#root`
  `position:relative; z-index:1`，保证 `#root` 里的 React 外壳稳定画在 `z-index:0` 的背景层之上。
- 深浅切换直接跟随 `body[data-ds-dark-theme]` 属性（CSS 选择器级联，无需 JS）；仅兜底扫描需要 JS 重跑。

### 3.2 真实外壳结构（来自 `dsh-client-ui-layout` 的 `AppFrame.module.css`）

```html
#root > div.<hash>_frame              /* background: var(--dsw-alias-bg-base) */
  ├─ div.<hash>_sidebarCol            /* background: var(--dsw-specific-sidebar-fill) */
  ├─ div.<hash>_centerCol             /* macOS: background: var(--dsw-alias-bg-base) */
  ├─ div.<hash>_rightbarCol
  ├─ div.<hash>_bottomRow             /* background: var(--dsw-alias-bg-base) */
  └─ div.<hash>_overlayLayer
```

- class 名是 CSS Modules 哈希（例如本构建为 `BynINW_frame`，实际部署随版本变化），**不要写死依赖**；
  真正稳定的是 `--dsw-alias-bg-*` / `--dsw-specific-sidebar-fill` 这些 token。
- macOS（`html[data-platform=darwin]`）下 sidebar 用渐变 + `color-mix` 绘制，仅覆盖 token 只能变半透明，
  渐变仍会存在；这是可接受的已知限制。
- Windows 有 `html[data-windows-titlebar]`，框架用 `--dsw-specific-sidebar-fill` 画 titlebar；同样靠 token 半透明化。

### 3.3 兜底扫描（针对写死颜色的大色块）

真实首页/聊天里存在少量**不透明、写死颜色或大色块**，token 覆盖不到。客户端在挂载后 / resize /
主题变化 / `#root` 子树变化（节流 900ms）时扫描 `#root div,main,section,aside,header,footer`：

- 命中条件：`background-color` alpha ≥ 0.85 且 `background-image: none`，并且
  `面积 ≥ 30% 视口`（大平面）**或** `宽 ≥ 55% 视口 且 高 ≥ max(80px,10% 视口) 且 面积 ≥ 8% 视口`（横贯整行的 hero/工具条）；
- 命中后打 `data-wm-glass` 标记并 inline `background-color: rgba(21,22,26,.58) !important`；
- 关闭总开关或主题切换时把所有 inline 样式回滚（`restoreGlassed()`），然后重新扫描；
- 扫描有 4000 节点预算、只在布局变化后节流执行，避免长聊天记录下每帧重排。

> 若真实 GUI 里仍有大面积背景字被挡住：优先怀疑是 `background-image`（渐变/纹理）或 `backdrop-filter`
> 覆盖层，这类元素当前扫描会跳过。用 DevTools 找到元素 class，再决定是否扩大扫描（需要评估误伤弹窗/气泡）。

## 4. 宿主 API 契约（客户端实际使用的字段）

客户端**只使用相对路径** `fetch("/weread-moyu/api/...")`，不硬编码端口；所有响应 JSON，
错误统一 `{ok:false, code, error}`。

| 方法 | 路径 | 客户端用途 |
|---|---|---|
| GET | `/ping` | 启动探测；`{ok:true, version}` 失败 → demo 模式（静默、指数退避重试） |
| GET | `/status` | `{ok, loggedIn, sessionExpired, user, books, wereadReady, hostError, shelfError}`；`loggedIn:false` 显示登录区 |
| GET | `/qr` | `{ok, uid, qrDataUrl, expiresAt}`，面板显示二维码 |
| GET | `/qr/poll?uid=` | `{ok:true, state:"waiting"\|"scanned"\|"confirmed"\|"expired"\|"error", user}`；`confirmed` 后用返回的 `user` 提示昵称并 `refreshStatus()` |
| POST | `/login/cookie` | body `{cookie}`；成功 → `refreshStatus()` |
| POST | `/logout` | 清空本地书/章节/进度状态 → demo |
| GET | `/books/:bookId/chapters` | `{ok, chapters:[{chapterUid,title,level,wordCount}]}` |
| GET | `/content?bookId=&chapterUid=&pos=&maxChars=` | `{ok, title, chapterTitle, lines, pos, hasMore, nextChapterUid, progress}` |

内容流规则（已按此实现）：

- 首次 `pos=0`；之后每页用响应里的 `pos` 作为下一页起点；请求带 `maxChars=1800` 控制单页长度。
- `hasMore:false` + `nextChapterUid` 非空 → 自动请求下一章（背景连续滚动，不打断阅读）；
- `hasMore:false` + `nextChapterUid:null` → 全书读完：停在末尾并显示“已读到全书末尾”。
- 读到接近底部（距底 < 520-600px）预取下一页，保证向上滚动不断流。
- 每章在滚动内容里的起始 offset 会被记录（`state.sections`），标题/面板“内容来源”始终显示**当前正在看的章节**，
  而不是最后预加载的章节。

### 4.1 微信读书 TOC 的非正文页（实测必须处理）

微信读书书籍的 TOC 前几项是 **封面 / 版权信息 / 献词 / 目录 / 书名页 / 出版信息** 等非正文页：

- 它们的 `wordCount` 常常只有 1-2；
- 它们的“正文”不是书页文本，而是 `<?xml version="1.0"...><ncx>...` 这类版权/导航文件垃圾
  （实测 `chapterUid=1` 直接返回 XML）。如果直接渲染，背景层会显示 XML。

客户端对策（对应 `client.js` 顶部 `JUNK_CHAPTER_RE`）：

```js
var JUNK_CHAPTER_RE = /^\s*(封面|目录|版权|献词|书名|扉页|插页|出版|contents|cover)/i;
function isJunkChapter(chapter) {
  return JUNK_CHAPTER_RE.test(title) || (wordCount > 0 && wordCount < 200);
}
```

1. **章节列表**：非正文页默认折叠，不进入列表；章节标题右侧显示“正文页/总页数 章 + 约 X 字”
   （`wordCount` 汇总用 `formatWords`，没有 wordCount 就不显示）。列表下方有
   “显示非正文页面（N）”开关，展开后灰显（`wm-item-junk`），**仍可手动点击**（保留手动选择能力）。
2. **自动起读章节**：`pickStartChapter()` 取第一个「非垃圾且 `wordCount >= 500`」的章节；
   没有就取第一个非垃圾章节；再没有才退回 `chapters[0]`。恢复上次进度时也会校验该章不是垃圾页。
3. **垃圾正文兜底**：`/content` 返回的 `lines` 拼接后如果匹配 `^\s*<\?xml`，或
   `hasMore=false` 且去空白后长度 < 40，就自动跳到 `nextChapterUid` 继续取，**最多连续跳 3 章**
   （`LIMIT.junkSkipMax`，防止整本都是版权页时死循环）。成功加载正文后计数清零；
   跳满 3 章仍失败则停在原地、面板提示“当前章节是非正文页，请换一章”。跳过过程中不把 XML 写进背景层。

## 5. 客户端行为与本地状态

- **demo 兜底**：`/ping` 失败或未登录时渲染内置公版古文（《古文观止》选段），循环续页，永不空白；
  面板明确显示“内容来源：演示文本（内置）”和“宿主未就绪 / 未登录”。demo 时不报错刷屏。
- **重试退避**：宿主探测 5s 起、正文加载 3s 起，各自 ×2 递增、上限 60s；成功后重置。
- **滚动看门狗**：主滚动用 `requestAnimationFrame`（30/42/60ms 每 1px，档位 0=暂停），另有 1.2s
  `setInterval` 兜底——rAF 在后台标签页/无头环境会被节流甚至停摆，不能只靠 rAF 续页。
- **localStorage 键**：`weread-moyu:config`，JSON：
  `{enabled:boolean, opacity:number(0.04-0.35), fontSize:12-22, speed:0-3, clickThrough:boolean, bookId, chapterUid, pos}`；
  滑块/开关即时生效并 debounce 350ms 写盘，dispose 时同步 flush。
- **点击穿透**：背景层始终 `pointer-events:none`；面板关闭时 `display:none`，不拦截点击；
  圆点可在面板打开时再次点击关闭，或点面板外部 / Esc 关闭。
- **总开关**：`<html class="weread-moyu-off">` 时撤掉全部 token 覆盖并隐藏背景层，外壳恢复不透明原样；
  重新开启后重新扫描大色块。

### 5.1 peek 浮层：把“正在看的这一页”清楚显示出来（看清当前页）

背景层故意很淡，有时需要直接看清当下这一页，因此右下角入口旁加了一个同样不显眼的按钮：

| 元素 | 契约 |
|---|---|
| `#weread-moyu-dock` | `position:fixed; right:14px; bottom:14px; display:flex; gap:10px; z-index:2147482600; pointer-events:none`，子元素 `pointer-events:auto`。里面只放 peek 按钮和原有圆点，**不新增可见工具栏**；dock 本身不挡聊天。 |
| `#weread-moyu-peek` | 18×18 圆形按钮，默认 `opacity:0.22`（hover 0.92），内联小书 `SVG`（非大字），与圆点同一水平线。点击 `togglePeek()`；`aria-label="看清当前这一页"`。 |
| `#weread-moyu-peek-panel` | `position:fixed; right:20px; bottom:56px; width:min(560px,92vw); max-height:64vh; z-index:2147482500`（高于 AppFrame、低于控制面板/圆点 2147482600，也低于 DSH 自身弹窗层）。近不透明深色卡片：`rgba(20,22,26,.97)` + `backdrop-filter:blur(12px)` + 1px 边 + 12px 圆角。 |

浮层内部：

- **头部**：`正在阅读` 小标签 + `《书名》` + 章节名 + 阅读进度（`state.progress`，有才显示；demo 显示“演示文本”标记）+ 右上角 `×`。
- **正文**：17px / 行高 1.9 / `#e6e9ee` / 同样宋体栈，可滚动；内容 = **背景层当前 `state.offset` 那一屏内的 `.wm-body p`**。
  定位方法：对每个段落取 `getBoundingClientRect().top - scrollRect.top`（两者受同一个 transform 影响，差值即静态位置），
  再按 `[offset, offset + layerHeight*0.85]` 截取，因此与背景层同一 section、同一 offset，不需要另存一份内容。
- **底部**：`上一页` / `下一页` 按钮 + `Esc 关闭` 提示。翻页动作直接移动背景层 `state.offset`（并可触发 `requestMore()`
  向宿主续下一页），同步 `applyTransform()` + `updateCurrentSection()` + 刷新浮层，所以背景层一起翻页。
  下一页到达已加载末尾时设置 `state.peekPendingTurn`，等宿主内容到达后自动继续；`上一页` 在 offset=0 禁用，
  `下一页` 在全书末尾禁用。
- **打开即冻结**：`state.peekOpen=true` 时 `tick()` 跳过 offset 推进（自动滚动停在打开那一刻），关闭后从冻结位置继续；
  打开期间 `__testAutoScroll()` 也返回不动。翻页按钮仍可移动 offset。
- **关闭方式**：再点一次 peek 按钮 / `×` / `Esc` / 点击浮层外部；点击 dock 内元素不误关。
  peek 与控制面板相互独立，共用文档级 Esc / 外点监听（`syncDocListeners()` 按需挂载）。
- **demo 与关闭背景**：demo 模式直接用内置演示段落渲染（不报错）；`enabled=false` 时正文区提示先开启背景。
- **清理**：`dispose()` 移除 `#weread-moyu-peek`、`#weread-moyu-peek-panel`、`#weread-moyu-dock`（含圆点）、
  清 `peekHintTimer`、复位 `peekOpen/peekPendingTurn`、移除文档监听；HMR 重复 mount 时先删残留同 id 节点。

### 5.2 章节目录 / 章号 / 快速跳章

上千章的书（实测 1060 章）如果没有章号，用户无法定位「第 500 章」。契约：

- **章号来源**：优先宿主 `/chapters` 返回的 `chapterIdx`（1-based，微信读书 TOC 原始序号）；
  缺失时退回章节在列表中的顺序序号（`chapterNoOf(chapter,index)`）。`/content` 若返回
  `chapterIndex`（0-based）/`chapterCount`，客户端会分别存成 `state.chapterIndex`/`state.chapterCount`，
  当前章号优先用 `chapterIndex+1`；`state.sections[]` 里每段还记录 `{chapterUid, chapterNo}`，
  这样预加载下一章后，状态行/peek 仍显示“正在看的那一章”的章号。
- **章节行**：`第 N 章`（`.wm-ch-no`，muted 10px、`min-width:58px` 固定宽度对齐）+ 标题（超长省略）+ 字数（右）。
  缩进仍按 `level`。非正文页（封面/版权等）展开后同样显示其原始 `chapterIdx`，默认仍隐藏。
- **章节区头部**：`共 N 章 · 约 X 字`（N = `/chapters` 总条数，X = 正文页 wordCount 汇总）。
- **快速跳章**：标题栏下方一行 `跳到第 [input#wm-jump-input] 章 [button#wm-jump-btn]`（Enter 也生效）。
  `jumpToChapterNumber()` 按显示章号定位：优先精确匹配；没有精确值时取最近的更大章号；超过总章数时
  轻提示“超出范围：本书共 N 章”（面板内 toast，不弹大对话框）；命中非正文页时自动落到最近的正文章，
  并提示“第 X 章为非正文页，已跳到第 Y 章”。跳转即 `selectChapter()`，背景层同步切换。
- **自动滚到当前章**：打开目录（`openPanel()` → `renderChapters({scrollToCurrent:true})`）或跳转/切换章节后，
  当前章行加 `data-current="1"`（左侧 2px 蓝色高亮条 + 淡蓝底），并 `scrollChapterIntoView()` 把它滚到
  章节列表可视区中间；普通重渲染会保留列表原来的 `scrollTop`，避免用户翻目录时被拉回顶部。
- **章号显示位置**：控制面板状态行（`内容来源：… · 第 N 章 · 章节名`）、peek 浮层头部
  （`第 N 章 · 章节名`）、背景层章节分隔标题（`第 N 章 · 章节名`）都带章号；demo 模式无章号，不显示。

### 5.3 整本缓存 / 离线阅读 UI（v0.1.4）

宿主契约见 `docs/spec.md` 的「v0.1.4 整本缓存 / 离线阅读契约」；客户端只负责显示与触发：

- **位置**：章节区下方一行 `.wm-cache-sec`（跟随面板风格，不新增大块 UI），仅在
  `loggedIn && !demo && bookId` 时显示；未登录/demo 整块隐藏。
- **状态机 → 文案/按钮**（`renderCache()`）：

  | 状态 | 文案 | 按钮 |
  |---|---|---|
  | idle（未缓存） | `尚未缓存 · 缓存后可离线阅读` | `缓存整本（约 X 字）`（X = 正文页 wordCount 汇总，`formatWords`） |
  | running（缓存中） | `缓存中 123/1060 · 32%` | `取消` |
  | done（已缓存） | `已缓存 · 12.3 MB` | `清除缓存` |
  | partial（cancelled/error/complete=false 且有已下载内容） | `部分缓存 123/1060 · 12.3 MB` | `继续缓存` + `清除缓存` |
  | error 且无内容 | `缓存失败：<error>` | `继续缓存` |

- **接口**：`POST /cache/download {bookId}`（幂等，已在跑直接返回状态）、
  `GET /cache/status?bookId=`（每 **1.5s** 轮询直到离开 running）、`POST /cache/cancel {bookId}`、
  `POST /cache/delete {bookId}`。所有请求走现有 `api()`（相对路径 + JSON）。
- **持久可见**：面板重开时 `openPanel()` 会重新拉一次 status；切换书籍时 `selectBook()` 停旧轮询、
  清空当前书状态、再拉新书 status（后台下载任务不取消）；切回已下载中的书会重新出现进度。
- **source 标识**：`/content` 命中缓存时返回 `source:"cache"`，状态行后缀显示 `· 本地缓存`，
  未命中 `source:"online"` 显示 `· 在线`；peek 浮层的进度小字同步显示同样后缀。
- **清理**：`dispose()` 清 `cachePollTimer`；面板 DOM 随 `#weread-moyu-panel` 一起移除。

## 6. 验证方法（可复现）

### 6.1 Harness

`examples/client-harness/index.html` 用真实 token 值 + 真实 `AppFrame` class 名模拟 DSH 外壳，并模拟
`window.__ModuleLoader__.load` 队列与宿主 API：

```
?mock=1      假宿主（已登录、4 本书：3 本小书 + 1060 章的「择日飞升」、分页正文、假二维码）
?panel=1     自动打开面板
?qr=1        打开面板并点“扫码登录”
?peek=1      内容加载后打开“看清当前页”浮层（截图用）
?book=b4     启动后切到指定 mock 书籍（截图用）
?jump=500    面板打开后跳到第 500 章（截图用）
?cache=done|running|cancelled  预设当前书的缓存状态（截图/手工验证用）
?theme=light 浅色主题
?speed=0     滚动暂停（截图用）
?assert=1    跑 DOM 契约断言，结果 JSON 写进 #harness-assertions
?dispose=1   启动后立即销毁（手工验证清理）
```

断言覆盖（共 136 条，mock/dark；demo 模式 91 条；mock/light 136 条）：bundle id / exports 形状、无平台模块依赖、
背景层 fixed+inset 0+z-index 0+pointer-events:none+中文文本、默认不透明度在 0.12-0.2、
`body/#root` 透明、外壳背景 alpha<1、圆点 14px/0.25、面板默认隐藏→可打开→宽 360、
登录/书籍/章节/3 滑块/2 开关存在、滑块与开关**真实 DOM 事件**即时生效、localStorage 持久化、
滚动推进（`__testAdvance` 绕开无头 rAF 限制）、resize 后层铺满/面板宽度不变、面板关闭不拦截点击、
dispose 后 DOM/style/class/全局清理干净、关闭总开关恢复不透明外壳；
**自动起读跳过封面/版权页（落到 1200 字的正文小节）、非正文页默认折叠+可展开、章节字数汇总（约 2900 字）、
手动选封面页时 XML 垃圾正文自动跳过 3 章直到正文、无 >=500 字章节时回退到第一个非垃圾章节**
（对应断言 `auto-start-*` / `chapters-*` / `junk-*`）；
**目录/跳章：章号行匹配 `/第\s*\d+\s*章/`、头部「共 N 章」、跳章控件存在、跳到第 1 章非正文页时提示并落到
「序言」、1060 章大书头部「共 1060 章」、跳第 500 章后状态行/当前行高亮/当前行在列表视口内、重开目录自动
滚到当前章、超范围跳章有轻提示且状态不变、demo/未登录时跳章控件隐藏且不报错**（对应 `chapters-*` /
`junk-rows-*` / `big-book-*` / `jump-*` / `open-panel-scrolls-*` / `demo-jump-*`）；
**整本缓存：缓存区出现、按钮「缓存整本（约 X 字）」、进度文案与取消、轮询标记、完成后「已缓存 · MB」与
清除按钮、清除回未缓存、取消→部分缓存→继续缓存→完成、命中缓存后 source 显示「本地缓存」（状态行 + peek）、
切书任务不中断/切回仍见状态、demo 隐藏缓存区、dispose 清理**（对应 `cache-*` / `demo-cache-*` /
`cleanup-cache-controls`）；
以及 **peek：按钮 18px 且默认 opacity≤0.3、浮层默认隐藏→点击出现、正文 >80 字、头部含书名/章节、
打开时冻结自动滚动、下一页后浮层文字变化且背景 offset 前进、上一页回退、Esc 关闭后浮层隐藏且背景恢复滚动、
再点按钮开关、demo 模式同样可用、dispose 后 dock/peek/peek-panel 全部清理**（对应 `peek-*` / `demo-peek-*`）。

调试/测试钩子（生产环境也挂载，仅用于自动化）：`__testAdvance(ms)`、`__testAutoScroll(ms)`（尊重 peek 冻结）、
`__testSelectBook(bookId)`、`__testSelectChapter(uid)`、`__testJump(no)`、`__testChapters()`、
`openPeek()/closePeek()/togglePeek()`、`flushConfig()`、`getState()/getConfig()/setConfig()`。
`getState()` 里与缓存相关的字段：`cacheState/cacheTotal/cacheCached/cacheBytes/cacheComplete/cacheLoaded/cachePolling/cacheVisible`。

一键验证：

```powershell
powershell -NoProfile -File examples/verify-client.ps1
powershell -NoProfile -File examples/verify-client.ps1 -Screenshots   # 同时刷新验收截图
```

脚本自动找 Edge/Chrome，跑 mock-dark / demo-dark / mock-light 三套断言并生成截图，退出码 0/1/2。

### 6.2 无头浏览器坑（踩过）

- `file://` 下相对路径 `/weread-moyu/api/...` 会被解析成 `file:///D:/weread-moyu/...`，harness 的
  mock 必须先 `indexOf("/weread-moyu/api/")` 裁剪盘符再匹配。
- `file://` 页面的 `localStorage` 在部分 Chromium 配置下不可用；harness 对此做了降级断言（真实 GUI 是 http 源，正常）。
- 无头 + `--virtual-time-budget` 下 rAF 可能不可靠，滚动断言用 `window.__wereadMoyu.__testAdvance(ms)`，
  视觉滚动另用真实 GUI 验收。
- Edge 会把浏览器日志写到 stderr，PowerShell 里需 `2>&1 | Out-File` 捕获后再正则提取 DOM，
  且脚本 `$ErrorActionPreference` 不能为 `Stop`（否则 stderr 变成终止错误）。
- PowerShell 5.1 读取无 BOM 的 UTF-8 脚本会把中文注释读成乱码，`verify-client.ps1` 保持纯 ASCII。

### 6.3 真实 GUI 验收要点

- 改 bundle 后重启 DSH；`GET /weread-moyu/api/ping` 返回 `{ok:true}` 说明宿主半就绪。
- 未登录时面板应显示“未登录 · 扫码或粘贴 Cookie 登录”、背景为演示文本；
  登录后应显示书名/章节/进度，背景接真实正文。
- 截图：`examples/shot-demo.png`（深色默认）、`shot-panel-mock.png`（已登录面板）、
  `shot-panel-demo.png`（未登录面板）、`shot-light.png`（浅色）、`shot-qr.png`（扫码）、
  `shot-peek.png`（“看清当前页”浮层打开）、`shot-chapters.png`（1060 章目录 + 跳第 500 章）、
  `shot-cache.png`（已缓存 + 本地缓存标识）、`shot-cache-progress.png`（缓存中进度）。
- 已知真实 GUI 现象（live 测试）：由于真实外壳中部分大块用渐变/backdrop-filter 绘制，背景字在
  个别区域会比 harness 更淡；如需更强可把默认 opacity 从 0.18 调到 0.2（面板滑块也可实时调）。

## 7. 文件清单与写入边界

| 文件 | 说明 |
|---|---|
| `plugin/client/client.js` | 唯一客户端 bundle（手写，纯 DOM，≈1900 行） |
| `examples/client-harness/index.html` | 测试 harness（假 DSH 外壳 + 真 token + 真 class 名） |
| `examples/client-harness/harness.js` | 假 ModuleLoader、假宿主 API、DOM 契约断言 |
| `examples/verify-client.ps1` | 一键断言 + 截图脚本 |
| `examples/shot-*.png` | 视觉验收截图 |
| `docs/client-plugin-contract.md` | 本文 |

写入边界见 `docs/spec.md`：客户端只写 `plugin/client/**`、`examples/**`、本文。
宿主 API 变化必须先改 `docs/spec.md` 并同步本文第 4 节。
