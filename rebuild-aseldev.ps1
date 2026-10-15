# Installs, builds and starts AselDev Harness. Use it the first time on a new
# computer, after a git pull, and after code changes.
# 1. stops the server already running on port 3080
# 2. pnpm install + pnpm run build (full output saved to
#    %USERPROFILE%\.dsh-aseldev\last-build.log, UTF-8)
# 3. aseldev\setup-profile.ps1 (points the profile at this folder's plugins)
# 4. runs start-aseldev.cmd (its output goes to last-start.log)
$env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh-aseldev'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
$log = Join-Path $env:DSH_HOME 'last-build.log'

foreach ($tool in 'node', 'pnpm') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Host "'$tool' was not found. Install Node.js 24 LTS (https://nodejs.org), then run: npm install -g pnpm@11.7.0"
    Write-Host 'Open a new terminal afterwards and run this again.'
    Read-Host 'Press Enter to close'
    exit 1
  }
}

Write-Host 'Stopping the AselDev server on port 3080 (if it is running)...'
Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

$out = New-Object System.Collections.Generic.List[string]
Write-Host 'Installing packages (pnpm install)...'
$out.Add('== pnpm install ==')
pnpm install --prefer-offline 2>&1 | ForEach-Object { $out.Add("$_") }
$installCode = $LASTEXITCODE
$out.Add("INSTALL EXIT: $installCode")

$buildCode = 1
if ($installCode -eq 0) {
  Write-Host 'Building (pnpm run build). This takes a few minutes...'
  $out.Add('== pnpm run build ==')
  pnpm run build 2>&1 | ForEach-Object { $out.Add("$_") }
  $buildCode = $LASTEXITCODE
}
$out.Add("BUILD EXIT: $buildCode")
$out | Set-Content -Encoding UTF8 $log
$out | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }

if ($buildCode -ne 0) {
  Write-Host ''
  Write-Host "Build failed. Full log: $log"
  Read-Host 'Press Enter to close'
  exit 1
}

& (Join-Path $PSScriptRoot 'aseldev\setup-profile.ps1') -DshHome $env:DSH_HOME
Write-Host 'Build OK. Starting AselDev Harness...'
& cmd /c "`"$PSScriptRoot\start-aseldev.cmd`""
