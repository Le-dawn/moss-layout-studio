#!/usr/bin/env bash
# 在 WSL 里交叉打 Windows exe：调 Windows 版 Python + PyInstaller，产物落到 dist/。
#
#   packaging/build_exe.sh              # 自动找 Windows python
#   WIN_PY='D:\software\python\python.exe' packaging/build_exe.sh
#
# 为什么不用 Linux 的 PyInstaller：那样出来的是 ELF，不是 exe。
# 这里全程用 Windows 解释器，只是代码放在 WSL 的文件系统上（走 \\wsl.localhost）。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v wslpath >/dev/null 2>&1; then
    echo "这个脚本要在 WSL 里跑；纯 Windows 请用 packaging\\build_exe.ps1" >&2
    exit 1
fi

WIN_PY="${WIN_PY:-}"
if [[ -z "$WIN_PY" ]]; then
    WIN_PY="$(cmd.exe /c "where python" 2>/dev/null | tr -d '\r' | head -n1 || true)"
fi
if [[ -z "$WIN_PY" || ! -x "$WIN_PY" ]]; then
    echo "找不到 Windows python.exe，用 WIN_PY=D:\\path\\to\\python.exe 指定" >&2
    exit 1
fi
echo "-> Windows Python: $WIN_PY"

WIN_ROOT="$(wslpath -m "$ROOT")"
WIN_TMP="$(wslpath -m "$ROOT/.build/tmp")"
mkdir -p "$ROOT/.build/tmp"

VENV="$ROOT/.build/venv"
if [[ ! -x "$VENV/Scripts/python.exe" ]]; then
    echo "-> 创建构建 venv: $VENV"
    "$WIN_PY" -m venv --copies "$WIN_ROOT/.build/venv"
    # Windows 上建出来的 exe 在 WSL 里默认没有执行位
    chmod +x "$VENV"/Scripts/*.exe 2>/dev/null || true
fi

echo "-> 安装 / 更新 打包依赖"
"$VENV/Scripts/python.exe" -m pip install --disable-pip-version-check --quiet --upgrade pip
"$VENV/Scripts/python.exe" -m pip install --disable-pip-version-check --quiet \
    -r "$WIN_ROOT/packaging/requirements-build.txt"

echo "-> 打包"
# 在 C:\ 下执行，避免 Windows 侧 cwd 是 UNC 路径；TEMP 指回 WSL，少写 C 盘。
(
    cd /mnt/c
    TEMP="$WIN_TMP" TMP="$WIN_TMP" "$VENV/Scripts/python.exe" -m PyInstaller \
        --noconfirm --clean \
        --distpath "$WIN_ROOT/dist" \
        --workpath "$WIN_ROOT/.build/pyinstaller" \
        "$WIN_ROOT/packaging/moss-layout-studio.spec"
)

EXE="$ROOT/dist/MOSS-Layout-Studio.exe"
if [[ ! -f "$EXE" ]]; then
    echo "没有看到产物：$EXE" >&2
    exit 1
fi
echo "-> 完成：$EXE ($(du -h "$EXE" | cut -f1))"
