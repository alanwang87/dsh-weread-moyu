# dsh-weread-moyu - client bundle verification
#
# Opens examples/client-harness/index.html in headless Edge/Chrome and runs DOM
# contract assertions:
#   1) mock host + dark theme (real data flow)
#   2) no host + dark theme (demo fallback mode)
#   3) mock host + light theme (theme branch)
#
# Usage:
#   powershell -NoProfile -File examples/verify-client.ps1
#   powershell -NoProfile -File examples/verify-client.ps1 -Screenshots
#
# Exit code: 0 = all pass; 1 = assertion failures; 2 = no browser found

[CmdletBinding()]
param(
  [switch]$Screenshots,
  [string]$Browser
)

$ErrorActionPreference = 'Continue'

$harness = Join-Path $PSScriptRoot 'client-harness\index.html'
if (-not (Test-Path $harness)) { throw "harness not found: $harness" }
$harnessUrl = ([System.Uri]$harness).AbsoluteUri

$candidates = @(
  $Browser,
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $candidates -or $candidates.Count -eq 0) {
  Write-Host 'Edge/Chrome not found, cannot run assertions.' -ForegroundColor Red
  exit 2
}
$browserExe = $candidates[0]

$tempRoot = Join-Path $env:TEMP ('weread-moyu-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$script:failures = @()

function Invoke-Suite {
  param([string]$Name, [string]$Query)

  $outFile = Join-Path $tempRoot ($Name + '.dom.txt')
  $profile = Join-Path $tempRoot ('profile-' + $Name)
  $url = $harnessUrl + $Query
  & $browserExe --headless=new --disable-gpu --no-first-run --user-data-dir="$profile" `
    --virtual-time-budget=45000 --dump-dom $url 2>&1 | Out-File -FilePath $outFile -Encoding utf8

  $raw = Get-Content $outFile -Raw
  $match = [regex]::Match($raw, 'id="harness-assertions"[^>]*>([\s\S]*?)</script>')
  if (-not $match.Success) {
    Write-Host ("[{0}] no assertion result (page did not boot)" -f $Name) -ForegroundColor Red
    $script:failures += "$Name / no-result"
    return
  }

  $json = [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value).Trim()
  $payload = $json | ConvertFrom-Json
  $color = if ($payload.pass) { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1}/{2} assertions passed" -f $Name, ($payload.total - $payload.failed), $payload.total) -ForegroundColor $color
  if (-not $payload.pass) {
    foreach ($item in $payload.results) {
      if (-not $item.pass) {
        Write-Host ("   FAIL {0} :: {1}" -f $item.name, $item.detail) -ForegroundColor Red
        $script:failures += "$Name / $($item.name)"
      }
    }
  }
  if ($payload.bootErrors -and @($payload.bootErrors).Count -gt 0) {
    Write-Host ("   bootErrors: {0}" -f (@($payload.bootErrors) -join '; ')) -ForegroundColor Yellow
  }
}

Write-Host ("browser: {0}" -f $browserExe)
Write-Host ("harness: {0}" -f $harnessUrl)
Write-Host ''

Invoke-Suite -Name 'mock-dark' -Query '?mock=1&assert=1'
Invoke-Suite -Name 'demo-dark' -Query '?assert=1'
Invoke-Suite -Name 'mock-light' -Query '?theme=light&mock=1&assert=1'

if ($Screenshots) {
  $shots = @(
    @{ Name = 'shot-demo.png'; Query = '?speed=0' },
    @{ Name = 'shot-panel-mock.png'; Query = '?mock=1&panel=1&speed=0' },
    @{ Name = 'shot-panel-demo.png'; Query = '?panel=1&speed=0' },
    @{ Name = 'shot-light.png'; Query = '?theme=light&speed=0' },
    @{ Name = 'shot-qr.png'; Query = '?mock=1&panel=1&qr=1&speed=0' },
    @{ Name = 'shot-peek.png'; Query = '?mock=1&peek=1&speed=0' },
    @{ Name = 'shot-chapters.png'; Query = '?mock=1&panel=1&book=b4&jump=500&speed=0' },
    @{ Name = 'shot-cache.png'; Query = '?mock=1&panel=1&book=b4&cache=done&speed=0' },
    @{ Name = 'shot-cache-progress.png'; Query = '?mock=1&panel=1&book=b4&cache=running&speed=0' }
  )
  Write-Host ''
  Write-Host 'generating screenshots ...'
  foreach ($shot in $shots) {
    $target = Join-Path $PSScriptRoot $shot.Name
    if (Test-Path $target) { Remove-Item $target -Force }
    $profile = Join-Path $tempRoot ('profile-shot-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
    $arguments = @(
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      ('--user-data-dir="' + $profile + '"'),
      '--virtual-time-budget=3200',
      '--window-size=1440,900',
      ('--screenshot="' + $target + '"'),
      ($harnessUrl + $shot.Query)
    )
    # Start-Process + WaitForExit 超时，避免个别 headless 实例卡死整个脚本
    $proc = Start-Process -FilePath $browserExe -ArgumentList $arguments -PassThru -NoNewWindow
    if (-not $proc.WaitForExit(45000)) {
      try { $proc.Kill() } catch { }
      Start-Sleep -Milliseconds 300
    }
    $tries = 0
    while (-not (Test-Path $target) -and $tries -lt 20) { Start-Sleep -Milliseconds 250; $tries++ }
    Start-Sleep -Milliseconds 250
    if (Test-Path $target) {
      Write-Host ("   OK {0} ({1:N0} bytes)" -f $shot.Name, (Get-Item $target).Length) -ForegroundColor Green
    } else {
      Write-Host ("   MISS {0}" -f $shot.Name) -ForegroundColor Red
      $script:failures += "screenshot / $($shot.Name)"
    }
  }
}

try { Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }

Write-Host ''
if ($script:failures.Count -eq 0) {
  Write-Host 'ALL PASS' -ForegroundColor Green
  exit 0
} else {
  Write-Host ("FAILED {0} item(s):" -f $script:failures.Count) -ForegroundColor Red
  $script:failures | ForEach-Object { Write-Host ("   - " + $_) -ForegroundColor Red }
  exit 1
}
