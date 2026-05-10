param(
  [string]$PackageName = "9router",
  [string]$NpmRoot = "",
  [int]$SmokePort = 20129,
  [switch]$SkipBuild,
  [switch]$SkipSmoke,
  [switch]$NoStopRunning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[deploy] $Message"
}

function Resolve-NpmRoot {
  param([string]$Override)

  if ($Override) {
    return (Resolve-Path -LiteralPath $Override).Path
  }

  $root = (& npm root -g).Trim()
  if (-not $root) {
    throw "Could not resolve npm global root with 'npm root -g'."
  }
  return $root
}

function Stop-RunningPackageNodes {
  param([string]$PackageDir)

  $normalized = $PackageDir.ToLowerInvariant()
  $processes = @()

  try {
    $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object {
        $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($normalized)
      }
  } catch {
    Write-Step "Could not inspect node command lines: $($_.Exception.Message)"
    return
  }

  foreach ($process in $processes) {
    Write-Step "Stopping running $PackageName node process PID $($process.ProcessId)"
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    } catch {
      Write-Step "Could not stop PID $($process.ProcessId): $($_.Exception.Message)"
    }
  }
}

function Invoke-NextBuild {
  param([string]$RepoRoot)

  Write-Step "Building standalone app"

  $oldNodeEnv = $env:NODE_ENV
  $oldUserProfile = $env:USERPROFILE
  $oldHome = $env:HOME

  try {
    $env:NODE_ENV = "production"
    $env:USERPROFILE = $RepoRoot
    $env:HOME = $RepoRoot

    & npx next build --webpack
    if ($LASTEXITCODE -ne 0) {
      throw "next build failed with exit code $LASTEXITCODE."
    }
  } finally {
    $env:NODE_ENV = $oldNodeEnv
    $env:USERPROFILE = $oldUserProfile
    $env:HOME = $oldHome
  }
}

function Copy-IfExists {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (Test-Path -LiteralPath $Source) {
    if (Test-Path -LiteralPath $Destination) {
      Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
  }
}

function Prepare-Standalone {
  param([string]$RepoRoot)

  $standalone = Join-Path $RepoRoot ".next\standalone"
  $server = Join-Path $standalone "server.js"

  if (-not (Test-Path -LiteralPath $server)) {
    throw "Standalone server not found at $server. Run build first."
  }

  Copy-IfExists -Source (Join-Path $RepoRoot "public") -Destination (Join-Path $standalone "public")
  Copy-IfExists -Source (Join-Path $RepoRoot ".next\static") -Destination (Join-Path $standalone ".next\static")

  return $standalone
}

function Update-GlobalPackageVersion {
  param(
    [string]$GlobalPackageJson,
    [string]$Version,
    [string]$Timestamp
  )

  $backup = Join-Path (Split-Path -Parent $GlobalPackageJson) "package.backup-$Timestamp.json"
  Copy-Item -LiteralPath $GlobalPackageJson -Destination $backup -Force

  $json = Get-Content -LiteralPath $GlobalPackageJson -Raw | ConvertFrom-Json
  $json.version = $Version
  $json | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $GlobalPackageJson -Encoding UTF8

  return $backup
}

function Invoke-SmokeTest {
  param(
    [string]$AppDir,
    [string]$ExpectedVersion,
    [int]$Port
  )

  $server = Join-Path $AppDir "server.js"
  $node = (Get-Command node -ErrorAction Stop).Source
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdout = Join-Path $env:TEMP "$PackageName-smoke-$stamp.out"
  $stderr = Join-Path $env:TEMP "$PackageName-smoke-$stamp.err"

  Write-Step "Starting smoke test on http://127.0.0.1:$Port/api/version"

  $oldNodeEnv = $env:NODE_ENV
  $oldPort = $env:PORT
  $oldHostname = $env:HOSTNAME
  $process = $null

  try {
    $env:NODE_ENV = "production"
    $env:PORT = [string]$Port
    $env:HOSTNAME = "127.0.0.1"

    $process = Start-Process `
      -FilePath $node `
      -ArgumentList @($server) `
      -WorkingDirectory $AppDir `
      -WindowStyle Hidden `
      -PassThru `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr

    $response = $null
    for ($i = 0; $i -lt 45; $i++) {
      Start-Sleep -Seconds 1
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/version" -TimeoutSec 3
        break
      } catch {
        if ($process.HasExited) {
          break
        }
      }
    }

    if (-not $response) {
      Write-Step "Smoke test stderr tail:"
      if (Test-Path -LiteralPath $stderr) {
        Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue | Select-Object -Last 80
      }
      throw "Smoke test failed: server did not answer /api/version."
    }

    $body = $response.Content | ConvertFrom-Json
    if ($body.currentVersion -ne $ExpectedVersion) {
      throw "Smoke test version mismatch: expected $ExpectedVersion, got $($body.currentVersion)."
    }

    Write-Step "Smoke test OK: currentVersion=$($body.currentVersion)"
  } finally {
    $env:NODE_ENV = $oldNodeEnv
    $env:PORT = $oldPort
    $env:HOSTNAME = $oldHostname

    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force
    }
  }
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$appPackageJson = Join-Path $repoRoot "package.json"
if (-not (Test-Path -LiteralPath $appPackageJson)) {
  throw "package.json not found at $appPackageJson"
}

$appPackage = Get-Content -LiteralPath $appPackageJson -Raw | ConvertFrom-Json
$version = $appPackage.version

Push-Location $repoRoot
try {
  $npmRootPath = Resolve-NpmRoot -Override $NpmRoot
  $globalPackageDir = Join-Path $npmRootPath $PackageName
  $globalPackageJson = Join-Path $globalPackageDir "package.json"
  $globalAppDir = Join-Path $globalPackageDir "app"

  if (-not (Test-Path -LiteralPath $globalPackageJson)) {
    throw "Global npm package '$PackageName' was not found at $globalPackageDir."
  }

  Write-Step "Repo: $repoRoot"
  Write-Step "Version: $version"
  Write-Step "Global package: $globalPackageDir"

  if (-not $NoStopRunning) {
    Stop-RunningPackageNodes -PackageDir $globalPackageDir
  }

  if (-not $SkipBuild) {
    Invoke-NextBuild -RepoRoot $repoRoot
  } else {
    Write-Step "Skipping build"
  }

  $standalone = Prepare-Standalone -RepoRoot $repoRoot
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupAppDir = Join-Path $globalPackageDir "app.backup-$timestamp"

  Write-Step "Backing up current app to $backupAppDir"
  if (Test-Path -LiteralPath $globalAppDir) {
    Move-Item -LiteralPath $globalAppDir -Destination $backupAppDir
  }

  Write-Step "Copying standalone app to $globalAppDir"
  Copy-Item -LiteralPath $standalone -Destination $globalAppDir -Recurse -Force

  $packageBackup = Update-GlobalPackageVersion `
    -GlobalPackageJson $globalPackageJson `
    -Version $version `
    -Timestamp $timestamp

  Write-Step "Package backup: $packageBackup"
  Write-Step "App backup: $backupAppDir"

  if (-not $SkipSmoke) {
    Invoke-SmokeTest -AppDir $globalAppDir -ExpectedVersion $version -Port $SmokePort
  } else {
    Write-Step "Skipping smoke test"
  }

  Write-Step "Done. '$PackageName --version' should now print $version."
} finally {
  Pop-Location
}
