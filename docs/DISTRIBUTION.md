# 分发与上架：把插件带到其他电脑 / 插件市场

> 结论先说：
> - **DSH 的账号不会自动同步插件**。插件是按机器、按 profile 安装的本地文件（`~/.dsh/profiles/<profile>`），
>   登录同一个 DeepSeek 账号只共享账号/计费，不会把某台电脑装的插件推给另一台。
> - **微信读书登录态也不会随插件走**。每台电脑要么扫码登录一次，要么手动拷 `~/.dsh/weread-moyu/session.json`
>   （同账号 cookie，属于敏感凭证，不推荐明文同步）。
> - 想让另一台电脑用上，有三条路：**拷目录/tarball**（最快）、**发 npm 包**、**上架 awesome-dsh-plugin 精选列表**
>   （插件市场的插件源就是这份精选列表）。

---

## 方案 A：拷贝文件（不需要任何账号，离线可用）

1. 在源电脑上重新打一次包（或直接用 `dist/dsh-weread-moyu-<version>.tgz`）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File "D:\Alan\插件\pack.ps1"
   ```
2. 把下面任意一种带到另一台电脑：
   - 整个 `D:\Alan\插件` 目录（推荐：含 `install.ps1`、README、截图）；
   - 或者只带 `dist/dsh-weread-moyu-<version>.tgz`。
3. 在另一台电脑（已装好 DSH Desktop、并至少启动过一次）上：

   **Windows（拷整个目录）**
   ```powershell
   powershell -ExecutionPolicy Bypass -File "D:\Alan\插件\install.ps1"
   ```

   **Windows（只有 tarball）**
   ```powershell
   dsh plugin --profile desktop add "D:\Downloads\dsh-weread-moyu-0.1.2.tgz"
   # 再确认 profile 的 dsh.profile.bundles 里有 dsh-weread-moyu（add 一般会自动加）
   ```
   > `dsh` 用 DSH 安装目录自带的命令；如果 PATH 里没有，用
   > `D:\Program Files\deepseekHarmess\resources\runtime\cli\bin\dsh.cmd`。

   **macOS / Linux（桌面版自带的 CLI）**
   ```bash
   # 找到安装目录里的 dsh（桌面版 resources/runtime/cli/bin/dsh）
   <安装目录>/resources/runtime/cli/bin/dsh plugin --profile desktop add ~/Downloads/dsh-weread-moyu-0.1.2.tgz
   ```
4. **完全退出并重新打开 DSH**（客户端 bundle 只在启动时加载）。
5. 右下角出现两个小按钮后，扫码登录一次微信读书即可。

> 注意：`file:` 依赖在 profile 里是硬链接副本。以后更新插件时，要么重新 `add` 一次 tarball，
> 要么用 `install.ps1`（它会在 `add` 后手动刷新 `lib/`、`client/`）。

---

## 方案 B：发布到 npm（之后一条命令安装，也能被市场收录）

npm 上的包名 **`dsh-weread-moyu` 目前没有被占用**（已用 `npm view` 确认 404）。

```powershell
# 1) 登录 npm（需要你自己的 npm 账号）
npm login

# 2) 在仓库根发布（版本号在根 package.json 里改）
cd "D:\Alan\插件"
npm publish --access public
```

之后任何一台电脑：

```powershell
dsh plugin --profile desktop add dsh-weread-moyu
# 如需固定版本： dsh plugin --profile desktop add dsh-weread-moyu@0.1.2
```

重新发版：改根 `package.json` 的 `version` → `npm publish`；其他电脑 `dsh plugin --profile desktop add dsh-weread-moyu@latest` 或市场里点更新。

---

## 方案 C：上架插件市场（awesome-dsh-plugin 精选列表）

DSH 里的「插件市场」（dshmarket）列表来自 **github.com/awesome-dsh-plugin/awesome-dsh-plugin** 这份精选列表，
站点 `awesome-dsh-plugin.com` 和市场每天自动刷新收录，通常一天内生效。

前置条件（必须让插件有一个“可安装的公开来源”，二选一）：

1. **npm 包**：按方案 B 发布 `dsh-weread-moyu`；或
2. **GitHub 仓库 + Release tarball**：把 `plugin/`（以及 README、截图）推到一个公开 GitHub 仓库，
   在 Releases 上传 `dsh-weread-moyu-<version>.tgz`，市场会优先用 npm，其次用 Release tarball。

然后：

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`，加**一个文件** `data/plugins/<owner>__<repo>.yml`
   （两个 README 由它生成，不要手工编辑 README）：

   ```yaml
   url: https://github.com/alanwang87/dsh-weread-moyu
   name: alanwang87/dsh-weread-moyu
   category: fun
   description:
     en: Sign in to WeRead by QR code and lay the current book page behind the whole DSH UI as a low-contrast text layer, with whole-book offline caching, a peek overlay and shelf/chapter/opacity/font/speed controls.
     zh: 扫码登录微信读书，把当前书页正文以低对比度文字层垫在整个 DSH 界面背后，聊天区半透明浮在上面，支持整本离线缓存、看清当前页浮层和书架/章节/透明度/字号/滚动速度调节。
   tarball: https://github.com/alanwang87/dsh-weread-moyu/releases/latest/download/dsh-weread-moyu.tgz
   ```

2. 分类：`fun`（Just for Fun，娱乐）。
3. 前置要求（CI 会查）：仓库根 `package.json` 声明 `dsh.bundle`（已满足）、仓库创建满 1 天、
   给仓库加 `dsh-plugin` topic、Release 资产名不带版本号并配 `latest/download/` 链接（或钉住 tag）。
4. 截图：在自己仓库根放 `screenshots.json`（本仓库已放），市场从 README/截图声明取图（GitHub 图床）。
3. 建议的中英描述（可直接改用）：

   > **zh**：扫码登录微信读书，把当前书页正文以低对比度文字层垫在整个 DSH 界面背后，聊天区半透明浮在上面，
   > 看起来像正常文档工作区；右下角小书按钮可一键看清当前页，支持书架/章节/透明度/字号/滚动速度。
   >
   > **en**：Sign in to WeRead with a QR code and render the current book page as a low-contrast background layer
   > behind the whole DSH UI. The chat surface floats above it like a normal document workspace; a subtle book
   > button opens the current page for a clear read, with shelf/chapter, opacity, font-size and scroll-speed controls.

4. 截图放仓库里并在条目里引用（市场只从 GitHub 图床取图）：
   - `examples/live-final.png`（背景 + 面板）
   - `examples/live-peek-peek.png`（peek 浮层）
   - `examples/shot-peek.png` / `shot-panel-mock.png`
5. 提 PR → 合并后等站点 CI 刷新（通常一天内），市场里即可搜到。

> 安全提示：dshmarket 默认只允许安装精选列表里的来源；收录 ≠ 背书，第三方代码请自行评估。
> 本插件需要「网络」（访问 weread.qq.com）和「文件读写」（`~/.dsh/weread-moyu/session.json` 登录态）能力，
> 条目/README 里如实说明即可。

---

## 方案 D：用插件市场自带的「备份与恢复 / 同步」带过去

dshmarket 提供：

- **备份与恢复**：把 profile 的插件清单与配置导出为可读 JSON，换机导入（合并式恢复）；
- **WebDAV 每日自动备份**，或**私有 GitHub Gist 跨机器同步**。

限制：它同步的是「清单与配置」，不搬运插件代码本身。所以：

1. 先把本插件改成公开来源（npm 包或 GitHub + tarball，见方案 B/C）；
2. 在源机器备份/同步 → 新机器恢复，市场会按清单重新安装；
3. 本地 `file:` 路径安装的插件无法在另一台电脑还原，需要先替换来源。

---

## 登录态（每台电脑一次）

- 推荐：新机器上直接点右下角小圆点 →「扫码登录」，微信扫码确认（约 10 秒）。
- 或手动复制登录态（同账号、同机器信任前提下）：
  - Windows：`C:\Users\<你>\.dsh\weread-moyu\session.json`
  - macOS/Linux：`~/.dsh/weread-moyu/session.json`
  文件里是微信读书的 cookie（`wr_vid`/`wr_skey`/`wr_rt` 等），**不要上传到任何公开位置**；
  过期后在面板里重新扫码即可。

---

## 本次已经准备好的东西

- `dist/dsh-weread-moyu-0.1.2.tgz` —— 已在全新 profile 里实测：`file:` 安装 → boot graph 含插件行 →
  client bundle 正常下发 → 宿主 API `{ok:true,version:"0.1.2"}`。
- `pack.ps1` —— 一键重新打包（自动用 `package.json` 的版本号）。
- `install.ps1` —— 拷目录方式的安装/更新脚本。
