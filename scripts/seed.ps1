# Runs one of the Signius seeds. Local stack by default; the remote project
# only with -Remote.
#
#   .\scripts\seed.ps1 sandbox           # wipe + reseed the [TEST] sandbox (build-only data)
#   .\scripts\seed.ps1 live              # add one new [LIVE] payout batch (real history)
#   .\scripts\seed.ps1 sandbox -Remote   # the same against the REMOTE project (asks to type "remote")
#   .\scripts\seed.ps1 live -Remote -Yes # skip the confirmation (automation only)
#   npm run seed:sandbox / seed:live / seed:sandbox:remote / seed:live:remote
#
# Local: psql against the local Supabase database (SUPABASE_DB_URL in .env as
# written by `npm run db:env`, else the config.toml default). psql prints the
# seeds' NOTICE lines. Remote: psql with SUPABASE_DB_URL from .env.remote
# (no CLI account involved); when that is empty, the SQL goes through
# scripts/supa.ps1 `db query --linked` (Management API, NOTICEs dropped).
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('sandbox', 'live')]
  [string]$Seed,
  [switch]$Remote,
  [switch]$Yes,
  [string]$DbUrl
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$file = Join-Path $root "supabase\seeds\signius_$Seed.sql"
if (-not (Test-Path $file)) { throw "Seed file not found: $file" }
$defaultLocalDbUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

function Read-EnvValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { return $null }
  $line = Get-Content $Path -Encoding UTF8 | Where-Object { $_ -match "^\s*$Key\s*=\s*(.+?)\s*$" } | Select-Object -First 1
  if ($line) { return ($Matches[1]).Trim('"', "'") }
  return $null
}
function Test-LocalUrl([string]$Url) {
  return ($Url -match '^[a-z]+://[^@/]*@?(127\.0\.0\.1|localhost|host\.docker\.internal)(:|/)')
}
function Test-Postgres([string]$Url) {
  $env:PGCONNECT_TIMEOUT = '3'
  & psql $Url -X -q -t -A -c 'select 1' 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

$useCli = $false
if ($Remote) {
  if (-not $DbUrl) { $DbUrl = Read-EnvValue (Join-Path $root '.env.remote') 'SUPABASE_DB_URL' }
  if ($DbUrl -and (Test-LocalUrl $DbUrl)) { throw "-Remote was given but the connection string is local: $DbUrl" }
  if (-not $DbUrl) {
    if (-not (Test-Path (Join-Path $PSScriptRoot 'supa.ps1'))) {
      throw 'Remote seeding needs SUPABASE_DB_URL in .env.remote or scripts/supa.ps1 (see scripts/README.md).'
    }
    $useCli = $true
  }
  Write-Host '!!! Targeting the REMOTE Supabase project !!!' -ForegroundColor Yellow
  $effect = if ($Seed -eq 'sandbox') { 'wipes the remote [TEST] sandbox and reseeds it' } else { 'appends a new [LIVE] payout batch to both live workgroups in the remote history' }
  Write-Host "signius_$Seed.sql $effect." -ForegroundColor Yellow
  if (-not $Yes) {
    # A remote write must never be one mistyped npm script away: the npm
    # `seed:*:remote` scripts deliberately omit -Yes so this always asks.
    $answer = Read-Host 'Type "remote" to continue, anything else to abort'
    if ($answer -cne 'remote') { Write-Host 'Aborted; nothing was written.'; exit 1 }
  }
} else {
  if (-not $DbUrl) { $DbUrl = Read-EnvValue (Join-Path $root '.env') 'SUPABASE_DB_URL' }
  if ($DbUrl -and -not (Test-LocalUrl $DbUrl)) {
    Write-Host "Ignoring non-local SUPABASE_DB_URL in .env ($DbUrl); seeds target the local stack unless -Remote is given."
    $DbUrl = $null
  }
  if (-not $DbUrl) { $DbUrl = $defaultLocalDbUrl }
  if (-not (Test-Postgres $DbUrl)) {
    throw "Cannot reach the local database at $DbUrl. Start Docker Desktop and run: npm run db:start"
  }
}

# psql and the CLI write progress/NOTICE lines to stderr; under 'Stop'
# PowerShell 5.1 would turn the first one into a terminating error, so relax
# it for the call and print stderr as plain text. The exit code decides.
$ErrorActionPreference = 'Continue'
if ($useCli) {
  Write-Host "Running signius_$Seed.sql through the Supabase CLI (linked project)"
  & (Join-Path $PSScriptRoot 'supa.ps1') db query --linked -f $file 2>&1 | ForEach-Object { $_.ToString() }
} else {
  $target = if ($Remote) { 'remote' } else { 'local' }
  Write-Host "Running signius_$Seed.sql through psql ($target database)"
  & psql $DbUrl -X -v ON_ERROR_STOP=1 -f $file 2>&1 | ForEach-Object { $_.ToString() }
}
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($code -ne 0) { throw "Seed failed with exit code $code" }
