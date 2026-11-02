param(
  [string]$ProductionPath = 'C:\apps\a-table',
  [switch]$ServerStopped
)

$ErrorActionPreference = 'Stop'

function Get-DeploymentFileHash {
  param([string]$LiteralPath)

  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    try {
      return [System.BitConverter]::ToString($algorithm.ComputeHash($stream))
    } finally {
      $stream.Dispose()
    }
  } finally {
    $algorithm.Dispose()
  }
}

$repositoryPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$productionPath = [System.IO.Path]::GetFullPath($ProductionPath)
$repositoryPrefix = $repositoryPath.TrimEnd('\') + '\'

if ($productionPath.TrimEnd('\') -ieq $repositoryPath -or $productionPath.StartsWith($repositoryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Le dossier de production doit être distinct du dépôt et situé en dehors de celui-ci.'
}

$productionEnv = Join-Path $productionPath '.env'
$sourceEnv = Join-Path $repositoryPath '.env'
$targetAlreadyExists = Test-Path -LiteralPath $productionPath
$isFirstDeploy = !(Test-Path -LiteralPath $productionEnv)

if ($isFirstDeploy -and $targetAlreadyExists -and (Get-ChildItem -LiteralPath $productionPath -Force | Select-Object -First 1)) {
  throw "Le dossier existe déjà sans .env : $productionPath. Vérifiez-le manuellement avant de continuer."
}
if ($isFirstDeploy -and !(Test-Path -LiteralPath $sourceEnv)) {
  throw "Configuration source absente : $sourceEnv. Créez et configurez .env avant le premier déploiement."
}

Push-Location $repositoryPath
try {
  New-Item -ItemType Directory -Path (Join-Path $productionPath 'data') -Force | Out-Null

  if ($isFirstDeploy) {
    $databaseBackup = Join-Path $productionPath 'data\planner.sqlite'
    if (Test-Path -LiteralPath $databaseBackup) {
      throw "La base cible existe déjà : $databaseBackup. Aucune donnée n'a été remplacée."
    }

    Write-Host 'Sauvegarde de la base actuelle vers le dossier de production...'
    & npm run backup -- $databaseBackup
    if ($LASTEXITCODE -ne 0) { throw 'Échec de la sauvegarde de la base source.' }

    $envContent = [System.IO.File]::ReadAllText($sourceEnv)
    if ($envContent -match '(?m)^\s*DATABASE_PATH\s*=') {
      $envContent = [System.Text.RegularExpressions.Regex]::Replace(
        $envContent,
        '(?m)^\s*DATABASE_PATH\s*=.*$',
        'DATABASE_PATH=./data/planner.sqlite'
      )
    } else {
      $envContent = $envContent.TrimEnd() + "`r`nDATABASE_PATH=./data/planner.sqlite`r`n"
    }
    New-Item -ItemType Directory -Path $productionPath -Force | Out-Null
    [System.IO.File]::WriteAllText($productionEnv, $envContent, [System.Text.UTF8Encoding]::new($false))
  } else {
    $backupDirectory = Join-Path $productionPath 'backups'
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $backupName = 'planner-{0}-{1}.sqlite' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $databaseBackup = Join-Path $backupDirectory $backupName

    Write-Host 'Sauvegarde de la base de production...'
    & node "--env-file-if-exists=$productionEnv" (Join-Path $repositoryPath 'scripts\backup.mjs') $databaseBackup
    if ($LASTEXITCODE -ne 0) { throw 'Échec de la sauvegarde de la base de production.' }
  }

  $port = 3000
  $portMatches = [System.Text.RegularExpressions.Regex]::Matches(
    [System.IO.File]::ReadAllText($productionEnv),
    '(?m)^\s*PORT\s*=\s*(\d+)\s*(?:#.*)?$'
  )
  if ($portMatches.Count -gt 0) {
    $port = [int]$portMatches[$portMatches.Count - 1].Groups[1].Value
  }

  if (!$ServerStopped) {
    $confirmation = Read-Host "Arrêtez le serveur de production et son démarrage automatique, puis saisissez O pour déployer (port $port)"
    if ($confirmation -notmatch '^(o|oui|y|yes)$') {
      throw 'Déploiement annulé. La sauvegarde créée est conservée.'
    }
  }

  $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    throw "Le port $port écoute encore. Arrêtez le serveur avant de relancer le déploiement."
  }

  Write-Host 'Construction du build de production...'
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Échec de npm run build.' }

  $packagePath = Join-Path $repositoryPath 'package.json'
  $lockPath = Join-Path $repositoryPath 'package-lock.json'
  $productionPackage = Join-Path $productionPath 'package.json'
  $productionLock = Join-Path $productionPath 'package-lock.json'
  $dependenciesChanged = $true
  if ((Test-Path -LiteralPath $productionPackage) -and (Test-Path -LiteralPath $productionLock)) {
    $dependenciesChanged =
      (Get-DeploymentFileHash -LiteralPath $packagePath) -ne (Get-DeploymentFileHash -LiteralPath $productionPackage) -or
      (Get-DeploymentFileHash -LiteralPath $lockPath) -ne (Get-DeploymentFileHash -LiteralPath $productionLock)
  }

  New-Item -ItemType Directory -Path $productionPath -Force | Out-Null
  Copy-Item -LiteralPath $packagePath -Destination $productionPackage -Force
  Copy-Item -LiteralPath $lockPath -Destination $productionLock -Force

  $productionScripts = Join-Path $productionPath 'scripts'
  New-Item -ItemType Directory -Path $productionScripts -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repositoryPath 'scripts\start.ps1') -Destination $productionScripts -Force
  Copy-Item -LiteralPath (Join-Path $repositoryPath 'scripts\backup.mjs') -Destination $productionScripts -Force

  if ($dependenciesChanged) {
    Write-Host 'Installation des dépendances de production...'
    Push-Location $productionPath
    try {
      & npm ci --omit=dev
      if ($LASTEXITCODE -ne 0) { throw 'Échec de npm ci --omit=dev dans le dossier de production.' }
    } finally {
      Pop-Location
    }
  }

  $stagingPath = Join-Path $productionPath ('.deploy-dist-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stagingPath | Out-Null
  try {
    Copy-Item -Path (Join-Path $repositoryPath 'dist\*') -Destination $stagingPath -Recurse -Force

    $productionDist = Join-Path $productionPath 'dist'
    if (Test-Path -LiteralPath $productionDist) {
      $releaseDirectory = Join-Path $productionPath 'releases'
      New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
      $previousBuild = Join-Path $releaseDirectory ('dist-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
      Move-Item -LiteralPath $productionDist -Destination $previousBuild
      try {
        Move-Item -LiteralPath $stagingPath -Destination $productionDist
      } catch {
        if (!(Test-Path -LiteralPath $productionDist) -and (Test-Path -LiteralPath $previousBuild)) {
          Move-Item -LiteralPath $previousBuild -Destination $productionDist
        }
        throw
      }
    } else {
      Move-Item -LiteralPath $stagingPath -Destination $productionDist
    }
  } finally {
    if (Test-Path -LiteralPath $stagingPath) {
      Remove-Item -LiteralPath $stagingPath -Recurse -Force
    }
  }

  Write-Host "Déploiement terminé dans $productionPath"
  Write-Host "Démarrez la production avec : & '$productionPath\scripts\start.ps1'"
} finally {
  Pop-Location
}
