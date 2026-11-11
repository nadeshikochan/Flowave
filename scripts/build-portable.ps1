param([switch]$SkipNpmInstall)
& (Join-Path $PSScriptRoot 'build-desktop.ps1') -Mode portable -SkipNpmInstall:$SkipNpmInstall
