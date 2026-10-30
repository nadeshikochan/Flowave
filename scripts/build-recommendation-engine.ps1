param(
  [switch]$Clean,
  [switch]$RefreshEnvironment
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$workDir = Join-Path $repoRoot "build\pyinstaller-worker"
$distDir = Join-Path $repoRoot "build\backend"
$engineDir = Join-Path $distDir "index-worker"
$venvDir = Join-Path $repoRoot "build\worker-venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$requirements = Join-Path $repoRoot "requirements-recommendation-engine.txt"

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

if ($RefreshEnvironment -and (Test-Path -LiteralPath $venvDir)) {
  $resolvedBuild = [IO.Path]::GetFullPath((Join-Path $repoRoot "build"))
  $resolvedVenv = [IO.Path]::GetFullPath($venvDir)
  if (-not $resolvedVenv.StartsWith(($resolvedBuild + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
    throw "隔离环境路径越界: $resolvedVenv"
  }
  Remove-Item -LiteralPath $resolvedVenv -Recurse -Force
}

if (-not (Test-Path -LiteralPath $venvPython)) {
  Invoke-Checked uv venv $venvDir --python 3.10
}
Invoke-Checked uv pip install --python $venvPython `
  --index-url "https://download.pytorch.org/whl/cu126" `
  "torch==2.7.0+cu126" "torchaudio==2.7.0+cu126"
Invoke-Checked uv pip install --python $venvPython -r $requirements
Invoke-Checked $venvPython -c "import torch; assert torch.version.cuda == '12.6', torch.__version__; print('CUDA runtime:', torch.version.cuda)"

Push-Location $repoRoot
try {
  $args = @(
    "--noconfirm",
    "--distpath", "build\backend",
    "--workpath", "build\pyinstaller-worker",
    "packaging\index-worker.spec"
  )
  if ($Clean) {
    $args = @("--clean") + $args
  }
  Invoke-Checked $venvPython -m PyInstaller @args
} finally {
  Pop-Location
}

$engineExe = Join-Path $engineDir "index-worker.exe"
if (-not (Test-Path -LiteralPath $engineExe)) {
  throw "推荐组件构建失败: $engineExe"
}
$componentManifest = [ordered]@{
  schema_version = 1
  runtime = "cuda"
  torch = "2.7.0+cu126"
  cuda = "12.6"
  cpu_fallback = $true
}
$componentManifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $engineDir "component.json") -Encoding utf8
$size = (Get-ChildItem -LiteralPath $engineDir -Recurse -File | Measure-Object Length -Sum).Sum
$sizeGiB = [Math]::Round($size / 1GB, 2)
$zipPath = Join-Path $distDir "Flowave-Recommendation-Engine-win-x64.zip"
if (Test-Path -LiteralPath $zipPath) {
  Move-Item -LiteralPath $zipPath -Destination "$zipPath.previous" -Force
}
Compress-Archive -Path (Join-Path $engineDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host "推荐组件构建完成: $zipPath ($sizeGiB GiB unpacked)"
