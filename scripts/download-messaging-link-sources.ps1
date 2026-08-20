[CmdletBinding()]
param(
    [string]$Destination = 'N:\mia\commoncrawl\messaging-links',
    [string]$Manifest = (Join-Path $PSScriptRoot '..\data\messaging-link-sources.json')
)

$ErrorActionPreference = 'Stop'
$manifestPath = (Resolve-Path $Manifest).Path
$plan = Get-Content -Raw $manifestPath | ConvertFrom-Json

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Destination 'logs') | Out-Null
Copy-Item -Force -LiteralPath $manifestPath -Destination (Join-Path $Destination 'source-manifest.json')

$statusPath = Join-Path $Destination 'download-status.json'
$hashesPath = Join-Path $Destination 'downloaded-sha256.txt'
$pidPath = Join-Path $Destination 'download.pid'
$PID | Set-Content -Encoding ascii $pidPath

function Write-Status {
    param(
        [string]$State,
        [object]$Item,
        [int64]$BytesOnDisk = 0,
        [string]$Message = ''
    )

    $expected = if ($null -ne $Item.bytes) { [int64]$Item.bytes } else { $null }
    $status = [ordered]@{
        updated_at = (Get-Date).ToUniversalTime().ToString('o')
        state = $State
        current_item = $Item.name
        current_filename = $Item.filename
        bytes_on_disk = $BytesOnDisk
        expected_bytes = $expected
        message = $Message
    }
    $json = $status | ConvertTo-Json
    $temporaryStatusPath = "$statusPath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporaryStatusPath, $json, [System.Text.UTF8Encoding]::new($false))
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            [System.IO.File]::Move($temporaryStatusPath, $statusPath, $true)
            return
        }
        catch {
            if ($attempt -lt 10) {
                Start-Sleep -Milliseconds 100
            }
        }
    }
    Write-Warning "Could not refresh status file after 10 attempts; continuing the download."
}

function Test-ExpectedHash {
    param([string]$Path, [object]$Item)

    if (-not $Item.hash) {
        return $true
    }

    $actual = (Get-FileHash -LiteralPath $Path -Algorithm $Item.hash_algorithm).Hash.ToLowerInvariant()
    return $actual -eq $Item.hash.ToLowerInvariant()
}

foreach ($item in $plan.items) {
    $directory = Join-Path $Destination $item.directory
    $target = Join-Path $directory $item.filename
    $partial = "$target.part"
    New-Item -ItemType Directory -Force -Path $directory | Out-Null

    if (Test-Path -LiteralPath $target) {
        $existing = Get-Item -LiteralPath $target
        $sizeMatches = ($null -eq $item.bytes) -or ($existing.Length -eq [int64]$item.bytes)
        if ($sizeMatches -and (Test-ExpectedHash -Path $target -Item $item)) {
            Write-Status -State 'skipped' -Item $item -BytesOnDisk $existing.Length -Message 'Already downloaded and verified.'
            continue
        }
        throw "Existing file failed verification: $target"
    }

    if (Test-Path -LiteralPath $partial) {
        $existingPartial = Get-Item -LiteralPath $partial
        $partialSizeMatches = ($null -eq $item.bytes) -or ($existingPartial.Length -eq [int64]$item.bytes)
        if ($partialSizeMatches -and $item.hash -and (Test-ExpectedHash -Path $partial -Item $item)) {
            Move-Item -LiteralPath $partial -Destination $target
            $sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
            "$sha256 *$($item.directory)/$($item.filename)" | Add-Content -Encoding ascii $hashesPath
            Write-Status -State 'completed-item' -Item $item -BytesOnDisk $existingPartial.Length -Message 'Verified an already-complete partial download.'
            continue
        }
    }

    $partialBytes = if (Test-Path -LiteralPath $partial) { (Get-Item -LiteralPath $partial).Length } else { 0 }
    Write-Status -State 'downloading' -Item $item -BytesOnDisk $partialBytes

    $curlArguments = @(
        '--fail'
        '--location'
        '--retry', '20'
        '--retry-delay', '5'
        '--retry-all-errors'
        '--connect-timeout', '30'
        '--speed-time', '180'
        '--speed-limit', '1024'
        '--continue-at', '-'
        '--output', $partial
        $item.url
    )
    & curl.exe @curlArguments

    if ($LASTEXITCODE -ne 0) {
        $downloaded = if (Test-Path -LiteralPath $partial) { (Get-Item -LiteralPath $partial).Length } else { 0 }
        Write-Status -State 'failed' -Item $item -BytesOnDisk $downloaded -Message "curl exited with code $LASTEXITCODE"
        throw "Download failed for $($item.name): curl exit $LASTEXITCODE"
    }

    $downloadedFile = Get-Item -LiteralPath $partial
    if (($null -ne $item.bytes) -and ($downloadedFile.Length -ne [int64]$item.bytes)) {
        Write-Status -State 'failed' -Item $item -BytesOnDisk $downloadedFile.Length -Message 'Downloaded size does not match manifest.'
        throw "Size mismatch for $($item.name): got $($downloadedFile.Length), expected $($item.bytes)"
    }
    if (-not (Test-ExpectedHash -Path $partial -Item $item)) {
        Write-Status -State 'failed' -Item $item -BytesOnDisk $downloadedFile.Length -Message 'Checksum mismatch.'
        throw "Checksum mismatch for $($item.name)"
    }

    Move-Item -LiteralPath $partial -Destination $target
    $sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    "$sha256 *$($item.directory)/$($item.filename)" | Add-Content -Encoding ascii $hashesPath
    Write-Status -State 'completed-item' -Item $item -BytesOnDisk (Get-Item -LiteralPath $target).Length
}

$finished = [ordered]@{
    updated_at = (Get-Date).ToUniversalTime().ToString('o')
    state = 'complete'
    current_item = $null
    current_filename = $null
    bytes_on_disk = 0
    expected_bytes = $null
    message = 'All sources downloaded and verified.'
}
$finishedJson = $finished | ConvertTo-Json
[System.IO.File]::WriteAllText($statusPath, $finishedJson, [System.Text.UTF8Encoding]::new($false))
