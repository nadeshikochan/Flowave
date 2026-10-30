param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir
)

$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path -LiteralPath $DataDir).Path
if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
  throw "Release data directory does not exist: $resolved"
}

$forbiddenNames = @(
  "renderer_state.json",
  "listening_history.json",
  "queries.json",
  "lyric-queries.json",
  "tasks.json",
  "recent.json",
  "manifest.json",
  "tag_commit_pending.json",
  "tag_commit_pending.json.previous",
  "main_window.json",
  "online_source.json",
  "remote_access.json",
  "remote_tunnel.json",
  "web_sessions.json",
  "mobile_token.json",
  "mobile_users.json",
  "tracks.json",
  "embeddings.npy",
  "online_catalog.json",
  "online_embeddings.json",
  "online_embeddings.npy",
  "composite_seeds.json",
  "recommendation_rate.json"
)

$allowedRelativeFiles = @(
  "README.txt",
  "cache/.gitkeep",
  "config/app.json",
  "downloads/.gitkeep",
  "library/.gitkeep",
  "logs/.gitkeep",
  "online-sources/.gitkeep"
)

$violations = @()
$relativePrefix = $resolved.TrimEnd("\") + "\"
Get-ChildItem -LiteralPath $resolved -Recurse -File | ForEach-Object {
  $relative = $_.FullName.Substring($relativePrefix.Length).Replace("\", "/")
  if ($allowedRelativeFiles -notcontains $relative) {
    $violations += "Unexpected release data file: $relative"
  }
  if ($forbiddenNames -contains $_.Name) {
    $violations += "Forbidden release file: $($_.FullName)"
  }
  if ($_.FullName -like "*\online-sources\*" -and $_.Name -ne ".gitkeep") {
    $violations += "Release data contains an online source: $($_.FullName)"
  }
}

$appConfig = Join-Path $resolved "config\app.json"
if (-not (Test-Path -LiteralPath $appConfig -PathType Leaf)) {
  $violations += "Missing default config: $appConfig"
} else {
  $cfg = Get-Content -LiteralPath $appConfig -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$cfg.audio_dir) {
    $violations += "audio_dir must be empty"
  }
  if ([string]$cfg.download_dir) {
    $violations += "download_dir must be empty"
  }
  if (@($cfg.online.exclude_tokens).Count -ne 0) {
    $violations += "online.exclude_tokens must be empty"
  }
  if ([string]$cfg.model.local_dir -ne "models/MERT-v1-330M") {
    $violations += "model.local_dir must use the public relative default"
  }
}

if ($violations.Count -gt 0) {
  $violations | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Host "Release data template check passed: $resolved"
