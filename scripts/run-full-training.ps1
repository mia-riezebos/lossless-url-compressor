param(
  [string]$CommonCrawlWat = "N:\mia\commoncrawl\CC-MAIN-2026-30\wat",
  [string]$MessagingCorpora = "N:\mia\commoncrawl\messaging-links\corpora",
  [string]$OutputRoot = "data\training\full-2026-08-16",
  [int]$Threads = 8,
  [int]$MessagingJobs = 2,
  [int]$MessagingThreadsPerShard = 2,
  [switch]$SkipCommonCrawl
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$output = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputRoot))
$statusPath = Join-Path $output "status.json"
$startedAt = [DateTimeOffset]::Now

function Write-Status {
  param(
    [string]$Phase,
    [string]$State,
    [string]$Detail = ""
  )

  $status = [ordered]@{
    state = $State
    phase = $Phase
    detail = $Detail
    startedAt = $startedAt.ToString("o")
    updatedAt = [DateTimeOffset]::Now.ToString("o")
    processId = $PID
    outputRoot = $output
  }
  $temporaryPath = "$statusPath.tmp"
  $status | ConvertTo-Json | Set-Content -LiteralPath $temporaryPath -Encoding utf8
  Move-Item -LiteralPath $temporaryPath -Destination $statusPath -Force
}

function Invoke-Trainer {
  param(
    [string]$Phase,
    [string[]]$Arguments,
    [string]$StdoutPath,
    [string]$StderrPath
  )

  Write-Status -Phase $Phase -State "running"
  & $script:trainer @Arguments 1>> $StdoutPath 2>> $StderrPath
  if ($LASTEXITCODE -ne 0) {
    throw "$Phase exited with code $LASTEXITCODE; see $StderrPath"
  }
}

New-Item -ItemType Directory -Path $output -Force | Out-Null

try {
  $requiredPaths = @($MessagingCorpora)
  if (-not $SkipCommonCrawl) {
    $requiredPaths += $CommonCrawlWat
  }
  foreach ($requiredPath in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      throw "Required corpus path is unavailable: $requiredPath"
    }
  }

  Write-Status -Phase "build" -State "running"
  & cargo build --release --manifest-path tools/urltrainer/Cargo.toml `
    1>> (Join-Path $output "build.stdout.log") `
    2>> (Join-Path $output "build.stderr.log")
  if ($LASTEXITCODE -ne 0) {
    throw "release build exited with code $LASTEXITCODE"
  }

  $script:trainer = Join-Path $repoRoot "tools\urltrainer\target\release\urltrainer.exe"
  $publicSuffixList = Join-Path $repoRoot "data\publicsuffix\public_suffix_list.dat"
  $commonCube = Join-Path $output "commoncrawl-cube.jsonl.gz"
  $messagingShardRoot = Join-Path $output "messaging-shards"
  $messagingManifestPath = Join-Path $messagingShardRoot "manifest.json"

  if ($SkipCommonCrawl) {
    if (-not (Test-Path -LiteralPath $commonCube -PathType Leaf) -or
        (Get-Item -LiteralPath $commonCube).Length -eq 0) {
      throw "Cannot skip Common Crawl: reusable cube is missing or empty: $commonCube"
    }
    Write-Status -Phase "commoncrawl-reused" -State "running" -Detail "Reusing completed Common Crawl cube."
  }
  else {
    Invoke-Trainer `
      -Phase "commoncrawl" `
      -StdoutPath (Join-Path $output "commoncrawl.stdout.log") `
      -StderrPath (Join-Path $output "commoncrawl.stderr.log") `
      -Arguments @(
        $CommonCrawlWat,
        "--format", "common-crawl-wat",
        "--collection", "CC-MAIN-2026-30-spaced-200GiB",
        "--public-suffix-list", $publicSuffixList,
        "--out", (Join-Path $output "commoncrawl.md"),
        "--raw-stats", $commonCube,
        "--header-stats", (Join-Path $output "commoncrawl-header-stats.json"),
        "--header-heldout", (Join-Path $output "commoncrawl-heldout.jsonl.gz"),
        "--threads", $Threads,
        "--checkpoint-rows", 30000,
        "--report-every-secs", 60
      )
  }

  Write-Status -Phase "messaging-shards" -State "running" -Detail "Completed shards are reused when their input and trainer fingerprints match."
  & pnpm train:messaging:shards -- `
    --input $MessagingCorpora `
    --output $messagingShardRoot `
    --trainer $script:trainer `
    --public-suffix-list $publicSuffixList `
    --collection "public-messaging-links-2026-08" `
    --jobs $MessagingJobs `
    --threads-per-shard $MessagingThreadsPerShard `
    --checkpoint-rows 30000 `
    --report-every-secs 60 `
    1>> (Join-Path $output "messaging-shards.stdout.log") `
    2>> (Join-Path $output "messaging-shards.stderr.log")
  $messagingExitCode = $LASTEXITCODE

  if (-not (Test-Path -LiteralPath $messagingManifestPath -PathType Leaf)) {
    throw "Messaging shard coordinator did not produce $messagingManifestPath"
  }
  $messagingManifest = Get-Content -LiteralPath $messagingManifestPath -Raw | ConvertFrom-Json
  $messagingCubes = @($messagingManifest.completedCubePaths)
  if ($messagingCubes.Count -eq 0) {
    throw "Messaging shard coordinator produced no reusable cubes; see $messagingManifestPath"
  }
  $reportCubes = @($commonCube) + $messagingCubes

  Write-Status -Phase "reports" -State "running"
  & $script:trainer report `
    --cubes ($reportCubes -join ",") `
    --out-dir (Join-Path $output "reports") `
    --family-weights "commoncrawl=1,discord=4,telegram=5,whatsapp=6" `
    --dataset-weights "disco=0.75,telegram-groupverse=1.25" `
    --context-weights "social-post/visible-url=32,message/visible-url=40,forwarded-message/visible-url=16" `
    1>> (Join-Path $output "reports.stdout.log") `
    2>> (Join-Path $output "reports.stderr.log")
  if ($LASTEXITCODE -ne 0) {
    throw "report generation exited with code $LASTEXITCODE"
  }

  if ($messagingExitCode -ne 0) {
    Write-Status -Phase "messaging-shards" -State "partial" -Detail "Reports were generated from completed shards; failed shards remain retryable via $messagingManifestPath"
    exit $messagingExitCode
  }

  Write-Status -Phase "complete" -State "complete" -Detail "Common Crawl, all messaging shard cubes, and all reports were generated."
}
catch {
  Write-Status -Phase "failed" -State "failed" -Detail $_.Exception.Message
  throw
}
