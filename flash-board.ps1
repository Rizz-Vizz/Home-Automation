param(
    [switch]$Build,
    [string]$Device = "MCXN236:FRDM-MCXN236",
    [string]$LinkServer = $(if ($env:LINKSERVER_PATH) { $env:LINKSERVER_PATH } else { "C:\nxp\LinkServer_26.9.130\LinkServer.exe" })
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$FwDir = Join-Path $Root "firmware"
$ElfPath = Join-Path $FwDir "debug\elly_edge_fw.elf"

if ($Build) {
    Push-Location $FwDir
    try {
        cmake --preset debug
        if ($LASTEXITCODE -ne 0) { throw "CMake configure failed." }
        cmake --build --preset debug
        if ($LASTEXITCODE -ne 0) { throw "Firmware build failed." }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $ElfPath)) {
    throw "Firmware ELF not found at $ElfPath. Re-run with -Build."
}

if (-not (Test-Path $LinkServer)) {
    throw "LinkServer executable not found at $LinkServer."
}

$mi00Keys = Get-ChildItem "HKLM:\SYSTEM\CurrentControlSet\Enum\USB\VID_1FC9&PID_0143&MI_00" -ErrorAction SilentlyContinue
$hasGuid = $false
foreach ($k in $mi00Keys) {
    $dp = Get-ItemProperty "$($k.PSPath)\Device Parameters" -ErrorAction SilentlyContinue
    if ($dp -and ($dp.DeviceInterfaceGUIDs -or $dp.DeviceInterfaceGUID)) {
        $hasGuid = $true
        break
    }
}

if (-not $hasGuid) {
    Write-Warning "Windows WinUSB MI_00 for MCU-LINK (VID_1FC9&PID_0143) lacks DeviceInterfaceGUIDs."
    Write-Warning "LinkServer/libusb may report 'Error: Probe not open' / 'Ee(42). Could not connect to core'."
    Write-Warning "Fix in an Administrator PowerShell (no firmware changes to MCU-Link):"
    Write-Warning "  1. Try plugging the J17 USB cable into a different USB port, OR uninstall/re-scan 'MCU-LINK FRDM-MCXN236 CMSIS-DAP' in Device Manager."
    Write-Warning "  2. Or register the CMSIS-DAP v2 GUID ({cdb3b5ad-293b-4663-aa36-1aae46463776}) in Device Parameters and replug."
}

Write-Host "Flashing $ElfPath onto $Device using LinkServer (-u none preserves MCU-Link probe firmware)..."
& $LinkServer flash -u none $Device load $ElfPath
exit $LASTEXITCODE
