param(
  [string]$RepoRoot = "",
  [string]$AppAsar = ""
)

$ErrorActionPreference = "Stop"
if (-not $RepoRoot) {
  $RepoRoot = Join-Path $PSScriptRoot ".."
}
$repo = [IO.Path]::GetFullPath($RepoRoot)
$electronDir = Join-Path $repo "electron-lxplayer"
$packagePath = Join-Path $electronDir "package.json"

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  throw "Missing Electron package.json: $packagePath"
}

$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$buildFiles = @($package.build.files | ForEach-Object { ([string]$_).Replace("\", "/").ToLowerInvariant() })
$forbiddenBuildEntries = @($buildFiles | Where-Object {
  $_ -eq "**/*" -or
  $_ -match "(^|/)metadata_cache" -or
  $_ -match "^data(?:/|$)" -or
  $_ -match "web-player|remote_access|remote_tunnel|web_sessions"
})
if ($forbiddenBuildEntries.Count -gt 0) {
  throw "Public package includes forbidden broad or runtime-data entries: $($forbiddenBuildEntries -join ', ')"
}

$dataMappings = @($package.build.extraFiles | Where-Object { ([string]$_.to).Replace("\", "/") -eq "data" })
if ($dataMappings.Count -ne 1) {
  throw "Public package must have exactly one data extraFiles mapping."
}
$dataSource = ([string]$dataMappings[0].from).Replace("\", "/")
if ($dataSource -ne "../release-template/data") {
  throw "Public package data must come from ../release-template/data, got: $dataSource"
}

$sourceFiles = @(
  "main.js",
  "preload.js",
  "overlay-preload.js",
  "listening-history-ops.js",
  "listening-history-store.js",
  "secure-protocols.js",
  "backend-health.js",
  "metadata-service.js"
) | ForEach-Object { Join-Path $electronDir $_ }
foreach ($relativeDir in @("online", "lyrics", "song-info")) {
  $sourceDir = Join-Path $electronDir $relativeDir
  $sourceFiles += @(Get-ChildItem -LiteralPath $sourceDir -Recurse -File -Include *.js |
    Select-Object -ExpandProperty FullName)
}
$sourceFiles += @(Get-ChildItem -LiteralPath (Join-Path $electronDir "renderer") -File -Include *.js,*.html,*.css |
  Select-Object -ExpandProperty FullName)

$literalDrivePattern = '["''][A-Za-z]:\\\\'
$literalFileUrlPattern = 'file:///[A-Za-z]:/'
$pathLeaks = @()
foreach ($file in $sourceFiles) {
  $item = Get-Item -LiteralPath $file
  $text = Get-Content -LiteralPath $item.FullName -Raw -Encoding UTF8
  if ($text -match $literalDrivePattern -or $text -match $literalFileUrlPattern) {
    $pathLeaks += $item.FullName
  }
}
if ($pathLeaks.Count -gt 0) {
  throw "Packaged first-party source contains literal Windows paths: $($pathLeaks -join ', ')"
}

if (Test-Path -LiteralPath (Join-Path $repo ".git")) {
  $trackedData = @(& git -C $repo -c core.quotePath=false ls-files -- data)
  if ($LASTEXITCODE -ne 0) {
    throw "git ls-files failed while checking tracked runtime data."
  }
  if ($trackedData.Count -gt 0) {
    throw "Runtime data is still tracked by Git: $($trackedData -join ', ')"
  }
}

if ($AppAsar) {
  $asarPath = [IO.Path]::GetFullPath($AppAsar)
  if (-not (Test-Path -LiteralPath $asarPath -PathType Leaf)) {
    throw "Missing app.asar: $asarPath"
  }
  $asarCmd = Join-Path $electronDir "node_modules\.bin\asar.cmd"
  if (-not (Test-Path -LiteralPath $asarCmd -PathType Leaf)) {
    throw "Missing local asar CLI: $asarCmd"
  }
  $asarEntries = @(& $asarCmd list $asarPath)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect app.asar."
  }
  $forbiddenAsarPattern = '^\\(?:metadata_cache[^\\]*\.json|config\.json|data(?:\\|$)|web-player(?:\\|$)|remote_access|remote_tunnel|web_sessions|cloudflared)'
  $asarViolations = @($asarEntries | Where-Object { [string]$_ -match $forbiddenAsarPattern })
  if ($asarViolations.Count -gt 0) {
    throw "app.asar contains forbidden runtime or removed-service files: $($asarViolations -join ', ')"
  }
}

Write-Host "Public source boundary check passed: $repo"
