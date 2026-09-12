param([switch]$Build)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$cargoDirectory = Join-Path $projectRoot '.toolchains\cargo'
if (Test-Path (Join-Path $cargoDirectory 'bin\cargo.exe')) {
    $env:CARGO_HOME = $cargoDirectory
    $env:RUSTUP_HOME = Join-Path $projectRoot '.toolchains\rustup'
    $env:PATH = "$cargoDirectory\bin;$env:PATH"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Rust MSVC toolchain and Visual Studio C++ Build Tools are required.' }
if (-not $env:TURBOPUSH_BROWSER_CHANNEL -and (Test-Path 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')) {
    $env:TURBOPUSH_BROWSER_CHANNEL = 'msedge'
}
# Keep this development workspace's authenticated accounts available in native mode too.
if (-not $env:TURBOPUSH_DATA_DIR) { $env:TURBOPUSH_DATA_DIR = Join-Path $projectRoot '.data' }
Push-Location $projectRoot
try {
    if ($Build) {
        pnpm build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend or engine build failed.' }
        cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
    } else { pnpm desktop:raw }
    if ($LASTEXITCODE -ne 0) { throw 'Desktop command failed.' }
} finally { Pop-Location }
