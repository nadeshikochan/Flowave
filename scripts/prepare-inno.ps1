$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools = Join-Path $repo 'build/tools'
$compilerRoot = Join-Path $tools 'inno-7.1.1'
$compiler = Join-Path $compilerRoot 'ISCC.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  [IO.Directory]::CreateDirectory($tools) | Out-Null
  $installer = Join-Path $tools 'innosetup-7.1.1-x64.exe'
  if (-not (Test-Path -LiteralPath $installer)) {
    Invoke-WebRequest -Uri 'https://github.com/jrsoftware/issrc/releases/download/is-7_1_1/innosetup-7.1.1-x64.exe' -OutFile $installer
  }
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne '8a5a6711c3766a6e5fb74f280ba0e3551e719ce94538d901fdbd1f8f9920b3f0') { throw 'Inno Setup download checksum mismatch.' }
  # Official portable mode keeps this build dependency inside the workspace.
  $process = Start-Process -FilePath $installer -ArgumentList @('/PORTABLE=1','/CURRENTUSER','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS','/TASKS=',('/DIR="'+$compilerRoot+'"')) -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw 'Inno Setup preparation failed.' }
}
if ((Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'e0f9f1dc32032650c6629f6dee41eb6d20ba140e4e3c07c25d8a24f9ba781644') { throw 'Inno Setup compiler checksum mismatch.' }
Write-Output $compiler
