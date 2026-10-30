param(
  [switch]$SkipBackendBuild,
  [switch]$SkipNpmInstall,
  [switch]$SkipInstaller,
  [switch]$RefreshBackendEnvironment
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$electronDir = Join-Path $repoRoot "electron-lxplayer"
$backendDir = Join-Path $repoRoot "build\backend\api"
$backendVenvDir = Join-Path $repoRoot "build\backend-venv"
$backendPython = Join-Path $backendVenvDir "Scripts\python.exe"
$backendRequirements = Join-Path $repoRoot "requirements-public-backend.txt"
$unpackedDir = Join-Path $electronDir "dist\win-unpacked"
$templateDir = Join-Path $repoRoot "release-template\data"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ArgumentList
  )
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "命令执行失败 ($LASTEXITCODE): $FilePath $($ArgumentList -join ' ')"
  }
}

& (Join-Path $PSScriptRoot "verify-public-source.ps1") -RepoRoot $repoRoot
& (Join-Path $PSScriptRoot "verify-release-data.ps1") -DataDir $templateDir

if (-not $SkipBackendBuild) {
  if ($RefreshBackendEnvironment -and (Test-Path -LiteralPath $backendVenvDir)) {
    $resolvedBuild = [IO.Path]::GetFullPath((Join-Path $repoRoot "build"))
    $resolvedVenv = [IO.Path]::GetFullPath($backendVenvDir)
    if (-not $resolvedVenv.StartsWith(($resolvedBuild + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
      throw "后端隔离环境路径越界: $resolvedVenv"
    }
    Remove-Item -LiteralPath $resolvedVenv -Recurse -Force
  }
  if (-not (Test-Path -LiteralPath $backendPython -PathType Leaf)) {
    Invoke-Checked uv venv $backendVenvDir --python 3.10
  }
  Invoke-Checked uv pip install --python $backendPython -r $backendRequirements
  Push-Location $repoRoot
  try {
    Invoke-Checked $backendPython -m PyInstaller --noconfirm --clean `
      --distpath "build\backend" `
      --workpath "build\pyinstaller-api" `
      "packaging\backend-api.spec"
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $backendDir "api.exe"))) {
  throw "缺少轻量后端: $backendDir"
}

Push-Location $electronDir
try {
  if (-not $SkipNpmInstall) {
    Invoke-Checked npm ci
  }
  Invoke-Checked npm run check
  $electronBuilder = Join-Path $electronDir "node_modules\.bin\electron-builder.cmd"
  if (-not (Test-Path -LiteralPath $electronBuilder -PathType Leaf)) {
    throw "缺少本地 electron-builder，请先成功执行 npm ci"
  }
  Invoke-Checked $electronBuilder --dir --x64
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath (Join-Path $unpackedDir "Flowave.exe"))) {
  throw "Electron 解包产物不存在: $unpackedDir"
}
& (Join-Path $PSScriptRoot "verify-public-source.ps1") `
  -RepoRoot $repoRoot `
  -AppAsar (Join-Path $unpackedDir "resources\app.asar")
& (Join-Path $PSScriptRoot "verify-release-data.ps1") -DataDir (Join-Path $unpackedDir "data")

$packageJson = Get-Content -LiteralPath (Join-Path $electronDir "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$packageJson.version
$productName = [string]$packageJson.build.productName
$zipPath = Join-Path $electronDir "dist\Flowave-$version-win-x64-portable.zip"
if (Test-Path -LiteralPath $zipPath) {
  Move-Item -LiteralPath $zipPath -Destination "$zipPath.previous" -Force
}
Compress-Archive -Path (Join-Path $unpackedDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

if (-not $SkipInstaller) {
  Push-Location $electronDir
  try {
    Invoke-Checked $electronBuilder --win nsis --x64 --prepackaged "$unpackedDir"
  } finally {
    Pop-Location
  }
}

$distDir = Join-Path $electronDir "dist"
$engineAsset = Join-Path $repoRoot "build\backend\Flowave-Recommendation-Engine-win-x64.zip"
if (Test-Path -LiteralPath $engineAsset -PathType Leaf) {
  Copy-Item -LiteralPath $engineAsset -Destination (Join-Path $distDir (Split-Path $engineAsset -Leaf)) -Force
}

$releaseAssets = @($zipPath)
if (-not $SkipInstaller) {
  $installerPath = Join-Path $distDir "$productName-$version-x64-Setup.exe"
  if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "安装版产物不存在: $installerPath"
  }
  $releaseAssets += $installerPath
}
if (Test-Path -LiteralPath $engineAsset -PathType Leaf) {
  $releaseAssets += Join-Path $distDir (Split-Path $engineAsset -Leaf)
}
$checksumPath = Join-Path $distDir "SHA256SUMS.txt"
$checksumLines = @($releaseAssets | ForEach-Object {
  $item = Get-Item -LiteralPath $_
  $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $($item.Name)"
})
Set-Content -LiteralPath $checksumPath -Value $checksumLines -Encoding ascii

Write-Host ""
Write-Host "Windows 产物已生成:"
Write-Host "  绿色 ZIP: $zipPath"
if (-not $SkipInstaller) {
  Write-Host "  安装版: $installerPath"
}
if (Test-Path -LiteralPath $engineAsset -PathType Leaf) {
  Write-Host "  推荐组件: $(Join-Path $distDir (Split-Path $engineAsset -Leaf))"
}
Write-Host "  校验清单: $checksumPath"
