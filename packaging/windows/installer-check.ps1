param([Parameter(Mandatory=$true)][string]$InstallDir, [string]$RegisteredDir = '')
$ErrorActionPreference = 'Stop'
try {
  $dataRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Flowave'))
  $targets = @($InstallDir, $RegisteredDir) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') } | Select-Object -Unique
  foreach ($target in $targets) {
    if ($target.Equals($dataRoot, [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($dataRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { exit 41 }
    if ((Test-Path -LiteralPath (Join-Path $target 'data')) -or (Test-Path -LiteralPath (Join-Path $target 'models'))) { exit 41 }
    if ((Test-Path -LiteralPath $target) -and @(Get-ChildItem -LiteralPath $target -Force).Count) {
      $marker = Join-Path $target 'distribution.json'
      if (-not (Test-Path -LiteralPath $marker)) { exit 41 }
      if ((Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json).mode -ne 'installed') { exit 41 }
    }
  }
  $processes = Get-CimInstance Win32_Process -Filter "Name='Flowave.exe' OR Name='api.exe' OR Name='python.exe'"
  foreach ($target in $targets) {
    $executables = @((Join-Path $target 'Flowave.exe'), (Join-Path $target 'backend/api.exe'))
    foreach ($process in $processes) {
      if ($process.ExecutablePath -and $executables -contains $process.ExecutablePath) { exit 42 }
      if ($process.Name -eq 'python.exe' -and $process.CommandLine -and $process.CommandLine.IndexOf((Join-Path $target 'backend/source'), [StringComparison]::OrdinalIgnoreCase) -ge 0) { exit 42 }
    }
  }
  exit 0
} catch { exit 43 }
