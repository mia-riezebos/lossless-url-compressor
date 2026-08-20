param(
  [int]$Rows = 100000,
  [double]$MaximumCheckpointRatio = 2.0
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$root = Join-Path $repoRoot "data\perf\aggregation"
$inputPath = Join-Path $root "urls-$Rows.txt"
$trainer = Join-Path $repoRoot "tools\urltrainer\target\release\urltrainer.exe"
$suffixes = Join-Path $repoRoot "data\publicsuffix\public_suffix_list.dat"
New-Item -ItemType Directory -Path $root -Force | Out-Null

if (-not (Test-Path -LiteralPath $inputPath)) {
  $writer = [System.IO.StreamWriter]::new($inputPath, $false, [System.Text.UTF8Encoding]::new($false))
  try {
    for ($index = 0; $index -lt $Rows; $index++) {
      $writer.WriteLine("https://example.com/category-$index/comments/item-$index?article=$index&source=benchmark")
    }
  }
  finally {
    $writer.Dispose()
  }
}

& cargo build --release --manifest-path tools/urltrainer/Cargo.toml | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

function Measure-Trainer([string]$Name, [int]$CheckpointRows) {
  $out = Join-Path $root "$Name.md"
  $elapsed = Measure-Command {
    & $trainer $inputPath `
      --format plain-urls `
      --public-suffix-list $suffixes `
      --out $out `
      --threads 4 `
      --checkpoint-rows $CheckpointRows `
      --heldout-every 0 `
      --top 10 `
      --candidate-pool 32 `
      --report-every-secs 3600 `
      1> (Join-Path $root "$Name.stdout.log") `
      2> (Join-Path $root "$Name.stderr.log")
  }
  if ($LASTEXITCODE -ne 0) { throw "$Name trainer run failed with $LASTEXITCODE" }
  return $elapsed.TotalSeconds
}

$singleMergeSeconds = Measure-Trainer "single-merge" 0
$checkpointedSeconds = Measure-Trainer "checkpointed" 1000
$ratio = $checkpointedSeconds / $singleMergeSeconds
$result = [ordered]@{
  rows = $Rows
  singleMergeSeconds = [math]::Round($singleMergeSeconds, 3)
  checkpointedSeconds = [math]::Round($checkpointedSeconds, 3)
  checkpointRatio = [math]::Round($ratio, 3)
  maximumCheckpointRatio = $MaximumCheckpointRatio
  passed = $ratio -le $MaximumCheckpointRatio
}
$result | ConvertTo-Json
if (-not $result.passed) { exit 1 }
