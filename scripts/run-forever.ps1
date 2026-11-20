# Keeps LaunchPad online on this PC: starts a Cloudflare quick tunnel and the server, restarts either one if it stops.
# Started at logon by the "LaunchPad" scheduled task (scripts/install-autostart.ps1). Logs and the current public URL go to .data\.
# shortcut: a quick tunnel gets a new address each time it (re)starts; use a named tunnel with your own domain for a fixed URL.
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$data = Join-Path $root '.data'; New-Item -ItemType Directory -Force $data | Out-Null
$cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$node = (Get-Command node).Source
$tlog = Join-Path $data 'tunnel.log'

while ($true) {
  Remove-Item $tlog -ErrorAction SilentlyContinue
  $tunnel = Start-Process $cf -ArgumentList "tunnel --no-autoupdate --url http://localhost:8787 --logfile `"$tlog`"" -WindowStyle Hidden -PassThru
  $url = $null
  for ($i = 0; $i -lt 90 -and -not $url -and -not $tunnel.HasExited; $i++) {
    Start-Sleep 1
    if (Test-Path $tlog) { $m = Select-String -Path $tlog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
  }
  if (-not $url) { if (-not $tunnel.HasExited) { Stop-Process $tunnel -Force }; Start-Sleep 15; continue }
  Set-Content (Join-Path $data 'public-url.txt') $url
  Add-Content (Join-Path $data 'uptime.log') "$(Get-Date -Format s) tunnel up at $url"
  $env:APP_ORIGIN = $url
  # The server is restarted on its own while the tunnel stays up, so the address doesn't change.
  while (-not $tunnel.HasExited) {
    $server = Start-Process $node -ArgumentList 'src/server.ts' -WorkingDirectory $root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $data 'server.log') -RedirectStandardError (Join-Path $data 'server-error.log')
    while (-not $server.HasExited -and -not $tunnel.HasExited) { Start-Sleep 5 }
    if (-not $server.HasExited) { Stop-Process $server -Force }
    Add-Content (Join-Path $data 'uptime.log') "$(Get-Date -Format s) server stopped; restarting"
    Start-Sleep 3
  }
  Add-Content (Join-Path $data 'uptime.log') "$(Get-Date -Format s) tunnel stopped; restarting"
  Start-Sleep 5
}
