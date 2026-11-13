param([string]$Installer = '')
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Installer) { $Installer = Join-Path $repo 'build/uninstall-validation/small/Flowave-0.1.0-x64-Setup.exe' }
$Installer = [IO.Path]::GetFullPath($Installer)
if (-not $Installer.StartsWith((Join-Path $repo 'build/uninstall-validation/'))) { throw 'Use only the isolated validation installer.' }
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\app.flowave.validation.cleanup_is1'
if (Test-Path -LiteralPath $registry) { throw 'Existing validation registration must be preserved.' }
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FlowaveCleanupCheck.lnk'
$startMenu = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/FlowaveCleanupCheck.lnk'
if ((Test-Path -LiteralPath $desktop) -or (Test-Path -LiteralPath $startMenu)) { throw 'Existing validation shortcuts must be preserved.' }
$fixture = Join-Path $repo ('build/uninstall-validation/check-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$program = Join-Path $fixture 'program'
$data = Join-Path $fixture '音乐 数据'
$originalLocal = $env:LOCALAPPDATA
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$env:LOCALAPPDATA = Join-Path $fixture 'local'

function RunInstaller {
  $mode = if (Test-Path -LiteralPath $data) { 'Existing' } else { 'New' }
  $process = Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',('/DATAMODE='+$mode),('/DIR="'+$program+'"'),('/DATADIR="'+$data+'"')) -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "Install failed: $($process.ExitCode)" }
}
function Uninstall([string]$groups = '', [bool]$forget = $false, [bool]$failure = $false) {
  $arguments = @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/LOG="'+(Join-Path $fixture 'uninstall.log')+'"'))
  if ($groups) { $arguments += '/REMOVEDATA='+$groups }
  if ($forget) { $arguments += '/FORGETLOCATIONS=1' }
  $process = Start-Process -FilePath (Join-Path $program 'unins000.exe') -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden
  if ($failure) {
    if ($process.ExitCode -eq 0 -or -not (Test-Path -LiteralPath (Join-Path $program 'Flowave.exe'))) { throw 'Failed cleanup did not retain the installation.' }
    return
  }
  if ($process.ExitCode -ne 0) { throw "Uninstall failed: $($process.ExitCode)" }
  foreach ($path in @($registry,$desktop,$startMenu,(Join-Path $program 'Flowave.exe'))) {
    if (Test-Path -LiteralPath $path) { throw "Uninstall residue: $path" }
  }
}
function AssertExists([string]$name, [bool]$expected) {
  if ((Test-Path -LiteralPath (Join-Path $data $name)) -ne $expected) { throw "Unexpected data retention: $name" }
}

try {
  RunInstaller
  foreach ($name in @('config/settings.json','library/listening/history.json','library/tracks.json','library/stems/stem.opus','components/resources/model.bin','packages/official/package.fwm','cache/download.bin','logs/check.log','downloads/music.mp3','unknown-user-file')) {
    $file = Join-Path $data $name
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
    [IO.File]::WriteAllText($file,'unchanged fixture')
  }
  $other = Join-Path $fixture 'other-workspace/keep.txt'
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($other)) | Out-Null
  [IO.File]::WriteAllText($other,'other workspace')
  Uninstall -groups 'unknown' -failure $true
  AssertExists 'config/settings.json' $true
  Uninstall
  foreach ($name in @('config/settings.json','components/resources/model.bin','library/tracks.json','cache/download.bin')) { AssertExists $name $true }
  RunInstaller
  AssertExists 'config/settings.json' $true
  Uninstall -groups 'temporary,resources'
  foreach ($name in @('config/settings.json','library/tracks.json','downloads/music.mp3','unknown-user-file')) { AssertExists $name $true }
  foreach ($name in @('cache','logs','components','packages')) { AssertExists $name $false }
  RunInstaller
  Uninstall -groups 'personal,results,resources,temporary' -forget $true
  foreach ($name in @('config','library','components','cache','packages')) { AssertExists $name $false }
  AssertExists 'downloads/music.mp3' $true
  AssertExists 'unknown-user-file' $true
  if (-not (Test-Path -LiteralPath $other)) { throw 'Other workspace was altered.' }
  if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Flowave')) { throw 'Explicit location cleanup left residue.' }
  Write-Host "PASS: actual Inno install, failed cleanup, default retention, selective removal, reinstall, shortcuts, registration, explicit location cleanup. $fixture"
} finally { $env:LOCALAPPDATA = $originalLocal }
