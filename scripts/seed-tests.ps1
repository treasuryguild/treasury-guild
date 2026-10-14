# Runs the SQL fixtures in supabase/tests against a throwaway Postgres in
# Docker. Each fixture builds the schema from the migrations, asserts, and
# rolls everything back, so one fresh database serves them all.
#
#   .\scripts\seed-tests.ps1                  # every supabase/tests/*.sql
#   .\scripts\seed-tests.ps1 -Filter signius  # only files whose name contains "signius"
#   npm run seed:test
#
# Needs Docker and a psql client on PATH. Never touches the remote project.
param(
  [string]$Filter = '',
  # 54330: clear of the local Supabase stack's ports (54320-54329 in config.toml).
  [int]$Port = 54330,
  [string]$Image = 'postgres:17'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$name = 'treasury-guild-sql-tests'
$tests = Get-ChildItem (Join-Path $root 'supabase\tests\*.sql') | Where-Object { $_.Name -like "*$Filter*" } | Sort-Object Name
if (-not $tests) { throw "No tests match '$Filter'" }

docker rm -f $name 2>$null | Out-Null
docker run -d --rm --name $name -e POSTGRES_PASSWORD=test -p "${Port}:5432" $Image | Out-Null
try {
  $ready = $false
  for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
    Start-Sleep -Seconds 1
    # Over TCP: the image's init runs a temporary server on the Unix socket
    # only, which the socket check would take for the real one.
    docker exec $name pg_isready -h 127.0.0.1 -U postgres 2>$null | Out-Null
    $ready = ($LASTEXITCODE -eq 0)
  }
  if (-not $ready) { throw 'Postgres container did not become ready' }

  $env:PGPASSWORD = 'test'
  $url = "postgresql://postgres@localhost:$Port/postgres"
  $failed = @()
  foreach ($t in $tests) {
    Write-Host "== $($t.Name)"
    # psql writes NOTICE/ERROR lines to stderr; under 'Stop' PowerShell 5.1
    # would turn the first one into a terminating error, so relax it here and
    # print stderr as plain text. The exit code is what decides pass/fail.
    $ErrorActionPreference = 'Continue'
    & psql $url -X -q -v ON_ERROR_STOP=1 -f $t.FullName 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { $failed += $t.Name; Write-Host "   FAILED (exit $code)" }
  }
  if ($failed) { throw "Failed: $($failed -join ', ')" }
  Write-Host "All $($tests.Count) SQL fixtures passed."
} finally {
  docker rm -f $name 2>$null | Out-Null
}
