# Publish dsh-weread-moyu to GitHub (repo + push + topics + release tarball).
#
# Prereqs:
#   .gh-token  — a GitHub classic PAT with `repo` scope, saved next to this script
#                (deleted after use by the caller; this script only reads it)
#
# Usage:
#   pwsh -ExecutionPolicy Bypass -File "D:\Alan\插件\publish-github.ps1"

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$owner = 'alanwang87'
$repo = 'dsh-weread-moyu'

$tokenFile = Join-Path $root '.gh-token'
if (-not (Test-Path $tokenFile)) { throw "token file not found: $tokenFile" }
$token = (Get-Content $tokenFile -Raw).Trim()
if (-not $token) { throw "token file is empty" }
$env:GCM_INTERACTIVE = 'never'
$env:GIT_TERMINAL_PROMPT = '0'
$h = @{ Authorization = "token $token"; 'User-Agent' = 'dsh-weread-moyu-publish'; Accept = 'application/vnd.github+json' }

# 1) verify token / account
$me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $h
if ($me.login -ne $owner) { throw "token belongs to '$($me.login)', expected '$owner'" }
Write-Host "[1/5] authenticated as $($me.login)" -ForegroundColor Cyan

# 2) create the repo if missing
try {
  $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo" -Headers $h
  Write-Host "[2/5] repo exists: $($r.html_url)" -ForegroundColor Cyan
} catch {
  $body = @{
    name        = $repo
    description = '微信读书当背景 — DeepSeek Harness 摸鱼插件：扫码登录微信读书，把书页正文以低对比度文字层垫在 Web GUI 背后。'
    private     = $false
    has_issues  = $true
    auto_init   = $false
  } | ConvertTo-Json
  $r = Invoke-RestMethod -Method Post -Uri 'https://api.github.com/user/repos' -Headers $h -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
  Write-Host "[2/5] repo created: $($r.html_url)" -ForegroundColor Green
}

# 3) push main (temporary credential file; deleted right after)
$credFile = Join-Path $env:TEMP ("ghcred-" + [guid]::NewGuid().ToString('N'))
[System.IO.File]::WriteAllText($credFile, "https://$owner`:$token@github.com`n")
$remotes = & git -C $root remote
if ($remotes -contains 'origin') { & git -C $root remote remove origin | Out-Null }
& git -C $root remote add origin "https://github.com/$owner/$repo.git" | Out-Null
try {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("$owner`:$token"))
  & git -C $root -c credential.helper= -c "http.extraheader=Authorization: Basic $b64" push -u origin main 2>&1 | ForEach-Object { "  $_" }
  $pushExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($pushExit -ne 0) { throw "git push failed with exit code $pushExit" }
  Write-Host '[3/5] pushed main' -ForegroundColor Cyan
} finally {
  Remove-Item $credFile -Force -ErrorAction SilentlyContinue
}

# 4) topics
$topics = @{ names = @('dsh-plugin', 'dsh', 'weread', 'deepseek-harness') } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri "https://api.github.com/repos/$owner/$repo/topics" -Headers $h -ContentType 'application/json' -Body $topics | Out-Null
Write-Host '[4/5] topics set: dsh-plugin, dsh, weread, deepseek-harness' -ForegroundColor Cyan

# 5) release with version-free tarball asset (dsh-weread-moyu.tgz)
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$tag = "v$version"
$assetName = "$repo.tgz"
$distTgz = Join-Path $root "dist\$repo-$version.tgz"
if (-not (Test-Path $distTgz)) { throw "tarball not found: $distTgz (run pack.ps1 first)" }

$releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases" -Headers $h
$rel = $releases | Where-Object { $_.tag_name -eq $tag } | Select-Object -First 1
if (-not $rel) {
  $body = @{
    tag_name = $tag
    name     = "$repo $tag"
    body     = "dsh-weread-moyu v$version — WeRead-as-background plugin for DeepSeek Harness.`n`nInstall: ``dsh plugin --profile desktop add $repo`` (npm) or download ``$assetName`` below and ``dsh plugin --profile desktop add <path-to-tgz>``."
  } | ConvertTo-Json
  $rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$owner/$repo/releases" -Headers $h -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
  Write-Host "[5/5] release $tag created" -ForegroundColor Green
} else {
  Write-Host "[5/5] release $tag exists" -ForegroundColor Cyan
}

# refresh the asset (delete + re-upload so republishing a version always works)
$assets = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/$($rel.id)/assets" -Headers $h
$old = $assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
if ($old) {
  Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$owner/$repo/releases/assets/$($old.id)" -Headers $h | Out-Null
  Write-Host "  replaced existing asset $assetName" -ForegroundColor Yellow
}
$uploadUrl = ($rel.upload_url -replace '\{\?.*$', '') + "?name=$assetName"
Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers ($h + @{ 'Content-Type' = 'application/gzip' }) -InFile $distTgz | Out-Null
$assetUrl = "https://github.com/$owner/$repo/releases/latest/download/$assetName"
Write-Host "  asset uploaded: $assetUrl" -ForegroundColor Green

Write-Host ''
Write-Host "DONE  repo:    $($r.html_url)" -ForegroundColor Green
Write-Host "      release: https://github.com/$owner/$repo/releases/tag/$tag" -ForegroundColor Green
Write-Host "      tarball: $assetUrl" -ForegroundColor Green
