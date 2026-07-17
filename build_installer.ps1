# Build the 360VideoConverter installer in this sandbox.
#
# Why a separate installer.build.iss?
#   installer.iss is the canonical script for machines that have a FULL Inno
#   Setup 6 installation (it uses WizardStyle=modern). The Inno Setup compiler
#   bundle we fetch at build time (node-innosetup-compiler) ships only the
#   "classic" wizard bitmaps, so it cannot build a modern-wizard installer.
#   installer.build.iss is therefore a classic-wizard variant of installer.iss
#   used by this build script. Keep installer.iss pristine for full installs.
#
# The compiler (ISCC.exe + support files) is NOT committed to git (see
# .gitignore: "Binaries & large downloads, fetched at build time"). This script
# auto-bootstraps it on first run, so a fresh clone can rebuild with one command:
#
#     .\build_installer.ps1
#
# Run from the repo root.
$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$isccDir = Join-Path $root 'build_tools\iscc'
$iscc    = Join-Path $isccDir 'ISCC.exe'
$script  = Join-Path $root 'installer.build.iss'

# ── Bootstrap the Inno Setup 6 compiler if it is missing ──────────────────────
if (-not (Test-Path $iscc)) {
    Write-Host "ISCC not found at '$iscc' -- bootstrapping Inno Setup 6.3.1 compiler bundle ..." -ForegroundColor Yellow
    $tmp  = Join-Path $env:TEMP ("iscc_bootstrap_" + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Force -Path $tmp
    try {
        $tarUrl  = 'https://codeload.github.com/felicienfrancois/node-innosetup-compiler/tar.gz/master'
        $tarPath = Join-Path $tmp 'iscc.tar.gz'
        Write-Host "  downloading $tarUrl"
        Invoke-WebRequest -Uri $tarUrl -OutFile $tarPath -UseBasicParsing
        Write-Host '  extracting ...'
        tar -xzf $tarPath -C $tmp
        $binSrc = Join-Path $tmp 'node-innosetup-compiler-master\bin'
        if (-not (Test-Path $binSrc)) { throw "Bootstrap failed: bin/ not found in tarball." }
        $null = New-Item -ItemType Directory -Force -Path $isccDir
        Copy-Item -Recurse -Force (Join-Path $binSrc '*') $isccDir
        if (-not (Test-Path $iscc)) { throw "Bootstrap failed: ISCC.exe not produced." }
        Write-Host "  ISCC bootstrapped to $isccDir" -ForegroundColor Green
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path $script)) { Write-Error "Build script not found at '$script'." }

Write-Host "Compiling $script ..."
& $iscc $script
if ($LASTEXITCODE -ne 0) { Write-Error "ISCC failed (exit $LASTEXITCODE)" }

$ver = (Get-Content (Join-Path $root 'VERSION')).Trim()
$out = Join-Path $root "installer_output\360VideoConverter_Setup_$ver.exe"
if (Test-Path $out) { Write-Host "Done -> $out" -ForegroundColor Green }
else { Write-Error "Expected output not found: $out" }
