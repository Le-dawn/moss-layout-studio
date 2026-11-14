#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MOSS Layout Studio 服务端。

    python3 server.py                # http://127.0.0.1:8480
    python3 server.py --port 9000 --host 0.0.0.0

零第三方依赖：标准库 http.server + sqlite3。

打包成单文件 exe 后（见 packaging/），双击即启动并自动打开浏览器：
静态资源从 PyInstaller 的解包目录读，数据写在 exe 同级的 data/，
exe 所在目录不可写时退回 %LOCALAPPDATA%\\MossLayoutStudio\\data。
"""

from __future__ import annotations

import argparse
import base64
import errno
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from moss import __version__, spec
from moss.store import Store

FROZEN = bool(getattr(sys, "frozen", False))
# 源码运行时资源与 exe 同级；打包后 web/ assets/ 在 PyInstaller 的临时解包目录里。
BASE_DIR = Path(__file__).resolve().parent
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", BASE_DIR))
APP_DIR = Path(sys.executable).resolve().parent if FROZEN else BASE_DIR
WEB_DIR = RESOURCE_DIR / "web"
ASSETS_DIR = RESOURCE_DIR / "assets"


def is_network_path(path):
    """UNC（\\\\server\\share、\\\\wsl.localhost\\...）——SQLite 在上面加锁不可靠。"""
    return str(path).startswith(("\\\\", "//"))


def local_app_data():
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "MossLayoutStudio" / "data"


def default_data_dir():
    """exe 旁边能写就写 exe 旁边（绿色版），否则退回用户目录。

    从共享目录启动（比如直接在资源管理器里双击 \\\\wsl.localhost 下的 exe）时，
    SQLite 放在 9p/SMB 上会报 database is locked，所以直接换到本地目录。
    """
    if not FROZEN:
        return BASE_DIR / "data"
    if is_network_path(APP_DIR):
        return local_app_data()
    portable = APP_DIR / "data"
    try:
        portable.mkdir(parents=True, exist_ok=True)
        probe = portable / ".writable"
        probe.write_text("", encoding="utf-8")
        probe.unlink()
        return portable
    except OSError:
        return local_app_data()


DEFAULT_DATA = None  # main() 里才决定，避免 --help 也去建目录
MAX_BODY = 24 * 1024 * 1024
MAX_IMAGE = 12 * 1024 * 1024
IMAGE_TYPES = {
    "image/png": (".png", b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": (".jpg", b"\xff\xd8\xff"),
    "image/webp": (".webp", b"RIFF"),
}

STORE: Store | None = None


# ── 错误 ──────────────────────────────────────────────────────────────────

class ApiError(Exception):
    def __init__(self, message, status=400, **extra):
        super().__init__(message)
        self.message = message
        self.status = status
        self.extra = extra


# ── 工具 ──────────────────────────────────────────────────────────────────

def public_layout(record):
    """editor 用合并后的文档：旧数据的中文参考会并进 caption。"""
    if not record:
        return None
    doc = spec.merge_notes(record["doc"], record.get("notes") or {})
    return {
        "id": record["id"],
        "name": record["name"],
        "doc": doc,
        "image": bool(record.get("image")),
        "image_name": record.get("image_name") or "",
        "rev": record["rev"],
        "created_at": record["created_at"],
        "updated_at": record["updated_at"],
    }


def clean_name(value, fallback="未命名画布"):
    name = re.sub(r"\s+", " ", str(value or "")).strip()
    return name[:80] or fallback


def normalize_new_doc(body):
    if body.get("doc") is not None:
        doc, warnings = spec.normalize_doc(body["doc"], body.get("width"), body.get("height"))
        doc = spec.merge_notes(doc, body.get("notes") or {})
        return doc, warnings
    width = spec._as_int(body.get("width"), 1152) or 1152
    height = spec._as_int(body.get("height"), 1536) or 1536
    width = max(16, min(spec.MAX_CANVAS, spec._round_half_up(width / 16) * 16))
    height = max(16, min(spec.MAX_CANVAS, spec._round_half_up(height / 16) * 16))
    return spec.blank_doc(width, height), []


def parse_data_url(data_url):
    match = re.fullmatch(r"data:(image/[a-z+.-]+);base64,(.+)", str(data_url or ""), re.S)
    if not match:
        raise ApiError("底图必须是 data:image/...;base64 形式")
    mime, payload = match.group(1), match.group(2)
    if mime not in IMAGE_TYPES:
        raise ApiError("只支持 PNG / JPEG / WebP 底图")
    if len(payload) > MAX_IMAGE * 1.4:
        raise ApiError("图片太大了（上限 12MB）", 413)
    try:
        raw = base64.b64decode(payload, validate=True)
    except (ValueError, TypeError):
        raise ApiError("图片数据不是合法的 base64")
    if len(raw) > MAX_IMAGE:
        raise ApiError("图片太大了（上限 12MB）", 413)
    ext, magic = IMAGE_TYPES[mime]
    if not raw.startswith(magic):
        raise ApiError("图片内容和扩展名对不上")
    return raw, ext


# ── 路由 ──────────────────────────────────────────────────────────────────

def api_index():
    return {
        "name": "MOSS Layout Studio",
        "version": __version__,
        "docs": "https://github.com/swan7-py/json-prompt-visualizer",
        "endpoints": [
            {"method": "GET", "path": "/api/layouts", "desc": "列出所有布局草稿"},
            {"method": "POST", "path": "/api/layouts", "desc": "新建：{name, width, height} 或 {name, doc}"},
            {"method": "GET", "path": "/api/layouts/{id}", "desc": "读取一份草稿"},
            {"method": "PUT", "path": "/api/layouts/{id}", "desc": "保存：{doc, rev, force?}；rev 不一致返回 409"},
            {"method": "DELETE", "path": "/api/layouts/{id}", "desc": "删除"},
            {"method": "POST", "path": "/api/layouts/{id}/duplicate", "desc": "复制一份"},
            {"method": "POST", "path": "/api/layouts/{id}/image", "desc": "上传底图：{data_url}"},
            {"method": "DELETE", "path": "/api/layouts/{id}/image", "desc": "移除底图"},
            {"method": "GET", "path": "/api/layouts/{id}/image", "desc": "读取底图"},
            {"method": "POST", "path": "/api/import", "desc": "导入：{name, json, width?, height?}"},
            {"method": "POST", "path": "/api/compile", "desc": "编译：{doc, klein?} → MOSS / 草稿 / Klein + 校验"},
            {"method": "GET", "path": "/api/example", "desc": "示例草稿"},
            {"method": "GET", "path": "/api/health", "desc": "健康检查"},
        ],
    }


def route(method, path, body, query):
    if path == "/api" or path == "/api/":
        return api_index()
    if path == "/api/health":
        return {"ok": True, "version": __version__, "data": str(STORE.root)}

    if path == "/api/layouts":
        if method == "GET":
            return {"layouts": STORE.list_layouts()}
        if method == "POST":
            doc, warnings = normalize_new_doc(body)
            name = clean_name(body.get("name"))
            record = STORE.create(name, doc["width"], doc["height"], *spec.split_notes(doc))
            return {"layout": public_layout(record), "warnings": warnings}

    if path == "/api/import" and method == "POST":
        raw = body.get("json")
        if raw is None:
            raise ApiError("缺少 json 字段")
        doc, warnings = spec.normalize_doc(raw, body.get("width"), body.get("height"))
        doc = spec.merge_notes(doc, body.get("notes") or {})
        name = clean_name(body.get("name"), "导入的草稿")
        record = STORE.create(name, doc["width"], doc["height"], *spec.split_notes(doc))
        return {"layout": public_layout(record), "warnings": warnings}

    if path == "/api/compile" and method == "POST":
        if body.get("doc") is None:
            raise ApiError("缺少 doc")
        doc, _ = spec.normalize_doc(body["doc"], body.get("width"), body.get("height"))
        doc = spec.merge_notes(doc, body.get("notes") or {})
        # lang 只为兼容旧调用保留，编译只认唯一的 caption
        result = spec.compile_all(doc, "en", body.get("klein") or {})
        result["overlaps"] = spec.overlaps_payload(doc)
        return result

    if path == "/api/example" and method == "GET":
        draft = json.loads((ASSETS_DIR / "example.draft.json").read_text(encoding="utf-8"))
        doc, _ = spec.normalize_doc(draft)
        return {"name": "晨间手冲 · 示例", "doc": doc}

    match = re.fullmatch(r"/api/layouts/(\d+)", path)
    if match:
        layout_id = int(match.group(1))
        if method == "GET":
            record = STORE.get(layout_id)
            if not record:
                raise ApiError("这份草稿不存在", 404)
            return {"layout": public_layout(record)}
        if method == "PUT":
            record = STORE.get(layout_id)
            if not record:
                raise ApiError("这份草稿不存在", 404)
            doc = None
            warnings = []
            if body.get("doc") is not None:
                normalized, warnings = spec.normalize_doc(body["doc"], body.get("width"),
                                                          body.get("height"))
                normalized = spec.merge_notes(normalized, body.get("notes") or {})
                doc, notes = spec.split_notes(normalized)
            else:
                notes = None
            name = clean_name(body["name"]) if body.get("name") is not None else None
            updated, error = STORE.update(
                layout_id, doc=doc, notes=notes, name=name,
                rev=body.get("rev"), force=bool(body.get("force")),
            )
            if error == "conflict":
                raise ApiError("这份草稿在别处被改过", 409, current_rev=record["rev"])
            if error == "not_found":
                raise ApiError("这份草稿不存在", 404)
            return {"layout": public_layout(updated), "warnings": warnings}
        if method == "DELETE":
            if not STORE.delete(layout_id):
                raise ApiError("这份草稿不存在", 404)
            return {"ok": True}

    match = re.fullmatch(r"/api/layouts/(\d+)/duplicate", path)
    if match and method == "POST":
        record = STORE.duplicate(int(match.group(1)))
        if not record:
            raise ApiError("这份草稿不存在", 404)
        return {"layout": public_layout(record)}

    match = re.fullmatch(r"/api/layouts/(\d+)/image", path)
    if match:
        layout_id = int(match.group(1))
        record = STORE.get(layout_id)
        if not record:
            raise ApiError("这份草稿不存在", 404)
        if method == "POST":
            raw, ext = parse_data_url(body.get("data_url"))
            filename = f"{layout_id}-{int(time.time() * 1000)}{ext}"
            target = Path(STORE.upload_dir) / filename
            target.write_bytes(raw)
            STORE.set_image(layout_id, filename, clean_name(body.get("name"), "底图"))
            return {"ok": True, "image": True, "image_name": body.get("name") or ""}
        if method == "DELETE":
            STORE.clear_image(layout_id)
            return {"ok": True, "image": False}
        if method == "GET":
            image_path = STORE.image_path(layout_id)
            if not image_path:
                raise ApiError("没有底图", 404)
            return {"__file__": image_path}

    raise ApiError(f"没有这个接口：{method} {path}", 404)


# ── HTTP ──────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = f"MossLayoutStudio/{__version__}"
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        try:
            parsed = urlsplit(self.path)
            path = unquote(parsed.path)
            if path.startswith("/api"):
                body = self.read_body() if method in ("POST", "PUT", "PATCH") else {}
                result = route(method, path, body, parsed.query)
                if isinstance(result, dict) and "__file__" in result:
                    self.send_file(result["__file__"], cache="private, max-age=60")
                else:
                    self.send_json(result)
            elif method == "GET":
                self.serve_static(path)
            else:
                raise ApiError("不支持的请求", 405)
        except ApiError as error:
            self.send_json({"error": error.message, **error.extra}, error.status)
        except BrokenPipeError:
            pass
        except Exception as error:  # noqa: BLE001
            traceback.print_exc()
            self.send_json({"error": f"服务器内部错误：{error}"}, 500)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError("请求体太大", 413)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError("请求体不是合法 JSON")
        if not isinstance(body, dict):
            raise ApiError("请求体必须是 JSON 对象")
        return body

    def send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def send_file(self, file_path, cache="no-cache"):
        path = Path(file_path)
        if not path.exists():
            raise ApiError("文件不存在", 404)
        raw = path.read_bytes()
        mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def serve_static(self, path):
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (WEB_DIR / relative).resolve()
        try:
            target.relative_to(WEB_DIR.resolve())
        except ValueError:
            raise ApiError("路径不合法", 403)
        if target.is_dir():
            target = target / "index.html"
        if not target.exists() or not target.is_file():
            if "." not in relative:
                target = WEB_DIR / "index.html"
            else:
                raise ApiError("找不到文件", 404)
        self.send_file(target, cache="no-cache")

    def log_message(self, fmt, *args):
        _note("  %s %s\n" % (self.command, self.path))


# ── 启动 ──────────────────────────────────────────────────────────────────

class StudioServer(ThreadingHTTPServer):
    """Windows 的 SO_REUSEADDR 允许两个进程绑同一个端口（互相抢连接），
    所以 Windows 上改成独占绑定：端口被占就让 bind 报错，主流程顺延到下一个。"""

    daemon_threads = True
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            except OSError:
                pass
        super().server_bind()


def bind_server(host, port, attempts=20):
    """绑定端口；port=0 时由系统分配（桌面版就用这个）。"""
    for offset in range(max(1, attempts)):
        candidate = port + offset
        try:
            server = StudioServer((host, candidate), Handler)
            return server, server.server_address[1]
        except OSError as error:
            busy = getattr(error, "winerror", None) == 10048 or error.errno in (
                errno.EADDRINUSE, 10048,
            )
            if not busy:
                raise
            _note("  端口 %d 被占用，换一个\n" % candidate)
    raise SystemExit("端口 %d–%d 都被占用了，用 --port 指定别的端口" % (port, port + attempts - 1))


def create_app(data_dir, host="127.0.0.1", port=0, attempts=20):
    """建好 store 并绑定端口，返回 (server, 实际端口)。CLI 和桌面版共用。"""
    global STORE
    try:
        STORE = Store(data_dir)
    except Exception as error:  # noqa: BLE001 - 数据目录问题要给人话
        message = "数据目录用不了：%s\n  %s" % (Path(data_dir), error)
        if is_network_path(data_dir):
            message += ("\n  这个路径在网络共享上，SQLite 加锁不可靠；"
                        "\n  换成本地目录再试，例如 --data C:\\MossData")
        raise RuntimeError(message) from error
    return bind_server(host, port, attempts)


def _note(text):
    """控制台被关掉（GUI 版）时写日志可能没人接手，能写就写。"""
    stream = sys.stderr
    if stream is None:
        return
    try:
        stream.write(text)
        stream.flush()
    except (OSError, ValueError):
        pass


def running_instance(host, port):
    """这个端口上是不是已经有一个本程序在跑？双击第二次时直接开它的页面。"""
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    url = "http://%s:%d/api/health" % (probe_host, port)
    try:
        with urllib.request.urlopen(url, timeout=0.8) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return bool(payload.get("ok")) and "MossLayoutStudio" in response.headers.get("Server", "")
    except Exception:  # noqa: BLE001 - 连不上就是没有实例
        return False


def open_browser_later(url, delay=0.7):
    timer = threading.Timer(delay, lambda: webbrowser.open(url))
    timer.daemon = True
    timer.start()


def main(argv=None):
    global STORE
    parser = argparse.ArgumentParser(
        prog="MOSS Layout Studio",
        description="MOSS Layout Studio 服务（零第三方依赖，双击 exe 也能直接跑）",
    )
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"),
                        help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8480")),
                        help="监听端口，默认 8480；被占用会自动往后顺延")
    parser.add_argument("--data", default=None,
                        help="数据目录，默认 exe 同级 data/（不可写时用 %%LOCALAPPDATA%%）")
    parser.add_argument("--open", dest="open_browser", action="store_true", default=None,
                        help="启动后自动打开浏览器（打包版默认开启）")
    parser.add_argument("--no-open", dest="open_browser", action="store_false",
                        help="启动后不打开浏览器")
    parser.add_argument("--force", action="store_true",
                        help="端口上已有实例时也照样再起一个")
    parser.add_argument("--version", action="version", version="MOSS Layout Studio %s" % __version__)
    args = parser.parse_args(argv)

    data_dir = args.data or os.environ.get("MOSS_DATA_DIR") or str(default_data_dir())
    should_open = FROZEN if args.open_browser is None else args.open_browser

    if not args.force and running_instance(args.host, args.port):
        probe_host = "127.0.0.1" if args.host in ("0.0.0.0", "::", "") else args.host
        url = "http://%s:%d/" % (probe_host, args.port)
        print()
        print("  已经有一个实例在跑了  %s" % url)
        print("  直接用它；要再起一个加 --force")
        print()
        if should_open:
            webbrowser.open(url)
        return

    server, port = create_app(data_dir, args.host, args.port)
    shown = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = "http://%s:%d/" % (shown, port)

    print()
    print("  MOSS Layout Studio  v%s" % __version__)
    print("  →  %s" % url)
    print("  数据  %s" % Path(data_dir).resolve())
    print("  退出  Ctrl+C%s" % ("，或直接关掉这个窗口" if FROZEN else ""))
    print()
    sys.stdout.flush()

    if should_open:
        open_browser_later(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止")
    finally:
        server.server_close()


def use_utf8_when_piped():
    """输出被重定向时（日志、管道）统一成 UTF-8，别让中文变成 cp936 乱码。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream is None or stream.isatty():
                continue
            if (stream.encoding or "").lower().replace("-", "") != "utf8":
                stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def run():
    """打包入口：出错时别让控制台一闪而过。"""
    use_utf8_when_piped()
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        traceback.print_exc()
        sys.stderr.write("\n  启动失败：%s\n" % error)
        if FROZEN and sys.stdin and sys.stdin.isatty():
            try:
                input("  按回车退出…")
            except (EOFError, KeyboardInterrupt):
                pass
        raise SystemExit(1)


if __name__ == "__main__":
    run()

