# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包脚本：MOSS Layout Studio 桌面版（pywebview + 系统 WebView2）。

    python -m PyInstaller --noconfirm --clean packaging/moss-layout-studio.spec

产物：dist/MOSS-Layout-Studio.exe —— 双击出一个应用窗口，没有控制台、没有浏览器。
数据在 %LOCALAPPDATA%\\MossLayoutStudio\\data，日志在同目录 logs/app.log。
"""

from pathlib import Path

ROOT = Path(SPECPATH).parent  # noqa: F821 - SPECPATH 由 PyInstaller 注入
PACKAGING = ROOT / "packaging"

datas = [
    (str(ROOT / "web"), "web"),
    (str(ROOT / "assets"), "assets"),
]

a = Analysis(
    [str(ROOT / "desktop.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "clr",
        "webview.platforms.winforms",
        "webview.platforms.edgechromium",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "tkinter", "unittest", "doctest", "pydoc", "test", "lib2to3",
        "setuptools", "pip", "wheel", "pydoc_data",
        "webview.platforms.gtk", "webview.platforms.qt", "webview.platforms.cef",
        "webview.platforms.android",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="MOSS-Layout-Studio",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # 桌面软件：不要黑框
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(PACKAGING / "icon.ico") if (PACKAGING / "icon.ico").exists() else None,
    version=str(PACKAGING / "version_info.txt") if (PACKAGING / "version_info.txt").exists() else None,
)
