# Checks Parousia Desktop on Windows with the real release build, the real
# Windows tray and the real registry: nothing here is a stand-in for Windows.
#
#   cargo build --release
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1
#
# Desktop runs against a throwaway data directory (PAROUSIA_DATA_DIR) and a
# Discord pipe name nothing listens on, so a real config and a real Discord
# are never touched. Port 57179 must be free: stop your own Desktop first.
# It drives the notification-area icon and its menu through UI Automation and
# the mouse, so run it on a signed-in desktop and leave the mouse alone for a
# few seconds.
#
# Covers: one Desktop at a time (a second launch says so and exits); the CLI
# over the control pipe from a terminal (status, set, allow, disallow, a bad
# origin); the pipe's access list (this user only); the port refusing to be
# shared and a clear failure when something else holds it; the tray icon, its
# menu, Settings > Start at login against the real Run key, and Quit.
# Discord quitting and restarting, and the extension link, are covered by
# `bun run desktop:verify` (browser/), and the Discord adapter against real
# named pipes by `cargo test`. Other OS users can't be tested without a
# second Windows account.

param(
    [string]$Exe = $(if ($env:PAROUSIA_DESKTOP_BIN) { $env:PAROUSIA_DESKTOP_BIN }
        elseif ($env:CARGO_TARGET_DIR) { Join-Path $env:CARGO_TARGET_DIR 'release\Parousia-Desktop.exe' }
        else { Join-Path $PSScriptRoot '..\target\release\Parousia-Desktop.exe' })
)

$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path $Exe).Path
$step = 0
function Log($message) { $script:step++; Write-Host ("[windows] {0,2}. {1}" -f $script:step, $message) }
function Assert($condition, $message) { if (-not $condition) { throw "assertion failed: $message" } }

function WaitUntil($description, [scriptblock]$check, $seconds = 15) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        $value = & $check
        if ($value) { return $value }
        Start-Sleep -Milliseconds 150
    }
    throw "timed out waiting for $description"
}

if (Get-NetTCPConnection -LocalPort 57179 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 57179 is in use (is your own Parousia Desktop running?). Stop it first; this check never does.'
}

$work = Join-Path $env:TEMP ("pdw-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $work | Out-Null
$saved = @{ data = $env:PAROUSIA_DATA_DIR; pipe = $env:PAROUSIA_DISCORD_IPC_PIPE }
$env:PAROUSIA_DATA_DIR = Join-Path $work 'data'
$env:PAROUSIA_DISCORD_IPC_PIPE = "\\.\pipe\$(Split-Path $work -Leaf)-discord-ipc-"

$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$pipePath = "\\.\pipe\parousia-desktop-$sid"
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'Parousia Desktop'
$startupBefore = (Get-ItemProperty $runKey -Name $runValue -ErrorAction SilentlyContinue).$runValue
$desktop = $null

function Pipes { [System.IO.Directory]::GetFiles('\\.\pipe\') }

# Runs Desktop with its output captured, like a script or a terminal would,
# and returns what it printed and its exit code.
function Run($arguments) {
    $out = Join-Path $work ([guid]::NewGuid().ToString('N'))
    $launch = @{ FilePath = $Exe; Wait = $true; PassThru = $true; WindowStyle = 'Hidden';
        RedirectStandardOutput = "$out.out"; RedirectStandardError = "$out.err" }
    # An empty ArgumentList is an error, so none is passed for a plain launch.
    if (@($arguments).Count -gt 0) { $launch.ArgumentList = @($arguments) }
    $process = Start-Process @launch
    [pscustomobject]@{
        Code = $process.ExitCode
        Out  = (Get-Content "$out.out" -Raw -ErrorAction SilentlyContinue)
        Err  = (Get-Content "$out.err" -Raw -ErrorAction SilentlyContinue)
    }
}

function DesktopJson($arguments) {
    $result = Run ($arguments + '--json')
    Assert ($result.Code -eq 0) "$arguments exited $($result.Code): $($result.Err)$($result.Out)"
    $result.Out | ConvertFrom-Json
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -Namespace Win -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuStringW(IntPtr menu, uint item, System.Text.StringBuilder text, int max, uint flags);
[DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr menu, int pos);
[DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr menu, uint item, uint flags);
[DllImport("user32.dll")] public static extern bool GetMenuItemRect(IntPtr window, IntPtr menu, uint item, out RECT rect);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
'@

# Menu positions and the mouse have to agree on pixels, on a scaled display too.
[void][Win.Native]::SetProcessDPIAware()

$ui = [System.Windows.Automation.AutomationElement]::RootElement
$Name = [System.Windows.Automation.AutomationElement]::NameProperty
$Class = [System.Windows.Automation.AutomationElement]::ClassNameProperty
function ByProperty($property, $value) { New-Object System.Windows.Automation.PropertyCondition($property, $value) }

# The icon's button in the notification area, whose name is the tooltip. On
# Windows 11 a new icon starts in the overflow flyout, which is opened first.
# Searches stay inside the taskbar and the flyout: walking the whole desktop
# fails now and then as windows come and go.
$Button = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
function IconIn($window) {
    if (-not $window) { return $null }
    try {
        $buttons = $window.FindAll('Descendants', (ByProperty $Button ([System.Windows.Automation.ControlType]::Button)))
        foreach ($candidate in $buttons) {
            if ($candidate.Current.Name -like 'Running*' -or $candidate.Current.Name -like 'Sharing*') { return $candidate }
        }
    } catch { }
    $null
}
function TrayIcon {
    $tray = $ui.FindFirst('Children', (ByProperty $Class 'Shell_TrayWnd'))
    $icon = IconIn $tray
    if ($icon) { return $icon }
    $flyout = $ui.FindFirst('Children', (ByProperty $Class 'TopLevelWindowForOverflowXamlIsland'))
    $icon = IconIn $flyout
    if ($icon) { return $icon }
    $chevron = $tray.FindFirst('Descendants', (ByProperty $Name 'Show Hidden Icons'))
    if ($chevron) {
        $chevron.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Start-Sleep -Milliseconds 1200
        return IconIn ($ui.FindFirst('Children', (ByProperty $Class 'TopLevelWindowForOverflowXamlIsland')))
    }
    $null
}

function MenuWindows { @($ui.FindAll('Children', (ByProperty $Class '#32768'))) }
# A menu on screen: its window, and the menu in it (MN_GETHMENU).
function MenuOf($element) {
    $window = [IntPtr]$element.Current.NativeWindowHandle
    [pscustomobject]@{ Window = $window; Menu = [Win.Native]::SendMessage($window, 0x1E1, [IntPtr]::Zero, [IntPtr]::Zero) }
}
function MenuLabels($menu) {
    for ($i = 0; $i -lt [Win.Native]::GetMenuItemCount($menu); $i++) {
        $text = New-Object System.Text.StringBuilder 256
        [void][Win.Native]::GetMenuStringW($menu, $i, $text, 256, 0x400)
        $text.ToString()
    }
}
function MenuIndex($menu, $label) {
    $labels = @(MenuLabels $menu)
    for ($i = 0; $i -lt $labels.Count; $i++) { if ($labels[$i] -like $label) { return $i } }
    throw "no menu item '$label' among: $($labels -join ' | ')"
}
function Click($on, $index) {
    $rect = New-Object Win.Native+RECT
    Assert ([Win.Native]::GetMenuItemRect($on.Window, $on.Menu, $index, [ref]$rect)) 'the menu item has a place on screen'
    [void][Win.Native]::SetCursorPos([int](($rect.Left + $rect.Right) / 2), [int](($rect.Top + $rect.Bottom) / 2))
    Start-Sleep -Milliseconds 250
    [Win.Native]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
    [Win.Native]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400
}
function OpenMenu {
    $icon = WaitUntil 'the tray icon' { TrayIcon } 20
    $icon.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $window = WaitUntil 'the tray menu' { (MenuWindows) | Select-Object -First 1 } 5
    MenuOf $window
}
# Opens the submenu at `index` of `parent` by clicking it, and returns it.
function Submenu($parent, $index) {
    $handle = [Win.Native]::GetSubMenu($parent.Menu, $index)
    Click $parent $index
    $found = WaitUntil 'the submenu' { MenuWindows | ForEach-Object { MenuOf $_ } | Where-Object { $_.Menu -eq $handle } | Select-Object -First 1 } 5
    $found
}
function CloseMenus { [System.Windows.Forms.SendKeys]::SendWait('{ESC}{ESC}'); Start-Sleep -Milliseconds 300 }
Add-Type -AssemblyName System.Windows.Forms

try {
    # --- Start ---
    $desktop = Start-Process $Exe -PassThru
    WaitUntil 'Desktop to listen' { Get-NetTCPConnection -LocalPort 57179 -State Listen -ErrorAction SilentlyContinue } | Out-Null
    WaitUntil 'the control pipe' { Pipes | Where-Object { $_ -eq $pipePath } } | Out-Null
    Log "started the release build (pid $($desktop.Id)): it listens on 127.0.0.1:57179 and holds $pipePath"

    # --- One Desktop at a time ---
    $second = Run @()
    Assert ($second.Code -eq 0) "a second launch exits cleanly ($($second.Code))"
    Assert ($second.Out -match 'already running') "and says so: $($second.Out)"
    Assert (@(Get-Process Parousia-Desktop | Where-Object { $_.Path -eq $Exe }).Count -eq 1) 'and there is still one Desktop'
    Log 'a second launch reports the running Desktop and exits; there is still one'

    # --- The CLI from a terminal, over the pipe ---
    $status = DesktopJson @('status')
    Assert ($status.result -eq 'status' -and $status.status.transport.address -eq '127.0.0.1:57179') 'status answers'
    Assert ($status.status.transport.sameUserCheck -eq $true) 'and says other OS users are refused'
    $text = Run @('status')
    Assert ($text.Out -match 'listening on 127.0.0.1:57179 \(other OS users refused\)') "the text form prints to the terminal: $($text.Out)"
    Assert ((DesktopJson @('set', 'userscripts', 'on')).status.settings.allowUserscripts -eq $true) 'set userscripts on'
    Assert ((DesktopJson @('set', 'userscripts', 'off')).status.settings.allowUserscripts -eq $false) 'set userscripts off'
    $origin = 'chrome-extension://' + ('a' * 32)
    Assert ((DesktopJson @('allow', $origin)).status.settings.allowedOrigins -contains $origin) 'allow adds an origin'
    Assert ((Get-Content (Join-Path $env:PAROUSIA_DATA_DIR 'config.json') -Raw) -match $origin) 'and saves it'
    Assert (-not ((DesktopJson @('disallow', $origin)).status.settings.allowedOrigins -contains $origin)) 'disallow removes it'
    $bad = Run @('allow', 'https://example.com', '--json')
    Assert ($bad.Code -ne 0 -and $bad.Out -match 'error') "a bad origin is an error ($($bad.Code)): $($bad.Out)"
    Log 'CLI over the control pipe: status (JSON and text), set, allow, disallow, and a bad origin refused'

    # --- The pipe is this user's alone ---
    $sddl = [System.IO.File]::GetAccessControl($pipePath).GetSecurityDescriptorSddlForm('Access')
    Assert ($sddl -match "^D:P\(A;;[A-Z]+;;;$([regex]::Escape($sid))\)$") "one entry, this user only, nothing inherited: $sddl"
    Log "the control pipe's access list is only this user ($sddl)"

    # --- The port can't be shared ---
    foreach ($reuse in $false, $true) {
        $socket = New-Object System.Net.Sockets.Socket('InterNetwork', 'Stream', 'Tcp')
        try {
            if ($reuse) { $socket.SetSocketOption('Socket', 'ReuseAddress', $true) }
            $socket.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Loopback, 57179)))
            throw "a second socket (reuse: $reuse) bound Desktop's port"
        } catch [System.Net.Sockets.SocketException] {
        } finally { $socket.Close() }
    }
    Log 'another program can bind 127.0.0.1:57179 neither plainly nor by asking to share it'

    # --- The tray ---
    $menu = OpenMenu
    $labels = @(MenuLabels $menu.Menu)
    foreach ($expected in 'Parousia Desktop', 'Running*', 'Diagnostics', 'Settings', 'Quit Parousia Desktop') {
        Assert ($labels | Where-Object { $_ -like $expected }) "the menu has '$expected': $($labels -join ' | ')"
    }
    $settingsLabels = @(MenuLabels ([Win.Native]::GetSubMenu($menu.Menu, (MenuIndex $menu.Menu 'Settings'))))
    foreach ($expected in 'Allow userscripts*', 'Debug logging*', 'Start at login') {
        Assert ($settingsLabels | Where-Object { $_ -like $expected }) "Settings has '$expected': $($settingsLabels -join ' | ')"
    }
    Log "the tray icon is in the notification area, and its menu has the status, Diagnostics, Settings ($($settingsLabels.Count) items), and Quit"

    # --- Start at login ---
    function StartupItem {
        $menu = OpenMenu
        $submenu = Submenu $menu (MenuIndex $menu.Menu 'Settings')
        $index = MenuIndex $submenu.Menu 'Start at login'
        [pscustomobject]@{ On = $submenu; Index = $index;
            Checked = (([Win.Native]::GetMenuState($submenu.Menu, $index, 0x400)) -band 0x8) -ne 0 }
    }
    CloseMenus
    $item = StartupItem
    Assert (-not $item.Checked) 'Start at login starts unchecked'
    Click $item.On $item.Index
    $entry = WaitUntil 'the Run entry' { (Get-ItemProperty $runKey -Name $runValue -ErrorAction SilentlyContinue).$runValue } 5
    Assert ($entry -eq "`"$Exe`"") "clicking it adds this exe to this user's Run key, quoted: $entry"
    $item = StartupItem
    Assert $item.Checked 'and the menu now shows it checked'
    Click $item.On $item.Index
    WaitUntil 'the Run entry to go' { -not (Get-ItemProperty $runKey -Name $runValue -ErrorAction SilentlyContinue).$runValue } 5 | Out-Null
    $item = StartupItem
    Assert (-not $item.Checked) 'clicking again removes it, and the menu shows it unchecked'
    CloseMenus
    Log 'Settings > Start at login adds and removes the real Run entry (quoted path), and the menu follows it'

    # --- Quit from the tray ---
    $menu = OpenMenu
    Click $menu (MenuIndex $menu.Menu 'Quit Parousia Desktop')
    WaitUntil 'Desktop to quit' { $desktop.Refresh(); $desktop.HasExited } 8 | Out-Null
    Assert ($desktop.ExitCode -eq 0) "Quit exits cleanly ($($desktop.ExitCode))"
    Assert (-not (Pipes | Where-Object { $_ -eq $pipePath })) 'the pipe is gone'
    Assert (-not (Get-NetTCPConnection -LocalPort 57179 -State Listen -ErrorAction SilentlyContinue)) 'the port is free'
    WaitUntil 'the tray icon to go' { -not (TrayIcon) } 8 | Out-Null
    Log 'Quit from the menu ends Desktop: the icon, the pipe, and the port are gone'

    # --- Something else on the port ---
    $holder = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 57179)
    $holder.Start()
    try {
        $blocked = Run @()
        Assert ($blocked.Code -ne 0) 'with the port taken, Desktop exits with an error'
        Assert (($blocked.Err + $blocked.Out) -match 'port 57179 is already in use') "and says which port and what to do: $($blocked.Err)"
        Assert (-not (Pipes | Where-Object { $_ -eq $pipePath })) 'and leaves no pipe behind'
    } finally { $holder.Stop() }
    Log 'with something else on the port, Desktop says so on stderr (a message box only where there is nowhere to print) and exits'

    Log 'done'
} finally {
    try { CloseMenus } catch { }
    if ($desktop -and -not $desktop.HasExited) { Stop-Process -Id $desktop.Id -Force }
    $current = (Get-ItemProperty $runKey -Name $runValue -ErrorAction SilentlyContinue).$runValue
    if ($current -and $current -ne $startupBefore) { Remove-ItemProperty $runKey -Name $runValue -ErrorAction SilentlyContinue }
    $env:PAROUSIA_DATA_DIR = $saved.data
    $env:PAROUSIA_DISCORD_IPC_PIPE = $saved.pipe
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
