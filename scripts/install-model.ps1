param(
  [string]$AppHome = $PSScriptRoot,
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
    [string]$Target,
    [Int64]$Done = 0,
    [Int64]$Total = 0
  )
  if (-not $ProgressJson) { return }
  $payload = [ordered]@{
    task = "model"
    phase = $Phase
    percent = $Percent
    message = $Message
    target = $Target
    done = $Done
    total = $Total
    running = $Phase -notin @("complete", "error")
  }
  Write-Output ("FLOWAVE_PROGRESS " + ($payload | ConvertTo-Json -Compress))
}

function Start-DownloadWithProgress {
  param(
    [string]$Source,
    [string]$Destination,
    [string]$DisplayName,
    [Int64]$CompletedBytes,
    [Int64]$ExpectedTotal,
    [string]$Target
  )
  if (-not (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue)) {
    Write-FlowaveProgress -Phase "download" -Percent $null -Message "正在下载 $DisplayName…" -Target $Target -Done $CompletedBytes -Total $ExpectedTotal
    Invoke-WebRequest -Uri $Source -OutFile $Destination -TimeoutSec 0
    return
  }
  $job = $null
  try {
    $job = Start-BitsTransfer -Source $Source -Destination $Destination -DisplayName $DisplayName -Asynchronous
    while ($true) {
      $job = Get-BitsTransfer -JobId $job.JobId
      if ($job.JobState -eq "Transferred") { break }
      if ($job.JobState -eq "Error") { throw $job.ErrorDescription }
      $done = $CompletedBytes + [Int64]$job.BytesTransferred
      $percent = if ($ExpectedTotal -gt 0) { [Math]::Min(99, [Math]::Round(($done * 100.0) / $ExpectedTotal, 1)) } else { $null }
      Write-FlowaveProgress -Phase "download" -Percent $percent -Message "正在下载 $DisplayName…" -Target $Target -Done $done -Total $ExpectedTotal
      Start-Sleep -Milliseconds 400
    }
    Complete-BitsTransfer -BitsJob $job
  } catch {
    if ($job) {
      Remove-BitsTransfer -BitsJob $job -Confirm:$false -ErrorAction SilentlyContinue
    }
    throw
  }
}

$appRoot = [IO.Path]::GetFullPath($AppHome)
$targetDir = [IO.Path]::GetFullPath((Join-Path $appRoot "models\MERT-v1-330M"))
$modelsRoot = [IO.Path]::GetFullPath((Join-Path $appRoot "models"))
if (-not $targetDir.StartsWith($modelsRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "模型目标目录越界: $targetDir"
}
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

$baseUrl = "https://huggingface.co/m-a-p/MERT-v1-330M/resolve/main"
$licenseUrl = "https://creativecommons.org/licenses/by-nc/4.0/"
$files = @(
  @{ Name = "config.json"; Size = 2032; Sha256 = "a5b40f9db03c84f29e3114abe813a9226178d5437b517d45cd4c2924ac3d0ce0" },
  @{ Name = "configuration_MERT.py"; Size = 5340; Sha256 = "ae0ec2bab8f59c724ba9878a7c20b67210189536ea62d34a56775968e9decb03" },
  @{ Name = "modeling_MERT.py"; Size = 18033; Sha256 = "6c3ee73cef6f0c30ef494f88d96f891fa6925ffe663fa391b512f4b57abecc6c" },
  @{ Name = "preprocessor_config.json"; Size = 212; Sha256 = "c623b903eb1967474b27522975cfb81638e265df99aa640d2c0bd87a987ab538" },
  @{ Name = "pytorch_model.bin"; Size = 1261846489; Sha256 = "0c03774d821a6ad972cb48220b128a10ebea2c790116bd0fd35e5a013f8017f6" }
)
$expectedTotal = [Int64](($files | Measure-Object -Property Size -Sum).Sum)
$completedBytes = [Int64]0

trap {
  Write-FlowaveProgress -Phase "error" -Percent $null -Message "模型安装失败，请检查网络后重试。" -Target "models\MERT-v1-330M" -Done $completedBytes -Total $expectedTotal
  exit 1
}

Write-FlowaveProgress -Phase "starting" -Percent 0 -Message "准备下载模型…" -Target "models\MERT-v1-330M" -Done 0 -Total $expectedTotal

Write-Host "MERT-v1-330M 由 m-a-p 发布，模型许可为 CC BY-NC 4.0。"
Write-Host "仅限符合非商业条款的用途；商业使用前请另行取得授权。"
Write-Host "许可说明: $licenseUrl"
Write-Host ""

function Test-ExpectedFile {
  param([string]$Path, [hashtable]$Expected)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  if ((Get-Item -LiteralPath $Path).Length -ne [int64]$Expected.Size) { return $false }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  return $actual -eq $Expected.Sha256
}

foreach ($file in $files) {
  $destination = Join-Path $targetDir $file.Name
  if (-not $Force -and (Test-ExpectedFile -Path $destination -Expected $file)) {
    Write-Host "已校验，跳过: $($file.Name)"
    $completedBytes += [Int64]$file.Size
    $percent = [Math]::Min(99, [Math]::Round(($completedBytes * 100.0) / $expectedTotal, 1))
    Write-FlowaveProgress -Phase "verify" -Percent $percent -Message "已校验 $($file.Name)" -Target "models\MERT-v1-330M" -Done $completedBytes -Total $expectedTotal
    continue
  }

  if (Test-Path -LiteralPath $destination) {
    $invalid = "$destination.invalid.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item -LiteralPath $destination -Destination $invalid
    Write-Warning "旧文件校验失败，已保留为: $invalid"
  }

  $partial = "$destination.partial"
  if (Test-Path -LiteralPath $partial) {
    $stale = "$partial.stale.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item -LiteralPath $partial -Destination $stale
  }
  $source = "$baseUrl/$($file.Name)?download=true"
  Write-Host "正在下载 $($file.Name) ..."
  try {
    Start-DownloadWithProgress -Source $source -Destination $partial -DisplayName $file.Name -CompletedBytes $completedBytes -ExpectedTotal $expectedTotal -Target "models\MERT-v1-330M"
  } catch {
    Write-Warning "BITS 下载失败，改用 HTTPS 下载: $($_.Exception.Message)"
    Write-FlowaveProgress -Phase "download" -Percent $null -Message "正在下载 $($file.Name)…" -Target "models\MERT-v1-330M" -Done $completedBytes -Total $expectedTotal
    Invoke-WebRequest -Uri $source -OutFile $partial -TimeoutSec 0
  }

  Write-FlowaveProgress -Phase "verify" -Percent ([Math]::Min(99, [Math]::Round((($completedBytes + [Int64]$file.Size) * 100.0) / $expectedTotal, 1))) -Message "正在校验 $($file.Name)…" -Target "models\MERT-v1-330M" -Done $completedBytes -Total $expectedTotal
  if (-not (Test-ExpectedFile -Path $partial -Expected $file)) {
    throw "下载文件校验失败: $($file.Name)"
  }
  Move-Item -LiteralPath $partial -Destination $destination
  $completedBytes += [Int64]$file.Size
  Write-Host "下载并校验完成: $($file.Name)"
}

$marker = @{
  model = "m-a-p/MERT-v1-330M"
  installedAt = (Get-Date).ToString("o")
  files = @($files | ForEach-Object { @{ name = $_.Name; size = $_.Size; sha256 = $_.Sha256 } })
}
$marker | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $targetDir "model-install.json") -Encoding UTF8
Write-Host ""
Write-Host "MERT 模型已安装到: $targetDir"
Write-Host "模型约 1.18 GiB。现在可以在软件的高级维护中更新索引。"
Write-Host "模型许可: CC BY-NC 4.0 ($licenseUrl)"
Write-FlowaveProgress -Phase "complete" -Percent 100 -Message "模型安装完成。" -Target "models\MERT-v1-330M" -Done $expectedTotal -Total $expectedTotal
