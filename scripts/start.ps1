$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
& node --env-file-if-exists=.env dist\server\server\index.js
exit $LASTEXITCODE
