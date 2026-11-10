param([switch]$SkipNpmInstall)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$electron = Join-Path $repo 'electron-lxplayer'
$python = Join-Path $repo 'build/backend-venv/Scripts/python.exe'
function Run([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "Build command failed: $exe ($LASTEXITCODE)" }
}
Push-Location $repo
try {
  Run -exe node -arguments @('scripts/verify-package-content.cjs')
  & (Join-Path $PSScriptRoot 'verify-public-source.ps1') -RepoRoot $repo
  & (Join-Path $PSScriptRoot 'verify-release-data.ps1') -DataDir (Join-Path $repo 'release-template/data')
  if (-not (Test-Path -LiteralPath $python)) { Run -exe uv -arguments @('venv', 'build/backend-venv', '--python', '3.11.14') }
  Run -exe $python -arguments @('-c', 'import sys; assert sys.version_info[:3] == (3,11,14), "Use the pinned backend Python 3.11.14 environment"')
  Run -exe $python -arguments @('-c', 'from pathlib import Path;from resource_runtime import catalog;from resource_installer import validate_url;c=catalog(Path("."));[validate_url(r["url"]) for g in c["groups"].values() for r in g["files"]];[validate_url(p[k]["url"]) for p in c["profiles"].values() for k in ("python","uv")]')
  Run -exe uv -arguments @('pip', 'sync', '--python', $python, '--require-hashes', 'packaging/backend-requirements.lock')
  $source = Join-Path $repo 'build/backend-source'
  [IO.Directory]::CreateDirectory($source) | Out-Null
  $files = @(& git -c core.quotePath=false ls-files -- '*.py' | Where-Object { $_ -notmatch '/' })
  if ($LASTEXITCODE -ne 0 -or $files -notcontains 'resource_installer.py') { throw 'Backend source list is incomplete.' }
  # This directory contains only generated source copies. Never touch app data.
  Get-ChildItem -LiteralPath $source -File -Filter '*.py' | Where-Object { $files -notcontains $_.Name } | Remove-Item -Force
  $hashes = @{}
  foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $repo $file) -Destination (Join-Path $source $file) -Force
    $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $source $file) -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $hashes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $source 'manifest.json') -Encoding utf8
  Run -exe $python -arguments @('-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', 'build/backend', '--workpath', 'build/pyinstaller-api', 'packaging/backend-api.spec')
  Push-Location $electron
  try {
    if (-not $SkipNpmInstall) { Run -exe npm -arguments @('ci') }
    $output = 'dist/portable-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Run -exe (Join-Path $electron 'node_modules/.bin/electron-builder.cmd') -arguments @('--dir', '--x64', "--config.directories.output=$output")
  } finally { Pop-Location }
  $unpacked = Join-Path $electron "$output/win-unpacked"
  foreach($file in $files){
    if((Get-FileHash -LiteralPath (Join-Path $repo $file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes[$file]){
      throw "Source changed during the build; rebuild before packaging: $file"
    }
  }
  Run -exe node -arguments @('scripts/verify-package-content.cjs', (Join-Path $unpacked 'resources/app.asar'))
  & (Join-Path $PSScriptRoot 'verify-public-source.ps1') -RepoRoot $repo -AppAsar (Join-Path $unpacked 'resources/app.asar')
  & (Join-Path $PSScriptRoot 'verify-release-data.ps1') -DataDir (Join-Path $unpacked 'data')
  $version = (Get-Content -LiteralPath (Join-Path $electron 'package.json') -Raw | ConvertFrom-Json).version
  $zip = Join-Path $electron "$output/Flowave-$version-win-x64-portable.zip"
  Compress-Archive -Path (Join-Path $unpacked '*') -DestinationPath $zip -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $([IO.Path]::GetFileName($zip))" | Set-Content -LiteralPath "$zip.sha256" -Encoding ascii
  $stamp = @{commit=(& git rev-parse HEAD);modified=(@(& git status --porcelain).Count -gt 0);version=$version;zip=$zip;sha256=$hash;bytes=(Get-Item -LiteralPath $zip).Length;unpacked=$unpacked}
  $stamp | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo 'build/portable-delivery/latest-build.json') -Encoding utf8
  Write-Host "Portable ZIP: $zip"
} finally { Pop-Location }
