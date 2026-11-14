param([Parameter(Mandatory=$true)][string[]]$Files)
$ErrorActionPreference = 'Stop'
$thumbprint = [string]$env:FLOWAVE_SIGN_CERT_SHA1
if (-not $thumbprint) { return 'unsigned' }
$thumbprint = $thumbprint.Replace(' ', '')
if ($thumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Invalid code-signing certificate thumbprint.' }
$certificate = Get-Item -LiteralPath "Cert:/CurrentUser/My/$thumbprint" -ErrorAction Stop
if ($certificate.NotAfter -le (Get-Date) -or -not $certificate.HasPrivateKey) { throw 'Code-signing certificate is expired or has no private key.' }
$command = Get-Command signtool.exe -ErrorAction SilentlyContinue
$signTool = if ($command) { $command.Source } else {
  Get-ChildItem -Path "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/signtool.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signTool) { throw 'Install the Windows SDK signing tools before signing.' }
foreach ($file in $Files) {
  $target = (Resolve-Path -LiteralPath $file).Path
  & $signTool sign /sha1 $thumbprint /fd SHA256 /tr 'https://timestamp.digicert.com' /td SHA256 $target | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Windows code signing failed.' }
  if ((Get-AuthenticodeSignature -LiteralPath $target).Status -ne 'Valid') { throw 'Signed output verification failed.' }
}
return 'signed'
