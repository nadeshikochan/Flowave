param(
  [Parameter(Mandatory=$true)][ValidateSet('Plan','Remove')][string]$Action,
  [Parameter(Mandatory=$true)][string]$DataDir,
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [string]$Groups = '',
  [switch]$ForgetLocations,
  [string]$ReportFile = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$utf8 = New-Object Text.UTF8Encoding($true)

function FullPath([string]$value) {
  if (-not [IO.Path]::IsPathRooted($value)) { throw '数据位置必须是完整路径。' }
  return [IO.Path]::GetFullPath($value).TrimEnd('\')
}
function Within([string]$parent, [string]$child) {
  return $child.Equals($parent,[StringComparison]::OrdinalIgnoreCase) -or $child.StartsWith($parent+'\',[StringComparison]::OrdinalIgnoreCase)
}
function NormalPath([string]$folder) {
  $cursor = $folder
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '清理目录含链接，已保留内容，请手动核对。' }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function EmptyDirectory([string]$folder) {
  if ((Test-Path -LiteralPath $folder -PathType Container) -and @(Get-ChildItem -LiteralPath $folder -Force).Count -eq 0) {
    Remove-Item -LiteralPath $folder -Force
  }
}

try {
  $root = FullPath $DataDir
  $program = FullPath $InstallDir
  $anchor = FullPath (Join-Path $env:LOCALAPPDATA 'Flowave')
  if ($root.Length -le 3 -or (Within $root $program) -or (Within $program $root) -or (Within $root $anchor)) {
    throw '拒绝清理磁盘根目录、程序目录或系统应用数据根。'
  }
  foreach ($special in @('Windows','ProgramFiles','UserProfile','Desktop','MyDocuments','LocalApplicationData','ApplicationData')) {
    $protected = [Environment]::GetFolderPath($special)
    if ($protected -and $root.Equals((FullPath $protected),[StringComparison]::OrdinalIgnoreCase)) { throw '请选择独立的软件工作区目录。' }
  }
  $pointer = Join-Path $anchor 'data-location.txt'
  if ((Test-Path -LiteralPath $pointer) -and -not $root.Equals((FullPath ([IO.File]::ReadAllText($pointer).Trim())),[StringComparison]::OrdinalIgnoreCase)) {
    throw '默认工作区已变化，未清理数据，请重新开始卸载。'
  }
  NormalPath $root
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw '工作区不可用，未清理任何数据。' }
  $recognized = $false
  $workspace = Join-Path $root '.flowave-workspace.json'
  $receipt = Join-Path $root '.flowave-data.json'
  if (Test-Path -LiteralPath $workspace) {
    $descriptor = Get-Content -LiteralPath $workspace -Raw -Encoding UTF8 | ConvertFrom-Json
    $recognized = $descriptor.application -eq 'Flowave' -and $descriptor.schema -eq 1 -and $descriptor.hostApi -eq 1
  } elseif (Test-Path -LiteralPath $receipt) {
    $descriptor = Get-Content -LiteralPath $receipt -Raw -Encoding UTF8 | ConvertFrom-Json
    $recognized = $descriptor.state -eq 'prepared' -and $descriptor.anchor -eq $anchor
  } elseif (Test-Path -LiteralPath (Join-Path $root 'config/features.json')) {
    $descriptor = Get-Content -LiteralPath (Join-Path $root 'config/features.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $recognized = $descriptor.schema -eq 1 -and $null -ne $descriptor.enabled
  }
  if (-not $recognized) { throw '目录无法确认为受管工作区，数据保留。' }
  $policyFile = Join-Path $PSScriptRoot 'storage-layout.json'
  if (-not (Test-Path -LiteralPath $policyFile)) { $policyFile = Join-Path $PSScriptRoot '../../resources/storage-layout.json' }
  $policy = Get-Content -LiteralPath $policyFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($policy.schema -ne 1) { throw '数据分类版本无法识别。' }
  $selected = @($Groups.Split(',') | Where-Object { $_ } | Select-Object -Unique)
  foreach ($group in $selected) { if ($group -notin @($policy.groups.id)) { throw '未知清理分类，数据保留。' } }
  $targets = New-Object 'Collections.Generic.List[string]'
  foreach ($group in $policy.groups | Where-Object { $_.id -in $selected }) {
    foreach ($relative in @($group.directories)+@($group.files)) {
      $target = FullPath (Join-Path $root $relative)
      if ($target -eq $root -or -not (Within $root $target)) { throw '数据分类路径越界。' }
      foreach ($kept in $policy.alwaysKeep) {
        $protected = FullPath (Join-Path $root $kept)
        if ((Within $protected $target) -or (Within $target $protected)) { throw '清理分类包含必须保留的音乐目录。' }
      }
      if (Test-Path -LiteralPath $target) { $targets.Add($target) }
      if ($relative -in @($group.files) -and (Test-Path -LiteralPath ($target+'.previous'))) { $targets.Add($target+'.previous') }
    }
  }
  # Preflight every selected subtree before removing the first file.
  $pending = New-Object 'Collections.Generic.Stack[IO.FileSystemInfo]'
  foreach ($target in $targets) {
    NormalPath $target
    $pending.Push((Get-Item -LiteralPath $target -Force))
  }
  [long]$bytes = 0
  while ($pending.Count) {
    $item = $pending.Pop()
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '清理目录含链接，已保留内容，请手动核对。' }
    if ($item.PSIsContainer) {
      foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Push($child) }
    } else { $bytes += $item.Length }
  }
  $running = Get-CimInstance Win32_Process -Filter "Name='Flowave.exe' OR Name='api.exe' OR Name='python.exe'"
  foreach ($process in $running) {
    if (($process.ExecutablePath -and (Within $program $process.ExecutablePath)) -or
        ($process.CommandLine -and ($process.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
          $process.CommandLine.IndexOf((Join-Path $program 'backend/source'),[StringComparison]::OrdinalIgnoreCase) -ge 0))) {
      throw '工作区或后台任务正在使用，请退出后再卸载。'
    }
  }
  $report = @{schema=1;directory=$root;groups=$selected;bytes=$bytes;paths=@($targets);removed=@();retained=@();ok=$true}
  if ($Action -eq 'Remove') {
    if ((Test-Path -LiteralPath $pointer) -and -not $root.Equals((FullPath ([IO.File]::ReadAllText($pointer).Trim())),[StringComparison]::OrdinalIgnoreCase)) {
      throw '默认工作区已变化，未清理数据。'
    }
    foreach ($target in $targets) {
      NormalPath $target
      if (-not (Within $root $target) -or $root -eq $target) { throw '清理路径越界。' }
      Remove-Item -LiteralPath $target -Recurse -Force
      $report.removed += $target
    }
    EmptyDirectory (Join-Path $root 'library')
    $remaining = @(Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -notin $policy.workspaceMarkers })
    if ($ForgetLocations -and $remaining.Count -eq 0 -and $selected.Count -eq @($policy.groups).Count) {
      foreach ($marker in $policy.workspaceMarkers) {
        $file = Join-Path $root $marker
        if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
      }
      EmptyDirectory $root
    }
    if ($ForgetLocations) {
      foreach ($name in @('data-location.txt','workspace-history.json')) {
        $file = Join-Path $anchor $name
        NormalPath $file
        if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
      }
      EmptyDirectory $anchor
    }
  }
  if (Test-Path -LiteralPath $root) { $report.retained = @(Get-ChildItem -LiteralPath $root -Force | Select-Object -ExpandProperty Name) }
  $body = $report | ConvertTo-Json -Depth 6
  if ($ReportFile) { [IO.File]::WriteAllText($ReportFile,$body,$utf8) }
  Write-Output $body
  exit 0
} catch {
  $body = @{ok=$false;error=$_.Exception.Message;directory=$DataDir} | ConvertTo-Json -Compress
  if ($ReportFile) { [IO.File]::WriteAllText($ReportFile,$body,$utf8) }
  Write-Output $body
  exit 45
}
