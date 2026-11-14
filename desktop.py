#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MOSS Layout Studio 桌面版入口：pywebview 窗口 + 系统 WebView2。

- 没有浏览器标签页、没有控制台窗口：双击就一个应用窗口。
- 后端还是 server.py 那套 HTTP 服务，但只绑 127.0.0.1 上由系统分配的临时端口，
  窗口自己用；窗口关闭、进程退出，端口随之消失，也不对外开放。
- 再双击一次不会开第二个，直接把已有窗口调到前台。
- 日志写到 %LOCALAPPDATA%\\MossLayoutStudio\\logs\\app.log。
"""

from __future__ import annotations

import ctypes
import os
import sys
import threading
import time
import traceback
from pathlib import Path

import webview

import server as server_mod
from moss import __version__

APP_TITLE = "MOSS Layout Studio"
MUTEX_NAME = "Local\\MossLayoutStudio.Desktop"
ERROR_ALREADY_EXISTS = 183
SW_RESTORE = 9


# ── 路径与日志 ────────────────────────────────────────────────────────────

def app_home():
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "MossLayoutStudio"


def redirect_output(log_path):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if log_path.exists() and log_path.stat().st_size > 2 * 1024 * 1024:
            log_path.replace(log_path.with_name("app.1.log"))
    except OSError:
        pass
    stream = open(log_path, "a", encoding="utf-8", errors="replace", buffering=1)
    sys.stdout = stream
    sys.stderr = stream


def message_box(text, title=APP_TITLE, icon=0x10):
    try:
        ctypes.windll.user32.MessageBoxW(None, str(text), title, icon | 0x40000)
    except Exception:  # noqa: BLE001 - 连弹窗都失败就只能写日志
        pass


# ── 单实例 ────────────────────────────────────────────────────────────────

_mutex_handle = None


def acquire_single_instance():
    global _mutex_handle
    kernel32 = ctypes.windll.kernel32
    _mutex_handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    return kernel32.GetLastError() != ERROR_ALREADY_EXISTS


def focus_existing_window(timeout=3.0):
    """第二个实例：找到已开的窗口，把它抬到前面然后退出。"""
    user32 = ctypes.windll.user32
    deadline = time.time() + timeout
    while time.time() < deadline:
        hwnd = user32.FindWindowW(None, APP_TITLE)
        if hwnd:
            user32.ShowWindow(hwnd, SW_RESTORE)
            user32.SetForegroundWindow(hwnd)
            return True
        time.sleep(0.15)
    return False


# ── 窗口 ↔ 页面 的桥 ──────────────────────────────────────────────────────

def safe_filename(name):
    name = os.path.basename(str(name or "MOSS-layout.txt"))
    name = "".join(ch for ch in name if ch not in '\\/:*?"<>|').strip()
    return name or "MOSS-layout.txt"


_WINDOW = None


class Bridge:
    """页面调用 window.pywebview.api.*：原生「另存为」、剪贴板兜底。

    注意别把 window 挂成 Bridge 的属性：pywebview 会遍历 js_api 对象的属性，
    碰到窗口对象就会顺着 .native 一路序列化下去（日志里刷一堆 recursion 错误）。
    """

    def save_text(self, filename, text):
        if _WINDOW is None:
            return ""
        name = safe_filename(filename)
        try:
            dialog_type = getattr(getattr(webview, "FileDialog", None), "SAVE", None)
            if dialog_type is None:  # pywebview < 5
                dialog_type = webview.SAVE_DIALOG
            result = _WINDOW.create_file_dialog(
                dialog_type,
                save_filename=name,
                file_types=("Text (*.txt)", "JSON (*.json)", "All files (*.*)"),
            )
        except Exception:  # noqa: BLE001
            return ""
        path = result[0] if isinstance(result, (list, tuple)) and result else result
        if not path:
            return ""
        try:
            Path(path).write_text(str(text), encoding="utf-8")
        except OSError as error:
            message_box("文件写不进去：%s" % error)
            return ""
        return str(path)

    def copy_text(self, text):
        """Win32 剪贴板；页面里的 navigator.clipboard 失败时兜底。"""
        data = str(text or "")
        kernel32 = ctypes.windll.kernel32
        user32 = ctypes.windll.user32
        kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
        kernel32.GlobalAlloc.restype = ctypes.c_void_p
        kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
        kernel32.GlobalLock.restype = ctypes.c_void_p
        kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
        kernel32.GlobalUnlock.restype = ctypes.c_int
        user32.OpenClipboard.argtypes = [ctypes.c_void_p]
        user32.OpenClipboard.restype = ctypes.c_int
        user32.EmptyClipboard.restype = ctypes.c_int
        user32.CloseClipboard.restype = ctypes.c_int
        user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
        user32.SetClipboardData.restype = ctypes.c_void_p

        if not user32.OpenClipboard(None):
            return False
        try:
            user32.EmptyClipboard()
            size = (len(data) + 1) * ctypes.sizeof(ctypes.c_wchar)
            handle = kernel32.GlobalAlloc(0x0002, size)  # GMEM_MOVEABLE
            if not handle:
                return False
            pointer = kernel32.GlobalLock(handle)
            if not pointer:
                return False
            ctypes.memmove(pointer, ctypes.create_unicode_buffer(data), size)
            kernel32.GlobalUnlock(handle)
            return bool(user32.SetClipboardData(13, handle))  # CF_UNICODETEXT
        finally:
            user32.CloseClipboard()

    def app_info(self):
        return {"version": __version__, "title": APP_TITLE, "desktop": True}


# ── 启动 ──────────────────────────────────────────────────────────────────

def run():
    home = app_home()
    redirect_output(home / "logs" / "app.log")

    if not acquire_single_instance():
        focus_existing_window()
        return 0

    data_dir = home / "data"
    # 临时端口：由系统分配，只给这个窗口用，不占固定端口、不对外开放
    server, port = server_mod.create_app(str(data_dir), "127.0.0.1", 0)
    threading.Thread(target=server.serve_forever, name="moss-http", daemon=True).start()
    url = "http://127.0.0.1:%d/" % port
    print("[%s] window → %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), url))

    global _WINDOW
    window = webview.create_window(
        APP_TITLE,
        url,
        width=1280,
        height=860,
        min_size=(960, 640),
        background_color="#0f1216",
        js_api=Bridge(),
    )
    _WINDOW = window

    try:
        webview.start(
            private_mode=False,
            storage_path=str(home / "webview"),
            debug=False,
        )
    finally:
        server.shutdown()
        server.server_close()
        print("[%s] closed" % time.strftime("%Y-%m-%d %H:%M:%S"))
    return 0


def main():
    try:
        return run()
    except Exception as error:  # noqa: BLE001 - GUI 版没有控制台，得弹给人看
        traceback.print_exc()
        text = str(error)
        if "WebView2" in text or "webview2" in text.lower():
            text += ("\n\n这台机器缺少 Microsoft Edge WebView2 运行时。\n"
                     "安装后重开即可：https://go.microsoft.com/fwlink/p/?LinkId=2124703")
        message_box(text)
        return 1


if __name__ == "__main__":
    sys.exit(main())
