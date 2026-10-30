param(
  [string]$AppHome = $PSScriptRoot,
  [string]$Url = "https://github.com/nadeshikochan/Flowave/releases/latest/download/Flowave-Recommendation-Engine-win-x64.zip",
  [switch]$Force,
  [switch]$ProgressJson
)

$ErrorActionPreference = "Stop"
if ($ProgressJson) {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
}

function Write-FlowaveProgress {
  param(
    [string]$Phase,
    [object]$Percent,
    [string]$Message,
    [Int64]$Done = 0,
    [Int64]$Total = 0
  )
  if (-not $ProgressJson) { return }
  $payload = [ordered]@{
    task = "recommendation"
    phase = $Phase
    percent = $Percent
    message = $Message
    target = "backend\index-worker"
    done = $Done
    total = $Total
    running = $Phase -notin @("complete", "error")
  }
  Write-Output ("FLOWAVE_PROGRESS " + ($payload | ConvertTo-Json -Compress))
}

$appRoot = [IO.Path]::GetFullPath($AppHome)
$backendRoot = [IO.Path]::GetFullPath((Join-Path $appRoot "backend"))
$targetDir = [IO.Path]::GetFullPath((Join-Path $backendRoot "index-worker"))
if (-not $targetDir.StartsWith(($backendRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
  throw "推荐组件目标目录越界: $targetDir"
}

$targetExe = Join-Path $targetDir "index-worker.exe"
$targetManifest = Join-Path $targetDir "component.json"
Write-FlowaveProgress -Phase "starting" -Percent 0 -Message "准备下载推荐组件…"
if (-not $Force -and (Test-Path -LiteralPath $targetExe -PathType Leaf) -and (Test-Path -LiteralPath $targetManifest -PathType Leaf)) {
  try {
    $installedComponent = Get-Content -LiteralPath $targetManifest -Raw | ConvertFrom-Json
    if ($installedComponent.runtime -eq "cuda" -and $installedComponent.cuda -eq "12.6") {
      Write-Host "推荐组件已经安装: $targetExe"
      Write-Host "如需重新安装，请运行: .\Install-Recommendation-Engine.ps1 -Force"
      Write-FlowaveProgress -Phase "complete" -Percent 100 -Message "推荐组件已安装。"
      exit 0
    }
  } catch {
    Write-Warning "现有推荐组件版本信息损坏，将重新安装。"
  }
}

$cacheRoot = Join-Path $appRoot "data\cache\installer"
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$zipPath = Join-Path $cacheRoot "recommendation-engine-$stamp.zip"
$extractDir = Join-Path $cacheRoot "recommendation-engine-$stamp"

try {
  Write-Host "正在下载推荐组件..."
  try {
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
      $job = Start-BitsTransfer -Source $Url -Destination $zipPath -DisplayName "Flowave 推荐组件" -Asynchronous
      try {
        while ($true) {
          $job = Get-BitsTransfer -JobId $job.JobId
          if ($job.JobState -eq "Transferred") { break }
          if ($job.JobState -eq "Error") { throw $job.ErrorDescription }
          $total = if ($job.BytesTotal -gt 0 -and $job.BytesTotal -lt [Int64]::MaxValue) { [Int64]$job.BytesTotal } else { [Int64]0 }
          $done = [Int64]$job.BytesTransferred
          $percent = if ($total -gt 0) { [Math]::Min(78, [Math]::Round(($done * 78.0) / $total, 1)) } else { $null }
          Write-FlowaveProgress -Phase "download" -Percent $percent -Message "正在下载推荐组件…" -Done $done -Total $total
          Start-Sleep -Milliseconds 400
        }
        Complete-BitsTransfer -BitsJob $job
      } catch {
        if ($job) {
          Remove-BitsTransfer -BitsJob $job -Confirm:$false -ErrorAction SilentlyContinue
        }
        throw
      }
    } else {
      Write-FlowaveProgress -Phase "download" -Percent $null -Message "正在下载推荐组件…"
      Invoke-WebRequest -Uri $Url -OutFile $zipPath -TimeoutSec 0
    }
  } catch {
    Write-Warning "BITS 下载失败，改用 HTTPS 下载: $($_.Exception.Message)"
    Write-FlowaveProgress -Phase "download" -Percent $null -Message "正在下载推荐组件…"
    Invoke-WebRequest -Uri $Url -OutFile $zipPath -TimeoutSec 0
  }

  Write-FlowaveProgress -Phase "extract" -Percent 82 -Message "正在解压推荐组件…"
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
  $downloadedExe = Join-Path $extractDir "index-worker.exe"
  $downloadedRuntime = Join-Path $extractDir "_internal"
  $downloadedManifest = Join-Path $extractDir "component.json"
  if (-not (Test-Path -LiteralPath $downloadedExe -PathType Leaf)) {
    throw "下载包缺少 index-worker.exe"
  }
  if (-not (Test-Path -LiteralPath $downloadedRuntime -PathType Container)) {
    throw "下载包缺少推荐组件运行库"
  }
  if (-not (Test-Path -LiteralPath $downloadedManifest -PathType Leaf)) {
    throw "下载包缺少推荐组件版本信息"
  }
  $component = Get-Content -LiteralPath $downloadedManifest -Raw | ConvertFrom-Json
  if ($component.runtime -ne "cuda" -or $component.cuda -ne "12.6") {
    throw "下载的推荐组件不支持预期的显卡加速"
  }

  Write-FlowaveProgress -Phase "install" -Percent 92 -Message "正在安装推荐组件…"
  $backupDir = "$targetDir.previous"
  if (Test-Path -LiteralPath $backupDir) {
    $staleBackup = "$backupDir.$stamp"
    Move-Item -LiteralPath $backupDir -Destination $staleBackup
  }
  if (Test-Path -LiteralPath $targetDir) {
    Move-Item -LiteralPath $targetDir -Destination $backupDir
  }
  try {
    Move-Item -LiteralPath $extractDir -Destination $targetDir
  } catch {
    if ((Test-Path -LiteralPath $backupDir) -and -not (Test-Path -LiteralPath $targetDir)) {
      Move-Item -LiteralPath $backupDir -Destination $targetDir
    }
    throw
  }

  Write-Host ""
  Write-Host "推荐组件安装完成: $targetExe"
  Write-Host "下一步安装 MERT 模型，再到“设置 > 高级维护”更新索引。"
  Write-FlowaveProgress -Phase "complete" -Percent 100 -Message "推荐组件安装完成。"
} catch {
  Write-FlowaveProgress -Phase "error" -Percent $null -Message "推荐组件安装失败，请检查网络后重试。"
  throw
} finally {
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  if (Test-Path -LiteralPath $extractDir) {
    Remove-Item -LiteralPath $extractDir -Recurse -Force
  }
}
