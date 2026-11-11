param([string]$Installer = '')
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $repo
$originalLocalAppData = $env:LOCALAPPDATA
try {
  if (-not $Installer) { $Installer = (Get-Content build/portable-delivery/latest-installer.json -Raw | ConvertFrom-Json).installer }
  $Installer = (Resolve-Path -LiteralPath $Installer).Path
  $expectedRoot = Join-Path $repo 'electron-lxplayer/dist/installed-'
  if (-not $Installer.StartsWith($expectedRoot) -or [IO.Path]::GetExtension($Installer) -ne '.exe') { throw 'Use this repository generated installer.' }
  $existing = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Flowave*' })
  if ($existing.Count) { throw 'An existing registered Flowave installation needs to be preserved; use an isolated Windows account.' }
  foreach ($shortcut in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Flowave.lnk'),(Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/Flowave.lnk'))) {
    if (Test-Path -LiteralPath $shortcut) { throw 'Existing shortcut must be preserved; use an isolated Windows account.' }
  }
  $fixture = Join-Path $repo ('build/installer-check/' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $program = Join-Path $fixture 'Flowave'
  $profile = Join-Path $fixture 'profile'
  $env:LOCALAPPDATA = Join-Path $fixture 'local-app-data'
  [IO.Directory]::CreateDirectory($fixture) | Out-Null
  function InstallTo([string]$target, [int]$expected = 0) {
    $process = Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/CURRENTUSER',('/DIR="'+$target+'"'),('/DATADIR="'+$profile+'"')) -PassThru -Wait -WindowStyle Hidden
    if ($process.ExitCode -ne $expected) { throw "Installer returned $($process.ExitCode), expected $expected" }
  }
  $blocked = Join-Path $fixture 'portable-with-data'
  [IO.Directory]::CreateDirectory((Join-Path $blocked 'data')) | Out-Null
  $protectedFile = Join-Path $blocked 'data/keep.txt'
  'protected portable data' | Set-Content -LiteralPath $protectedFile -Encoding ascii
  $protectedHash = (Get-FileHash -LiteralPath $protectedFile).Hash
  InstallTo -target $blocked -expected 7
  if ((Get-FileHash -LiteralPath $protectedFile).Hash -ne $protectedHash) { throw 'Portable data changed' }
  InstallTo -target $program
  if (Test-Path -LiteralPath (Join-Path $program 'data')) { throw 'Installed program contains user data' }
  & node scripts/check-portable-app.cjs $program --installed --default-data --resources "--installer=$Installer"
  if ($LASTEXITCODE -ne 0) { throw 'Installed app/resource workflow failed' }
  $sentinel = Join-Path $profile 'library/installer-preserved.data'
  'history and index preservation fixture' | Set-Content -LiteralPath $sentinel -Encoding ascii
  $selection = Join-Path $profile 'config/features.json'
  $hashes = @{}
  foreach ($file in @($sentinel,$selection)) { $hashes[$file] = (Get-FileHash -LiteralPath $file).Hash }
  InstallTo -target $program
  foreach ($file in $hashes.Keys) { if ((Get-FileHash -LiteralPath $file).Hash -ne $hashes[$file]) { throw 'Upgrade changed saved data' } }
  & node scripts/check-portable-app.cjs $program --installed --default-data --reopen
  if ($LASTEXITCODE -ne 0) { throw 'Installed app could not reopen after upgrade' }
  $uninstaller = Join-Path $program 'unins000.exe'
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw 'Uninstaller failed' }
  if (Test-Path -LiteralPath (Join-Path $program 'Flowave.exe')) { throw 'Installed program was not removed' }
  foreach ($file in $hashes.Keys) { if ((Get-FileHash -LiteralPath $file).Hash -ne $hashes[$file]) { throw 'Uninstall changed saved data' } }
  InstallTo -target $program
  foreach ($file in $hashes.Keys) { if ((Get-FileHash -LiteralPath $file).Hash -ne $hashes[$file]) { throw 'Reinstall changed saved data' } }
  & node scripts/check-portable-app.cjs $program --installed --default-data --reopen
  if ($LASTEXITCODE -ne 0) { throw 'Installed app could not read retained plugins/data' }
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw 'Final test uninstall failed' }
  Write-Host "PASS: install, running/portable guards, upgrade, uninstall, reinstall and retained data. Fixture: $fixture"
} finally { $env:LOCALAPPDATA = $originalLocalAppData; Pop-Location }
