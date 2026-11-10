# Register dsh-weread-moyu into the awesome-dsh-plugin list (fork + entry file + PR).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$token = (Get-Content (Join-Path $root '.gh-token') -Raw).Trim()
$h = @{ Authorization = "token $token"; 'User-Agent' = 'dsh-weread-moyu-publish'; Accept = 'application/vnd.github+json' }
$upstream = 'awesome-dsh-plugin/awesome-dsh-plugin'
$fork = 'alanwang87/awesome-dsh-plugin'
$branch = 'add-dsh-weread-moyu'

# 0) upstream default branch + head sha
$up = Invoke-RestMethod -Uri "https://api.github.com/repos/$upstream" -Headers $h
$base = $up.default_branch
$ref = Invoke-RestMethod -Uri "https://api.github.com/repos/$upstream/git/ref/heads/$base" -Headers $h
$sha = $ref.object.sha
Write-Host "[1/4] upstream base branch '$base' @ $($sha.Substring(0,8))" -ForegroundColor Cyan

# 1) fork (idempotent-ish: if it exists we reuse it)
try {
  $f = Invoke-RestMethod -Uri "https://api.github.com/repos/$fork" -Headers $h
  Write-Host "[2/4] fork already exists: $($f.html_url)" -ForegroundColor Cyan
} catch {
  $f = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$upstream/forks" -Headers $h
  Write-Host "[2/4] fork requested: $($f.html_url) (waiting for it to be ready)" -ForegroundColor Cyan
}
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$fork/git/ref/heads/$base" -Headers $h
    $ready = $true; break
  } catch { Start-Sleep -Seconds 3 }
}
if (-not $ready) { throw 'fork not ready after 60s' }

# 2) entry file must not exist yet on upstream
try {
  $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$upstream/contents/data/plugins/alanwang87__dsh-weread-moyu.yml" -Headers $h
  throw 'entry already exists upstream'
} catch [System.Net.WebException] {
  if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
}

# 3) create branch in the fork (idempotent)
try {
  $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$fork/git/ref/heads/$branch" -Headers $h
  Write-Host "[3/4] branch $branch already exists" -ForegroundColor Yellow
} catch [System.Net.WebException] {
  if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
  $body = @{ ref = "refs/heads/$branch"; sha = $sha } | ConvertTo-Json
  $null = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$fork/git/refs" -Headers $h -ContentType 'application/json' -Body $body
  Write-Host "[3/4] branch $branch created from upstream head" -ForegroundColor Cyan
}

# 4) commit the entry file into the fork branch
$yml = @"
url: https://github.com/alanwang87/dsh-weread-moyu
name: alanwang87/dsh-weread-moyu
category: fun
description:
  en: Sign in to WeRead by QR code and lay the current book page behind the whole DSH UI as a low-contrast text layer, with whole-book offline caching, a peek overlay and shelf/chapter/opacity/font/speed controls.
  zh: 扫码登录微信读书，把当前书页正文以低对比度文字层垫在整个 DSH 界面背后，聊天区半透明浮在上面，支持整本离线缓存、看清当前页浮层和书架/章节/透明度/字号/滚动速度调节。
tarball: https://github.com/alanwang87/dsh-weread-moyu/releases/latest/download/dsh-weread-moyu.tgz
"@
$content = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($yml))
$body = @{
  message = 'Add alanwang87/dsh-weread-moyu (fun)'
  content = $content
  branch  = $branch
} | ConvertTo-Json
$put = Invoke-RestMethod -Method Put -Uri "https://api.github.com/repos/$fork/contents/data/plugins/alanwang87__dsh-weread-moyu.yml" -Headers $h -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
Write-Host "[4/4] entry committed: $($put.commit.sha.Substring(0,8))" -ForegroundColor Cyan

# 5) open the PR
$prBody = @"
Adds [alanwang87/dsh-weread-moyu](https://github.com/alanwang87/dsh-weread-moyu) under **fun**.

What it does: signs in to WeRead (WeChat Reading) by QR code and renders the current book page as a low-contrast, fixed, non-interactive text layer behind the whole DSH web UI, with the chrome made translucent so the session floats above it like a document workspace. Includes shelf and chapter picker, opacity/font-size/auto-scroll-speed controls, a peek overlay for reading the current page clearly, whole-book offline caching readable without login, and a demo-text fallback while the host or network is not ready.

- Installable from source: ``dsh.bundle`` manifest in the root ``package.json`` (``dsh.bundle.patch`` + ``dsh.client``, platform web) with ``cordis.patch.yml`` beside it; host half uses only Node built-ins, client bundle is hand-written with zero dependencies.
- Prebuilt tarball attached to a GitHub Release (version-free asset name) and declared via ``tarball:``.
- Screenshots declared in the repo's own ``screenshots.json`` (4 images).
- Topics include ``dsh-plugin``.
- Repo was created today; the 1-day age gate should pass on its automatic re-run.
"@
$pr = @{
  title = 'Add alanwang87/dsh-weread-moyu (fun)'
  head  = "alanwang87:$branch"
  base  = $base
  body  = $prBody
} | ConvertTo-Json
$pull = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$upstream/pulls" -Headers $h -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($pr))
Write-Host ''
Write-Host "PR:   $($pull.html_url)" -ForegroundColor Green
