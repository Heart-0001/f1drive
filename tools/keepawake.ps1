# Keeps Windows from going to sleep while the overnight build runs (the display may still turn off).
# Started detached by the watchdog setup; stop it with:  Stop-Process -Id (Get-Content tools\watchdog-out\keepawake.pid)
# It changes no system setting: the request ends when this process ends. Exits by itself after -Hours.
param([int]$Hours = 16)
$out = Join-Path $PSScriptRoot 'watchdog-out'
New-Item -ItemType Directory -Force $out | Out-Null
Set-Content -Path (Join-Path $out 'keepawake.pid') -Value $PID -Encoding ascii
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
$until = (Get-Date).AddHours($Hours)
while ((Get-Date) -lt $until) {
  [Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
  Start-Sleep -Seconds 30
}
[Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
