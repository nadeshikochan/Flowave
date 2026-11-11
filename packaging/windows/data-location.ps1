param(
  [Parameter(Mandatory=$true)][ValidateSet('Prepare','Commit')][string]$Action,
  [Parameter(Mandatory=$true)][string]$DataDir,
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [string]$ErrorFile = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$utf8 = New-Object Text.UTF8Encoding($true)

function FullPath([string]$value) {
  if (-not [IO.Path]::IsPathRooted($value)) { throw '请选择完整的数据目录。' }
  return [IO.Path]::GetFullPath($value).TrimEnd('\')
}
function ContainsPath([string]$parent, [string]$child) {
  return $child.Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or $child.StartsWith($parent+'\', [StringComparison]::OrdinalIgnoreCase)
}
function AssertNormalDirectory([string]$folder) {
  $cursor = $folder
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '请选择普通目录，避免链接指向其他位置。' }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function WriteAtomic([string]$file, [string]$body) {
  $temporary = $file + '.tmp'
  [IO.File]::WriteAllText($temporary, $body, $utf8)
  if (Test-Path -LiteralPath $file) { [IO.File]::Replace($temporary, $file, [NullString]::Value) }
  else { [IO.File]::Move($temporary, $file) }
}
function FileHash([string]$file) {
  $stream = [IO.File]::OpenRead($file)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash($stream)) }
  finally { $stream.Dispose(); $hasher.Dispose() }
}

try {
  $anchor = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Flowave')).TrimEnd('\')
  $pointer = Join-Path $anchor 'data-location.txt'
  $legacy = Join-Path $anchor 'data'
  $target = FullPath $DataDir
  $program = FullPath $InstallDir
  if ($target.Length -le 3 -or (ContainsPath $program $target) -or (ContainsPath $target $program) -or (ContainsPath $anchor $target) -or (ContainsPath $target $anchor)) {
    throw '数据目录须与程序和系统应用数据目录分开，请选择独立文件夹。'
  }
  AssertNormalDirectory $target
  $source = ''
  if (Test-Path -LiteralPath $pointer) {
    $source = FullPath ([IO.File]::ReadAllText($pointer).Trim())
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw '原数据目录不可用，请连接原磁盘后重试，避免丢失已有记录。' }
  } elseif (Test-Path -LiteralPath $legacy -PathType Container) { $source = $legacy }
  $same = $source -and $source.Equals($target, [StringComparison]::OrdinalIgnoreCase)
  if ($source -and -not $same -and ((ContainsPath $source $target) -or (ContainsPath $target $source))) { throw '新旧数据目录不能互相包含。' }
  $marker = Join-Path $target '.flowave-data.json'

  if ($Action -eq 'Prepare') {
    if ($same) { Write-Output '继续使用原数据目录。'; exit 0 }
    if ((Test-Path -LiteralPath $target) -and @(Get-ChildItem -LiteralPath $target -Force).Count) {
      if (-not (Test-Path -LiteralPath $marker)) { throw '目标目录已有内容，请新建空文件夹，避免覆盖或混合数据。' }
      $state = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($state.source -ne $source -or $state.anchor -ne $anchor -or $state.state -notin @('copying','prepared')) { throw '目标目录已有内容，请新建空文件夹，避免覆盖或混合数据。' }
    }
    [IO.Directory]::CreateDirectory($target) | Out-Null
    WriteAtomic $marker (@{source=$source;anchor=$anchor;state='copying'} | ConvertTo-Json -Compress)
    $files = New-Object 'Collections.Generic.List[IO.FileInfo]'
    $directories = New-Object 'Collections.Generic.Stack[string]'
    if ($source) { AssertNormalDirectory $source; $directories.Push($source) }
    while ($directories.Count) {
      foreach ($item in Get-ChildItem -LiteralPath ($directories.Pop()) -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '原数据含链接，请先核对实际目录。' }
        if ($item.PSIsContainer) { $directories.Push($item.FullName) } else { $files.Add($item) }
      }
    }
    [long]$total = 0
    foreach ($file in $files) { $total += $file.Length }
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($target))
    if ($drive.AvailableFreeSpace -lt $total) { throw '目标磁盘空间不足，原数据保留。' }
    [long]$done = 0
    $clock = [Diagnostics.Stopwatch]::StartNew()
    foreach ($file in $files) {
      $relative = $file.FullName.Substring($source.Length).TrimStart('\')
      if ($relative -eq '.flowave-data.json') { continue }
      $destination = Join-Path $target $relative
      $before = Get-Item -LiteralPath $file.FullName -Force
      $length = $before.Length
      $modified = $before.LastWriteTimeUtc
      $hash = FileHash $file.FullName
      AssertNormalDirectory ([IO.Path]::GetDirectoryName($destination))
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
      if (Test-Path -LiteralPath $destination) {
        if ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '目标含链接，请核对数据目录。' }
        if ((FileHash $destination) -ne $hash) { throw '目标存在同名不同内容文件，尚未切换目录。' }
      } else {
        $temporary = $destination + '.flowave-copying'
        [IO.File]::Copy($file.FullName, $temporary, $true)
        if ((FileHash $temporary) -ne $hash) { throw '复制校验失败，原数据保留。' }
        [IO.File]::Move($temporary, $destination)
      }
      $after = Get-Item -LiteralPath $file.FullName -Force
      if ($after.Length -ne $length -or $after.LastWriteTimeUtc -ne $modified) { throw '原数据正在变化，请退出旧软件及后台后重试。' }
      $done += $length
      if ($clock.ElapsedMilliseconds -ge 500) {
        Write-Output ('正在复制并校验数据 {0:N0} / {1:N0} MiB' -f ($done/1MB),($total/1MB))
        $clock.Restart()
      }
    }
    WriteAtomic $marker (@{source=$source;anchor=$anchor;state='prepared'} | ConvertTo-Json -Compress)
    Write-Output '数据准备完成，安装成功后切换。原文件保留供核对。'
  } else {
    if (-not $same) {
      $state = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($state.source -ne $source -or $state.anchor -ne $anchor -or $state.state -ne 'prepared') { throw '数据准备尚未完成，保留原目录。' }
    }
    [IO.Directory]::CreateDirectory($anchor) | Out-Null
    WriteAtomic $pointer $target
    Write-Output '数据目录已保存。'
  }
  exit 0
} catch {
  if ($ErrorFile) { [IO.File]::WriteAllText($ErrorFile, $_.Exception.Message, $utf8) }
  Write-Output $_.Exception.Message
  exit 44
}
