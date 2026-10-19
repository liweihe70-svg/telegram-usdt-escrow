$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDir
function Test-Panel {
  try {
    $response = Invoke-RestMethod 'http://127.0.0.1:8781/api/settings' -TimeoutSec 2
    return ($response.mode -eq 'simulation')
  } catch { return $false }
}
if (-not (Test-Panel)) {
  $nodePath = (Get-Command node -ErrorAction Stop).Source
  if (-not (Test-Path -LiteralPath 'dist/src/server.js')) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. Run npm install first.' }
  }
  New-Item -ItemType Directory -Path 'data' -Force | Out-Null
  Start-Process -FilePath $nodePath -ArgumentList 'dist/src/server.js' -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectDir 'data/panel-output.log') -RedirectStandardError (Join-Path $projectDir 'data/panel-error.log') | Out-Null
  for ($attempt = 0; $attempt -lt 25; $attempt++) {
    if (Test-Panel) { break }
    Start-Sleep -Milliseconds 400
  }
  if (-not (Test-Panel)) { throw 'Could not start panel. Check data/panel-error.log or port 8781.' }
}
Start-Process 'http://127.0.0.1:8781/'
