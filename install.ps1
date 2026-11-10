# dsh-weread-moyu installer (DSH Desktop profile)
#
# Usage (PowerShell 7 recommended, so non-ASCII paths/messages print correctly):
#   pwsh -ExecutionPolicy Bypass -File "D:\Alan\插件\install.ps1"
#
# What it does:
#   1. dsh plugin --profile desktop add file:<repo>   (repo root IS the plugin package)
#   2. refresh the profile's hardlink copy of lib/ client/ package.json (pnpm
#      does not recopy an unchanged file: dependency, but the bundle changed)
#   3. make sure dsh-weread-moyu is listed in dsh.profile.bundles
#   4. print the restart instruction (client bundles load only at app startup)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$plugin = $root   # repo root IS the plugin package
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$manifestPath = Join-Path $profileDir 'package.json'
$installDir = Join-Path $profileDir 'node_modules\dsh-weread-moyu'

if (-not (Test-Path (Join-Path $plugin 'package.json'))) {
  throw "plugin package not found: $plugin"
}
if (-not (Test-Path $manifestPath)) {
  throw "DSH desktop profile not found: $manifestPath (open DeepSeek Harness once first)"
}

Write-Host '[1/3] install/update dsh-weread-moyu in the desktop profile ...' -ForegroundColor Cyan
& dsh plugin --profile desktop add "file:$plugin"
if ($LASTEXITCODE -ne 0) {
  throw "dsh plugin add failed with exit code $LASTEXITCODE"
}

Write-Host '[2/3] refresh the installed plugin files ...' -ForegroundColor Cyan
if (-not (Test-Path $installDir)) {
  throw "install directory missing: $installDir"
}
foreach ($sub in @('lib', 'client')) {
  $from = Join-Path $plugin $sub
  $to = Join-Path $installDir $sub
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  if (Test-Path $from) { Copy-Item (Join-Path $from '*') $to -Recurse -Force }
}
Copy-Item (Join-Path $plugin 'package.json') (Join-Path $installDir 'package.json') -Force
Copy-Item (Join-Path $plugin 'cordis.patch.yml') (Join-Path $installDir 'cordis.patch.yml') -Force
Write-Host '  refreshed lib/, client/, package.json, cordis.patch.yml'

Write-Host '[3/3] verify the profile manifest ...' -ForegroundColor Cyan
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-weread-moyu') {
  $manifest.dsh.profile.bundles = @($bundles + 'dsh-weread-moyu')
  $json = $manifest | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host '  added dsh-weread-moyu to dsh.profile.bundles' -ForegroundColor Yellow
} else {
  Write-Host '  dsh.profile.bundles already lists dsh-weread-moyu'
}
if (-not (Test-Path (Join-Path $installDir 'client\client.js'))) {
  Write-Host '  WARNING: client/client.js missing in the profile install' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'DONE. Fully quit and reopen DeepSeek Harness (client bundles load at startup).' -ForegroundColor Green
Write-Host 'After restart: click the small dot at the bottom-right -> scan the WeChat Reading QR -> pick a book.' -ForegroundColor Green
