# Creates an owner (admin) account. The database is single-process in development, so the site pauses for a moment.
Set-Location (Split-Path $PSScriptRoot -Parent)
Stop-ScheduledTask LaunchPad -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*src/server.ts*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
node src/cli.ts create-owner
Start-ScheduledTask LaunchPad
'Site restarting. The new address will be in .data\public-url.txt in about 20 seconds.'
