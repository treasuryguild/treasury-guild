# Local Supabase stack for day-to-day development: Postgres + PostgREST +
# Studio in Docker, built from supabase/migrations and seeded with a data
# snapshot of the remote project. Nothing here writes to the remote.
#
#   .\scripts\local.ps1 start      # start the stack (a brand-new DB also migrates + seeds)
#   .\scripts\local.ps1 stop
#   .\scripts\local.ps1 reset      # drop, migrate from scratch, load the snapshot
#   .\scripts\local.ps1 snapshot   # dump remote data -> supabase/seeds/local/remote_snapshot.sql
#   .\scripts\local.ps1 env        # point .env at the local stack (remote values -> .env.remote)
#   .\scripts\local.ps1 status
#   npm run db:start / db:stop / db:reset / db:snapshot / db:env
#
# Needs Docker Desktop. start/stop/reset/status/env are Docker-only and never
# authenticate with a Supabase account. snapshot reads the remote through
# pg_dump when SUPABASE_DB_URL is set in .env.remote (or the environment),
# otherwise through scripts/supa.ps1 (token scoped to that one call).
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('start', 'stop', 'reset', 'snapshot', 'env', 'status')]
  [string]$Command
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$snapshotDir = Join-Path $root 'supabase\seeds\local'
$snapshot = Join-Path $snapshotDir 'remote_snapshot.sql'
$envFile = Join-Path $root '.env'
$remoteEnvFile = Join-Path $root '.env.remote'
$defaultLocalDbUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
$supabaseKeys = @(
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET', 'SUPABASE_DB_URL'
)

function Read-EnvFile([string]$Path) {
  $map = @{}
  if (Test-Path $Path) {
    foreach ($line in Get-Content $Path -Encoding UTF8) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
        $map[$Matches[1]] = $Matches[2].Trim('"', "'")
      }
    }
  }
  return $map
}

# Rewrites the given KEY=value lines in place, appends keys that are missing
# and leaves every other line (comments, other variables) untouched.
function Set-EnvValues([string]$Path, [System.Collections.IDictionary]$Values) {
  $lines = @()
  if (Test-Path $Path) { $lines = @(Get-Content $Path -Encoding UTF8) }
  $seen = @{}
  $out = @(foreach ($line in $lines) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=' -and $Values.Contains($Matches[1])) {
      $seen[$Matches[1]] = $true
      "$($Matches[1])=$($Values[$Matches[1]])"
    } else { $line }
  })
  foreach ($k in $Values.Keys) { if (-not $seen[$k]) { $out += "$k=$($Values[$k])" } }
  # UTF-8 without BOM: Next.js reads .env with a plain dotenv parser.
  [System.IO.File]::WriteAllLines($Path, [string[]]$out)
}

function Test-LocalUrl([string]$Url) {
  return ($Url -match '^[a-z]+://[^@/]*@?(127\.0\.0\.1|localhost|host\.docker\.internal)(:|/)')
}

# Runs the Supabase CLI through scripts/supa.ps1 when present (repo rule) or
# bare `supabase` otherwise. Streams output; the exit code decides.
function Invoke-Supabase([string[]]$CliArgs) {
  $wrapper = Join-Path $PSScriptRoot 'supa.ps1'
  $ErrorActionPreference = 'Continue'
  if (Test-Path $wrapper) {
    & $wrapper @CliArgs 2>&1 | ForEach-Object { $_.ToString() }
  } else {
    & supabase @CliArgs 2>&1 | ForEach-Object { $_.ToString() }
  }
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($code -ne 0) { throw "supabase $($CliArgs -join ' ') failed with exit code $code" }
}

function Invoke-Native([string]$Label, [scriptblock]$Call) {
  $ErrorActionPreference = 'Continue'
  & $Call 2>&1 | ForEach-Object { $_.ToString() }
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($code -ne 0) { throw "$Label failed with exit code $code" }
}

# Docker publishes the stack's ports on 0.0.0.0, so Postgres (postgres:postgres),
# Studio (no login) and the API (well-known demo keys) are reachable from the
# LAN unless Windows blocks them; the database holds the remote snapshot with
# real member wallets. The CLI has no bind-address option, so a firewall rule
# is the guard. Creating it needs an elevated shell, hence only a reminder.
$firewallRuleName = 'Guild Vault local Supabase (block LAN)'
function Test-LanFirewallRule {
  $rule = $null
  try { $rule = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction Stop } catch {}
  if ($rule -and $rule.Enabled -eq 'True') { return }
  Write-Host 'Warning: the local stack is reachable from your network (ports 54320-54330, default credentials, real member data).' -ForegroundColor Yellow
  Write-Host 'Block it once from an elevated PowerShell:' -ForegroundColor Yellow
  Write-Host "  New-NetFirewallRule -DisplayName '$firewallRuleName' -Direction Inbound -Protocol TCP -LocalPort 54320-54330 -RemoteAddress Any -Action Block" -ForegroundColor Yellow
  Write-Host '  (loopback traffic is not filtered; the app on this machine keeps working)' -ForegroundColor Yellow
  Write-Host ''
}

# `supabase status -o env` as a hashtable; throws when the stack is down.
function Get-LocalStatus {
  try {
    $lines = Invoke-Supabase @('status', '-o', 'env')
  } catch {
    throw "The local Supabase stack is not running. Start Docker Desktop and run: npm run db:start"
  }
  $status = @{}
  foreach ($l in @($lines)) {
    if ($l -match '^([A-Z0-9_]+)="?(.*?)"?\s*$') { $status[$Matches[1]] = $Matches[2] }
  }
  return $status
}

switch ($Command) {
  'start' {
    if (-not (Test-Path $snapshot)) {
      Write-Host "No remote snapshot yet ($snapshot)."
      Write-Host "The local database will hold only the schema. To mirror the remote data run:"
      Write-Host "  npm run db:snapshot   then   npm run db:reset"
    }
    Invoke-Supabase @('start') | Out-Host
    Write-Host ''
    Test-LanFirewallRule
    Write-Host 'Next: npm run db:env (point .env at this stack), then npm run seed:sandbox.'
  }
  'stop' {
    Invoke-Supabase @('stop') | Out-Host
  }
  'status' {
    Invoke-Supabase @('status') | Out-Host
  }
  'reset' {
    if (-not (Test-Path $snapshot)) {
      Write-Host "No remote snapshot at $snapshot; resetting to an empty schema (npm run db:snapshot to mirror the remote)."
    }
    # --local: never the linked project, even though the repo is linked.
    Invoke-Supabase @('db', 'reset', '--local') | Out-Host
  }
  'snapshot' {
    New-Item -ItemType Directory -Force $snapshotDir | Out-Null
    $tmp = Join-Path $snapshotDir 'remote_snapshot.tmp.sql'
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
    $url = $env:SUPABASE_DB_URL
    if (-not $url) { $url = (Read-EnvFile $remoteEnvFile)['SUPABASE_DB_URL'] }
    if ($url -and (Test-LocalUrl $url)) {
      throw "SUPABASE_DB_URL points at the local stack ($url). Put the REMOTE connection string in .env.remote."
    }
    if ($url) {
      Write-Host 'Dumping remote data with pg_dump (no Supabase CLI account involved)'
      # auth_nonces: per-login challenges, useless elsewhere. webhook_events:
      # raw GitHub payloads (sender profiles, repo contents) the local app
      # never reads; the snapshot already holds enough personal data.
      Invoke-Native 'pg_dump' {
        & pg_dump $url --data-only --schema=public --column-inserts --no-owner --no-privileges `
          --exclude-table-data=public.auth_nonces --exclude-table-data=public.webhook_events --file $tmp
      }
    } else {
      if (-not (Test-Path (Join-Path $PSScriptRoot 'supa.ps1'))) {
        throw 'Set SUPABASE_DB_URL in .env.remote (Project Settings -> Database connection string) or recreate scripts/supa.ps1 (see scripts/README.md).'
      }
      Write-Host 'Dumping remote data with scripts/supa.ps1 db dump --linked'
      Invoke-Supabase @('db', 'dump', '--linked', '--data-only', '-s', 'public', '-x', 'public.auth_nonces,public.webhook_events', '-f', $tmp) | Out-Host
    }
    if (-not (Test-Path $tmp)) { throw 'The dump produced no file.' }

    $content = @(Get-Content $tmp -Encoding UTF8)
    # Migration history belongs to each database; loading the remote's rows
    # into the local supabase_migrations table would break `db reset`.
    $migrationRows = @($content | Where-Object { $_ -match 'supabase_migrations' })
    if ($migrationRows.Count -gt 0) {
      $content = @($content | Where-Object { $_ -notmatch 'supabase_migrations' })
      Write-Host "Stripped $($migrationRows.Count) supabase_migrations line(s)."
    }
    # Restore with triggers and FK checks off: task numbers, lifecycle guards
    # and archive guards must not fire while the rows are copied in.
    if (@($content | Where-Object { $_ -match '^\s*set\s+session_replication_role\s*=\s*.?replica' }).Count -eq 0) {
      $content = @('set session_replication_role = replica;') + $content
    }
    $header = @(
      '-- Data snapshot of the remote Guild Vault project, generated by',
      '-- scripts/local.ps1 snapshot. Loaded by `supabase db reset` (config.toml',
      '-- [db.seed].sql_paths). Gitignored: it holds real member wallets.',
      "-- Taken $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
    )
    [System.IO.File]::WriteAllLines($snapshot, [string[]]($header + $content))
    Remove-Item $tmp -Force

    Write-Host "Wrote $snapshot"
    # Row counts per table. pg_dump --column-inserts writes one INSERT per row;
    # the CLI writes one INSERT per table with a "(...)," line per row.
    $counts = @{}
    $table = $null
    foreach ($line in $content) {
      if ($line -match '^INSERT INTO "?public"?\."?([A-Za-z0-9_]+)"?\s') {
        $table = $Matches[1]
        if (-not $counts.ContainsKey($table)) { $counts[$table] = 0 }
        if ($line -match '\)\s*VALUES\s*\(') { $counts[$table]++ }
        if ($line -match ';\s*$') { $table = $null }
      } elseif ($table) {
        if ($line -match '^\s*\(') { $counts[$table]++ }
        if ($line -match ';\s*$') { $table = $null }
      }
    }
    foreach ($t in 'communities', 'community_members', 'treasuries', 'mints', 'workgroups', 'tasks', 'transactions') {
      $n = 0; if ($counts.ContainsKey($t)) { $n = $counts[$t] }
      Write-Host ("  {0,-18} {1,6} rows" -f $t, $n)
    }
    if (-not $counts.ContainsKey('mints') -or $counts['mints'] -eq 0) {
      Write-Host 'Warning: no mints in the snapshot; the Signius seeds need the confirmed GVTT mint.'
    }
    Write-Host 'Load it with: npm run db:reset'
  }
  'env' {
    $status = Get-LocalStatus
    $anon = $status['ANON_KEY']; if (-not $anon) { $anon = $status['PUBLISHABLE_KEY'] }
    $service = $status['SERVICE_ROLE_KEY']; if (-not $service) { $service = $status['SECRET_KEY'] }
    $dbUrl = $status['DB_URL']; if (-not $dbUrl) { $dbUrl = $defaultLocalDbUrl }
    $missing = @()
    if (-not $status['API_URL']) { $missing += 'API_URL' }
    if (-not $anon) { $missing += 'ANON_KEY' }
    if (-not $service) { $missing += 'SERVICE_ROLE_KEY' }
    if (-not $status['JWT_SECRET']) { $missing += 'JWT_SECRET' }
    if ($missing) { throw "supabase status -o env did not report: $($missing -join ', ')" }

    $current = Read-EnvFile $envFile
    if (-not (Test-Path $remoteEnvFile)) {
      if ($current['NEXT_PUBLIC_SUPABASE_URL'] -and (Test-LocalUrl $current['NEXT_PUBLIC_SUPABASE_URL'])) {
        Write-Host '.env already points at a local stack and .env.remote does not exist; not saving local values as remote.'
      } else {
        $lines = @(
          '# Remote Supabase project. Read by `npm run dev:remote`, `npm run db:snapshot`',
          '# and `npm run seed:*:remote`; never by `npm run dev`. Written once by',
          '# `npm run db:env` from the values .env held at the time. Gitignored.',
          '#',
          '# SUPABASE_DB_URL: the direct or session-pooler connection string from the',
          '# dashboard (Project Settings -> Database), password included. With it set,',
          '# db:snapshot and seed:*:remote use pg_dump/psql and need no CLI account.'
        )
        foreach ($k in $supabaseKeys) { $lines += "$k=$($current[$k])" }
        [System.IO.File]::WriteAllLines($remoteEnvFile, [string[]]$lines)
        Write-Host "Saved the previous Supabase values to $remoteEnvFile"
      }
    }
    $values = [ordered]@{
      NEXT_PUBLIC_SUPABASE_URL      = $status['API_URL']
      NEXT_PUBLIC_SUPABASE_ANON_KEY = $anon
      SUPABASE_SERVICE_ROLE_KEY     = $service
      SUPABASE_JWT_SECRET           = $status['JWT_SECRET']
      SUPABASE_DB_URL               = $dbUrl
    }
    Set-EnvValues $envFile $values
    Write-Host ".env now targets the local stack: $($status['API_URL']) (db $dbUrl)"
    Write-Host 'Restart `npm run dev` to pick it up. Remote: `npm run dev:remote`.'
  }
}
