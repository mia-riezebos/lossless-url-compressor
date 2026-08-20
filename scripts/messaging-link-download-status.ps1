[CmdletBinding()]
param(
    [string]$Destination = 'N:\mia\commoncrawl\messaging-links'
)

$manifest = Get-Content -Raw (Join-Path $Destination 'source-manifest.json') | ConvertFrom-Json
$rows = foreach ($item in $manifest.items) {
    $target = Join-Path (Join-Path $Destination $item.directory) $item.filename
    $partial = "$target.part"
    $path = if (Test-Path -LiteralPath $target) { $target } elseif (Test-Path -LiteralPath $partial) { $partial } else { $null }
    $bytes = if ($path) { (Get-Item -LiteralPath $path).Length } else { 0 }
    $expected = if ($null -ne $item.bytes) { [int64]$item.bytes } else { $null }
    $percent = if ($expected -and $expected -gt 0) { [math]::Round(100 * $bytes / $expected, 2) } else { $null }
    [pscustomobject]@{
        Name = $item.name
        State = if (Test-Path -LiteralPath $target) { 'complete' } elseif ($bytes -gt 0) { 'partial' } else { 'queued' }
        GiB = [math]::Round($bytes / 1GB, 2)
        ExpectedGiB = if ($expected) { [math]::Round($expected / 1GB, 2) } else { $null }
        Percent = $percent
    }
}

$rows | Format-Table -AutoSize
if (Test-Path (Join-Path $Destination 'download-status.json')) {
    Get-Content -Raw (Join-Path $Destination 'download-status.json')
}
