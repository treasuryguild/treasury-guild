# Starts the Next.js dev server. With -Remote, every non-empty value in
# .env.remote is loaded into the process first; Next's own .env loader never
# overrides variables that are already set, so the app talks to the remote
# project while .env keeps pointing at the local stack.
#
#   npm run dev            # local stack (.env)
#   npm run dev:remote     # scripts/dev.ps1 -Remote
param([switch]$Remote)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

if ($Remote) {
  $file = Join-Path $root '.env.remote'
  if (-not (Test-Path $file)) {
    throw '.env.remote not found. Run `npm run db:env` once (it saves the remote values there) or create it from .env.example.'
  }
  $loaded = @()
  foreach ($line in Get-Content $file -Encoding UTF8) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $value = $Matches[2].Trim('"', "'")
      if ($value) { Set-Item -Path "env:$($Matches[1])" -Value $value; $loaded += $Matches[1] }
    }
  }
  if ($loaded -notcontains 'NEXT_PUBLIC_SUPABASE_URL') { throw '.env.remote has no NEXT_PUBLIC_SUPABASE_URL.' }
  Write-Host "Using the REMOTE Supabase project: $env:NEXT_PUBLIC_SUPABASE_URL"
}

Set-Location $root
& npx next dev
exit $LASTEXITCODE
