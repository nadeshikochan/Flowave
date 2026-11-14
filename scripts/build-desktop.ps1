param([ValidateSet('portable','installed')][string]$Mode = 'portable', [switch]$SkipNpmInstall)
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
  $sourceCommit = (& git rev-parse HEAD).Trim()
  $sourceStatus = @(& git status --porcelain)
  $applicationVersion = (Get-Content -LiteralPath (Join-Path $electron 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $buildInfo = @{version=$applicationVersion;commit=$sourceCommit;builtAt=(Get-Date).ToUniversalTime().ToString('o');channel='preview';modified=($sourceStatus.Count -gt 0)}
  [IO.Directory]::CreateDirectory((Join-Path $repo 'build/portable-delivery')) | Out-Null
  $buildInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo 'build/release-build-info.json') -Encoding utf8
  Run -exe node -arguments @('scripts/verify-package-content.cjs')
  & (Join-Path $PSScriptRoot 'verify-public-source.ps1') -RepoRoot $repo
  & (Join-Path $PSScriptRoot 'verify-release-data.ps1') -DataDir (Join-Path $repo 'release-template/data')
  if (-not (Test-Path -LiteralPath $python)) { Run -exe uv -arguments @('venv', 'build/backend-venv', '--python', '3.11.14') }
  $verifyEnvironment = @'
import sys
from pathlib import Path
from resource_runtime import catalog
from resource_installer import validate_url
assert sys.version_info[:3] == (3, 11, 14), 'Use the pinned backend Python 3.11.14 environment'
resources = catalog(Path('.'))
for group in resources['groups'].values():
    for resource in group['files']:
        validate_url(resource['url'])
for profile in resources['profiles'].values():
    for name in ('python', 'uv'):
        validate_url(profile[name]['url'])
'@
  $verifyEnvironment | & $python -
  if ($LASTEXITCODE -ne 0) { throw 'Backend environment or resource URL validation failed.' }
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
    & npm ls --all --omit=dev --include=optional --json 2>&1 | Set-Content -LiteralPath (Join-Path $repo 'build/runtime-dependencies.json') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Installed production dependencies are incomplete. Run npm ci in this build tree.' }
    $output = 'dist/' + $Mode + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    $configPath = Join-Path $repo "build/desktop-$Mode.json"
    $config = (Get-Content -LiteralPath (Join-Path $electron 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).build
    $config.directories.output = Join-Path $electron $output
    $config.files = @($config.files) + @(@{from=(Join-Path $repo 'build/release-build-info.json');to='build-info.json'})
    $electronDist = Join-Path $electron 'node_modules/electron/dist'
    if (Test-Path -LiteralPath (Join-Path $electronDist 'electron.exe')) { $config | Add-Member -NotePropertyName electronDist -NotePropertyValue $electronDist -Force }
    if ($Mode -eq 'installed') {
      $marker = Join-Path $repo 'build/installed-distribution.json'
      '{"mode":"installed","officialPackages":"bundled"}' | Set-Content -LiteralPath $marker -Encoding ascii
      $config.extraFiles = @($config.extraFiles | Where-Object { $_.to -notin @('data','distribution.json','README-开始使用.txt') }) + @(@{from=$marker;to='distribution.json'},@{from=(Join-Path $repo 'release-template/README-安装版.txt');to='README-开始使用.txt'})
    }
    $config | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $configPath -Encoding utf8
    Run -exe (Join-Path $electron 'node_modules/.bin/electron-builder.cmd') -arguments @('--dir', '--x64', '--config', $configPath, '--publish','never')
  } finally { Pop-Location }
  $unpacked = Join-Path $electron "$output/win-unpacked"
  $signatureState = & (Join-Path $PSScriptRoot 'sign-windows.ps1') -Files @((Join-Path $unpacked 'Flowave.exe'), (Join-Path $unpacked 'backend/api.exe'))
  foreach($file in $files){
    if((Get-FileHash -LiteralPath (Join-Path $repo $file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes[$file]){
      throw "Source changed during the build; rebuild before packaging: $file"
    }
  }
  Run -exe node -arguments @('scripts/verify-package-content.cjs', (Join-Path $unpacked 'resources/app.asar'))
  & (Join-Path $PSScriptRoot 'verify-public-source.ps1') -RepoRoot $repo -AppAsar (Join-Path $unpacked 'resources/app.asar')
  if ($Mode -eq 'portable') {
    & (Join-Path $PSScriptRoot 'verify-release-data.ps1') -DataDir (Join-Path $unpacked 'data')
  } elseif (Test-Path -LiteralPath (Join-Path $unpacked 'data')) { throw 'Installed program must not contain user data.' }
  $version = (Get-Content -LiteralPath (Join-Path $electron 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ((& git rev-parse HEAD).Trim() -ne $sourceCommit -or (@(& git status --porcelain) -join "`n") -ne ($sourceStatus -join "`n")) { throw 'Source changed during packaging. Build again from the selected source version.' }
  if ($Mode -eq 'installed') {
    $compiler = & (Join-Path $PSScriptRoot 'prepare-inno.ps1')
    Run -exe $compiler -arguments @("/DSourceDir=$unpacked", "/DAppVersion=$version", ('/DAppIcon=' + (Join-Path $electron 'renderer/assets/app-icon.ico')), ('/O' + (Join-Path $electron $output)), (Join-Path $repo 'packaging/windows/installer.iss'))
    $installer = Join-Path $electron "$output/Flowave-$version-x64-Setup.exe"
    $signatureState = & (Join-Path $PSScriptRoot 'sign-windows.ps1') -Files @($installer)
    $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($installer))" | Set-Content -LiteralPath "$installer.sha256" -Encoding ascii
    @{commit=$sourceCommit;modified=($sourceStatus.Count -gt 0);version=$version;signature=$signatureState;installer=$installer;sha256=$hash;bytes=(Get-Item -LiteralPath $installer).Length;unpacked=$unpacked} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo 'build/portable-delivery/latest-installer.json') -Encoding utf8
    Write-Host "Installer: $installer"
    return
  }
  $zip = Join-Path $electron "$output/Flowave-$version-win-x64-portable.zip"
  Compress-Archive -Path (Join-Path $unpacked '*') -DestinationPath $zip -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $([IO.Path]::GetFileName($zip))" | Set-Content -LiteralPath "$zip.sha256" -Encoding ascii
  $stamp = @{commit=$sourceCommit;modified=($sourceStatus.Count -gt 0);version=$version;signature=$signatureState;zip=$zip;sha256=$hash;bytes=(Get-Item -LiteralPath $zip).Length;unpacked=$unpacked}
  $stamp | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo 'build/portable-delivery/latest-build.json') -Encoding utf8
  Write-Host "Portable ZIP: $zip"
} finally { Pop-Location }
