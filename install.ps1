# =============================================================================
#  ais installer for Windows (Windows PowerShell 5.1 or PowerShell 7)
#
#    irm https://github.com/j-ts/ai-switcher/releases/latest/download/install.ps1 | iex
#
#  Installs (or updates) ais into %LOCALAPPDATA%\ais and puts its bin folder
#  on the user PATH. No admin rights, no git/Go/Node needed: ais fetches its
#  own pinned Node on first run and ships agm prebuilt.
#
#  Updating replaces the program files only; app\ (runtimes) and profiles\
#  (accounts, sessions, the agm store) are never touched.
#
#  Environment knobs:
#    AIS_HOME=<dir>          install location          (default %LOCALAPPDATA%\ais)
#    AIS_VERSION=<tag>       a specific release tag    (default: latest)
#    AIS_CHANNEL=nightly     newest build, prereleases included
#    AIS_ARCHIVE=<file|url>  install this zip instead of downloading
#    AIS_REPO=<owner/name>   release source            (default j-ts/ai-switcher)
#    AIS_NO_MODIFY_PATH=1    leave the user PATH alone
#    AIS_NO_BOOTSTRAP=1      do not fetch Node right away
# =============================================================================

function Install-Ais {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

    function Opt([string]$name, [string]$default) {
        $v = [Environment]::GetEnvironmentVariable($name)
        if ([string]::IsNullOrEmpty($v)) { return $default } else { return $v }
    }

    $repo    = Opt 'AIS_REPO' 'j-ts/ai-switcher'
    $aisHome = Opt 'AIS_HOME' (Join-Path $env:LOCALAPPDATA 'ais')
    $asset   = 'ais-windows-x64.zip'
    $binDir  = Join-Path $aisHome 'bin'

    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($arch -eq 'ARM64') { Write-Host 'Note: Windows on ARM runs the x64 build under emulation.' }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ais-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zip = Join-Path $tmp $asset
        $archive = Opt 'AIS_ARCHIVE' ''
        if ($archive) {
            if ($archive -match '^https?://') { Invoke-WebRequest -Uri $archive -OutFile $zip -UseBasicParsing }
            elseif (Test-Path -LiteralPath $archive) { Copy-Item -LiteralPath $archive -Destination $zip }
            else { throw "no such archive: $archive" }
            Write-Host "Installing ais from $archive"
        } else {
            $headers = @{ 'User-Agent' = 'ais-installer' }
            $tag = Opt 'AIS_VERSION' ''
            if (-not $tag -and (Opt 'AIS_CHANNEL' '') -ne 'nightly') {
                try { $tag = (Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers).tag_name } catch { $tag = '' }
            }
            if (-not $tag) {
                # No stable release yet (or nightly asked for): newest one, prereleases included.
                $all = @(Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=5" -Headers $headers)
                if ($all.Count -gt 0) { $tag = $all[0].tag_name }
            }
            if (-not $tag) { throw "no release found for $repo" }
            $base = "https://github.com/$repo/releases/download/$tag"
            Write-Host "Installing ais $tag (windows-x64)"
            Invoke-WebRequest -Uri "$base/$asset" -OutFile $zip -UseBasicParsing
            $sums = Join-Path $tmp 'SHA256SUMS'
            Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
            $want = (Get-Content $sums | Where-Object { ($_ -split '\s+')[1] -eq $asset } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
            if (-not $want) { throw "$asset is not listed in SHA256SUMS" }
            $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
            if ($got -ne $want.ToLower()) { throw "checksum mismatch for $asset (expected $want, got $got)" }
        }

        # Unpack, then replace program files - never app\ or profiles\.
        $x = Join-Path $tmp 'x'
        Expand-Archive -LiteralPath $zip -DestinationPath $x -Force
        $src = Join-Path $x 'ais'
        if (-not (Test-Path (Join-Path $src 'bin\ais.cmd'))) { throw 'archive does not look like an ais release' }
        New-Item -ItemType Directory -Force -Path $aisHome | Out-Null
        foreach ($item in Get-ChildItem -LiteralPath $src -Force) {
            if ($item.Name -in @('app', 'profiles')) { continue }
            $dst = Join-Path $aisHome $item.Name
            if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
            Move-Item -LiteralPath $item.FullName -Destination $dst
        }

        # Put bin\ on the user PATH (raw registry value, so %VARS% stay unexpanded).
        if (-not (Opt 'AIS_NO_MODIFY_PATH' '')) {
            $key = Get-Item 'HKCU:\Environment'
            $raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
            $parts = @($raw -split ';' | Where-Object { $_ })
            $present = $parts | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }
            if (-not $present) {
                Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Type ExpandString -Value ((@($parts) + $binDir) -join ';')
                # Setting a variable through .NET broadcasts WM_SETTINGCHANGE, so new
                # terminals see the PATH change; AIS_HOME also records where ais lives.
                [Environment]::SetEnvironmentVariable('AIS_HOME', $aisHome, 'User')
            }
            if (($env:Path -split ';') -notcontains $binDir) { $env:Path = "$binDir;$env:Path" }
        }

        $version = ''
        if (-not (Opt 'AIS_NO_BOOTSTRAP' '')) {
            $version = (& (Join-Path $binDir 'ais.cmd') --version) | Select-Object -Last 1
        }
        Write-Host ''
        Write-Host ("ais installed in $aisHome" + $(if ($version) { " ($version)" } else { '' }))
        Write-Host 'Open a new terminal if `ais` is not found yet.'
        Write-Host ''
        Write-Host 'Next:  ais setup'
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Ais
