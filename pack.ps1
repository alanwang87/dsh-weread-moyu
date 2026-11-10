# Build a distributable npm tarball for dsh-weread-moyu.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "D:\Alan\插件\pack.ps1"
#
# Output:
#   dist\dsh-weread-moyu-<version>.tgz
#
# The tarball can be installed on another machine with:
#   dsh plugin --profile desktop add "<path>\dsh-weread-moyu-<version>.tgz"

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$plugin = $root   # repo root IS the plugin package (package.json lives here)
$dist = Join-Path $root 'dist'

if (-not (Test-Path (Join-Path $plugin 'package.json'))) {
  throw "plugin package not found: $plugin"
}

$pkg = Get-Content (Join-Path $plugin 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
New-Item -ItemType Directory -Force -Path $dist | Out-Null

Push-Location $plugin
try {
  npm pack --pack-destination $dist | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm pack failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$tgz = Join-Path $dist "dsh-weread-moyu-$version.tgz"
if (-not (Test-Path $tgz)) { throw "expected tarball not found: $tgz" }
$file = Get-Item $tgz
$hash = (Get-FileHash $tgz -Algorithm SHA256).Hash
Write-Host ''
Write-Host "PACKED  $($file.FullName)"
Write-Host ("        {0:N1} KB   sha256={1}" -f ($file.Length / 1KB), $hash)
Write-Host ''
Write-Host 'Next steps:'
Write-Host ("  other machine:  dsh plugin --profile desktop add `"<copied path>\dsh-weread-moyu-$version.tgz`"")
Write-Host '  then fully quit and reopen DeepSeek Harness.'
Write-Host '  publish to npm: (repo root) npm publish --access public'
Write-Host '  marketplace:    see docs/DISTRIBUTION.md'
