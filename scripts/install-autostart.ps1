# Registers a per-user scheduled task that runs scripts/run-forever.ps1 at logon, hidden, and restarts it if it fails.
# Remove with: Unregister-ScheduledTask -TaskName LaunchPad -Confirm:$false
$script = Join-Path $PSScriptRoot 'run-forever.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'LaunchPad' -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps the LaunchPad server and tunnel running' -Force | Out-Null
Start-ScheduledTask -TaskName 'LaunchPad'
'LaunchPad will now start automatically when you sign in to Windows.'
