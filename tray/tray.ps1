# Nedese Studio tray icon: runs the panel (port 1071) without a window and starts ComfyUI only when the panel needs it.
# Bottom-right icon: right click opens the menu, double click opens the panel. Extra background services of this computer
# (panel-data\services.json, not in the repository) run and are watched the same way, without a menu item.
# Start: "Nedese Studio.vbs" (hidden) or the desktop shortcut. Logs: <install folder>\logs\*.log
# Exit: the panel (and the extra services) and ComfyUI are closed (asks first if a job is running).
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ai = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $ai 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null

# Panel port: panel-data\settings.json "port" (kept across updates), otherwise the default in panel\defaults.json.
# ayar.json is the file written by older versions; the panel renames it on its first start (lib/migrate.mjs).
function SettingsFile {
  @('panel-data\settings.json', 'panel-data\ayar.json') | ForEach-Object { Join-Path $ai $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
}
# Read again on every watchdog tick: a port changed in Settings > Network is followed once the panel restarts.
function PanelPort {
  $port = (Get-Content (Join-Path $ai 'panel\defaults.json') -Raw -Encoding UTF8 | ConvertFrom-Json).port
  try { $p = [int](Get-Content (SettingsFile) -Raw -Encoding UTF8 | ConvertFrom-Json).port; if ($p -gt 0) { $port = $p } } catch {}
  return $port
}
$panelPort = PanelPort
$panelAddress = "http://127.0.0.1:$panelPort/"

# Single instance: a second start only opens the panel in the browser.
$singleInstance = New-Object System.Threading.Mutex($false, 'Local\NedeseStudioTray')
# a tray that was ended without Exit leaves the lock abandoned: taking it then is ours
$owned = try { $singleInstance.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $true }
if (-not $owned) {
  Start-Process $panelAddress
  exit
}

$node = Join-Path $ai 'node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
$ffmpegBin = Join-Path $ai 'ffmpeg\bin'

function Log($text) {
  Add-Content -Path (Join-Path $logs 'tray.log') -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text) -Encoding UTF8
}

# Managed services: the command runs through cmd /c (output goes to the log), no window.
$services = [ordered]@{
  panel = @{ Name = 'Nedese Studio'; Port = $panelPort; Folder = $ai; Command = "`"$node`" `"$ai\panel\server.mjs`" --no-browser"; Log = 'panel.log'; Pid = $null; Restarts = @(); Warned = $false }
}
# Extra services of this computer: panel-data\services.json = [{ "name", "folder" (under the install folder or absolute),
# "command" ({node} = the bundled node.exe), "port", "log" }]. Not in the repository, so nothing personal is shared.
$extraServices = Join-Path $ai 'panel-data\services.json'
if (Test-Path $extraServices) {
  try {
    foreach ($e in @(Get-Content $extraServices -Raw -Encoding UTF8 | ConvertFrom-Json)) {
      $folder = if ([IO.Path]::IsPathRooted($e.folder)) { $e.folder } else { Join-Path $ai $e.folder }
      $services["extra-$($e.name)"] = @{ Name = $e.name; Port = [int]$e.port; Folder = $folder; Command = ([string]$e.command).Replace('{node}', "`"$node`""); Log = $e.log; Pid = $null; Restarts = @(); Warned = $false }
    }
  } catch { Log "panel-data\services.json could not be read: $($_.Exception.Message)" }
}

function PortOwner($port) {
  $b = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($b) { return [int]$b.OwningProcess } else { return $null }
}

function KillTree($id) {
  if ($id) { & taskkill.exe /PID $id /T /F 2>&1 | Out-Null }
}

function StartService($key) {
  $s = $services[$key]
  # If the port is already taken (started from an older window), adopt that process: it is closed on exit too.
  $owner = PortOwner $s.Port
  if ($owner) { $s.Pid = $owner; Log "$($s.Name) already running (pid $owner), adopted"; return }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $env:ComSpec
  $info.Arguments = "/d /c `"$($s.Command) >> `"$(Join-Path $logs $s.Log)`" 2>&1`""
  $info.WorkingDirectory = $s.Folder
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  # After an update the panel only exits; this watchdog starts it again (outside the tray it uses its own helper)
  $info.EnvironmentVariables['AI_PANEL_TRAY'] = '1'
  $info.EnvironmentVariables['PYTHONUTF8'] = '1'
  if (Test-Path $ffmpegBin) { $info.EnvironmentVariables['PATH'] = "$ffmpegBin;$($info.EnvironmentVariables['PATH'])" }
  $proc = [System.Diagnostics.Process]::Start($info)
  $s.Pid = $proc.Id
  Log "$($s.Name) started (pid $($proc.Id))"
}

function ServiceRunning($key) {
  $s = $services[$key]
  if (-not $s.Pid) { return $false }
  return [bool](Get-Process -Id $s.Pid -ErrorAction SilentlyContinue)
}

function StopService($key) {
  $s = $services[$key]
  KillTree $s.Pid
  # If the port is still taken (the adopted process may have a different parent shell), kill its owner too.
  Start-Sleep -Milliseconds 300
  KillTree (PortOwner $s.Port)
  $s.Pid = $null
  Log "$($s.Name) stopped"
}

function ComfyProcesses {
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*ComfyUI\main.py*' }
}

function StopComfy {
  foreach ($c in @(ComfyProcesses)) { KillTree $c.ProcessId }
  # Leftover empty "ComfyUI" cmd windows from earlier shutdowns.
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*start_comfyui.bat*' -or $_.CommandLine -like '*baslat_comfyui.bat*' } | ForEach-Object { KillTree $_.ProcessId }
  Log 'ComfyUI stopped'
}

# The panel's addresses on this computer's networks (home Wi-Fi, Tailscale): what the phone and other devices use.
function NetworkAddresses {
  try {
    return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Sort-Object InterfaceMetric | ForEach-Object { "http://$($_.IPAddress):$($script:panelPort)/" })
  } catch { return @() }
}

function ApiKey {
  try { return (Get-Content (SettingsFile) -Raw -Encoding UTF8 | ConvertFrom-Json).apiKey } catch { return $null }
}

function PanelApi($path, $method = 'GET', $body = $null, $timeoutSec = 3) {
  $key = ApiKey
  $request = @{ Method = $method; Uri = "$($panelAddress)api/v1$path"; Headers = @{ Authorization = "Bearer $key" }; TimeoutSec = $timeoutSec }
  if ($null -ne $body) { $request.Body = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress)); $request.ContentType = 'application/json; charset=utf-8' }
  return Invoke-RestMethod @request
}

function ErrorText($e) {
  # The panel's error message (response body) if there is one, otherwise the exception
  try { $j = $e.ErrorDetails.Message | ConvertFrom-Json; if ($j.error) { return $j.error } } catch {}
  return $e.Exception.Message
}

function RunningJob {
  try { $d = PanelApi '/status'; if ($d.active) { return $d.active } } catch {}
  return $null
}

function ConfirmIfBusy($question) {
  $job = RunningJob
  if (-not $job) { return $true }
  $answer = [System.Windows.Forms.MessageBox]::Show("A job is running: $($job.typeName) ($($job.progress.stage)).`n$question", 'Nedese Studio', 'YesNo', 'Warning')
  return $answer -eq 'Yes'
}

# ── Icon and menu ─────────────────────────────────────────────────────
$icon = New-Object System.Windows.Forms.NotifyIcon
$iconFile = Join-Path $ai 'panel\icon.ico'
$icon.Icon = if (Test-Path $iconFile) { New-Object System.Drawing.Icon($iconFile) } else { [System.Drawing.SystemIcons]::Application }
$icon.Text = 'Nedese Studio'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Item($text, $action) { $o = $menu.Items.Add($text); $o.add_Click($action); return $o }

$itemPanel = Item 'Open Nedese Studio' { Start-Process $panelAddress }
$itemPanel.Font = New-Object System.Drawing.Font($itemPanel.Font, [System.Drawing.FontStyle]::Bold)
# The maker's site
Item 'nedese.com' { Start-Process 'https://nedese.com/' } | Out-Null
$menu.Items.Add('-') | Out-Null
$itemComfyStart = Item 'Start ComfyUI' {
  try { $r = PanelApi '/comfy/start' 'POST'; $icon.ShowBalloonTip(3000, 'Nedese Studio', $r.message, 'Info') } catch { $icon.ShowBalloonTip(3000, 'Nedese Studio', "ComfyUI could not be started: $(ErrorText $_)", 'Error') }
}
$itemComfyStop = Item 'Stop ComfyUI' {
  if (ConfirmIfBusy 'Stopping ComfyUI interrupts the job. Stop it anyway?') { StopComfy; $icon.ShowBalloonTip(2000, 'Nedese Studio', 'ComfyUI stopped.', 'Info') }
}
Item 'Restart the panel' {
  if (ConfirmIfBusy 'Restarting the panel interrupts the job ("Retry" resumes where it left off). Continue?') {
    StopService 'panel'; Start-Sleep 1; StartService 'panel'
    $icon.ShowBalloonTip(2000, 'Nedese Studio', 'Panel restarted.', 'Info')
  }
} | Out-Null
Item 'Open logs' { Start-Process explorer.exe $logs } | Out-Null
$menu.Items.Add('-') | Out-Null
# Updates: a new version on GitHub (same as Settings > Update)
Item 'Check for updates' {
  try { $r = PanelApi '/update/check' 'POST' $null 30; $icon.ShowBalloonTip(6000, 'Nedese Studio', $r.message, 'Info') } catch { $icon.ShowBalloonTip(5000, 'Nedese Studio', "Could not check: $(ErrorText $_)", 'Error') }
} | Out-Null
$itemUpdate = Item 'Update now' {
  try { $r = PanelApi '/update/apply' 'POST' $null 300; $icon.ShowBalloonTip(6000, 'Nedese Studio', $r.message, 'Info') } catch { $icon.ShowBalloonTip(5000, 'Nedese Studio', "Could not update: $(ErrorText $_)", 'Error') }
}
$itemAuto = Item 'Daily update check' {
  try { $r = PanelApi '/update' 'PATCH' @{ auto = (-not $itemAuto.Checked) }; $itemAuto.Checked = [bool]$r.auto; $icon.ShowBalloonTip(4000, 'Nedese Studio', $r.message, 'Info') } catch { $icon.ShowBalloonTip(5000, 'Nedese Studio', "Could not save: $(ErrorText $_)", 'Error') }
}
$menu.Items.Add('-') | Out-Null
Item 'Exit' {
  if (-not (ConfirmIfBusy 'Exiting interrupts the job. Exit anyway?')) { return }
  $script:exiting = $true
  $timer.Stop()
  foreach ($k in @($services.Keys)) { StopService $k }
  StopComfy
  $icon.Visible = $false
  $icon.Dispose()
  [System.Windows.Forms.Application]::Exit()
} | Out-Null

$menu.add_Opening({
  $comfyOpen = [bool](@(ComfyProcesses).Count)
  $itemComfyStart.Enabled = -not $comfyOpen
  $itemComfyStop.Enabled = $comfyOpen
  # Updates: the automatic check box and "Update now" (only when a new version exists; a development copy uses git)
  try {
    $u = PanelApi '/update'
    $itemAuto.Checked = [bool]$u.auto
    $itemUpdate.Enabled = [bool]($u.last.fresh -and -not $u.development -and -not $u.applying)
    $itemUpdate.Text = if ($u.last.fresh -and $u.last.remote.sha) { "Update now ($($u.last.remote.sha.Substring(0, 7)))" } else { 'Update now' }
  } catch { $itemUpdate.Enabled = $false }
})
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Start-Process $panelAddress })

# ── Watchdog: restarts a service that stopped (at most 3 times in 5 minutes), updates the icon tooltip ──
$script:exiting = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.add_Tick({
  if ($script:exiting) { return }
  $port = PanelPort
  if ($port -ne $script:panelPort) {
    Log "panel port $($script:panelPort) -> $port"
    $script:panelPort = $port
    $script:panelAddress = "http://127.0.0.1:$port/"
    $services.panel.Port = $port
  }
  foreach ($k in @($services.Keys)) {
    $s = $services[$k]
    if (ServiceRunning $k) { continue }
    if (PortOwner $s.Port) { $s.Pid = PortOwner $s.Port; continue }
    $now = Get-Date
    $s.Restarts = @($s.Restarts | Where-Object { ($now - $_).TotalMinutes -lt 5 })
    if ($s.Restarts.Count -ge 3) {
      if (-not $s.Warned) { $icon.ShowBalloonTip(5000, 'Nedese Studio', "$($s.Name) keeps stopping; see the log ($($s.Log)).", 'Error'); $s.Warned = $true }
      continue
    }
    $s.Restarts += $now
    Log "$($s.Name) stopped; restarting"
    StartService $k
  }
  # Tooltip (at most 63 characters): job status and ComfyUI.
  $hint = 'Nedese Studio'
  try {
    $d = PanelApi '/status'
    $hint = if ($d.active) { "Nedese Studio · $($d.active.typeName) $([math]::Round($d.active.progress.percent))%" } else { "Nedese Studio · idle$(if ($d.pending.Count) { " · $($d.pending.Count) queued" })" }
    $hint += if ($d.comfy.running) { ' · ComfyUI on' } else { ' · ComfyUI off' }
    # The first time the panel answers after this start: open it in the browser and show the address for the phone
    # (a new user otherwise sees only a tray icon and does not know the port, 10.10.2026).
    if (-not $script:opened) {
      $script:opened = $true
      $timer.Interval = 10000
      Start-Process $script:panelAddress
      $network = @(NetworkAddresses)
      $text = "Open in the browser: $($script:panelAddress)" + $(if ($network.Count) { "`nPhone and other devices at home: $($network -join '  ')" } else { '' })
      $icon.ShowBalloonTip(10000, 'Nedese Studio', $text, 'Info')
      Log "panel opened in the browser; network addresses: $($network -join ' ')"
    }
  } catch { $hint = 'Nedese Studio · starting…' }
  $icon.Text = $hint.Substring(0, [math]::Min(63, $hint.Length))
})

foreach ($k in @($services.Keys)) { StartService $k }
# Quick polls until the panel answers (then every 10 s)
$script:opened = $false
$timer.Interval = 1500
$timer.Start()
$icon.ShowBalloonTip(3000, 'Nedese Studio', 'Starting the panel; it opens in the browser in a moment. Right click: menu, double click: open the panel.', 'Info')
Log 'tray started'
[System.Windows.Forms.Application]::Run()
$singleInstance.ReleaseMutex()
