# 在 Windows 上打包 MOSS Layout Studio：建一个构建用 venv，装 PyInstaller，产出单文件 exe。
#
#   powershell -ExecutionPolicy Bypass -File packaging\build_exe.ps1
#
# 需要 Python 3.10+（py launcher 或 PATH 里的 python）。

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Venv = Join-Path $Root ".build\venv"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path $Python)) {
    Write-Host "-> 创建构建 venv: $Venv"
    $Base = "python"
    if (-not (Get-Command $Base -ErrorAction SilentlyContinue)) { $Base = "py" }
    & $Base -m venv $Venv
}
if (-not (Test-Path $Python)) { throw "venv 创建失败：$Python" }

Write-Host "-> 安装 / 更新 打包依赖"
& $Python -m pip install --disable-pip-version-check --quiet --upgrade pip
& $Python -m pip install --disable-pip-version-check --quiet -r (Join-Path $Root "packaging\requirements-build.txt")

Push-Location $Root
try {
    Write-Host "-> 打包"
    & $Python -m PyInstaller --noconfirm --clean "packaging\moss-layout-studio.spec"
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller 退出码 $LASTEXITCODE" }
}
finally {
    Pop-Location
}

$Exe = Join-Path $Root "dist\MOSS-Layout-Studio.exe"
if (-not (Test-Path $Exe)) { throw "没有看到产物：$Exe" }
$Size = [math]::Round((Get-Item $Exe).Length / 1MB, 1)
Write-Host "-> 完成：$Exe ($Size MB)"
